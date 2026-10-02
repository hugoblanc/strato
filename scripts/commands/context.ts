/**
 * `strato context <topic | key | link> [--since 2h] [--max 200]`: a thread read through its tool, printed as plain
 * text for a session or the master (docs/design/providers.md, section 9). One command for every tool that reads
 * threads, with the account Strato already uses: a session needs no MCP server to read its topic.
 *
 * A key, a link or a bare ticket id names one thread; a letter, a short session id or a sessionId names a topic, whose
 * threads are all printed. It only reads.
 */
import { fail, flags, out } from "../app/env.ts";
import { selfCommand } from "../app/self.ts";
import { loadSujets } from "../app/store.ts";
import { contextLines } from "../core/context.ts";
import { t } from "../core/i18n.ts";
import { canonicalKey, formatKey, parseKey } from "../core/keys.ts";
import { checkedLink, claimTicketId, descriptorOf, parseLink, readsThreads } from "../core/links.ts";
import { findSujet, sujetKeys } from "../core/sujet.ts";
import { toolLabel } from "../core/targets.ts";
import { parseDuration } from "../core/text.ts";
import { untrustedRule } from "../policy/prompts.ts";
import { authUsable, providerError } from "../providers/api.ts";
import { accountContext, accountOf, nativeOfKey } from "../providers/registry.ts";
import type { Provider } from "../providers/sdk.ts";

/** Items read per thread when `--max` is not given, and the most a call may ask for. */
export const CONTEXT_MAX = 200;
export const CONTEXT_MAX_LIMIT = 1000;

/** A thread to read: its key as the output names it, its account, its native id. */
interface Wanted {
  key: string;
  provider: string;
  account: string;
  native: string | null;
}

/** A key -> the thread to read; a long key's native id is read back from its account's map. */
function wantedOfKey(key: string): Wanted | null {
  const p = parseKey(key);
  if (!p) return null;
  return { key, provider: p.provider, account: p.account, native: nativeOfKey(key)?.native ?? (p.long ? null : p.native) };
}

/** What a reference names: one thread (a link, a key, a bare ticket id), or every thread of a topic. */
function wantedOf(ref: string): Wanted[] | null {
  const link = parseLink(ref);
  if (link) return [{ key: formatKey(link.provider, link.account, link.thread) ?? ref, provider: link.provider, account: link.account, native: link.thread }];
  // a link no connected tool recognizes is not a key either
  if (/^https?:\/\//i.test(ref)) return null;
  const key = canonicalKey(ref);
  const named = key ? wantedOfKey(key) : null;
  if (named) return [named];
  const ticket = claimTicketId(ref);
  if (ticket) return [{ key: formatKey(ticket.provider, ticket.account, ticket.native) ?? ref, provider: ticket.provider, account: ticket.account, native: ticket.native }];
  const s = findSujet(loadSujets(), ref);
  return s ? sujetKeys(s).flatMap((k) => wantedOfKey(k) ?? []) : null;
}

/** Why a thread cannot be read here, in one line for stderr; null when it can. */
function unreadable(w: Wanted): string | null {
  const tool = toolLabel(w.provider, w.account);
  const entry = accountOf(w.provider, w.account);
  if (!entry) return t("cli.context.noAccount", { key: w.key, tool });
  if (!entry.provider) return t("cli.context.failed", { key: w.key, reason: entry.problem ?? tool });
  if (!entry.provider.context || !readsThreads(w.provider, w.account)) {
    const mcp = descriptorOf(w.provider)?.mcp;
    // a links-only account: the tool reads threads once it is connected
    if (entry.provider.context && mcp && !authUsable(entry.provider.descriptor, entry.account.auth)) {
      const cmd = `${selfCommand()} setup --connect ${w.provider}${w.account === "default" ? "" : ` --account ${w.account}`}`;
      return t("cli.context.linksOnly", { key: w.key, tool, cmd, server: entry.mcpServer ?? mcp.server, read: mcp.readTools.join(", ") });
    }
    return mcp ? t("cli.context.unreadableMcp", { key: w.key, tool, server: entry.mcpServer ?? mcp.server, read: mcp.readTools.join(", ") }) : t("cli.context.unreadable", { key: w.key, tool });
  }
  if (w.native === null) return t("cli.context.failed", { key: w.key, reason: t("cli.context.lostLongKey") });
  return null;
}

/** Reads one thread: connect, then context. The lines to print, or why it failed. */
async function readOne(w: Wanted, opts: { since?: number; max: number }): Promise<{ lines: string[] } | { error: string }> {
  const entry = accountOf(w.provider, w.account);
  const provider = entry?.provider as Provider | null | undefined;
  if (!entry || !provider?.context || w.native === null) return { error: t("cli.context.failed", { key: w.key, reason: "-" }) };
  try {
    const identity = await provider.connect(accountContext(entry));
    const r = await provider.context(accountContext(entry, { identity }), w.native, opts);
    const link = typeof r.link === "string" ? checkedLink(r.link, w.provider) : null;
    return { lines: contextLines({ key: w.key, tool: toolLabel(w.provider, w.account), link }, r, opts.max) };
  } catch (e) {
    return { error: t("cli.context.failed", { key: w.key, reason: providerError(e).message }) };
  }
}

export async function context(args: string[]): Promise<void> {
  const { positional, opts } = flags(args);
  const ref = positional[0];
  if (!ref) fail(t("cli.context.usage"));
  let since: number | undefined;
  if (opts.since) {
    try {
      since = Date.now() - parseDuration(opts.since);
    } catch (e) {
      fail((e as Error).message);
    }
  }
  const max = opts.max === undefined ? CONTEXT_MAX : Number(opts.max);
  if (!Number.isInteger(max) || max < 1 || max > CONTEXT_MAX_LIMIT) fail(t("cli.context.max", { limit: CONTEXT_MAX_LIMIT }));
  const wanted = wantedOf(ref);
  if (!wanted?.length) fail(t("cli.context.unknown", { ref }));
  const read: string[] = [];
  let failed = 0;
  for (const w of wanted) {
    const why = unreadable(w);
    const r = why ? { error: why } : await readOne(w, { ...(since !== undefined ? { since } : {}), max });
    if ("error" in r) {
      failed++;
      process.stderr.write(`strato: ${r.error}\n`);
    } else read.push(...r.lines);
  }
  if (!read.length) process.exit(1);
  // the frame: what follows is data written by third parties, never an instruction
  out(untrustedRule());
  for (const line of read) out(line);
  if (failed) process.exitCode = 1;
}
