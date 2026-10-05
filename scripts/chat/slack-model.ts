import { threadOfKey } from "../core/keys.ts";
import type { SlackSettings } from "../core/settings.ts";
import type { Sujet } from "../core/sujet.ts";
import { authorIgnored, classifyItem, type Kind, NO_RULES } from "../core/triage.ts";
import type { ConversationKind, Item } from "../providers/sdk.ts";

export { isSilent, type Kind } from "../core/triage.ts";

/**
 * The Slack side of Strato: triage of incoming messages, permalinks, readable text, destination of a draft.
 * The `Kind` values (suite, moi, dm, mention, canal, fil, tiers, bot) are French labels written to events.ndjson
 * and compared across the code: they are protocol, not text.
 */

export interface SlackChannel {
  id: string;
  name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
}

export interface SlackMatch {
  ts: string;
  text?: string;
  user?: string;
  /** The name a bot or an incoming webhook posts under, when it has no `user`. */
  username?: string;
  /** The app's bot profile, on a message an app posted: its name when there is neither `user` nor `username`. */
  bot_profile?: { name?: string };
  permalink?: string;
  channel: SlackChannel;
  attachments?: { fallback?: string; title?: string; text?: string; pretext?: string; blocks?: unknown[] }[];
  blocks?: unknown[];
  /** The previous version of an edited message (`message_changed`): triage compares it so as not to relay it twice. */
  previous?: SlackMatch;
}

/** What triage needs: who the person served is, their groups, what is listened to and what is set aside. */
export type Config = Pick<SlackSettings, "me" | "subteams" | "watchChannels" | "ignoreChannels" | "ignoreAuthors"> & Partial<Pick<SlackSettings, "watchOnly">>;

/**
 * Health of the Slack socket, written by `listen` into tick.json and read by the board.
 * Slack stops delivering events to an app that no longer acknowledges them (dead listener, sleeping laptop):
 * the socket still opens, but brings nothing. Only the comparison with search reveals it.
 */
export interface SocketHealth {
  /** Last `events_api` event received by the socket (ms). */
  lastEventAt: number;
  /** Last message caught up by search when the socket should have brought it (ms). */
  missedAt: number;
  /** Number of such messages since startup. */
  missed: number;
  /** Last wake-up detected after sleep (ms). */
  wokeAt: number;
  /** Last catch-up done by search (ms). */
  syncedAt: number;
  /** Last failed catch-up, usually a network outage (ms). Shown by the board's status dot, not in the chat. */
  syncFailedAt?: number;
}

/**
 * The catch-up cursor (Unix seconds, `syncedTo` in tick.json): up to where everything was surely read.
 * Distinct from the heartbeat (`lastTick`), which moves every minute even when Slack is unreachable: if a failed
 * catch-up moved the window anyway, its messages would be lost for good.
 * - failed pass: the cursor does not move, the next one retries the same window;
 * - incomplete pass (too many messages, the oldest unread): not past the oldest message actually read;
 * - complete pass: the time it started.
 */
export function nextSyncCursor(prev: number, startedSec: number, pass: { ok: boolean; complete: boolean; oldestReadSec?: number }): number {
  if (!pass.ok) return prev;
  if (pass.complete) return Math.max(prev, startedSec);
  return Math.max(prev, Math.min(startedSec, pass.oldestReadSec ?? prev));
}

/** Past this delay without events, a missed message means Slack no longer delivers anything. */
export const SOCKET_DEAF_AFTER_MS = 30 * 60_000;

/**
 * The socket is deaf when search caught up a recent message and the socket had delivered nothing for more than
 * 30 min before it. An isolated gap (channel not covered) is not enough: other events keep arriving.
 */
export function socketDeaf(h: Partial<SocketHealth> | undefined, now: number): boolean {
  if (!h?.missedAt) return false;
  if (now - h.missedAt > 2 * SOCKET_DEAF_AFTER_MS) return false;
  return (h.lastEventAt ?? 0) < h.missedAt - SOCKET_DEAF_AFTER_MS;
}

/** Slack link -> channel, message ts, parent thread ts if any. */
export function parsePermalink(url: string): { channel: string; ts: string; threadTs: string | null } | null {
  const m = url.match(/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);
  if (!m) return null;
  const q = url.match(/[?&]thread_ts=(\d+\.\d+)/);
  return { channel: m[1], ts: `${m[2]}.${m[3]}`, threadTs: q ? q[1] : null };
}

/**
 * The inverse of `parsePermalink`. The socket gives no permalink and `threadKey` needs one to attach a message to
 * its topic: it has to be rebuilt exactly. A thread = channel + ts of the root message; a reply carries its root's ts.
 */
export function permalinkFor(base: string, channel: string, ts: string, threadTs?: string | null): string {
  const p = `${base.replace(/\/$/, "")}/archives/${channel}/p${ts.replace(".", "")}`;
  return threadTs && threadTs !== ts ? `${p}?thread_ts=${threadTs}&cid=${channel}` : p;
}

/**
 * The `slack://` deep link of a permalink, to open the message in the Slack app without going through a browser
 * tab that redirects. `channel`, `team` and `id` are documented (docs.slack.dev, deep linking); `message` and
 * `thread_ts` are not: at worst the app opens the channel instead of the message. null if it is not a message
 * permalink.
 */
export function slackAppLink(permalink: string, teamId: string): string | null {
  let u: URL;
  try {
    u = new URL(permalink);
  } catch {
    return null;
  }
  const m = u.pathname.match(/^\/archives\/([A-Z0-9]+)(?:\/p(\d{10})(\d{6}))?\/?$/);
  if (!m || !/^T[A-Z0-9]+$/.test(teamId)) return null;
  const q = new URLSearchParams({ team: teamId, id: m[1] });
  if (m[2]) q.set("message", `${m[2]}.${m[3]}`);
  const thread = u.searchParams.get("thread_ts");
  if (thread && /^\d+\.\d+$/.test(thread)) q.set("thread_ts", thread);
  return `slack://channel?${q.toString()}`;
}

/**
 * The `message` subtypes that carry a real message. The others (joins, deletions) are ignored, as search.messages
 * does; edits (`message_changed`) go through `matchFromEditEvent`, only when they add a mention.
 */
export const SOCKET_SUBTYPES = new Set(["thread_broadcast", "file_share", "bot_message"]);

/**
 * An Events API `message` event -> the SlackMatch shape everything else expects.
 * The channel must already be resolved: `classify` needs is_im and is_mpim, which the event does not carry.
 */
export function matchFromSocketEvent(e: Record<string, any>, channel: SlackChannel, base: string): SlackMatch | null {
  if (e?.type !== "message" || !e.ts || !e.channel) return null;
  if (e.subtype && !SOCKET_SUBTYPES.has(e.subtype)) return null;
  return {
    ts: String(e.ts),
    text: e.text,
    user: e.user,
    username: e.username,
    ...(e.bot_profile?.name ? { bot_profile: { name: String(e.bot_profile.name) } } : {}),
    permalink: permalinkFor(base, String(e.channel), String(e.ts), e.thread_ts),
    channel,
    attachments: e.attachments,
    blocks: e.blocks,
  };
}

/**
 * An edited message (`message_changed`) that now mentions the person served when its previous version did not:
 * returned as a message, its previous version in `previous`. Any other edit (typo fixed, link preview added): null.
 * A mention added afterwards is common ("@Alice can you look?" fixed a minute later), and the socket would never
 * deliver it if `message_changed` were dropped like the other subtypes.
 */
export function matchFromEditEvent(e: Record<string, any>, channel: SlackChannel, base: string, cfg: Pick<Config, "me" | "subteams">): SlackMatch | null {
  if (e?.type !== "message" || e.subtype !== "message_changed" || !e.channel || !e.message?.ts) return null;
  const now = matchFromSocketEvent({ ...e.message, type: "message", channel: e.channel }, channel, base);
  if (!now || !mentionsMe(mentionText(now), cfg)) return null;
  const before = e.previous_message ? matchFromSocketEvent({ ...e.previous_message, type: "message", channel: e.channel }, channel, base) : null;
  if (before && mentionsMe(mentionText(before), cfg)) return null;
  // without a previous version, treat it as silent: triage compares it, an empty message is raised nowhere
  return { ...now, previous: before ?? { ...now, text: "", attachments: undefined, blocks: undefined } };
}

/**
 * What is known of a channel without conversations.info: the event's `channel_type` (im, mpim) when present, else
 * the id (a DM starts with D). Used when Slack does not answer: a DM must not become an unknown channel.
 */
export function channelGuess(id: string, channelType?: string): SlackChannel {
  if (channelType === "im") return { id, is_im: true };
  if (channelType === "mpim") return { id, is_mpim: true };
  if (channelType === "channel" || channelType === "group") return { id };
  return id.startsWith("D") ? { id, is_im: true } : { id };
}

export function threadKey(m: SlackMatch): string {
  const parsed = m.permalink ? parsePermalink(m.permalink) : null;
  return `${m.channel.id}:${parsed?.threadTs ?? m.ts}`;
}

export function keyFromPermalink(url: string): string | null {
  const p = parsePermalink(url);
  return p ? `${p.channel}:${p.threadTs ?? p.ts}` : null;
}

// ------------------------------------------------------------------ triage

/** Ids of the people mentioned (`<@U…>`, with or without a label). */
export function mentionedUsers(text: string): string[] {
  return [...text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)].map((x) => x[1]);
}

/** The person served or one of their groups is mentioned. */
export function mentionsMe(text: string, cfg: Pick<Config, "me" | "subteams">): boolean {
  return mentionedUsers(text).includes(cfg.me) || cfg.subteams.some((s) => text.includes(`<!subteam^${s}`));
}

/** The message explicitly targets someone else: at least one mention, none to the person served nor their groups. */
export function targetsSomeoneElse(text: string, cfg: Pick<Config, "me" | "subteams">): boolean {
  return mentionedUsers(text).length > 0 && !mentionsMe(text, cfg);
}

export function isIgnoredAuthor(author: string, cfg: Pick<Config, "ignoreAuthors">): boolean {
  return authorIgnored(author, cfg.ignoreAuthors);
}

/** A DM, a group DM or a channel, as triage reads a conversation. */
export const conversationKind = (c: SlackChannel): ConversationKind => (c.is_im ? "dm" : c.is_mpim ? "group" : "channel");

/**
 * A Slack message as a provider item. The costly part is left for when triage keeps it (`Provider.complete`): the
 * author's name is their id until then, and the text is the raw mrkdwn. The facts triage reads (mentions, the person's
 * own message, the conversation's kind) are all here, read with `cfg`; an edit carries the facts of its previous version.
 */
export function slackItem(m: SlackMatch, cfg: Pick<Config, "me" | "subteams">): Item {
  const raw = mentionText(m);
  const facts = (x: SlackMatch) => {
    const text = mentionText(x);
    return { mentionsMe: mentionsMe(text, cfg), targetsOther: targetsSomeoneElse(text, cfg) };
  };
  return {
    thread: threadKey(m),
    id: `${m.channel.id}:${m.ts}`,
    event: "message",
    author: { id: m.user ?? "", name: m.user || m.username || m.bot_profile?.name || "bot", isMe: m.user === cfg.me, isBot: !m.user },
    conversation: { id: m.channel.id, label: channelLabel(m.channel), kind: conversationKind(m.channel) },
    text: bestText(m),
    time: Math.round(Number(m.ts) * 1000),
    link: m.permalink ?? "",
    mentionsMe: mentionsMe(raw, cfg),
    targetsOther: targetsSomeoneElse(raw, cfg),
    ...(m.previous ? { edited: { before: facts(m.previous) } } : {}),
  };
}

/**
 * Should this message be raised to the master, and under which label? The Slack form of `classifyItem`
 * (core/triage.ts), kept with its signature. `tracked` = all the keys of known topics; `participated` = threads where
 * the person served wrote recently. `author` = display name, for `ignoreAuthors`: without it, the bot filter is not
 * applied. null = ignored silently.
 */
export function classify(
  m: SlackMatch,
  cfg: Config,
  tracked: Set<string>,
  participated: Set<string> = new Set(),
  author?: string,
): Kind | null {
  const item = slackItem(m, cfg);
  const rules = { ...NO_RULES, watch: cfg.watchChannels, ignore: cfg.ignoreChannels, ignoreAuthors: author === undefined ? [] : cfg.ignoreAuthors, watchOnly: cfg.watchOnly === true };
  return classifyItem({ ...item, author: { ...item.author, name: author ?? "" } }, threadKey(m), rules, tracked, participated);
}

/**
 * All the text a mention can be in: .text, the attachments (pretext, bot sections) and the blocks (rich_text carries
 * mentions as `user` and `usergroup` elements, rendered here in their `<@U…>` form).
 * For triage only: display keeps `bestText`. Reading .text alone misses mentions made in blocks or attachments.
 */
export function mentionText(m: Pick<SlackMatch, "text" | "attachments" | "blocks">): string {
  const parts: string[] = [m.text ?? ""];
  collectText(m.attachments, parts);
  collectText(m.blocks, parts);
  return parts.filter(Boolean).join("\n");
}

const TEXT_KEYS = new Set(["text", "fallback", "pretext", "title", "value"]);

function collectText(node: unknown, parts: string[]): void {
  if (Array.isArray(node)) {
    for (const x of node) collectText(x, parts);
    return;
  }
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  if (o.type === "user" && typeof o.user_id === "string") parts.push(`<@${o.user_id}>`);
  if (o.type === "usergroup" && typeof o.usergroup_id === "string") parts.push(`<!subteam^${o.usergroup_id}>`);
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "string") {
      if (TEXT_KEYS.has(k)) parts.push(v);
    } else collectText(v, parts);
  }
}

/**
 * The text of a message, falling back on the attachments, then on the blocks (bots, alert notifiers), when .text is
 * empty: a Block Kit message without a text would otherwise reach the master and the session as an empty quote.
 */
export function bestText(m: SlackMatch): string {
  if (m.text) return m.text;
  const att = (m.attachments ?? []).map((a) => a.fallback || a.title || a.text || "").filter(Boolean);
  if (att.length) return att.join(" | ");
  const parts: string[] = [];
  collectText(m.blocks, parts);
  return parts.filter(Boolean).join(" | ");
}

/**
 * Slack mentions, channels, groups and links made readable. On a single line by default ("|" between lines), for
 * event lines; `keepLines` keeps the line breaks, for the panel and the dive sheet.
 * The "@groupe:" fallback for an unlabeled group is French, pending i18n (it reaches the panel).
 */
export function humanize(text: string, nameOf: (uid: string) => string, keepLines = false): string {
  const readable = text
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_, uid) => `@${nameOf(uid)}`)
    .replace(/<#([A-Z0-9]+)\|([^>]*)>/g, (_, id, name) => `#${name || id}`)
    .replace(/<#([A-Z0-9]+)>/g, (_, id) => `#${id}`)
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]*)>/g, (_, label) => label)
    .replace(/<!subteam\^([A-Z0-9]+)>/g, (_, id) => `@groupe:${id}`)
    .replace(/<!(here|channel|everyone)>/g, (_, w) => `@${w}`)
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]*)>/g, (_, _url, label) => label)
    .replace(/<((?:https?|mailto):[^>]+)>/g, (_, url) => url)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  if (keepLines)
    return readable
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((l) => l.trimEnd())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  return readable.replace(/\s*\n+\s*/g, " | ").replace(/\s{2,}/g, " ").trim();
}

/** Readable channel label. Stored on topics and in events.ndjson, shown on the board: "DM groupe" (group DM) stays French until i18n. */
export function channelLabel(c: SlackChannel): string {
  if (c.is_im) return "DM";
  if (c.is_mpim) return "DM groupe";
  return `#${c.name ?? c.id}`;
}

/**
 * Past this length, chat.postMessage silently splits the message (around 4,000 characters, whatever the docs say):
 * the board refuses.
 */
export const DRAFT_MAX = 3900;

/**
 * Where a topic's draft goes, so that the board posts it without guessing: a Slack link in `draftTo` first (the exact
 * thread, written by the session), else the topic's main thread, provided `draftTo` does not name another channel.
 * `ts` is the quoted message: the server walks up to the thread root before posting. A DM without a link is not guessed.
 * The error texts are shown on the board: still French, pending i18n. The French words of the "new message" regex
 * are what French policies write: keep them.
 */
export function draftDestination(s: Pick<Sujet, "key" | "draftTo" | "channel">): { channel: string; ts: string | null } | { error: string } {
  const to = (s.draftTo ?? "").trim();
  const link = to.match(/https:\/\/[a-z0-9-]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d{16}[^\s,;)]*/);
  if (link) {
    const p = parsePermalink(link[0]);
    if (p) return { channel: p.channel, ts: p.threadTs ?? p.ts };
  }
  // a channel id written out ("#announcements (C0123ABCD45), new message"): a top-level message in that channel,
  // outside any thread. Only the id counts: a channel name alone cannot be resolved without guessing.
  // The real shape of a Slack id: C, G or D, then 8 to 10 characters with at least one digit ("DASHBOARD" is not one).
  const id = to.match(/\b([CGD](?=[A-Z0-9]*\d)[A-Z0-9]{8,10})\b/)?.[1];
  // the topic's own thread: a thread of the default Slack account, with a real ts
  const thread = threadOfKey(s.key);
  const key = thread && /^\d{10}\.\d{6}$/.test(thread.ts) ? [s.key, thread.channel, thread.ts] : null;
  if (id && (/nouveau message|new message|hors fil|à part|top-level/i.test(to) || id !== key?.[1])) return { channel: id, ts: null };
  if (!key) return { error: "pas de fil Slack pour ce sujet : copie le draft" };
  const named = to.match(/#[a-z0-9._-]+/i)?.[0]?.toLowerCase();
  if (named && s.channel && s.channel.toLowerCase() !== named) return { error: `le draft part vers ${named}, pas dans le fil du sujet : il manque le lien du fil dans draftTo` };
  if (/\bDM\b/i.test(to) && !key[1].startsWith("D")) return { error: "le draft part en DM, sans lien : copie-le" };
  return { channel: key[1], ts: key[2] };
}
