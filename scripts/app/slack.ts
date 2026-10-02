/**
 * Slack, network side: the token, the Web API, names, search, thread reads and the socket.
 * One `SlackClient` per Slack account, each with its token and its caches; the functions exported at the top level
 * work on the default account's client, the one found by today's token search (`connectSlack`), and keep their
 * signatures. Message triage and formatting, pure, live in chat/slack-model.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bestText, channelGuess, channelLabel, type Config, humanize, matchFromEditEvent, matchFromSocketEvent, type SlackChannel, type SlackMatch, SOCKET_SUBTYPES, threadKey } from "../chat/slack-model.ts";
import { type ThreadDump } from "../core/cards.ts";
import { permalinkOfKey, threadOfKey } from "../core/keys.ts";
import { settings, type SlackSettings } from "../core/settings.ts";
import { tokenKindProblem, USER_TOKEN_WHERE } from "../core/setup.ts";
import { type Sujet, sujetKeys } from "../core/sujet.ts";
import { expandHome, F, fail, localDay, readJson, WORKSPACE, writeJson } from "./env.ts";

// ------------------------------------------------------------------ slack

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

/** Slack's answer to a call, untyped. */
// biome-ignore lint/suspicious/noExplicitAny: untyped Slack responses
type SlackBody = any;

/** A conversations.info failure on a private conversation: the person served is not in it. */
const NOT_MINE_TTL_MS = 3_600_000;

/** A private conversation (DM, group DM) according to the event: only those are checked for membership. */
const isPrivateConversation = (id: string, channelType?: string) => channelType === "im" || channelType === "mpim" || id.startsWith("D");

/** Cap on a thread read: past it, the most recent replies are not read. */
export const REPLIES_MAX = 2000;

/**
 * One Slack account's connection: its token, its HTTP, and what it remembers (people's names, conversations).
 * `fetch` is read at each call, so the default account follows a fetch replaced by tests, and a named account goes
 * through the fetch its account context limits to Slack's API host. `saveUsers` keeps the names between runs.
 */
export class SlackClient {
  token = "";
  /** The workspace's URL (`https://acme.slack.com`), from auth.test: the base of the links the socket does not give. */
  base: string | null = null;
  /** Full channel objects, cached: triage needs is_im/is_mpim, the socket only gives the id. */
  private readonly channelObjects = new Map<string, SlackChannel>();
  /** The DMs and group DMs the person served belongs to, read with their token. */
  private readonly myConversations = new Set<string>();
  /** Conversations they are known not to belong to (Slack answers channel_not_found with their token), and since when. */
  private readonly notMine = new Map<string, number>();
  /** Readable channel names ("#sales", "DM"), in memory only; a failure is not remembered. */
  private readonly channelNames = new Map<string, string>();

  constructor(
    private readonly http: () => typeof fetch,
    readonly users: Map<string, string>,
    private readonly saveUsers: (users: Map<string, string>) => void,
  ) {}

  async call(method: string, params: Record<string, string | number> = {}, attempt = 0): Promise<SlackBody> {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]));
    const res = await this.http()(`https://slack.com/api/${method}?${qs}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(25_000),
    });
    if (res.status === 429) {
      // search.messages is Tier 2 (~20 calls/min): a long catch-up hits it, wait as long as Slack asks
      if (attempt >= 4) throw new SlackError("ratelimited");
      await Bun.sleep((Number(res.headers.get("retry-after")) || 10) * 1000);
      return this.call(method, params, attempt + 1);
    }
    // some channel or profile names contain invalid bytes: lenient decoding
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(await res.arrayBuffer()));
    if (!body.ok) throw new SlackError(body.error ?? "unknown");
    return body;
  }

  /**
   * A write call (chat.postMessage, chat.delete): as a POST, the text does not travel in the URL. Only the Slack
   * provider's writes (providers/slack/act.ts) call it, behind the gate: act.test.ts fails if anything else does.
   */
  async postWrite(method: string, params: Record<string, string>): Promise<SlackBody> {
    const res = await this.http()(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (!body.ok) throw new SlackError(body.error ?? "unknown");
    return body;
  }

  /** The workspace's URL, read once from auth.test. Throws when Slack does not answer. */
  async workspaceUrl(): Promise<string> {
    if (this.base) return this.base;
    const url = String((await this.call("auth.test")).url ?? "").replace(/\/$/, "");
    if (url) this.base = url;
    return url;
  }

  /** A person's display name, remembered. A failure returns the id without writing: the next message asks again. */
  async nameOf(uid: string): Promise<string> {
    const hit = this.users.get(uid);
    if (hit) return hit;
    let name: string;
    try {
      const r = await this.call("users.info", { user: uid });
      name = r.user?.profile?.display_name || r.user?.real_name || r.user?.name || uid;
    } catch {
      return uid;
    }
    this.users.set(uid, name);
    this.saveUsers(this.users);
    return name;
  }

  async readable(raw: string, keepLines = false): Promise<string> {
    for (const [, uid] of raw.matchAll(/<@([A-Z0-9]+)/g)) await this.nameOf(uid);
    return humanize(raw, (uid) => this.users.get(uid) ?? uid, keepLines);
  }

  /**
   * Messages visible to the person served, posted since `sinceSec`, oldest first.
   * A busy workspace yields about a thousand per working day: pages are read until `sinceSec`, `complete` says whether
   * it got there. search.messages reads the search index, which lags a few seconds to a minute.
   */
  async fetchSince(sinceSec: number, maxPages: number): Promise<{ matches: SlackMatch[]; complete: boolean }> {
    // after: excludes the given day, step back one day to lose nothing
    const query = `after:${localDay((sinceSec - 86400) * 1000)}`;
    const all: SlackMatch[] = [];
    let complete = false;
    for (let page = 1; page <= maxPages; page++) {
      const r = await this.call("search.messages", { query, count: 100, page, sort: "timestamp", sort_dir: "desc" });
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
  async participatedThreads(cfg: Pick<Config, "me">, days = 7): Promise<Set<string>> {
    const keys = new Set<string>();
    const query = `from:<@${cfg.me}> after:${localDay(Date.now() - (days + 1) * 86400_000)}`;
    for (let page = 1; page <= 3; page++) {
      const r = await this.call("search.messages", { query, count: 100, page, sort: "timestamp", sort_dir: "desc" });
      const matches = (r.messages?.matches ?? []) as SlackMatch[];
      for (const m of matches) keys.add(threadKey(m));
      if (matches.length < 100) break;
    }
    return keys;
  }

  /**
   * A message's channel. `channelType` is the event's `channel_type` (im, mpim, channel, group) when there is one.
   * A conversations.info failure is never cached: otherwise a single failure turns a DM into an unknown channel for
   * the whole life of the process, and its messages stop being surfaced.
   */
  async channelOf(id: string, channelType?: string): Promise<SlackChannel> {
    const hit = this.channelObjects.get(id);
    if (hit) return hit;
    // a DM or group DM is recognised from the event, without a call: its name is useless ("DM")
    if (channelType === "im" || channelType === "mpim") {
      const c = channelGuess(id, channelType);
      this.channelObjects.set(id, c);
      return c;
    }
    try {
      const r = await this.call("conversations.info", { channel: id });
      if (r.channel) {
        const c: SlackChannel = { id, name: r.channel.name, is_im: r.channel.is_im, is_mpim: r.channel.is_mpim };
        this.channelObjects.set(id, c);
        return c;
      }
    } catch {}
    return channelGuess(id, channelType);
  }

  /**
   * True if the person served is in this private conversation, false if not, null when Slack does not tell (network,
   * rate limit): the caller then keeps the message rather than risk losing one.
   * A Slack app installed by several people receives everyone's DMs over Socket Mode: the event's `authorizations`
   * field names only one of them, and Slack says not to rely on it. conversations.info with their token only sees
   * their conversations: channel_not_found on one between two colleagues. A foreign conversation is checked again
   * after an hour: one can be added to a group DM.
   */
  async isMyConversation(id: string): Promise<boolean | null> {
    if (this.myConversations.has(id)) return true;
    const seen = this.notMine.get(id);
    if (seen !== undefined && Date.now() - seen < NOT_MINE_TTL_MS) return false;
    try {
      const r = await this.call("conversations.info", { channel: id });
      if (!r.channel) return null;
      this.myConversations.add(id);
      this.notMine.delete(id);
      return true;
    } catch (e) {
      if (/channel_not_found|not_in_channel/.test((e as Error).message)) {
        this.notMine.set(id, Date.now());
        return false;
      }
      return null;
    }
  }

  /**
   * A socket `message` event -> a SlackMatch, once the channel is resolved. The conversion itself lives in chat/slack-model.ts, tested.
   * A `message_changed` only passes if it adds a mention of the person served (`cfg`), compared with its previous version.
   */
  async matchFromEvent(e: Record<string, any>, base: string, cfg: Pick<Config, "me" | "subteams">): Promise<SlackMatch | null> {
    // the DM of two colleagues who also installed the app is not a DM of the person served
    if (e?.channel && isPrivateConversation(String(e.channel), e.channel_type) && (await this.isMyConversation(String(e.channel))) === false) return null;
    if (e?.subtype === "message_changed" && e.channel) return matchFromEditEvent(e, await this.channelOf(String(e.channel), e.channel_type), base, cfg);
    if (e?.type !== "message" || !e.ts || !e.channel) return null;
    if (e.subtype && !SOCKET_SUBTYPES.has(e.subtype)) return null;
    return matchFromSocketEvent(e, await this.channelOf(String(e.channel), e.channel_type), base);
  }

  /**
   * A thread's messages, root included, page by page (next_cursor) up to `REPLIES_MAX`.
   * `extra` passes parameters to conversations.replies (`oldest` for the catch-up). A single page of 200 would make a
   * long thread lose its most recent replies, the ones that matter.
   */
  async repliesOf(channel: string, ts: string, extra: Record<string, string> = {}): Promise<SlackBody[]> {
    const all: SlackBody[] = [];
    let cursor = "";
    do {
      const r = await this.call("conversations.replies", { channel, ts, limit: 200, ...extra, ...(cursor ? { cursor } : {}) });
      all.push(...(r.messages ?? []));
      cursor = r.response_metadata?.next_cursor ?? "";
    } while (cursor && all.length < REPLIES_MAX);
    return all.slice(0, REPLIES_MAX);
  }

  async channelNameOf(id: string): Promise<string | undefined> {
    const hit = this.channelNames.get(id);
    if (hit) return hit;
    try {
      const r = await this.call("conversations.info", { channel: id });
      if (!r.channel) return undefined;
      const name = channelLabel({ id, ...r.channel });
      this.channelNames.set(id, name);
      return name;
    } catch {
      return undefined;
    }
  }
}

/** The default Slack account's client: the token of today's search order, the names in users.json. */
export const defaultSlack = new SlackClient(
  () => fetch,
  new Map<string, string>(Object.entries(readJson<Record<string, string>>(F.users, {}))),
  (u) => writeJson(F.users, Object.fromEntries(u)),
);

/** The default account's remembered names. */
export const users = defaultSlack.users;

/** A token of the right workspace was already found: calls can go out without `connectSlack`. */
export const hasSlackToken = () => defaultSlack.token !== "";

export const slack = (method: string, params: Record<string, string | number> = {}): Promise<SlackBody> => defaultSlack.call(method, params);

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

/** The seconds `connectSlack` waits between rounds while Slack does not answer, before giving up. */
export const SLACK_CONNECT_DELAYS = [5, 15, 30, 60];

/** Who the person is on the default account, from the auth.test of its token: also the workspace's id and URL. */
export interface SlackIdentity {
  team: string;
  me: string;
  teamUnset?: true;
  teamId?: string;
  url?: string;
}

/**
 * Several tokens can live on the machine (other workspaces): keep the first one that belongs to the right workspace, else null.
 * While `slack.team` is not set (a new installation), the first token Slack accepts is used, as `setup --check` does,
 * and `teamUnset` says so.
 * Only an answer from Slack rules a token out (other workspace, token refused). A network failure or a timeout says
 * nothing about the token: retry, otherwise a few seconds of outage at startup would stop the listener with "no token".
 */
export async function connectSlack(cfg: SlackSettings, delays: number[] = SLACK_CONNECT_DELAYS): Promise<SlackIdentity | null> {
  for (let attempt = 0; ; attempt++) {
    const p = await probeSlack(cfg);
    if (p.found) return p.found;
    if (!p.transient || attempt >= delays.length) return null;
    await Bun.sleep(delays[attempt] * 1000);
  }
}

/**
 * One round of `connectSlack` over the tokens found: the first one of the right workspace, or none, with the code of a
 * failure that may clear on the next round (network, rate limit) in `transient`. The caller decides whether to retry.
 */
export async function probeSlack(cfg: SlackSettings): Promise<{ found: SlackIdentity | null; transient: string | null }> {
  let transient: string | null = null;
  probed = [];
  for (const t of tokenCandidates()) {
    defaultSlack.token = t;
    try {
      const r = await slack("auth.test");
      probed.push({ token: t, team: r.team });
      const url = String(r.url ?? "").replace(/\/$/, "");
      const who: SlackIdentity = { team: r.team, me: r.user_id, ...(r.team_id ? { teamId: String(r.team_id) } : {}), ...(url ? { url } : {}) };
      if (!cfg.team) return { found: { ...who, teamUnset: true }, transient };
      if (r.team === cfg.team) return { found: who, transient };
    } catch (e) {
      probed.push({ token: t, error: e instanceof SlackError ? e.code : "network" });
      if (!(e instanceof SlackError)) transient ??= "network";
      else if (e.code === "ratelimited") transient ??= e.code;
    }
  }
  defaultSlack.token = "";
  return { found: null, transient };
}

export async function initSlack(cfg: SlackSettings): Promise<{ team: string; me: string }> {
  const r = await connectSlack(cfg);
  if (!r) fail(NO_TOKEN(cfg), 78);
  return r;
}

/** A person's display name on the default account, remembered in users.json. */
export const nameOf = (uid: string): Promise<string> => defaultSlack.nameOf(uid);

export const readable = (raw: string, keepLines = false): Promise<string> => defaultSlack.readable(raw, keepLines);

/** The Socket Mode app token (xapp-): the environment first, then the profile's `slack.appTokenFile`. */
export function appToken(): string | null {
  if (process.env.SLACK_APP_TOKEN) return process.env.SLACK_APP_TOKEN;
  const file = settings().slack.appTokenFile;
  return file ? envFileValue(file, "SLACK_APP_TOKEN") : null;
}

/** A message's channel on the default account. */
export const channelOf = (id: string, channelType?: string): Promise<SlackChannel> => defaultSlack.channelOf(id, channelType);

/** The person served is in this private conversation of the default account (null: Slack does not tell). */
export const isMyConversation = (id: string): Promise<boolean | null> => defaultSlack.isMyConversation(id);

/** A socket `message` event of the default account -> a SlackMatch. */
// biome-ignore lint/suspicious/noExplicitAny: untyped Slack event
export const matchFromEvent = (e: Record<string, any>, base: string, cfg: Pick<Config, "me" | "subteams">): Promise<SlackMatch | null> => defaultSlack.matchFromEvent(e, base, cfg);

/** A thread's messages on the default account, root included, up to `REPLIES_MAX`. */
export const repliesOf = (channel: string, ts: string, extra: Record<string, string> = {}): Promise<SlackBody[]> => defaultSlack.repliesOf(channel, ts, extra);

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
  return { key, permalink, channel: await defaultSlack.channelNameOf(channel), messages };
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

// ------------------------------------------------------------------ socket mode

/**
 * How a connection ended: "propre" (clean, Slack asked for a reconnect), "coupee" (cut), "fatal" (do not retry).
 * `refus`: Slack refused to open (or answered something other than JSON).
 */
export interface FinSocket {
  fin: "propre" | "coupee" | "fatal";
  refus?: string;
  /** Retry-After of apps.connections.open, in seconds. */
  retryAfterSec?: number;
}

/** What tests replace: fetch, the WebSocket class, the delays. */
export interface SocketDeps {
  fetch?: typeof fetch;
  WebSocket?: new (url: string) => WebSocket;
  /** Beyond this silence (no frame, ping or pong included), the socket is considered dead. */
  silenceMs?: number;
  /** Watchdog period. */
  checkMs?: number;
  /** Timeout of apps.connections.open. */
  openTimeoutMs?: number;
  /** The socket just opened. */
  onOpen?: () => void;
}

const FATAL_OPEN_ERRORS = new Set(["invalid_auth", "token_revoked", "not_authed"]);

/**
 * One WebSocket connection, from opening to closing. Resolves "propre" on a disconnect requested by Slack.
 * Never hangs: an HTML page in answer to apps.connections.open (Slack outage, captive portal) must not throw outside
 * any try inside a `new Promise(async …)`, or the promise never resolves and the listener stays deaf for good.
 * The watchdog sends a ping at half the silence and closes the socket if nothing, not even a pong, came back: a
 * half-open connection (sleep, network change) is invisible otherwise.
 */
export async function connexionSocket(xapp: string, onEvent: (e: Record<string, any>) => void, socket: { ws: WebSocket | null }, deps: SocketDeps = {}): Promise<FinSocket> {
  let url: string;
  try {
    const r = await (deps.fetch ?? fetch)("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: { Authorization: `Bearer ${xapp}`, "Content-type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(deps.openTimeoutMs ?? 15_000),
    });
    const retryAfterSec = Number(r.headers.get("retry-after")) || undefined;
    let j: { ok?: boolean; url?: string; error?: string };
    try {
      j = (await r.json()) as typeof j;
    } catch {
      return { fin: "coupee", refus: `unreadable answer from Slack (HTTP ${r.status})`, retryAfterSec };
    }
    if (!j.ok || !j.url) {
      // a revoked or invalid token is not fixed by reconnecting
      const fatal = FATAL_OPEN_ERRORS.has(j.error ?? "");
      return { fin: fatal ? "fatal" : "coupee", refus: j.error ?? `unknown error (HTTP ${r.status})`, retryAfterSec };
    }
    url = j.url;
  } catch {
    // network down or timeout: no line per attempt, the board's pill says it
    return { fin: "coupee" };
  }

  const silenceMs = deps.silenceMs ?? 120_000;
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new (deps.WebSocket ?? WebSocket)(url);
    } catch {
      return resolve({ fin: "coupee" });
    }
    socket.ws = ws;
    let reconnectRequested = false;
    let lastFrame = Date.now();
    let ended = false;
    const frame = () => {
      lastFrame = Date.now();
    };
    const end = (fin: FinSocket["fin"]) => {
      if (ended) return;
      ended = true;
      clearInterval(watchdog);
      if (socket.ws === ws) socket.ws = null;
      resolve({ fin });
    };
    const watchdog = setInterval(() => {
      const silence = Date.now() - lastFrame;
      if (silence >= silenceMs) {
        // a half-open socket does not always fire its onclose: do not wait for it
        try {
          ws.terminate();
        } catch {}
        end("coupee");
      } else if (silence >= silenceMs / 2) {
        try {
          ws.ping();
        } catch {}
      }
    }, deps.checkMs ?? 30_000);
    watchdog.unref?.();

    ws.addEventListener("ping", frame);
    ws.addEventListener("pong", frame);
    ws.onopen = () => {
      frame();
      deps.onOpen?.();
    };
    ws.onmessage = (ev: MessageEvent) => {
      frame();
      let m: Record<string, any>;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.type === "disconnect") {
        reconnectRequested = true;
        return;
      }
      // Acknowledge at once: without an ack within 3 s, Slack redelivers three times.
      if (m.envelope_id) ws.send(JSON.stringify({ envelope_id: m.envelope_id }));
      if (m.type !== "events_api") return;
      const e = m.payload?.event;
      if (e) onEvent(e);
    };
    ws.onclose = () => end(reconnectRequested ? "propre" : "coupee");
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  });
}
