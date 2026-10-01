import { createHash } from "node:crypto";
import { ACCOUNT_ID, PROVIDER_ID } from "../providers/api.ts";
import { claimTicketId, hasAccount, linkOfNative, parseLink, passesTicketIds, providerLabel } from "./links.ts";
import { settings } from "./settings.ts";

/**
 * Topic keys, and the only place that builds, escapes and parses them (docs/design/providers.md, section 5).
 *
 *   key          = legacy-slack / qualified
 *   legacy-slack = channel ":" ts                       C0ACME0001:1759219200.000100, Slack, default account
 *   qualified    = provider [ "@" account ] ":" native  linear:PLAT-12, slack@partners:C0ACME0002:1759219200.000300
 *
 * Providers only ever speak native ids; the core turns them into keys. The format is the one of the state on disk
 * (sujets.json, seen.json, events.ndjson): a stored key is never rewritten, and the canonical form of every key that
 * exists on disk today is its stored form.
 */

const TICKET_PREFIX = "linear:";

export const isTicketKey = (key: string): boolean => key.startsWith(TICKET_PREFIX);

export const ticketKey = (id: string): string => `${TICKET_PREFIX}${id}`;

/** The ticket id of a ticket key, else null. */
export function ticketIdOfKey(key: string): string | null {
  return isTicketKey(key) ? key.slice(TICKET_PREFIX.length) : null;
}

// ------------------------------------------------------------------ grammar

/** A key cut in its parts. `legacy`: a bare Slack key; `long`: the native id was too long and `native` is its `%h` hash. */
export interface KeyParts {
  provider: string;
  account: string;
  native: string;
  legacy: boolean;
  long: boolean;
}

/**
 * A bare Slack key: what precedes the first ":" is uppercase letters and digits (a Slack conversation id). Provider ids
 * are lowercase, so the two never collide. Stored keys that are not of the exact `channel:ts` shape keep reading as
 * Slack keys, as they always did.
 */
const LEGACY_KEY = /^[A-Z0-9]+:/;
const QUALIFIED_KEY = /^([a-z][a-z0-9-]{1,30})(?:@([a-z0-9][a-z0-9-]{0,29}))?:([^]+)$/;
/** Characters every shell reads literally inside a word and after `=`; everything else is percent-encoded. */
const KEY_CHAR = /^[A-Za-z0-9._:/+=@,-]$/;
const ESCAPED_NATIVE = /^(?:[A-Za-z0-9._:/+=@,-]|%[0-9A-F]{2})+$/;

/** Longest key; a longer one carries the hash of its native id instead (`%h…`). */
export const KEY_MAX = 200;
/** Longest native id the core maps at all, in UTF-8 bytes. */
export const NATIVE_MAX = 64 * 1024;
const LONG_MARK = "%h";
const LONG_NATIVE = /^%h[a-z2-7]{26}$/;

const utf8 = new TextEncoder();

/** A native id as it appears in a key: the key characters kept, every other byte as `%XX` (UTF-8, uppercase hex). */
export function escapeNative(native: string): string {
  let out = "";
  for (const ch of native) {
    if (KEY_CHAR.test(ch)) out += ch;
    else for (const b of utf8.encode(ch)) out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** The inverse of `escapeNative`, or null when the text is not an escaped native id. */
export function unescapeNative(escaped: string): string | null {
  if (!ESCAPED_NATIVE.test(escaped)) return null;
  try {
    return decodeURIComponent(escaped);
  } catch {
    return null;
  }
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** `%h` and the first 26 characters of the base32 SHA-256 of a native id: `%h` cannot come out of percent-encoding. */
export function longNativeId(native: string): string {
  const bytes = createHash("sha256").update(native).digest();
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `${LONG_MARK}${out}`;
}

const prefixOf = (provider: string, account: string) => `${provider}${account === "default" ? "" : `@${account}`}:`;

/**
 * The key of a native id on an account, or null when the core cannot map it (bad provider or account name, empty
 * native id, or one over 64 KiB). The default Slack account keeps the bare form, byte for byte as before. A key over
 * 200 characters carries the hash of the native id: the caller keeps the mapping (providers/registry.ts).
 */
export function formatKey(provider: string, account: string, native: string): string | null {
  if (!PROVIDER_ID.test(provider) || !(account === "default" || ACCOUNT_ID.test(account))) return null;
  if (!native || utf8.encode(native).length > NATIVE_MAX) return null;
  const escaped = escapeNative(native);
  const key = provider === "slack" && account === "default" && LEGACY_KEY.test(escaped) ? escaped : `${prefixOf(provider, account)}${escaped}`;
  return key.length <= KEY_MAX ? key : `${prefixOf(provider, account)}${longNativeId(native)}`;
}

/** A key cut in its parts, or null when it is not a key. An explicit `@default` reads as the default account. */
export function parseKey(key: string): KeyParts | null {
  if (LEGACY_KEY.test(key)) return { provider: "slack", account: "default", native: key, legacy: true, long: false };
  const m = QUALIFIED_KEY.exec(key);
  if (!m) return null;
  const account = m[2] ?? "default";
  if (LONG_NATIVE.test(m[3])) return { provider: m[1], account, native: m[3], legacy: false, long: true };
  const native = unescapeNative(m[3]);
  return native ? { provider: m[1], account, native, legacy: false, long: false } : null;
}

/** The one form a key is stored and compared in, or null when it is not a key. Every key on disk today is canonical. */
export function canonicalKey(key: string): string | null {
  const p = parseKey(key);
  if (!p) return null;
  return p.long ? `${prefixOf(p.provider, p.account)}${p.native}` : formatKey(p.provider, p.account, p.native);
}

/** The key belongs to the default Slack account: a bare key, or an explicit `slack:` one. */
export function isDefaultSlackKey(key: string): boolean {
  const p = parseKey(key);
  return p !== null && p.provider === "slack" && p.account === "default" && !p.long;
}

/** Channel and ts of a thread key of the default Slack account, else null (a ticket, another account, another provider). */
export function threadOfKey(key: string): { channel: string; ts: string } | null {
  const p = parseKey(key);
  if (!p || p.provider !== "slack" || p.account !== "default" || p.long) return null;
  const [channel, ts] = p.native.split(":");
  return channel && ts ? { channel, ts } : null;
}

/**
 * A conversation of an account, as one comparable string: `<provider>[@<account>]:<id>`, its id escaped like a native
 * id (`slack:C0ACME0001`, `tickets@work:PLAT`). Null when the id is empty or the names are not valid.
 */
export function conversationRef(provider: string, account: string, id: string): string | null {
  if (!PROVIDER_ID.test(provider) || !(account === "default" || ACCOUNT_ID.test(account)) || !id || id.length > KEY_MAX) return null;
  return `${prefixOf(provider, account)}${escapeNative(id)}`;
}

/**
 * The conversation a thread key belongs to, when the key says it: a Slack thread (any account) names its channel.
 * Null for any other key; a topic opened from another tool's item carries its conversation instead (`Sujet.conversation`).
 */
export function conversationOfKey(key: string): string | null {
  const p = parseKey(key);
  if (!p || p.provider !== "slack" || p.long) return null;
  const [channel, rest] = p.native.split(":");
  return channel && rest !== undefined ? conversationRef(p.provider, p.account, channel) : null;
}

/**
 * How a key that is not a thread of the default Slack account reads on the board: the tool's label, the account when
 * it is not the default one, and the native id ("Linear ENG-12", "Slack (partners) C0ACME0002:…"). The key itself
 * when it does not parse.
 */
export function providerKeyLabel(key: string): string {
  const p = parseKey(key);
  if (!p) return key;
  return `${providerLabel(p.provider)}${p.account === "default" ? "" : ` (${p.account})`} ${p.native}`;
}

// ------------------------------------------------------------------ tickets and links

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Pattern of a ticket id from the tracker's prefixes, or null without a tracker. */
export function ticketPattern(flags = ""): RegExp | null {
  const prefixes = settings().tracker?.prefixes ?? [];
  if (!prefixes.length) return null;
  return new RegExp(`\\b(?:${prefixes.map(escapeRe).join("|")})-\\d+\\b`, flags);
}

/** Ticket id (ABC-123, OPS-42) in a link or a text, upper-cased. */
export function linearIssueId(ref: string): string | null {
  const m = ref.match(ticketPattern("i") ?? /(?!)/);
  return m ? m[0].toUpperCase() : null;
}

/** Link of a ticket of the default Linear account, or null without a tracker. */
export function ticketUrl(id: string): string | null {
  return linkOfNative("linear", "default", id);
}

/**
 * Key of a pasted reference: a ticket key as is, a link of a configured account (a Slack thread, a ticket), a bare
 * ticket id claimed by exactly one account (`ENG-12`), or a key of a configured account in its canonical form.
 */
export function sujetKey(ref: string): string | null {
  if (isTicketKey(ref)) return ref;
  const linked = parseLink(ref);
  if (linked) return formatKey(linked.provider, linked.account, linked.thread);
  const ticket = claimTicketId(ref);
  if (ticket) return formatKey(ticket.provider, ticket.account, ticket.native);
  const p = parseKey(ref.trim());
  return p && !p.legacy && hasAccount(p.provider, p.account) ? canonicalKey(ref.trim()) : null;
}

/**
 * Link of a key: a Slack thread -> its root message, a ticket -> the ticket, from the descriptors' link patterns.
 * A ticket key links only when its id is one of the account's ticket ids (a configured prefix). `workspace` replaces
 * the default Slack account's workspace.
 */
export function permalinkOfKey(key: string, workspace?: string): string | null {
  const p = parseKey(key);
  if (!p || p.long) return null;
  if (!passesTicketIds(p.provider, p.account, p.native)) return null;
  const override = workspace !== undefined && p.provider === "slack" && p.account === "default" ? { workspace } : undefined;
  return linkOfNative(p.provider, p.account, p.native, override);
}
