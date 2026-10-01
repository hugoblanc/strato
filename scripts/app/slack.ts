/**
 * Slack, network side: the token, the Web API, names, search, thread reads and the socket's app token.
 * Message triage and formatting, pure, live in chat/slack-model.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bestText, channelGuess, channelLabel, classify, type Config, humanize, type Kind, matchFromEditEvent, matchFromSocketEvent, type SlackChannel, type SlackMatch, SOCKET_SUBTYPES, threadKey } from "../chat/slack-model.ts";
import { type ThreadDump } from "../core/cards.ts";
import { permalinkOfKey, threadOfKey } from "../core/keys.ts";
import { settings, type SlackSettings } from "../core/settings.ts";
import { tokenKindProblem, USER_TOKEN_WHERE } from "../core/setup.ts";
import { type Sujet, sujetKeys, type Trigger } from "../core/sujet.ts";
import { truncate } from "../core/text.ts";
import { expandHome, F, fail, localDay, readJson, WORKSPACE, writeJson } from "./env.ts";

// ------------------------------------------------------------------ slack

let TOKEN = "";

/** A token of the right workspace was already found: calls can go out without `connectSlack`. */
export const hasSlackToken = () => TOKEN !== "";

/** A write call (chat.postMessage, chat.delete): as a POST, the text does not travel in the URL. */
// biome-ignore lint/suspicious/noExplicitAny: untyped Slack responses
export async function slackPost(method: string, params: Record<string, string>): Promise<any> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json()) as { ok?: boolean; error?: string };
  if (!body.ok) throw new SlackError(body.error ?? "unknown");
  return body;
}

export class SlackError extends Error {
  constructor(readonly code: string) {
    super(`Slack: ${code}`);
  }
  get fatal() {
    return ["invalid_auth", "token_revoked", "account_inactive", "not_authed", "missing_scope"].includes(this.code);
  }
}

/** The value of `KEY=value` (or `export KEY=value`, quotes allowed) in a small env file, or null. */
export function envFileValue(file: string, key: string): string | null {
  try {
    const m = readFileSync(expandHome(file), "utf8").match(new RegExp(`^\\s*(?:export\\s+)?${key}=(.+)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
  } catch {
    return null;
  }
}

/** Every user token found on the machine for this workspace folder, in the order they are tried. */
export function tokenCandidates(): string[] {
  const file = settings().slack.userTokenFile;
  const fromFile = file ? envFileValue(file, "SLACK_USER_TOKEN") : null;
  const local = readJson<{ env?: Record<string, string> }>(join(WORKSPACE, ".claude/settings.local.json"), {});
  const mcp = readJson<{ mcpServers?: { slack?: { env?: Record<string, string> } } }>(join(WORKSPACE, ".mcp.json"), {});
  const all = [
    fromFile,
    process.env.STRATO_SLACK_TOKEN,
    process.env.AIGUILLEUR_SLACK_TOKEN,
    local.env?.SLACK_MCP_XOXP_TOKEN,
    mcp.mcpServers?.slack?.env?.SLACK_MCP_XOXP_TOKEN,
    process.env.SLACK_MCP_XOXP_TOKEN,
  ];
  return [...new Set(all.filter((t): t is string => Boolean(t)))];
}

// biome-ignore lint/suspicious/noExplicitAny: untyped Slack responses
export async function slack(method: string, params: Record<string, string | number> = {}, attempt = 0): Promise<any> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]));
  const res = await fetch(`https://slack.com/api/${method}?${qs}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(25_000),
  });
  if (res.status === 429) {
    // search.messages is Tier 2 (~20 calls/min): a long catch-up hits it, wait as long as Slack asks
    if (attempt >= 4) throw new SlackError("ratelimited");
    await Bun.sleep((Number(res.headers.get("retry-after")) || 10) * 1000);
    return slack(method, params, attempt + 1);
  }
  // some channel or profile names contain invalid bytes: lenient decoding
  const body = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(await res.arrayBuffer()));
  if (!body.ok) throw new SlackError(body.error ?? "unknown");
  return body;
}

/** What the last `connectSlack` saw, token by token: the "no token" message names the workspace of each. */
let probed: { token: string; team?: string; error?: string }[] = [];

const maskToken = (t: string) => `${t.slice(0, 5)}…${t.slice(-4)}`;

/**
 * Why no token is usable, in two distinct cases: none found at all (where to put one), or some found that belong to
 * another workspace or that Slack refuses (each one masked, with its workspace or Slack's refusal code).
 */
export const NO_TOKEN = (cfg: SlackSettings) => {
  const found = tokenCandidates();
  if (!found.length) {
    return `no Slack user token found: copy ${USER_TOKEN_WHERE}, then run setup --token; or set STRATO_SLACK_TOKEN, or SLACK_MCP_XOXP_TOKEN in ${WORKSPACE}/.claude/settings.local.json ("env") or ${WORKSPACE}/.mcp.json (the "slack" server); see SETUP.md, "Connect Slack"`;
  }
  const seen = found.map((t) => {
    const p = probed.find((x) => x.token === t);
    return `${maskToken(t)}: ${p?.team ? `workspace "${p.team}"` : (tokenKindProblem(t) ?? p?.error ?? "not checked")}`;
  });
  return `${found.length} Slack token(s) found, none usable${cfg.team ? ` for workspace "${cfg.team}" (slack.team)` : ""}: ${seen.join(", ")}`;
};

/**
 * Several tokens can live on the machine (other workspaces): keep the first one that belongs to the right workspace, else null.
 * While `slack.team` is not set (a new installation), the first token Slack accepts is used, as `setup --check` does,
 * and `teamUnset` says so.
 * Only an answer from Slack rules a token out (other workspace, token refused). A network failure or a timeout says
 * nothing about the token: retry, otherwise a few seconds of outage at startup would stop the listener with "no token".
 */
export async function connectSlack(cfg: SlackSettings): Promise<{ team: string; me: string; teamUnset?: true } | null> {
  const delays = [5, 15, 30, 60];
  for (let attempt = 0; ; attempt++) {
    let transient = false;
    probed = [];
    for (const t of tokenCandidates()) {
      TOKEN = t;
      try {
        const r = await slack("auth.test");
        probed.push({ token: t, team: r.team });
        if (!cfg.team) return { team: r.team, me: r.user_id, teamUnset: true };
        if (r.team === cfg.team) return { team: r.team, me: r.user_id };
      } catch (e) {
        probed.push({ token: t, error: e instanceof SlackError ? e.code : "network" });
        if (!(e instanceof SlackError) || e.code === "ratelimited") transient = true;
      }
    }
    TOKEN = "";
    if (!transient || attempt >= delays.length) return null;
    await Bun.sleep(delays[attempt] * 1000);
  }
}

export async function initSlack(cfg: SlackSettings): Promise<{ team: string; me: string }> {
  const r = await connectSlack(cfg);
  if (!r) fail(NO_TOKEN(cfg), 78);
  return r;
}

export const users = new Map<string, string>(Object.entries(readJson<Record<string, string>>(F.users, {})));

/** A person's display name, remembered in users.json. A failure returns the id without writing: the next message asks again. */
export async function nameOf(uid: string): Promise<string> {
  const hit = users.get(uid);
  if (hit) return hit;
  let name: string;
  try {
    const r = await slack("users.info", { user: uid });
    name = r.user?.profile?.display_name || r.user?.real_name || r.user?.name || uid;
  } catch {
    return uid;
  }
  users.set(uid, name);
  writeJson(F.users, Object.fromEntries(users));
  return name;
}

export async function readable(raw: string, keepLines = false): Promise<string> {
  for (const [, uid] of raw.matchAll(/<@([A-Z0-9]+)/g)) await nameOf(uid);
  return humanize(raw, (uid) => users.get(uid) ?? uid, keepLines);
}

/**
 * Messages visible to the person served, posted since `sinceSec`, oldest first.
 * A busy workspace yields about a thousand per working day: pages are read until `sinceSec`, `complete` says whether
 * it got there. search.messages reads the search index, which lags a few seconds to a minute.
 */
export async function fetchSince(sinceSec: number, maxPages: number): Promise<{ matches: SlackMatch[]; complete: boolean }> {
  // after: excludes the given day, step back one day to lose nothing
  const query = `after:${localDay((sinceSec - 86400) * 1000)}`;
  const all: SlackMatch[] = [];
  let complete = false;
  for (let page = 1; page <= maxPages; page++) {
    const r = await slack("search.messages", { query, count: 100, page, sort: "timestamp", sort_dir: "desc" });
    const matches = (r.messages?.matches ?? []) as SlackMatch[];
    all.push(...matches);
    const pages = r.messages?.paging?.pages ?? 1;
    if (!matches.length || page >= pages || Number(matches[matches.length - 1].ts) < sinceSec) {
      complete = true;
      break;
    }
  }
  return { matches: all.filter((m) => Number(m.ts) >= sinceSec).sort((a, b) => a.ts.localeCompare(b.ts)), complete };
}

/** Threads where the person served wrote in the last `days` days: a reply there without a mention is probably for them. */
export async function participatedThreads(cfg: Config, days = 7): Promise<Set<string>> {
  const keys = new Set<string>();
  const query = `from:<@${cfg.me}> after:${localDay(Date.now() - (days + 1) * 86400_000)}`;
  for (let page = 1; page <= 3; page++) {
    const r = await slack("search.messages", { query, count: 100, page, sort: "timestamp", sort_dir: "desc" });
    const matches = (r.messages?.matches ?? []) as SlackMatch[];
    for (const m of matches) keys.add(threadKey(m));
    if (matches.length < 100) break;
  }
  return keys;
}

async function describeMessage(m: SlackMatch): Promise<Trigger & { key: string }> {
  const from = m.user ? await nameOf(m.user) : m.username || "bot";
  return {
    key: threadKey(m),
    from,
    channel: channelLabel(m.channel),
    text: truncate(await readable(bestText(m)), 500),
    permalink: m.permalink ?? "-",
  };
}

/**
 * Two-step triage: first without the author's name (no Slack call for ignored messages), then with it,
 * for `ignoreAuthors`. The bot filter only silences a message already kept.
 */
export async function triage(m: SlackMatch, cfg: Config, tracked: Set<string>, participated: Set<string>) {
  if (!classify(m, cfg, tracked, participated)) return null;
  const d = await describeMessage(m);
  const kind = classify(m, cfg, tracked, participated, d.from) as Kind;
  return { kind, d };
}

/** The Socket Mode app token (xapp-): the environment first, then the profile's `slack.appTokenFile`. */
export function appToken(): string | null {
  if (process.env.SLACK_APP_TOKEN) return process.env.SLACK_APP_TOKEN;
  const file = settings().slack.appTokenFile;
  return file ? envFileValue(file, "SLACK_APP_TOKEN") : null;
}

/** Full channel objects, cached: `classify` needs is_im/is_mpim, the socket only gives the id. */
const channelObjects = new Map<string, SlackChannel>();

/**
 * A message's channel. `channelType` is the event's `channel_type` (im, mpim, channel, group) when there is one.
 * A conversations.info failure is never cached: otherwise a single failure turns a DM into an unknown channel for
 * the whole life of the process, and its messages stop being surfaced.
 */
export async function channelOf(id: string, channelType?: string): Promise<SlackChannel> {
  const hit = channelObjects.get(id);
  if (hit) return hit;
  // a DM or group DM is recognised from the event, without a call: its name is useless ("DM")
  if (channelType === "im" || channelType === "mpim") {
    const c = channelGuess(id, channelType);
    channelObjects.set(id, c);
    return c;
  }
  try {
    const r = await slack("conversations.info", { channel: id });
    if (r.channel) {
      const c: SlackChannel = { id, name: r.channel.name, is_im: r.channel.is_im, is_mpim: r.channel.is_mpim };
      channelObjects.set(id, c);
      return c;
    }
  } catch {}
  return channelGuess(id, channelType);
}

/**
 * The DMs and group DMs the person served belongs to, read with their token.
 * A Slack app installed by several people receives everyone's DMs over Socket Mode: the event's `authorizations`
 * field names only one of them, and Slack says not to rely on it. Without this check, the listener surfaces
 * conversations between two colleagues as "DM".
 */
const myConversations = new Set<string>();
/** Conversations they are known not to belong to (Slack answers channel_not_found with their token), and since when. */
const notMine = new Map<string, number>();
/** A foreign conversation is checked again after an hour: one can be added to a group DM. */
const NOT_MINE_TTL_MS = 3_600_000;

/**
 * True if the person served is in this private conversation, false if not, null when Slack does not tell (network,
 * rate limit): the caller then keeps the message rather than risk losing one.
 * conversations.info with their token only sees their conversations: channel_not_found on one between two colleagues.
 */
export async function isMyConversation(id: string): Promise<boolean | null> {
  if (myConversations.has(id)) return true;
  const seen = notMine.get(id);
  if (seen !== undefined && Date.now() - seen < NOT_MINE_TTL_MS) return false;
  try {
    const r = await slack("conversations.info", { channel: id });
    if (!r.channel) return null;
    myConversations.add(id);
    notMine.delete(id);
    return true;
  } catch (e) {
    if (/channel_not_found|not_in_channel/.test((e as Error).message)) {
      notMine.set(id, Date.now());
      return false;
    }
    return null;
  }
}

/** A private conversation (DM, group DM) according to the event: only those are checked for membership. */
const isPrivateConversation = (id: string, channelType?: string) => channelType === "im" || channelType === "mpim" || id.startsWith("D");

/**
 * A socket `message` event -> a SlackMatch, once the channel is resolved. The conversion itself lives in chat/slack-model.ts, tested.
 * A `message_changed` only passes if it adds a mention of the person served (`cfg`), compared with its previous version.
 */
export async function matchFromEvent(e: Record<string, any>, base: string, cfg: Pick<Config, "me" | "subteams">): Promise<SlackMatch | null> {
  // the DM of two colleagues who also installed the app is not a DM of the person served
  if (e?.channel && isPrivateConversation(String(e.channel), e.channel_type) && (await isMyConversation(String(e.channel))) === false) return null;
  if (e?.subtype === "message_changed" && e.channel) return matchFromEditEvent(e, await channelOf(String(e.channel), e.channel_type), base, cfg);
  if (e?.type !== "message" || !e.ts || !e.channel) return null;
  if (e.subtype && !SOCKET_SUBTYPES.has(e.subtype)) return null;
  return matchFromSocketEvent(e, await channelOf(String(e.channel), e.channel_type), base);
}

/** Cap on a thread read: past it, the most recent replies are not read. */
export const REPLIES_MAX = 2000;

/**
 * A thread's messages, root included, page by page (next_cursor) up to `REPLIES_MAX`.
 * `extra` passes parameters to conversations.replies (`oldest` for the catch-up). A single page of 200 would make a
 * long thread lose its most recent replies, the ones that matter.
 */
// biome-ignore lint/suspicious/noExplicitAny: untyped Slack responses
export async function repliesOf(channel: string, ts: string, extra: Record<string, string> = {}): Promise<any[]> {
  // biome-ignore lint/suspicious/noExplicitAny: untyped Slack responses
  const all: any[] = [];
  let cursor = "";
  do {
    const r = await slack("conversations.replies", { channel, ts, limit: 200, ...extra, ...(cursor ? { cursor } : {}) });
    all.push(...(r.messages ?? []));
    cursor = r.response_metadata?.next_cursor ?? "";
  } while (cursor && all.length < REPLIES_MAX);
  return all.slice(0, REPLIES_MAX);
}

/** Reads a whole Slack thread for the dive sheet. null for any key but a thread of the default Slack account. */
export async function threadDump(key: string): Promise<ThreadDump | null> {
  const permalink = permalinkOfKey(key);
  const thread = threadOfKey(key);
  if (!permalink || !thread) return null;
  const { channel, ts } = thread;
  const messages: ThreadDump["messages"] = [];
  for (const m of (await repliesOf(channel, ts)) as (SlackMatch & { bot_profile?: { name?: string } })[]) {
    const from = m.user ? await nameOf(m.user) : m.username || m.bot_profile?.name || "bot";
    const at = new Date(Number(m.ts) * 1000);
    const stamp = `${localDay(at.getTime()).slice(5)} ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    messages.push({ at: stamp, from, text: await readable(bestText({ ...m, channel: { id: channel } }), true) });
  }
  return { key, permalink, channel: await channelNameOf(channel), messages };
}

/** Readable channel names ("#sales", "DM"), in memory only; a failure is not remembered. */
const channelNames = new Map<string, string>();

async function channelNameOf(id: string): Promise<string | undefined> {
  const hit = channelNames.get(id);
  if (hit) return hit;
  try {
    const r = await slack("conversations.info", { channel: id });
    if (!r.channel) return undefined;
    const name = channelLabel({ id, ...r.channel });
    channelNames.set(id, name);
    return name;
  } catch {
    return undefined;
  }
}

/** All the Slack threads of a topic, in the order of its keys; an unreadable thread leaves an error message in its place. */
export async function readThreads(s: Sujet): Promise<ThreadDump[]> {
  const dumps = await Promise.all(
    sujetKeys(s).map(async (key): Promise<ThreadDump | null> => {
      try {
        return await threadDump(key);
      } catch (e) {
        return { key, permalink: permalinkOfKey(key) ?? key, messages: [{ at: "--", from: "strato", text: `unreadable thread: ${(e as Error).message}` }] };
      }
    }),
  );
  return dumps.filter((d): d is ThreadDump => d !== null);
}
