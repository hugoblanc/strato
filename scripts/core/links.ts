/**
 * Links as data (docs/design/providers.md, section 4.9). A provider does not implement links: its descriptor declares
 * patterns, and this module evaluates them for every configured account, synchronously, because link resolution runs
 * inside pure code (finding a topic, the board's links, transcript citations, the ⌘K bar).
 *
 * The descriptors are installed at startup with `useProviders`, the way `useSettings` installs the profile (app/env.ts,
 * and test-setup.ts for the tests), so this module stays pure. Native ids only: core/keys.ts turns them into keys.
 */
import type { LinkSpec, ProviderDescriptor, Text } from "../providers/sdk.ts";
import { locale, type MessageKey, t } from "./i18n.ts";
import { resolveAccounts, type Settings, settings } from "./settings.ts";

let installed: ProviderDescriptor[] = [];
let generation = 0;

/** Installs the descriptors of the providers Strato knows: the built-in ones, and later the trusted external ones. */
export function useProviders(list: ProviderDescriptor[]): void {
  installed = [...list];
  generation++;
}

/** The installed descriptors, in installation order. */
export const providerDescriptors = (): ProviderDescriptor[] => installed;

export const descriptorOf = (id: string): ProviderDescriptor | null => installed.find((d) => d.id === id) ?? null;

/** A provider string in the person's language: an i18n key for a built-in provider, else its English text by default. */
export function textOf(x: Text): string {
  if ("key" in x) return t(x.key as MessageKey);
  return locale() === "fr" && x.fr ? x.fr : x.en;
}

/** The name of a tool ("Slack", "Linear"), or its id when it is not installed. */
export function providerLabel(id: string): string {
  const d = descriptorOf(id);
  return d ? textOf(d.label) : id;
}

// ------------------------------------------------------------------ accounts as the links see them

interface LinkAccount {
  provider: string;
  account: string;
  settings: Record<string, unknown>;
  spec: LinkSpec;
  hosts: string[];
  ticketPrefixes: string[] | null;
}

let cache: { s: Settings; gen: number; accounts: LinkAccount[] } | null = null;

/** The configured accounts whose provider is installed, recomputed when the profile or the descriptors change. */
function linkAccounts(): LinkAccount[] {
  const s = settings();
  if (cache && cache.s === s && cache.gen === generation) return cache.accounts;
  const byId = Object.fromEntries(installed.map((d) => [d.id, d]));
  const accounts: LinkAccount[] = [];
  for (const { account } of resolveAccounts(s, byId)) {
    const d = byId[account.provider];
    if (!d) continue;
    const from = d.ticketIds?.prefixesFrom;
    const prefixes = from ? account.settings[from] : null;
    accounts.push({
      provider: account.provider,
      account: account.id,
      settings: account.settings,
      spec: d.links,
      hosts: d.hosts,
      ticketPrefixes: from ? (Array.isArray(prefixes) ? prefixes.filter((x): x is string => typeof x === "string" && x !== "") : []) : null,
    });
  }
  cache = { s, gen: generation, accounts };
  return accounts;
}

/** The profile has this account, and its provider is installed. */
export const hasAccount = (provider: string, account: string): boolean => linkAccounts().some((a) => a.provider === provider && a.account === account);

// ------------------------------------------------------------------ the evaluator

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SETTING_REF = /\{settings\.([A-Za-z0-9_]+)\}/g;
/** Longest text a link pattern runs on: a pathological pattern cannot stall a synchronous path for long. */
export const LINK_INPUT_MAX = 2048;

/**
 * `{settings.<name>}` replaced by the account's setting: regex-escaped in a pattern, where a list becomes alternatives
 * (`ENG|OPS`); as is in a host or a URL, where a list gives its first value. An empty or missing setting makes the
 * entry unusable: null, and the entry is skipped (no workspace, no link).
 */
function substitute(template: string, values: Record<string, unknown>, mode: "pattern" | "text"): string | null {
  let missing = false;
  const out = template.replace(SETTING_REF, (_m, name: string) => {
    const v = values[name];
    const list = (Array.isArray(v) ? v : [v]).filter((x): x is string | number => (typeof x === "string" && x !== "") || typeof x === "number").map(String);
    if (!list.length) missing = true;
    return mode === "pattern" ? list.map(escapeRe).join("|") : (list[0] ?? "");
  });
  return missing ? null : out;
}

const compiled = new Map<string, RegExp | null>();

/** A pattern compiled once; an invalid one is null and never matches. */
function regex(source: string): RegExp | null {
  if (!compiled.has(source)) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(source);
    } catch {}
    compiled.set(source, re);
  }
  return compiled.get(source) ?? null;
}

/** `$1`, `$2`… replaced by the groups of a match; null when a referenced group did not take part. */
function fill(template: string, m: RegExpExecArray): string | null {
  let missing = false;
  const out = template.replace(/\$(\d)/g, (_x, n: string) => {
    const g = m[Number(n)];
    if (g === undefined || g === "") missing = true;
    return g ?? "";
  });
  return missing ? null : out;
}

/** A host pattern: exact, without case, or `*.example.com` for any subdomain of example.com, at any depth. */
export function hostMatches(pattern: string, hostname: string): boolean {
  const p = pattern.toLowerCase();
  const h = hostname.toLowerCase();
  return p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p;
}

/**
 * The link in a pasted reference: the reference itself, the first http(s) link of a text, or a link written without
 * its scheme (`acme.slack.com/archives/…`). Null over 2 KiB.
 */
function urlIn(text: string): URL | null {
  const ref = text.trim();
  if (!ref || ref.length > LINK_INPUT_MAX) return null;
  const found = ref.match(/\bhttps?:\/\/[^\s<>"'`]+/i)?.[0] ?? (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*$/i.test(ref) ? `https://${ref}` : null);
  if (!found) return null;
  try {
    return new URL(found);
  } catch {
    return null;
  }
}

/** What a link points to: a thread (and an item of it) on one account. */
export interface LinkTarget {
  provider: string;
  account: string;
  thread: string;
  item?: string;
}

/**
 * A pasted link -> native ids, from the `parse` patterns of every configured account. Exact hosts are tried before
 * wildcard hosts, across accounts, so `acme-partners.slack.com` goes to the account of that workspace and any other
 * Slack host to the default account; within a host kind, accounts and patterns keep their order.
 */
export function parseLink(text: string): LinkTarget | null {
  const url = urlIn(text);
  if (!url) return null;
  const rest = `${url.pathname}${url.search}${url.hash}`;
  const entries = linkAccounts().flatMap((a) =>
    a.spec.parse.flatMap((e) => {
      const host = substitute(e.host, a.settings, "text");
      return host ? [{ a, e, host, wildcard: host.startsWith("*.") }] : [];
    }),
  );
  for (const { a, e, host } of [...entries.filter((x) => !x.wildcard), ...entries.filter((x) => x.wildcard)]) {
    if (!hostMatches(host, url.hostname)) continue;
    const source = substitute(e.pattern, a.settings, "pattern");
    const m = source ? regex(source.startsWith("^") ? source : `^(?:${source})`)?.exec(rest) : null;
    if (!m) continue;
    const thread = fill(e.thread, m);
    if (!thread) continue;
    const item = e.item ? fill(e.item, m) : null;
    return { provider: a.provider, account: a.account, thread, ...(item ? { item } : {}) };
  }
  return null;
}

/**
 * A native thread or item id -> its link, from the account's `of` patterns, or null. The link must be https, without
 * whitespace and on the provider's `hosts`, whatever the descriptor says. `override` replaces settings for one call.
 */
export function linkOfNative(provider: string, account: string, native: string, override?: Record<string, unknown>): string | null {
  const a = linkAccounts().find((x) => x.provider === provider && x.account === account);
  if (!a || native.length > LINK_INPUT_MAX) return null;
  const values = override ? { ...a.settings, ...override } : a.settings;
  for (const of of a.spec.of) {
    const source = substitute(of.match, values, "pattern");
    const m = source ? regex(source)?.exec(native) : null;
    if (!m) continue;
    const template = substitute(of.url, values, "text");
    const url = template ? fill(template, m) : null;
    return url && isAllowedLink(url, a.hosts) ? url : null;
  }
  return null;
}

/** An https link on one of these hosts, without whitespace. */
function isAllowedLink(url: string, hosts: string[]): boolean {
  if (/\s/.test(url)) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && hosts.some((h) => hostMatches(h, u.hostname));
  } catch {
    return false;
  }
}

/** The account a link's host belongs to (exact hosts first), or null: the board opens only these. */
export function hostOwner(hostname: string): { provider: string; account: string } | null {
  const accounts = linkAccounts();
  const exact = accounts.find((a) => a.hosts.some((h) => !h.startsWith("*.") && hostMatches(h, hostname)));
  const owner = exact ?? accounts.find((a) => a.hosts.some((h) => hostMatches(h, hostname)));
  return owner ? { provider: owner.provider, account: owner.account } : null;
}

// ------------------------------------------------------------------ bare ticket ids

const ticketRegex = (prefixes: string[], flags: string) => new RegExp(`\\b(?:${prefixes.map(escapeRe).join("|")})-\\d+\\b`, flags);

/**
 * A bare ticket id in a reference (`ENG-12`, `see eng-12`), upper-cased, with the account that claims its prefix.
 * Null when no account claims it, or when several do: the id is ambiguous, and only a link names its account.
 */
export function claimTicketId(text: string): { provider: string; account: string; native: string } | null {
  if (text.length > LINK_INPUT_MAX) return null;
  const claims = linkAccounts().flatMap((a) => {
    const m = a.ticketPrefixes?.length ? text.match(ticketRegex(a.ticketPrefixes, "i")) : null;
    return m ? [{ provider: a.provider, account: a.account, native: m[0].toUpperCase() }] : [];
  });
  return claims.length === 1 ? claims[0] : null;
}

/** True unless the provider claims ticket ids and this native id is not one of the account's (a prefix it does not have). */
export function passesTicketIds(provider: string, account: string, native: string): boolean {
  const a = linkAccounts().find((x) => x.provider === provider && x.account === account);
  if (!a || a.ticketPrefixes === null) return true;
  return a.ticketPrefixes.length > 0 && (regex(`^${ticketRegex(a.ticketPrefixes, "").source}$`)?.test(native) ?? false);
}
