/**
 * The board: Strato's overview in a browser tab (http://127.0.0.1:<ui.port>/board).
 * Everything is computed from what Strato has already seen: sujets.json, events.ndjson, live/ and ~/.claude/sessions.
 * No Slack or tracker call: a topic's freshness is the last event of its threads compared with the date of its card.
 * This module is pure: it receives the data read by strato.ts and renders HTML, which makes it testable without a server.
 * The page has its own shell (Tailwind v4 from a CDN, IBM Plex), separate from the iTerm2 panel, which stays in panel.ts.
 * Every visible word goes through core/i18n.ts: t() on the server, tr() in the page's script.
 */
import { faviconHref, stratoMark } from "./core/brand.ts";
import { isItemEvent, postOnlyAction, truncate, t, clientMessages, locale, type MessageKey, type ActivityStep, type AgentNode, agentCounts, type Due, type MasterRequest, type MrStage, MR_STAGE_ORDER, parseDue, REVUE_STALE_MS, REVUE_WINDOWS, draftText, isSnoozed, type Snooze, parseSteps, permalinkOfKey, providerKeyLabel, providerLabel, repoLabel, isResolved, maxTextOf, planOfTask, planSha, providerOfKey, unknownOf, renderHtml, resolveTarget, type ResolvedTarget, targetLink, threadInfoOfKey, type UnresolvedTarget, type SessionContext, settings, shellQuote, ticketIdOfKey, ticketUrl, type SocketHealth, socketDeaf, type Sujet, sujetKeys, takenBy, freshness, gateSince, checkable, openTasks, tasksOf, taskDraftText, taskReady, sendsUnseenMessage, type Task, type TaskKind } from "./lib.ts";
import { type StaleSignal, staleSignals } from "./core/refresh.ts";
import { escapeHtml, textToHtml } from "./panel.ts";
import { slackEventsPage } from "./providers/slack/model.ts";
import type { LocalVersion, UpdateCheck, UpdateResult } from "./app/update.ts";

/** A line of events.ndjson: a routed Slack message, or a session transition. */
export interface BoardEvent {
  at: string;
  type: string;
  kind?: string;
  key?: string;
  from?: string;
  channel?: string;
  permalink?: string;
  attention?: string;
}

/** What a topic session declared through its hooks, in live/<sessionId>.json. */
export interface LiveState {
  attention: string | null;
  event?: string;
  at: number;
}

/** A Claude Code session started in the workspace without Strato, read from ~/.claude/sessions. */
export interface BoardSession {
  sessionId: string;
  name: string;
  /** idle, busy or waiting, as Claude Code writes it. */
  status: string;
  /** interactive or bg. */
  kind: string;
  cwd: string;
  branch: string | null;
  startedAt: string | null;
  context: SessionContext | null;
  /** Remote Control id, to open the conversation on claude.ai. */
  remote?: string | null;
}

/** "travail": a session at work; "attente": waiting on someone else (a third party, a teammate). */
export type Bloc = "attend" | "revoir" | "travail" | "attente";
/**
 * warn = red; accent = a gate waiting on the person served (neutral badge with a filled dot: amber is reserved for the
 * lamp of the "waiting on you" block and the "On your go" box); clear = green (at work); wait = blue (waiting on someone
 * else); muted = grey.
 */
export type Tone = "warn" | "accent" | "clear" | "wait" | "muted";

/** The last Slack message seen in one of the topic's threads. */
export interface LastMessage {
  kind: string;
  from: string;
  at: string;
  channel?: string;
  permalink?: string;
}

/** A merge request of a topic, with its stage towards production, computed by the server from the forge. */
export interface Delivery {
  repo: string;
  iid: number;
  title: string;
  url: string;
  /** null until the forge has been read. */
  stage: MrStage | null;
  label: string;
  blocker: string | null;
  /** The blocker needs the author (red CI, conflict, rebase, requested changes): shown as a warning. */
  hard?: boolean;
  /** Merge or arrival in production, ISO. */
  at: string | null;
}

/** A due date of the card, placed relative to now. */
export interface DueView extends Due {
  state: "past" | "soon" | "later";
  /** "" for today, "tomorrow", else "30/09". */
  day: string;
}

export interface BoardLine {
  sujet: Sujet;
  bloc: Bloc;
  /** What the line says in one badge: "review the draft", "Ann wrote"… */
  verdict: string;
  tone: Tone;
  lastMessage: LastMessage | null;
  attention: string | null;
  /** Claude Code status of the session (busy, idle, waiting), or null when it is not alive. */
  running: string | null;
  /** The conversation on claude.ai (Remote Control), or null when the session is not connected. */
  remoteUrl: string | null;
  /** Since when Claude Code reports this status, ISO, or null. */
  runningSince: string | null;
  /** The session's last message in its conversation: the truth when the card is late. */
  lastAgent: { text: string; at: string | null } | null;
  /** The last steps of the current turn (tools, agent sentences), read from the transcript. */
  trail: ActivityStep[];
  /** The sub-agents of the current turn and those still working, as a tree. */
  agents: AgentNode[];
  /** The topic's merge requests and their stage towards production. */
  deliveries?: Delivery[];
  /** The card's due dates. */
  dues?: DueView[];
  /** Until when (ms) the draft posted from the board can still be removed from the thread, or null. */
  undoUntil?: number | null;
  /** The task whose draft was just posted (the one Undo reopens). */
  undoTask?: string | null;
  /** Why the card has probably aged (core/refresh.ts), or []: the board says so and offers to revalidate it. */
  stale?: StaleSignal[];
  /** Since when the wait shown by the badge lasts (open gate, third party), ISO: its age shows in the badge. */
  waitingSince?: string | null;
}

export interface BoardInput {
  sujets: Sujet[];
  events: BoardEvent[];
  /** What topic sessions declared, by sessionId. */
  live: Map<string, LiveState>;
  /** Claude Code status of live topic sessions, by sessionId: busy = it is working right now. */
  running: Map<string, string>;
  /** Remote Control id of live sessions, by sessionId. */
  remote?: Map<string, string>;
  /** Since when each live session is in its status, ISO, by sessionId. */
  since?: Map<string, string>;
  /** Last message of each topic session, by sessionId, read from its transcript. */
  lastAgent?: Map<string, { text: string; at: string | null }>;
  /** Steps of the current turn of each topic session, by sessionId. */
  trail?: Map<string, ActivityStep[]>;
  /** Sub-agent tree of each topic session, by sessionId. */
  agents?: Map<string, AgentNode[]>;
  /** Topics snoozed by the person served ("later"), by topic key. */
  snoozed?: Map<string, Snooze>;
  /** Teammates behind the team alias: their answer in a thread takes the topic out of "waiting on you". */
  teammates?: string[];
  sessions: BoardSession[];
  /** Live workspace sessions that cite neither Slack nor the tracker: only counted. */
  otherSessions: number;
  now: Date;
  /** ISO -> readable time, for the verdicts. */
  timeOf: (iso: string) => string;
  /** When the master's Slack listener wrote its last tick (every 5 min), ISO, or null if never. */
  lastTick?: string | null;
  /** Health of the Slack socket, written by `listen` in tick.json. */
  socket?: Partial<SocketHealth>;
  /** Slack app id, for the link to its Event Subscriptions page. */
  slackAppId?: string;
  /** The last review requested from the master on the board (master.json). */
  revue?: MasterRequest | null;
  /** People's names by Slack id (users.json), for the mentions in drafts. */
  users?: Record<string, string>;
  /** Free requests made to the master from the ⌘K bar (master.json). */
  demandes?: MasterRequest[];
  /** The merge requests of each open topic, by topic key. */
  deliveries?: Map<string, Delivery[]>;
  /** The listener's heartbeat in seconds (tick.json), absent for a listener older than the heartbeat. */
  heartbeat?: number;
  /** Drafts posted from the board that can still be undone: topic key -> end of the undo window (ms) and posted task. */
  undo?: Map<string, { until: number; taskId: string | null }>;
}

export interface BoardModel {
  /** The Slack listener: alive when its tick is less than 12 minutes old. */
  listener: { alive: boolean; lastTick: string | null; deaf: boolean; lastEventAt: string | null; appId: string | null };
  /** Snoozed topics, out of the blocks until the given time or until someone else's next message in the thread. */
  paused: { line: BoardLine; until: string; reason?: string }[];
  /** Time of the computation, ms. */
  now: number;
  /** What the top bar's pill reads: the listener's heartbeat and the socket's health, in ms. */
  sync: { tick: number | null; beat: number; lastEventAt: number | null; syncedAt: number | null; syncFailedAt: number | null; deaf: boolean };
  /** Free requests of the last 24 h, newest first, with their answer. */
  demandes: { req: MasterRequest; state: "queued" | "running" | "done" | "stale" }[];
  /** The last review requested from the master, and where it stands. */
  revue: { req: MasterRequest; state: "queued" | "running" | "done" | "stale" } | null;
  attend: BoardLine[];
  revoir: BoardLine[];
  /** Sessions working, preparing, or whose sub-agents are running. */
  travail: BoardLine[];
  /** What waits on someone else (a third party, a teammate who took the topic), longest wait first. */
  attente: BoardLine[];
  closedToday: Sujet[];
  sessions: BoardSession[];
  otherSessions: number;
}

/** Rendering context of the board: readable time and the read time shown at the top. */
export interface BoardContext {
  timeOf: (iso: string) => string;
  readAt?: string;
  /** Reference time of relative ages ("12 min ago"), ms; Date.now() by default. */
  now?: number;
}

const blocTitle = (b: Bloc) => t(`board.bloc.${b}.title` as MessageKey);
const blocHint = (b: Bloc) => t(`board.bloc.${b}.tip` as MessageKey);

/** The signal lamps: amber = waiting on you, red = to review, green = running, blue = waiting on someone. */
export type Lamp = "amber" | "red" | "green" | "blue";
const BLOC_LAMP: Record<Bloc, Lamp> = { attend: "amber", revoir: "red", travail: "green", attente: "blue" };

const blocEmpty = (b: Bloc) => t(`board.bloc.${b}.empty` as MessageKey);

/** The conversation of a session connected through Remote Control. */
export const remoteUrlOf = (id: string) => `https://claude.ai/code/${id}`;

/** Attentions declared by a session that call for the person served, and nothing else (protocol values, see app/claude.ts). */
const BLOCKING_ATTENTION = new Set(["attend une autorisation", "attend une réponse"]);

/** Display of the attention values written by the hooks (protocol values in French, see claude/model.ts). */
const ATTENTION_KEYS: Record<string, MessageKey> = {
  "attend une autorisation": "board.attention.permission",
  "attend une réponse": "board.attention.answer",
  "tour terminé": "board.attention.turnDone",
  "tour terminé en erreur": "board.attention.turnError",
  arrêtée: "board.attention.stopped",
  bloquée: "board.attention.stuck",
};
/** An attention value as the person served reads it; an unknown "attend X" reads "waiting for X", anything else as is. */
export function attentionLabel(a: string): string {
  const key = ATTENTION_KEYS[a];
  if (key) return t(key);
  const waiting = a.match(/^attend (.+)$/);
  return waiting ? t("board.attention.waitingFor", { what: waiting[1] }) : a;
}

const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The last message seen in one of the topic's threads (Slack or another tool), or null if Strato logged none. */
export function lastMessageOf(s: Sujet, events: BoardEvent[]): LastMessage | null {
  const keys = new Set(sujetKeys(s));
  let last: BoardEvent | null = null;
  for (const e of events) {
    if (!isItemEvent(e) || !e.key || !keys.has(e.key) || !e.kind) continue;
    if (!last || e.at > last.at) last = e;
  }
  return last ? { kind: last.kind ?? "", from: last.from ?? "?", at: last.at, channel: last.channel, permalink: last.permalink } : null;
}

/** What the gate asks of the person served, in two words, for the card's badge. */
const GATE_KEYS: Record<string, MessageKey> = { draft: "board.gate.draft", release: "board.gate.release", merge: "board.gate.merge", decision: "board.gate.decision", question: "board.gate.question" };
/** The badge of a task: what it asks of the person served, in two words. */
const TASK_KIND_KEYS: Record<TaskKind, MessageKey> = { draft: "board.gate.draft", action: "board.gate.none", decision: "board.gate.decision", question: "board.gate.question" };
export const taskKindLabel = (kind: TaskKind) => t(TASK_KIND_KEYS[kind]);

export const gateLabel = (gate: string | undefined) => {
  const key = GATE_KEYS[gate ?? ""];
  if (key) return t(key);
  return gate && gate !== "none" ? t("board.gate.other", { gate }) : t("board.gate.none");
};

/**
 * Puts an open topic in a block and gives it its verdict.
 * The rules are ordered by trust: a message newer than the card wins over what the card says, a blocked session wins
 * over its gate, and the gate wins over the status.
 */
export function classify(s: Sujet, events: BoardEvent[], live: LiveState | null, running: string | null, timeOf: (iso: string) => string, remoteId: string | null = null, runningSince: string | null = null, lastAgent: { text: string; at: string | null } | null = null, teammates: string[] = [], trail: ActivityStep[] = [], agents: AgentNode[] = []): BoardLine {
  const lastMessage = lastMessageOf(s, events);
  const attention = live?.attention ?? null;
  const base = { sujet: s, lastMessage, attention, running, remoteUrl: remoteId ? remoteUrlOf(remoteId) : null, runningSince, lastAgent, trail, agents };
  // a working session is about to rewrite its card: what the card says now is not the state yet
  if (running === "busy") return { ...base, bloc: "travail", verdict: t("board.verdict.busy"), tone: "clear" };
  // an idle session whose background agents still work is not stopped: it waits for their reports
  const busyAgents = running !== null ? agentCounts(agents).running : 0;
  if (busyAgents) return { ...base, bloc: "travail", verdict: busyAgents > 1 ? t("board.verdict.agents.other", { n: busyAgents }) : t("board.verdict.agents.one"), tone: "clear" };
  // the team alias means "someone on the team": a teammate who answered carries the topic, nothing to do for the person served
  const taken = takenBy(s, events, teammates);
  if (taken) return { ...base, bloc: "attente", waitingSince: taken.at, verdict: t("board.verdict.taken", { name: taken.from }), tone: "muted" };
  const cardAt = Date.parse(s.updatedAt);
  if (lastMessage && Date.parse(lastMessage.at) > cardAt) {
    // the "to review" block already says "after the card"; the message's age shows in the badge
    if (lastMessage.kind === "moi") return { ...base, bloc: "revoir", verdict: t("board.verdict.youReplied"), tone: "muted", waitingSince: lastMessage.at };
    return { ...base, bloc: "revoir", verdict: t("board.verdict.wrote", { name: lastMessage.from }), tone: "warn", waitingSince: lastMessage.at };
  }
  // a blocking declaration only counts if Claude Code does not say otherwise: `idle` = it waits to be spoken to, nothing more
  if (attention && BLOCKING_ATTENTION.has(attention) && running !== "idle") return { ...base, bloc: "attend", verdict: t("board.verdict.blocked", { attention: attentionLabel(attention) }), tone: "warn" };
  if (running === "waiting") return { ...base, bloc: "attend", verdict: t("board.verdict.waitingInput"), tone: "warn" };
  if (s.status === "gate") {
    // what waits is the list of open tasks: the badge names the only one, or counts them; the age is the oldest's
    const open = openTasks(s);
    const one = open.length === 1 ? open[0] : null;
    const verdict = open.length > 1 ? t("board.tasks.count", { n: open.length }) : one ? (one.origin === "set" && one.kind === "action" ? gateLabel(s.gate) : taskKindLabel(one.kind)) : gateLabel(s.gate);
    return { ...base, bloc: "attend", verdict, tone: "accent", waitingSince: open[0]?.createdAt ?? gateSince(s) };
  }
  if (s.status === "waiting") return { ...base, bloc: "attente", verdict: s.waiting ? t("board.verdict.waitingOn", { who: s.waiting }) : t("board.verdict.waiting"), tone: "wait", waitingSince: s.updatedAt };
  // Here the card says "I am working" (preparing or working). If Claude Code says otherwise, the card is wrong: the
  // session ended its turn without opening a gate, and its last word usually asks the person served for something.
  if (attention === "tour terminé en erreur") return { ...base, bloc: "attend", verdict: t("board.verdict.turnError"), tone: "warn" };
  if (running === "idle" || attention === "tour terminé") return { ...base, bloc: "attend", verdict: t("board.verdict.idleNoGate"), tone: "warn" };
  if (running === null || attention === "arrêtée") return { ...base, bloc: "attend", verdict: t("board.verdict.deadNoGate"), tone: "warn" };
  return { ...base, bloc: "travail", verdict: s.status === "preparing" ? t("board.verdict.preparing") : t("board.verdict.working"), tone: "clear" };
}

/** The gap in calendar days (local time) between two dates: 0 today, -1 yesterday, 1 tomorrow. */
const dayDiff = (at: Date, now: Date) => Math.round((new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);

/** The day of a date relative to today: "", "tomorrow", "yesterday" or "13/10". */
function dayLabel(at: Date, now: Date): string {
  const days = dayDiff(at, now);
  return days === 0 ? "" : days === 1 ? t("board.time.tomorrow") : days === -1 ? t("board.time.yesterday") : `${String(at.getDate()).padStart(2, "0")}/${String(at.getMonth() + 1).padStart(2, "0")}`;
}

/** The due dates of a card, placed: past, within 2 h, or later, with the readable day. */
export function dueViews(raw: string | undefined, now: Date): DueView[] {
  return parseDue(raw).map((d) => {
    const t = Date.parse(d.at);
    const at = new Date(t);
    const day = dayLabel(at, now);
    return { ...d, state: t < now.getTime() ? "past" : t - now.getTime() < 2 * 3600_000 ? "soon" : "later", day };
  });
}

/** Spreads the topics over the blocks, sorts each block by age, sets apart those closed today. */
export function buildBoard(input: BoardInput): BoardModel {
  learnChannels(input.sujets, input.events);
  for (const [id, name] of Object.entries(input.users ?? {})) USER_NAMES.set(id, name);
  const open = input.sujets.filter((s) => s.status !== "closed");
  const lines = open.map((s) => classify(s, input.events, (s.sessionId && input.live.get(s.sessionId)) || null, (s.sessionId && input.running.get(s.sessionId)) || null, input.timeOf, (s.sessionId && input.remote?.get(s.sessionId)) || null, (s.sessionId && input.since?.get(s.sessionId)) || null, (s.sessionId && input.lastAgent?.get(s.sessionId)) || null, input.teammates ?? [], (s.sessionId && input.trail?.get(s.sessionId)) || [], (s.sessionId && input.agents?.get(s.sessionId)) || []));
  // a snooze takes the line out of the blocks; a working session or someone else's message brings it back
  const now = input.now.getTime();
  for (const l of lines) {
    l.deliveries = input.deliveries?.get(l.sujet.key) ?? [];
    l.dues = dueViews(l.sujet.due, input.now);
    const u = input.undo?.get(l.sujet.key);
    l.undoUntil = u?.until ?? null;
    l.undoTask = u?.taskId ?? null;
    l.stale = staleSignals(l.sujet, input.events, now, settings().refresh);
  }
  const paused: { line: BoardLine; until: string; reason?: string }[] = [];
  const active: BoardLine[] = [];
  for (const l of lines) {
    const z = input.snoozed?.get(l.sujet.key);
    if (z && l.running !== "busy" && isSnoozed(z, l.lastMessage, now)) paused.push({ line: l, until: z.until, reason: z.reason });
    else active.push(l);
  }
  paused.sort((a, b) => a.until.localeCompare(b.until));
  // "waiting on you": oldest first, the one that has waited longest
  const attend = active.filter((l) => l.bloc === "attend").sort((a, b) => (a.waitingSince ?? a.sujet.updatedAt).localeCompare(b.waitingSince ?? b.sujet.updatedAt));
  // "at work": most recently active first
  const travail = active.filter((l) => l.bloc === "travail").sort((a, b) => b.sujet.updatedAt.localeCompare(a.sujet.updatedAt));
  // "waiting on someone": longest wait first
  const attente = active.filter((l) => l.bloc === "attente").sort((a, b) => (a.waitingSince ?? a.sujet.updatedAt).localeCompare(b.waitingSince ?? b.sujet.updatedAt));
  // "to review": most recent message first
  const revoir = active.filter((l) => l.bloc === "revoir").sort((a, b) => (b.lastMessage?.at ?? "").localeCompare(a.lastMessage?.at ?? ""));
  const today = localDate(input.now);
  const closedToday = input.sujets
    .filter((s) => s.status === "closed" && localDate(new Date(Date.parse(s.updatedAt))) === today)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const sessions = [...input.sessions].sort((a, b) => Number(b.context?.master ?? false) - Number(a.context?.master ?? false) || (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  const lastTick = input.lastTick ?? null;
  const alive = !!lastTick && input.now.getTime() - Date.parse(lastTick) < 12 * 60_000;
  const listener = {
    alive,
    lastTick,
    deaf: alive && socketDeaf(input.socket, input.now.getTime()),
    lastEventAt: input.socket?.lastEventAt ? new Date(input.socket.lastEventAt).toISOString() : null,
    appId: input.slackAppId ?? null,
  };
  const stateOf = (x: MasterRequest) => {
    const a = input.now.getTime() - Date.parse(x.at);
    return x.doneAt ? ("done" as const) : a > REVUE_STALE_MS ? ("stale" as const) : x.deliveredAt ? ("running" as const) : ("queued" as const);
  };
  const demandes = (input.demandes ?? [])
    .filter((x) => !x.dismissedAt)
    .filter((x) => input.now.getTime() - Date.parse(x.doneAt ?? x.at) < 24 * 3600_000)
    .slice(-3)
    .reverse()
    .map((x) => ({ req: x, state: stateOf(x) }));
  const r = input.revue ?? null;
  const age = r ? input.now.getTime() - Date.parse(r.doneAt ?? r.at) : 0;
  // a report stays shown for a day; a request without a report after 45 min is said to have gone unanswered
  const revue = !r || r.dismissedAt || age > 24 * 3600_000 ? null : { req: r, state: r.doneAt ? ("done" as const) : age > REVUE_STALE_MS ? ("stale" as const) : r.deliveredAt ? ("running" as const) : ("queued" as const) };
  const sock = input.socket;
  const sync = {
    tick: lastTick ? Date.parse(lastTick) : null,
    beat: (input.heartbeat ?? 300) * 1000,
    lastEventAt: sock?.lastEventAt ?? null,
    syncedAt: sock?.syncedAt || null,
    syncFailedAt: sock?.syncFailedAt ?? null,
    deaf: listener.deaf,
  };
  return { attend, revoir, travail, attente, closedToday, sessions, otherSessions: input.otherSessions, listener, paused, revue, demandes, sync, now };
}

// ------------------------------------------------------------------ rendering

const link = (url: string, label: string, cls = "text-link hover:underline underline-offset-2") => `<a href="${escapeHtml(url)}" class="${cls}" data-open>${escapeHtml(label)}</a>`;
/** The command that starts this installation's master: from its working folder, otherwise another master starts. */
export const masterCommand = () => `${settings().workspace ? `cd ${shellQuote(settings().workspace)} && ` : ""}claude -n strato "/strato"`;

/** The short name of the sessions' working folder. */
const workspaceLabel = () => (settings().workspace ? repoLabel(settings().workspace) : t("board.workspace.fallback"));

const ticketLink = (id: string) => {
  const url = ticketUrl(id);
  return url ? link(url, id) : escapeHtml(id);
};

// ---- time: relative for today, the absolute date on hover

const pad2 = (n: number) => String(n).padStart(2, "0");
const hhmm = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const ddmm = (d: Date) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;

/** A short duration, rounded down: "< 1 min", "48 min", "3 h", "5 d". */
export function span(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return t("board.span.underMinute");
  if (m < 60) return t("board.span.minutes", { n: m });
  const h = Math.floor(m / 60);
  return h < 24 ? t("board.span.hours", { n: h }) : t("board.span.days", { n: Math.floor(h / 24) });
}

/**
 * An instant told relative to now, local time: "12 min ago", "3 h ago", "in 40 min" for today; "yesterday 14:02",
 * "tomorrow 10:00" the day before and after; "28/09" further in the past, "02/10 10:00" further in the future (a due
 * date keeps its time).
 */
export function ago(iso: string, now: number): string {
  const at0 = Date.parse(iso);
  if (!Number.isFinite(at0)) return iso;
  const at = new Date(at0);
  const days = dayDiff(at, new Date(now));
  if (days === 0) {
    const m = Math.floor(Math.abs(at0 - now) / 60_000);
    if (m < 1) return t("board.time.justNow");
    const d = m < 60 ? t("board.span.minutes", { n: m }) : t("board.span.hours", { n: Math.floor(m / 60) });
    return at0 <= now ? t("board.time.ago", { d }) : t("board.time.in", { d });
  }
  if (days === -1) return t("board.time.yesterdayAt", { time: hhmm(at) });
  if (days === 1) return t("board.time.tomorrowAt", { time: hhmm(at) });
  return days < 0 ? ddmm(at) : `${ddmm(at)} ${hhmm(at)}`;
}

const nowOf = (ctx: BoardContext) => ctx.now ?? Date.now();

/** An instant shown relative, in tabular figures, with the absolute date on hover. */
const when = (iso: string, ctx: BoardContext) => `<time datetime="${escapeHtml(iso)}" title="${escapeHtml(ctx.timeOf(iso))}" class="tabular-nums">${escapeHtml(ago(iso, nowOf(ctx)))}</time>`;

/** People's names by their tool's id (users.json for Slack), to show the mentions of a draft. */
const USER_NAMES = new Map<string, string>();

/** Readable conversation names ("#requests", "DM") by their tool's id, learnt from the topics and the logged messages. */
const CHANNEL_NAMES = new Map<string, string>();
function learnChannels(sujets: Sujet[], events: BoardEvent[]): void {
  const learn = (key: string | undefined, name: string | undefined) => {
    const id = key ? threadInfoOfKey(key)?.conversation : undefined;
    if (id && name) CHANNEL_NAMES.set(id, name);
  };
  for (const s of sujets) learn(s.key, s.channel);
  for (const e of events) learn(e.key, e.channel);
}

/** The names the board knows, for the mentions of a draft. */
const renderNames = () => ({ people: Object.fromEntries(USER_NAMES), conversations: Object.fromEntries(CHANNEL_NAMES) });

/**
 * A draft as its tool will show it, through the provider's rendering ("<@U012AB3CD>" becomes "@Ann" for Slack).
 * Display only: the posted and copied text keeps the tool's format.
 */
export const draftHtml = (provider: string | null, text: string): string => renderHtml(provider, text, renderNames());

/** A Slack draft as Slack will show it: `draftHtml` for Slack, kept for its callers. */
export const slackToHtml = (text: string): string => draftHtml("slack", text);

/**
 * A thread attached to the topic: the original thread keeps the channel's name; the others show channel and date of
 * the thread, so that three threads of the same DM do not all read "Slack D0123456789".
 */
function keyLink(key: string, s: Sujet): string {
  const ticket = ticketIdOfKey(key);
  if (ticket) return ticketLink(ticket);
  const url = permalinkOfKey(key);
  const thread = threadInfoOfKey(key);
  if (!thread) {
    const label = key === s.key ? s.channel : providerKeyLabel(key);
    return url ? link(url, label) : escapeHtml(label);
  }
  const id = thread.conversation;
  const when = thread.at !== undefined ? new Date(thread.at) : null;
  const date = when && !Number.isNaN(when.getTime()) ? ` ${String(when.getDate()).padStart(2, "0")}/${String(when.getMonth() + 1).padStart(2, "0")} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}` : "";
  const twin =
    when &&
    sujetKeys(s).some((k) => {
      const other = k !== key ? threadInfoOfKey(k) : null;
      return other !== null && other.provider === thread.provider && other.account === thread.account && other.conversation === id && Math.floor((other.at ?? Number.NaN) / 60_000) === Math.floor(when.getTime() / 60_000);
    });
  const label = key === s.key ? s.channel : `${CHANNEL_NAMES.get(id) ?? `${thread.tool} ${id}`}${date}${twin && when ? `:${String(when.getSeconds()).padStart(2, "0")}` : ""}`;
  return url ? link(url, label) : escapeHtml(label);
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * The label column, the same everywhere (Request, Proposal, Delivery, Due, fields of the Details panel): a single
 * vertical alignment on the card.
 */
const FIELD = "grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-x-3 max-sm:grid-cols-1";
const LABEL = "text-[12.5px] font-medium text-muted";

/** A labelled line of the card: the content is already HTML. */
const fieldRow = (label: string, html: string, attrs = "") => `<div class="${FIELD}"${attrs}><dt class="${LABEL}">${label}</dt><dd class="min-w-0">${html}</dd></div>`;

/** A field of the Details panel. Sessions sometimes write a literal `\n` through `set`: rendered as a line break. */
function cardField(label: string, value: string | undefined): string {
  const text = value?.replace(/\\n/g, "\n").trim();
  return fieldRow(escapeHtml(label), `<div class="whitespace-pre-wrap text-[13.5px] leading-relaxed">${text ? textToHtml(text) : `<span class="text-muted">${t("board.field.empty")}</span>`}</div>`);
}

/** Amber is reserved for what waits on the person served (block lamp, "On your go" box): the gate badge is neutral, with its shape. */
const BADGE: Record<Tone, string> = {
  warn: "bg-warn-soft text-warn",
  accent: "bg-soft text-ink",
  clear: "bg-clear-soft text-clear-ink",
  wait: "bg-wait-soft text-wait-ink",
  muted: "bg-soft text-muted",
};

/**
 * One shape per state, on top of the colour, to read the badge without telling colours apart:
 * filled dot = waiting on you, triangle = to review or alert, square = running, ring = waiting on someone else.
 * A working session keeps its pulsing dot instead.
 */
const SHAPE: Record<Tone, string> = { accent: "shape-dot", warn: "shape-tri", clear: "shape-sq", wait: "shape-ring", muted: "" };
const shape = (tone: Tone) => (SHAPE[tone] ? `<span class="shape ${SHAPE[tone]}" aria-hidden="true"></span>` : "");

/** Maximum length of a badge, age suffix included: beyond it the text is cut, and whole on hover. */
export const BADGE_MAX = 32;

/** A badge: the text cut at BADGE_MAX characters (suffix included, never cut), the whole text as title. */
export function badge(text: string, tone: Tone, pulse = false, suffix = ""): string {
  const full = `${text}${suffix}`;
  const shown = `${clip(text, Math.max(8, BADGE_MAX - suffix.length))}${suffix}`;
  const title = shown !== full.replace(/\s+/g, " ").trim() ? ` title="${escapeHtml(full)}"` : "";
  return `<span class="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11.5px] font-medium leading-5 tabular-nums ${BADGE[tone]}"${title}>${pulse ? `<span class="relative inline-flex h-1.5 w-1.5"><span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60 motion-reduce:hidden"></span><span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-current"></span></span>` : shape(tone)}${escapeHtml(shown.slice(0, shown.length - suffix.length))}${suffix ? `<span data-age>${escapeHtml(suffix)}</span>` : ""}</span>`;
}

/** The items of a sub-line, spaced, without separator. */
const meta = (items: string[]) => `<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted">${items.map((x) => `<span>${x}</span>`).join("")}</div>`;

/**
 * The three button levels, and only three. Primary: the card's action (Go, Send), one per card, 32 px.
 * Secondary: the tools (Write to E, Terminal, Revalidate…), 28 px. Tertiary: text (Later, Stop, Close).
 */
const BTN_PRIMARY = "inline-flex h-8 items-center rounded-md bg-accent px-3 text-[12.5px] font-semibold text-[#1b1406] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40";
const BTN = "inline-flex h-7 items-center rounded-md border border-line bg-surface px-2.5 text-[12.5px] font-medium text-ink hover:bg-soft disabled:cursor-not-allowed disabled:opacity-50";
const BTN_TEXT = "inline-flex h-7 items-center whitespace-nowrap rounded-md px-2 text-[12.5px] font-medium text-muted hover:bg-soft hover:text-ink";

/** The keyboard key that triggers the primary button, inside the button. */
const KEY_HINT = `<span class="ml-2 text-[11.5px] font-medium opacity-60" aria-hidden="true">g g</span>`;

/** A text button that unfolds a panel of the line (Details). */
const toggle = (panelId: string, label: string) =>
  `<button type="button" data-toggle="${escapeHtml(panelId)}" class="${BTN_TEXT} aria-expanded:bg-soft aria-expanded:text-ink" aria-expanded="false">${escapeHtml(label)}</button>`;

/**
 * What the session is doing right now, while it works: the current step (pulsing dot) and the earlier ones of the turn.
 * Read from its transcript (tools called, agent sentences): the card is only updated at the end of the turn.
 */
function trailBlock(l: BoardLine, ctx: { timeOf: (iso: string) => string }): string {
  const agentsBusy = agentCounts(l.agents).running > 0;
  if (l.running !== "busy" && !agentsBusy) return "";
  if (!l.trail.length) return agentTreeBlock(l.agents, ctx);
  const hm = (at: string | null) => (at ? escapeHtml(ctx.timeOf(at).slice(6)) : "");
  const items = l.trail.map((st, i) => {
    const last = i === l.trail.length - 1;
    const dot = last
      ? `<span class="relative mt-[7px] inline-flex h-1.5 w-1.5 shrink-0"><span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-clear opacity-60 motion-reduce:hidden"></span><span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-clear"></span></span>`
      : `<span class="mt-[7px] inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-line"></span>`;
    return `<li class="flex items-start gap-2.5 ${last ? "text-ink" : "text-muted"}">${dot}<span class="w-10 shrink-0 text-[11.5px] leading-5 tabular-nums text-muted">${hm(st.at)}</span><span class="min-w-0 leading-5">${escapeHtml(st.text)}</span></li>`;
  });
  return `<ol class="max-w-[78ch] space-y-0.5 text-[12.5px]" aria-label="${escapeHtml(t("board.trail.label"))}">${items.join("")}</ol>${agentTreeBlock(l.agents, ctx)}`;
}

/**
 * The sub-agents as a tree: one node per agent (what it was given, its type and model, its times), its last step
 * while it works, and its own agents below. Nothing when the session started none.
 */
function agentTreeBlock(tree: AgentNode[], ctx: { timeOf: (iso: string) => string }): string {
  if (!tree.length) return "";
  const { total, running } = agentCounts(tree);
  const hm = (at: string | null) => (at ? escapeHtml(ctx.timeOf(at).slice(6)) : "");
  const mark: Record<AgentNode["status"], string> = {
    running: `<span class="relative mt-[6px] inline-flex h-2 w-2 shrink-0"><span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-clear opacity-60 motion-reduce:hidden"></span><span class="relative inline-flex h-2 w-2 rounded-full bg-clear"></span></span>`,
    done: `<span class="mt-[1px] w-2 shrink-0 text-center text-[11.5px] leading-5 text-clear" aria-label="${escapeHtml(t("board.agents.done"))}">✓</span>`,
    error: `<span class="mt-[1px] w-2 shrink-0 text-center text-[11.5px] leading-5 text-warn" aria-label="${escapeHtml(t("board.agents.error"))}">✕</span>`,
    stopped: `<span class="mt-[6px] inline-flex h-2 w-2 shrink-0 rounded-full border border-muted" aria-label="${escapeHtml(t("board.agents.stopped"))}"></span>`,
  };
  const node = (a: AgentNode): string => {
    const tag = [a.kind && a.kind !== "general-purpose" ? a.kind : null, a.model].filter(Boolean).join(" · ");
    const when = a.status === "running" ? t("board.since", { time: hm(a.startedAt) }) : `${hm(a.startedAt)} → ${hm(a.lastAt)}`;
    const step = a.status === "running" && a.step ? `<p class="ml-4 truncate text-muted">${escapeHtml(a.step.text)}</p>` : "";
    const kids = a.children.length ? `<ul>${a.children.map(node).join("")}</ul>` : "";
    return `<li><div class="flex items-start gap-2">${mark[a.status]}<span class="min-w-0 flex-1 leading-5 ${a.status === "running" ? "text-ink" : "text-muted"}">${escapeHtml(a.label)}${tag ? ` <span class="text-[11.5px] text-muted">${escapeHtml(tag)}</span>` : ""}</span><span class="shrink-0 text-[11.5px] leading-5 tabular-nums text-muted">${when}</span></div>${step}${kids}</li>`;
  };
  const head = running ? t("board.agents.running", { n: running, total }) : t(total > 1 ? "board.agents.finished.other" : "board.agents.finished.one", { n: total });
  return `<div class="max-w-[78ch] text-[12.5px]" aria-label="${escapeHtml(t("board.agents.title"))}"><p class="mb-1 text-[11.5px] font-medium text-muted">${t("board.agents.title")} · ${head}</p><ul class="agent-tree">${tree.map(node).join("")}</ul></div>`;
}

const STAGE_TONE: Record<MrStage, Tone> = { draft: "muted", review: "muted", ready: "accent", dev: "wait", prod: "clear", closed: "muted" };
/** A merge request's title without the forge's "Draft:" prefix, already told by the stage badge. */
export const mrTitle = (title: string) => title.replace(/^\s*(?:\[draft\]|\(draft\)|draft\s*:)\s*/i, "");

/** A merge request on one line: number and repo (link), stage, what blocks it, its title. */
function deliveryRow(d: Delivery, ctx: BoardContext): string {
  const tone: Tone = d.blocker && d.hard ? "warn" : d.stage ? STAGE_TONE[d.stage] : "muted";
  const when = d.at && (d.stage === "prod" || d.stage === "dev") ? ` · ${ago(d.at, nowOf(ctx))}` : "";
  const title = mrTitle(d.title);
  return `<li class="flex flex-wrap items-center gap-x-2.5 gap-y-0.5"><a href="${escapeHtml(d.url)}" target="_blank" rel="noopener" class="font-mono text-[12.5px] text-link hover:underline underline-offset-2">${escapeHtml(d.repo)}!${d.iid}</a>${badge(d.label, tone, false, when)}${d.blocker ? `<span class="${tone === "warn" ? "text-warn" : "text-muted"}">${escapeHtml(d.blocker)}</span>` : ""}${title ? `<span class="min-w-0 truncate text-muted" title="${escapeHtml(title)}">${escapeHtml(clip(title, 70))}</span>` : ""}</li>`;
}

const DUE_CLASS: Record<DueView["state"], string> = { past: "text-warn", soon: "text-ink font-medium", later: "text-muted" };

function dueRow(d: DueView, ctx: BoardContext): string {
  return `<li class="flex flex-wrap items-baseline gap-x-2.5 ${DUE_CLASS[d.state]}"><span class="text-[12.5px]">${when(d.at, ctx)}</span><span>${escapeHtml(clip(d.text, 140))}</span>${d.state === "past" ? `<span class="text-[11.5px] font-medium">${t("board.due.past")}</span>` : ""}</li>`;
}

/**
 * The reason before the button: Request and Proposal on one line each, then what blocks (only when no action box
 * already says it), the state of the merge requests read from the forge and the due dates. One label column.
 * A card older than the ask and proposal fields falls back on its summary.
 */
function factsBlock(l: BoardLine, ctx: BoardContext): string {
  const s = l.sujet;
  const mrs = l.deliveries ?? [];
  const dues = l.dues ?? [];
  const text = (t: string, max: number) => `<p class="text-[13.5px] leading-snug text-ink/90" title="${escapeHtml(t.replace(/\\n/g, " "))}">${escapeHtml(clip(t.replace(/\\n/g, " "), max))}</p>`;
  const rows: string[] = [];
  // a topic with open tasks shows each task's request and proposal in its own block, never the card's: the card's
  // ask can belong to an earlier request
  if (!openTasks(s).length) {
    if (s.ask?.trim()) rows.push(fieldRow(t("board.card.ask"), text(s.ask, 140)));
    if (s.proposal?.trim()) rows.push(fieldRow(t("board.card.proposal"), text(s.proposal, 200)));
    if (!rows.length && s.summary?.trim()) rows.push(fieldRow(t("board.card.summary"), text(s.summary, 200)));
  }
  rows.push(blockerLine(l));
  const list = (items: string) => `<ul class="flex min-w-0 flex-col gap-1 text-[12.5px]">${items}</ul>`;
  if (mrs.length) rows.push(fieldRow(t("board.card.delivery"), list(mrs.map((d) => deliveryRow(d, ctx)).join("")), " data-delivery"));
  if (dues.length) rows.push(fieldRow(t("board.card.due"), list(dues.map((d) => dueRow(d, ctx)).join(""))));
  const body = rows.filter(Boolean).join("");
  return body ? `<dl class="flex max-w-[78ch] flex-col gap-1.5" data-facts>${body}</dl>` : "";
}

/**
 * The card may have aged: what the sweep saw, the last relaunch, and a button to have its session revalidate it.
 * Nothing when there is no signal and no recent relaunch, or when the session does not exist.
 */
export function staleLine(l: BoardLine, ctx: BoardContext): string {
  const s = l.sujet;
  if (!s.sessionId || l.running === "busy") return "";
  const signals = l.stale ?? [];
  const r = s.refresh;
  // a relaunch is "recent" as long as the card has not been rewritten since
  const pending = r && Date.parse(r.at) >= Date.parse(s.updatedAt);
  if (!signals.length && !pending) return "";
  const button = `<button type="button" data-revalidate="${escapeHtml(s.key)}" title="${escapeHtml(t("board.card.revalidate.tip"))}" class="${BTN}">${t("board.card.revalidate")}</button>`;
  const what = signals.length ? t("board.stale.line", { signals: escapeHtml(signals.map((x) => x.text).join(t("board.stale.separator"))) }) : "";
  const since = pending ? ` <span class="text-muted">${t("board.stale.requested", { when: when(r.at, ctx) })}</span>` : "";
  return `<p class="flex max-w-[78ch] flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] leading-relaxed text-muted" data-stale>${what ? `<span>${what}</span>` : ""}${since}${pending ? "" : button}</p>`;
}

/**
 * What blocks, on the line of a topic waiting on the person served: `blocker`, else `next` for older cards. Nothing for
 * a "just a go": its action box already says what goes out, one wording is enough.
 */
function blockerLine(l: BoardLine): string {
  const s = l.sujet;
  const text = (s.blocker || s.next || "").trim();
  if (l.bloc !== "attend" || !text || isQuickGo(l)) return "";
  const now = parseSteps(s.steps).find((x) => x.state === "now");
  return fieldRow(t("board.card.blocker"), `<p class="text-[13.5px] leading-snug text-ink" data-blocker>${escapeHtml(clip(text, 200))}${now && !text.toLowerCase().includes(now.text.slice(0, 20).toLowerCase()) ? ` <span class="text-muted">${t("board.card.blockerStep", { step: escapeHtml(clip(now.text, 80)) })}</span>` : ""}</p>`);
}

/** The topic's plan as a list: ✓ done, ◉ in progress (the one that blocks), ○ to do. Nothing if the session left `steps` empty. */
function stepsList(s: Sujet): string {
  const steps = parseSteps(s.steps);
  if (!steps.length) return "";
  const glyph = { done: "✓", now: "◉", todo: "○" } as const;
  const cls = { done: "text-muted line-through decoration-line/60", now: "text-ink font-medium", todo: "text-ink/80" } as const;
  const doneCount = steps.filter((x) => x.state === "done").length;
  return fieldRow(`${t("board.card.plan")} <span class="tabular-nums">${doneCount}/${steps.length}</span>`, `<ol class="flex flex-col gap-1 text-[13.5px] leading-relaxed">${steps.map((x) => `<li class="flex gap-2 ${cls[x.state]}"><span class="w-4 shrink-0 text-center">${glyph[x.state]}</span><span>${escapeHtml(x.text)}</span></li>`).join("")}</ol>`);
}

/**
 * The draft went out (Send button, or removed by listen when the person served posted it by hand): a line says so for
 * 24 h, with the message's link. Without it, the draft's removal went unnoticed.
 * While the server can still remove the message (30 s after Send), the line carries the Undo button and its countdown:
 * rendered here rather than by the script, it survives the redraws that follow the post.
 * In "waiting on you", the line keeps a low profile (grey, no lamp): the card has another action to show. A card at a
 * gate does not wait for "the rest of the thread", it waits on the person served: the end of the sentence goes.
 */
export function postedLine(s: Sujet, ctx: BoardContext, now = Date.now(), undoUntil: number | null = null, bloc: Bloc | null = null, undoTask: string | null = null): string {
  const m = (s.posted ?? "").match(/^(\S+)\s+(https?:\/\/\S+)/);
  const canUndo = !!undoUntil && undoUntil > now;
  // another draft waiting on the card hides the line, except while the post can still be undone
  if (!m || (!canUndo && openTasks(s).some((x) => taskDraftText(x))) || now - Date.parse(m[1]) > 86_400_000) return "";
  const undo = canUndo ? `<button type="button" data-unpost="${escapeHtml(s.key)}"${undoTask ? ` data-task="${escapeHtml(undoTask)}"` : ""} data-undo-until="${undoUntil}" class="font-medium text-warn hover:underline" title="${escapeHtml(t("board.posted.undo.tip"))}">${t("board.posted.undo", { n: Math.ceil(((undoUntil as number) - now) / 1000) })}</button>` : "";
  const quiet = bloc === "attend";
  const tail = s.status === "gate" ? "" : `<span class="text-muted">${t("board.posted.tail")}</span>`;
  const at = `<time datetime="${escapeHtml(m[1])}" title="${escapeHtml(ctx.timeOf(m[1]))}" class="tabular-nums">${escapeHtml(ago(m[1], now))}</time>`;
  return `<p class="flex items-center gap-2 text-[12.5px] ${quiet ? "text-muted" : "text-clear-ink"}" data-posted>${quiet ? "" : `<span class="lamp lamp-green" aria-hidden="true"></span>`}${t("board.posted.at", { at })} · <span><a href="${escapeHtml(m[2])}" target="_blank" rel="noopener" class="underline underline-offset-2">${t("board.posted.view")}</a>${tail}</span>${undo}</p>`;
}

/** The card says a post is due, but there is no draft text: say it on the line, rather than leave the person served searching. */
export function draftMissing(s: Sujet): string {
  // a topic with tasks says it per task (taskBox)
  if (tasksOf(s).length || draftText(s)) return "";
  // Only when the card waits on the person served. Right after Send, the card goes "waiting for the rest of the thread"
  // but keeps the session's "now: post the draft" step for a while: the warning would show wrongly.
  if (s.status !== "gate") return "";
  const hint = `${s.blocker ?? ""} ${parseSteps(s.steps).find((x) => x.state === "now")?.text ?? ""}`.toLowerCase();
  if (s.gate === "draft" || /draft|poster|envo/.test(hint)) return `<p class="mt-1 rounded-lg border border-warn/40 bg-warn-soft/40 px-3.5 py-2 text-[12.5px] text-warn">${t("board.draft.missingCard")}</p>`;
  return "";
}

/**
 * The draft's destination, as a link to the exact place where Send will post: the thread, or the conversation for a
 * separate message, as the provider resolved it. The person served no longer has to ask the session for the thread's
 * exact link before a post. Its words are the provider's (Slack: the channel named in draftTo, else the topic's).
 */
function draftToLink(x: Pick<Task, "draftTo" | "to">, dest: ResolvedTarget | UnresolvedTarget): string {
  const label = `→ ${escapeHtml(clip((isResolved(dest) ? dest.target.label : dest.label) || "?", 44))}`;
  const href = isResolved(dest) ? targetLink(dest) : null;
  const scope = isResolved(dest) ? dest.target.scope : null;
  const title = escapeHtml(href ? t(scope === "conversation" ? "board.draft.dest.channel" : "board.draft.dest.thread", { url: href }) : (x.to || x.draftTo || ""));
  return href
    ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener" data-draft-dest class="min-w-0 truncate text-link hover:underline underline-offset-2" title="${title}">${label}</a>`
    : `<span class="min-w-0 truncate text-muted" title="${title}">${label}</span>`;
}

/** The two closing buttons of a task, with the armed confirmation of the board's script. */
function taskOps(key: string, x: Task): string {
  const k = escapeHtml(key);
  const id = escapeHtml(x.id);
  return `<span class="ml-auto flex shrink-0 items-center gap-0.5"><button type="button" data-task-op="done" data-key="${k}" data-task="${id}" class="${BTN}" title="${escapeHtml(t("board.task.done.tip"))}">${escapeHtml(t("board.task.done"))}</button><button type="button" data-task-op="drop" data-key="${k}" data-task="${id}" class="${BTN_TEXT} -mr-2 hover:bg-warn-soft hover:text-warn" title="${escapeHtml(t("board.task.drop.tip"))}">${escapeHtml(t("board.task.drop"))}</button></span>`;
}

/** Shadow mode (workers.shadow): the primary button of a task, off, saying why. No data-post/data-go: the script never re-enables it. */
const shadowButton = () => `<button type="button" disabled data-shadow class="${BTN_PRIMARY}" title="${escapeHtml(t("board.task.shadow.tip"))}">${escapeHtml(t("board.task.shadow"))}</button>`;

/**
 * The box of a task: its draft (Send posts the text as is in the thread, from the server, on behalf of the person
 * served; Edit makes it editable; Copy), or the action that goes out on go and its Go button, or nothing for a
 * decision or a question. Its primary button is the only filled button of the task; `hint` puts the g g key on it
 * (the first ready task of the card, the one g g sends). The draft folds to four lines in the go queue.
 */
function taskBox(s: Sujet, x: Task, hint: boolean): string {
  const text = taskDraftText(x);
  const key = escapeHtml(s.key);
  const id = escapeHtml(x.id);
  const keyHint = hint ? KEY_HINT : "";
  const ops = taskOps(s.key, x);
  const shadow = settings().workers.shadow;
  if (text) {
    const dest = resolveTarget(s, x);
    const tool = dest.provider;
    const max = tool ? maxTextOf(tool) : null;
    const why = !isResolved(dest) ? dest.error : max !== null && text.length > max ? t("board.draft.tooLong", { tool: providerLabel(dest.provider), n: text.length }) : "";
    const legacy = !x.draft?.trim();
    // the action does more than post (merge then post…): Go to the session, which runs everything in order
    const viaSession = !postOnlyAction(x);
    // the last send may have gone out (no answer, or a board that stopped mid-send): said before any new click, and
    // Send becomes "Send again" (data-retry), which tells the gate the person checked
    const maybe = unknownOf(x, Date.now());
    const postButtons = `<div class="mt-2.5 flex flex-wrap items-center gap-1.5">${shadow ? shadowButton() : `<button type="button" data-post class="${BTN_PRIMARY}"${why ? ` disabled title="${escapeHtml(why)}"` : ` title="${escapeHtml(t("board.draft.send.tip"))}"`}><span data-label>${t(maybe && !why ? "board.js.post.again" : "board.draft.send")}</span>${keyHint}</button>`}<button type="button" data-edit class="${BTN}">${t("board.draft.edit")}</button><button type="button" data-copy class="${BTN}">${t("board.draft.copy")}</button>${ops}</div>`;
    // the hash of the plan shown: Send sends it back, and the gate acts only if the task still hashes to it
    const plan = planOfTask(s, x);
    const sha = "plan" in plan ? ` data-sha="${planSha(plan.plan)}"` : "";
    return `<form class="max-w-[78ch] cursor-auto rounded-lg border border-accent/40 bg-accent-soft/30 px-4 py-3" data-draft data-key="${key}" data-task="${id}" data-draft-to="${escapeHtml(x.draftTo ?? "")}"${sha}${maybe ? " data-retry" : ""} data-postable="${why || viaSession || shadow ? "0" : "1"}">
<div class="flex items-center gap-2 text-[12.5px]"><span class="font-semibold text-accent-ink">${t("board.draft.label")}</span>${draftToLink(x, dest)}<span class="ml-auto shrink-0 text-[11.5px] tabular-nums text-muted">${t("board.draft.chars", { n: text.length })}</span></div>
<div class="mt-1.5 max-h-80 overflow-y-auto whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink" data-draft-text>${draftHtml(tool ?? providerOfKey(s.key), text)}</div>
<textarea name="draft" rows="${Math.min(14, Math.max(4, text.split("\n").length + Math.ceil(text.length / 90)))}" hidden data-draft-edit class="mt-1.5 w-full resize-y rounded-md border border-line bg-bg px-2.5 py-2 text-[13.5px] leading-relaxed focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20">${escapeHtml(text)}</textarea>
${legacy ? `<p class="mt-1 text-[11.5px] text-muted">${t("board.draft.legacy")}</p>` : ""}
${viaSession ? `<div class="mt-2.5 flex flex-wrap items-center gap-2">${shadow ? shadowButton() : `<button type="button" data-go="${key}" data-task="${id}" class="${BTN_PRIMARY}" title="${escapeHtml(t("board.draft.viaSession.tip"))}">${t("board.draft.viaSession")}${keyHint}</button>`}<span class="min-w-0 truncate text-[12.5px] text-muted" data-go-status>${escapeHtml(truncate(x.action ?? "", 140))}</span>${ops}</div>` : postButtons}
<p class="mt-1.5 text-[12.5px] leading-snug ${why || maybe ? "text-warn" : "text-muted"} empty:hidden" data-draft-status>${why ? escapeHtml(why) : maybe ? escapeHtml(t("gate.mayHaveGone", { id: x.id, link: maybe.link ?? s.permalink })) : ""}</p>
</form>`;
  }
  if (x.action?.trim() && sendsUnseenMessage(x)) {
    // posting words the person never saw: no Go, the session is asked for one draft per message
    return `<div class="max-w-[78ch] cursor-auto rounded-lg border border-warn/40 bg-warn-soft/30 px-4 py-3" data-key="${key}" data-task="${id}" data-unseen>
<div class="text-[12.5px] font-semibold text-warn">${t("board.card.onYourGo")}</div>
<p class="mt-1 text-[13.5px] leading-relaxed text-ink">${escapeHtml(x.action.replace(/\\n/g, " "))}</p>
<p class="mt-1.5 text-[12.5px] leading-snug text-warn">${escapeHtml(t("board.task.textsMissing"))}</p>
<div class="mt-2.5 flex items-center gap-2"><button type="button" data-ask-texts="${key}" data-msg="${escapeHtml(t("task.askTexts", { id: x.id }))}" class="${BTN}" title="${escapeHtml(t("board.task.askTexts.tip"))}">${escapeHtml(t("board.task.askTexts"))}</button><span class="min-w-0 truncate text-[12.5px] text-muted" data-go-status></span>${ops}</div>
</div>`;
  }
  if (x.action?.trim()) {
    return `<div class="max-w-[78ch] cursor-auto rounded-lg border border-accent/40 bg-accent-soft/30 px-4 py-3" data-gocard data-key="${key}" data-task="${id}">
<div class="text-[12.5px] font-semibold text-accent-ink">${t("board.card.onYourGo")}</div>
<p class="mt-1 text-[13.5px] leading-relaxed text-ink">${escapeHtml(x.action.replace(/\\n/g, " "))}</p>
<div class="mt-2.5 flex items-center gap-2">${shadow ? shadowButton() : `<button type="button" data-go="${key}" data-task="${id}" class="${BTN_PRIMARY}" title="${escapeHtml(t("board.task.go.tip"))}">${t("board.task.go")}${keyHint}</button>`}<span class="min-w-0 truncate text-[12.5px] text-muted" data-go-status></span>${ops}</div>
</div>`;
  }
  const missing = x.kind === "draft" ? `<p class="mr-auto text-[12.5px] text-warn">${escapeHtml(t("board.task.draftMissing"))}</p>` : "";
  // no box: the buttons sit under the request, aligned with the labels, not floating at the far right
  return `<div class="flex max-w-[78ch] flex-wrap items-center gap-2" data-task-ops>${missing}${missing ? ops : ops.replace("ml-auto ", "")}</div>`;
}

/**
 * One open task: its id and badge (kind and real age, tinted by freshness), its request and proposal, its box, and
 * its Done and Drop buttons. `hint`: this task's primary button is the one g g sends.
 */
export function taskBlock(s: Sujet, x: Task, ctx: BoardContext, hint = false): string {
  const age = nowOf(ctx) - Date.parse(x.createdAt);
  const fresh = freshness(age);
  const text = (v: string, max: number) => `<p class="text-[13.5px] leading-snug text-ink/90" title="${escapeHtml(v.replace(/\\n/g, " "))}">${escapeHtml(clip(v.replace(/\\n/g, " "), max))}</p>`;
  const rows = [fieldRow(t("board.card.ask"), text(x.ask, 160)), ...(x.proposal?.trim() ? [fieldRow(t("board.card.proposal"), text(x.proposal, 220))] : [])].join("");
  const head = `<div class="flex items-center gap-2"><span class="font-mono text-[11.5px] font-medium text-muted" title="${escapeHtml(t("board.task.id.tip", { id: x.id }))}">${escapeHtml(x.id)}</span>${badge(taskKindLabel(x.kind), "accent", false, ` · ${span(age)}`)}</div>`;
  return `<div class="flex flex-col gap-2 border-t border-dashed border-line pt-3 first:border-t-0 first:pt-0" data-task-item data-task="${escapeHtml(x.id)}" data-task-fresh style="--fh:${fresh.h};--fk:${fresh.k}">
${head}
<dl class="flex max-w-[78ch] flex-col gap-1.5">${rows}</dl>
${taskBox(s, x, hint)}
</div>`;
}

/**
 * The action zone of a card: the list of its open tasks, oldest first. g g sends the first ready one. Empty when no
 * task is open: a closed task never shows a Go nor an amber box.
 */
export function actionCard(l: BoardLine, ctx?: BoardContext): string {
  const s = l.sujet;
  const open = openTasks(s);
  if (!open.length) return "";
  const first = open.find(taskReady)?.id;
  const c: BoardContext = ctx ?? { timeOf: (i: string) => i };
  return `<div class="flex flex-col gap-3" data-tasks>${open.map((x) => taskBlock(s, x, c, x.id === first)).join("")}</div>`;
}

/** The tasks closed in the last three days, newest first: what was done or dropped, when, and why. */
function closedTasksField(s: Sujet, ctx: BoardContext): string {
  const now = nowOf(ctx);
  const recent = tasksOf(s)
    .filter((x) => x.status !== "open" && now - Date.parse(x.closedAt ?? x.updatedAt) < 3 * 86_400_000)
    .sort((a, b) => (b.closedAt ?? b.updatedAt).localeCompare(a.closedAt ?? a.updatedAt))
    .slice(0, 8);
  if (!recent.length) return "";
  const item = (x: Task) =>
    `<li class="flex flex-wrap items-baseline gap-x-2 text-[12.5px]" data-closed-task="${escapeHtml(x.id)}"><span class="font-mono text-muted">${escapeHtml(x.id)}</span><span class="font-medium ${x.status === "done" ? "text-clear-ink" : "text-muted"}">${escapeHtml(t(x.status === "done" ? "board.task.status.done" : "board.task.status.dropped"))}</span>${when(x.closedAt ?? x.updatedAt, ctx)}<span class="min-w-0 text-ink/85">${escapeHtml(clip(x.ask, 120))}</span>${x.note ? `<span class="min-w-0 text-muted">${textToHtml(clip(x.note, 200))}</span>` : ""}</li>`;
  return fieldRow(escapeHtml(t("board.card.closedTasks")), `<ul class="flex flex-col gap-1">${recent.map(item).join("")}</ul>`);
}

/**
 * What the server checks before posting a draft from the board: the click validates a precise text, shown with a
 * precise destination, for a precise task. The client sends the task (`taskId`), the text to post (`text`), the raw
 * draft the person served decided on (`draft`) and its destination (`draftTo`); if the task is no longer open, or no
 * longer carries this draft or this destination, nothing goes out. The content is compared rather than `updatedAt`:
 * the card changes for many other reasons (summary, steps, other tasks). Returns the reason for refusing, or null.
 */
export function draftConflict(s: Sujet, sent: { taskId?: unknown; text?: unknown; draft?: unknown; draftTo?: unknown }): string | null {
  if (typeof sent.text !== "string" || typeof sent.draft !== "string" || typeof sent.taskId !== "string") return t("board.api.draftOldPage");
  const x = tasksOf(s).find((y) => y.id === sent.taskId);
  if (!x || x.status !== "open") return t("board.api.taskClosed", { id: sent.taskId });
  if (sent.draft.replace(/\r\n/g, "\n").trim() !== taskDraftText(x)) return t("board.api.draftChanged");
  if ((typeof sent.draftTo === "string" ? sent.draftTo : "").trim() !== (x.draftTo ?? "").trim()) return t("board.api.draftToChanged");
  return null;
}

/**
 * Ready-made answers, under the message: one click sends them to the session. "go" disappears when the card already has
 * its Go or Send button; "it's settled" closes the topic, so it asks for a second click ("Sure?").
 * The "go" text is a protocol value (the server and the go lock recognise it): it is never translated.
 */
const chips = (): { label: string; text: string; confirm?: boolean }[] => [
  { label: "go", text: "go" },
  { label: t("board.chip.later"), text: t("board.chip.later.text") },
  { label: t("board.chip.dig"), text: t("board.chip.dig.text") },
  { label: t("board.chip.settled"), text: t("board.chip.settled.text"), confirm: true },
];

/** The session's state in a few words, read from Claude Code: "idle", "waiting for your go", "at work"… */
function sessionState(l: BoardLine): { text: string; awaitingGo: boolean } {
  const say = (key: MessageKey) => ({ text: t(key), awaitingGo: key === "board.session.state.awaitingGo" });
  if (l.running === "busy") return say("board.session.state.busy");
  if (l.running === "waiting") return say("board.session.state.waiting");
  if (l.running === "idle" || l.attention === "tour terminé") return say(l.sujet.status === "gate" ? "board.session.state.awaitingGo" : "board.session.state.idle");
  if (l.running === null) return l.attention && l.attention !== "arrêtée" ? { text: attentionLabel(l.attention), awaitingGo: false } : say("board.session.state.stopped");
  return l.attention ? { text: attentionLabel(l.attention), awaitingGo: false } : say("board.session.state.unknown");
}

/** The right column of a line: the session, its state, and the message to write to it. */
function sessionPane(l: BoardLine, ctx: BoardContext): string {
  const s = l.sujet;
  if (!s.sessionId) return `<div class="text-[12.5px] text-muted md:pl-5 md:border-l md:border-line">${t("board.session.none")}</div>`;
  const key = escapeHtml(s.key);
  // the state comes from Claude Code, with its duration: what it rests on and since when (exact time on hover).
  // A card waiting for your go already carries its age in the badge: a second duration, counted otherwise, would blur it
  const state = sessionState(l);
  const since = l.runningSince && !state.awaitingGo ? ` · <span class="tabular-nums" title="${escapeHtml(t("board.since", { time: ctx.timeOf(l.runningSince) }))}">${escapeHtml(span(nowOf(ctx) - Date.parse(l.runningSince)))}</span>` : "";
  // in shadow mode the go chip is hidden too: nothing goes out on a go
  const shown = chips().filter((c) => !(c.text === "go" && (actionCard(l) || settings().workers.shadow)));
  const quick = isQuickGo(l);
  return `<div class="flex min-w-0 flex-col gap-2.5 md:pl-5 md:border-l md:border-line" data-pane>
<div class="text-[12.5px] text-muted">${t("board.session.label")} <span class="text-ink/80">${escapeHtml(state.text)}</span>${since}</div>
<div class="flex flex-wrap items-center gap-1.5">
<button type="button" data-term="${key}" data-letter="${escapeHtml(s.letter)}" data-title="${escapeHtml(s.title)}" class="${BTN}"${s.shortId ? ` title="${escapeHtml(t("board.session.terminal.tip", { id: s.shortId }))}"` : ""}>${t("board.session.terminal")}</button>
${settings().ui.iterm ? `<button type="button" data-dive="${key}" class="${BTN}">iTerm2</button>` : ""}
${l.remoteUrl ? `<a href="${escapeHtml(l.remoteUrl)}" data-open class="${BTN}">claude.ai</a>` : ""}
</div>
<div class="-ml-2 -mt-1 flex flex-wrap items-center gap-0.5">
<details class="relative" id="snooze-${key}" data-snooze-menu><summary class="${BTN_TEXT} cursor-pointer list-none" title="${escapeHtml(t("board.snooze.tip"))}">${t("board.snooze")}</summary><div class="absolute left-0 top-full z-10 mt-1 flex flex-col rounded-md border border-line bg-surface p-1 shadow-lg">${["1h", "pm", "eod", "tomorrow"].map((w) => `<button type="button" data-snooze="${w}" data-key="${key}" class="whitespace-nowrap rounded px-2.5 py-1 text-left text-[12.5px] text-ink hover:bg-soft"></button>`).join("")}<form data-snooze-date data-key="${key}" class="mt-1 flex w-60 flex-col gap-1.5 border-t border-line px-1.5 pb-1 pt-2"><span class="text-[11.5px] font-medium text-muted">${t("board.snooze.until")}</span><div class="flex gap-1.5"><input type="date" name="day" required class="min-w-0 flex-1 rounded border border-line bg-bg px-1.5 py-0.5 text-[12.5px] text-ink [color-scheme:dark]"><input type="time" name="hour" value="09:00" required class="w-[76px] rounded border border-line bg-bg px-1.5 py-0.5 text-[12.5px] text-ink [color-scheme:dark]"></div><input type="text" name="reason" maxlength="200" placeholder="${escapeHtml(t("board.snooze.reason"))}" class="rounded border border-line bg-bg px-1.5 py-0.5 text-[12.5px] text-ink placeholder:text-muted"><button type="submit" class="${BTN} self-start">${t("board.snooze.submit")}</button></form></div></details>
<button type="button" data-confirm="stop" data-key="${key}" class="${BTN_TEXT}" title="${escapeHtml(t("board.session.stop.tip"))}">${t("board.session.stop")}</button>
<button type="button" data-confirm="close" data-key="${key}" class="${BTN_TEXT} hover:bg-warn-soft hover:text-warn" title="${escapeHtml(t("board.session.close.tip"))}">${t("board.session.close")}</button>
<span class="ml-auto min-w-0 truncate text-[12.5px] text-muted" data-session-status></span>
</div>
${l.lastAgent?.text && !quick ? `<details class="group min-w-0 text-[12.5px]" id="last-${key}"><summary class="flex min-w-0 cursor-pointer select-none list-none items-baseline gap-1.5 text-muted hover:text-ink"><span class="shrink-0 font-medium text-ink/80">${t("board.session.lastWord")}</span>${l.lastAgent.at ? `<span class="shrink-0">${when(l.lastAgent.at, ctx)}</span>` : ""}<span class="min-w-0 truncate group-open:hidden">${escapeHtml(clip(l.lastAgent.text, 160))}</span></summary><div class="mt-1.5 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md bg-bg px-3 py-2 leading-relaxed text-ink/85">${escapeHtml(l.lastAgent.text)}</div></details>` : ""}
<form class="flex flex-col gap-2" data-send data-key="${key}">
<textarea name="text" rows="2" required placeholder="${escapeHtml(t("board.send.placeholder"))}" title="${escapeHtml(t("board.send.tip"))}" class="w-full resize-y rounded-lg border border-line bg-bg px-3 py-2 text-[13.5px] leading-relaxed placeholder:text-muted focus:border-muted focus:outline-none focus:ring-2 focus:ring-ink/10"></textarea>
<div class="flex flex-wrap gap-1">${shown.map((c) => `<button type="button" data-chip="${escapeHtml(c.text)}"${c.confirm ? ` data-chip-confirm` : ""} class="inline-flex h-6 items-center rounded-full border border-muted/50 px-2 text-[11.5px] text-ink/80 hover:border-ink/60 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40">${escapeHtml(c.label)}</button>`).join("")}</div>
<div class="flex items-center gap-3"><button type="submit" class="${BTN}">${t("board.send.button", { letter: escapeHtml(s.letter) })}<span class="ml-1.5 font-normal text-muted">⌘↩</span></button><span class="min-w-0 truncate text-[12.5px] text-muted" data-status></span></div>
</form>
</div>`;
}

/** A topic line, in two columns: the topic on the left, the session and its message on the right; the details folded below. */
export function lineView(l: BoardLine, ctx: BoardContext): string {
  const s = l.sujet;
  const now = nowOf(ctx);
  const sujetUrl = `/?sujet=${encodeURIComponent(s.key)}`;
  // the original thread is the link of the meta line ("Ann in #releases"), the other threads and tickets follow
  const others = sujetKeys(s).filter((k) => k !== s.key).map((k) => keyLink(k, s));
  const sub: string[] = [t("board.line.askerIn", { asker: escapeHtml(s.asker), where: keyLink(s.key, s) }), ...others, t("board.line.card", { when: when(s.updatedAt, ctx) })];
  if (l.lastMessage) {
    const who = l.lastMessage.kind === "moi" ? t("board.line.you") : l.lastMessage.from;
    const label = `${who} ${ago(l.lastMessage.at, now)}`;
    sub.push(t("board.line.lastMessage", { message: l.lastMessage.permalink ? link(l.lastMessage.permalink, label) : escapeHtml(label) }));
  }
  const age = l.waitingSince ? ` · ${span(now - Date.parse(l.waitingSince))}` : "";
  const sig = `${s.updatedAt}|${l.lastMessage?.at ?? ""}|${l.bloc}`;
  const k = escapeHtml(s.key);
  // what waits on you carries its freshness: a side border and the badge's age, from green (recent) to dark red (3 days and more)
  const fresh = l.bloc === "attend" && l.waitingSince ? freshness(now - Date.parse(l.waitingSince)) : null;
  const freshAttr = fresh ? ` data-fresh style="--fh:${fresh.h};--fk:${fresh.k}"` : "";
  return `<li${freshAttr} class="cursor-pointer scroll-mt-20 px-5 py-4 border-b border-line last:border-b-0 hover:bg-soft/40 data-[cursor]:bg-soft/60 data-[cursor]:shadow-[inset_3px_0_0_var(--color-ink)]" data-row="card-${k}" data-key="${k}" data-letter="${escapeHtml(s.letter)}" data-sig="${escapeHtml(sig)}">
<div class="grid gap-x-6 gap-y-4 md:grid-cols-[minmax(0,1fr)_330px]">
<div class="flex min-w-0 items-start gap-4">
<span class="mt-px inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-md bg-soft px-1.5 text-[13.5px] font-semibold text-ink">${escapeHtml(s.letter)}</span>
<div class="flex min-w-0 flex-1 flex-col gap-2.5">
<div class="flex flex-col gap-1">
<div class="flex items-start gap-3"><a href="${sujetUrl}" class="min-w-0 text-[15px] font-semibold leading-snug text-ink hover:underline underline-offset-2">${escapeHtml(s.title)}</a><span data-new hidden class="mt-0.5 shrink-0 rounded-full bg-soft px-2 py-0.5 text-[11.5px] font-medium leading-4 text-ink">${t("board.line.new")}</span><span class="ml-auto">${badge(l.verdict, l.tone, l.running === "busy" || agentCounts(l.agents).running > 0, age)}</span></div>
${meta(sub)}
</div>
${trailBlock(l, ctx)}
${factsBlock(l, ctx)}
${staleLine(l, ctx)}
${postedLine(s, ctx, Date.now(), l.undoUntil ?? null, l.bloc, l.undoTask ?? null)}
${draftMissing(s)}
${actionCard(l, ctx)}
<div class="-ml-2 flex flex-wrap items-center gap-x-1 gap-y-1.5">${toggle(`card-${s.key}`, t("board.card.details"))}<a href="${sujetUrl}" class="inline-flex h-7 items-center rounded-md px-2 text-[12.5px] font-medium text-link hover:bg-soft hover:underline underline-offset-2">${t("board.card.report")}</a></div>
</div>
</div>
${sessionPane(l, ctx)}
</div>
<div id="card-${k}" data-panel hidden class="ml-11 mt-3 cursor-auto">
<dl class="-ml-4 flex flex-col gap-3 rounded-lg bg-bg px-4 py-3.5">
${cardField(t("board.card.summary"), s.summary)}
${tasksOf(s).length ? "" : cardField(t("board.card.ask"), s.ask || s.title)}
${cardField(t("board.card.why", { owner: settings().owner.name }), s.why)}
${tasksOf(s).length ? "" : cardField(t("board.card.proposal"), s.proposal || s.next)}
${stepsList(s)}
${cardField(t("board.card.blocker"), s.blocker || s.next)}
${cardField(t("board.card.unverified"), s.unverified)}
${closedTasksField(s, ctx)}
</dl>
</div>
</li>`;
}

/** A gate whose action is ready (draft or written action): one click is enough, no thinking. */
export function isQuickGo(l: BoardLine): boolean {
  const open = openTasks(l.sujet);
  return l.bloc === "attend" && l.sujet.status === "gate" && l.tone === "accent" && open.length > 0 && open.every((x) => (x.kind === "draft" || x.kind === "action") && taskReady(x));
}

/** A block's count, discreet: a number in a pill, not a big counter. */
const count = (n: number) => `<span class="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-soft px-1.5 text-[11.5px] font-medium tabular-nums text-muted">${n}</span>`;

function blocView(bloc: Bloc, lines: BoardLine[], ctx: BoardContext): string {
  // the go queue: only the card under the cursor, or the first one, shows its whole draft (CSS .go-queue)
  const list = (ls: BoardLine[], queue = false) => `<ul class="overflow-hidden rounded-lg border border-line bg-surface${queue ? " go-queue" : ""}">${ls.map((l) => lineView(l, ctx)).join("\n")}</ul>`;
  const quick = bloc === "attend" ? lines.filter(isQuickGo) : [];
  const rest = lines.filter((l) => !quick.includes(l));
  const sub = (label: string, hint: string, ls: BoardLine[], queue = false) => `<p class="mt-1 flex items-center gap-2 text-[12.5px]" title="${escapeHtml(hint)}"><span class="font-semibold text-ink">${label}</span>${count(ls.length)}</p>${list(ls, queue)}`;
  const body = !lines.length
    ? `<p class="rounded-lg border border-dashed border-line px-4 py-3 text-[13.5px] text-muted">${blocEmpty(bloc)}</p>`
    : quick.length
      ? `${sub(t("board.bloc.quick.title"), t("board.bloc.quick.tip"), quick, quick.length > 1)}${rest.length ? sub(t("board.bloc.decision.title"), t("board.bloc.decision.tip"), rest) : ""}`
      : list(lines);
  return `<section class="flex flex-col gap-2.5" id="bloc-${bloc}">
<h2 class="flex items-center gap-x-3"><span class="lamp lamp-${BLOC_LAMP[bloc]}${lines.length ? " lit" : ""}" aria-hidden="true"></span><span class="text-[17px] font-semibold tracking-tight text-ink" title="${escapeHtml(blocHint(bloc))}">${blocTitle(bloc)}</span>${count(lines.length)}</h2>
${body}
</section>`;
}

/** A Claude Code session outside Strato: name, state, repo, first request, cited threads and tickets. */
export function sessionLine(x: BoardSession, ctx: BoardContext): string {
  const c = x.context;
  const title = c?.title || (c?.firstRequest ? clip(c.firstRequest.text, 90) : x.name);
  const repo = repoLabel(x.cwd) ?? x.cwd;
  const sub: string[] = [escapeHtml(x.name), escapeHtml(x.branch ? t("board.session.onBranch", { repo, branch: x.branch }) : repo)];
  if (x.startedAt) sub.push(t("board.since", { time: when(x.startedAt, ctx) }));
  if (c?.lastAgent?.at) sub.push(t("board.session.lastTurn", { when: when(c.lastAgent.at, ctx) }));
  const cites: string[] = [];
  for (const th of c?.slackThreads ?? []) {
    const info = threadInfoOfKey(th.key);
    cites.push(link(th.url, info ? `${info.tool} ${info.conversation}` : providerKeyLabel(th.key)));
  }
  for (const id of c?.linearIssues ?? []) cites.push(ticketLink(id));
  if (x.remote) cites.push(link(remoteUrlOf(x.remote), "claude.ai"));
  const state = c?.master ? badge("master", "accent") : badge(t(x.status === "busy" ? "board.session.status.busy" : x.status === "waiting" ? "board.session.status.waiting" : "board.session.status.idle"), x.status === "busy" ? "clear" : x.status === "waiting" ? "warn" : "muted", x.status === "busy");
  return `<li class="bg-surface px-4 py-3 border-b border-line last:border-b-0 first:rounded-t-lg last:rounded-b-lg" data-key="session:${escapeHtml(x.sessionId)}">
<div class="flex items-start gap-3.5">
<span class="mt-0.5 inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-md bg-soft px-1.5 text-[11.5px] font-semibold text-muted">${escapeHtml(x.kind === "bg" ? "bg" : "cli")}</span>
<div class="flex min-w-0 flex-1 flex-col gap-1">
<div class="flex flex-wrap items-center gap-x-3 gap-y-1"><span class="text-[15px] font-semibold leading-snug text-ink">${escapeHtml(title)}</span>${state}</div>
${meta(sub)}
${cites.length ? `<div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">${cites.join("")}</div>` : ""}
</div>
</div>
</li>`;
}

/** A snoozed topic: until when, and a button to bring it back right away. */
function pausedRow(l: BoardLine, until: string, ctx: BoardContext, reason?: string): string {
  const s = l.sujet;
  return `<li class="flex items-center gap-3 px-4 py-2.5 border-b border-line last:border-b-0">
<span class="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md bg-soft px-1.5 text-[12.5px] font-semibold text-muted">${escapeHtml(s.letter)}</span>
<a href="/?sujet=${encodeURIComponent(s.key)}" class="min-w-0 truncate text-[13.5px] font-medium text-ink hover:underline underline-offset-2">${escapeHtml(s.title)}</a>
<span class="min-w-0 truncate text-[12.5px] text-muted">${reason ? `${escapeHtml(reason)} · ` : `${escapeHtml(l.verdict)} · `}${t("board.paused.back", { when: when(until, ctx) })}</span>
<button type="button" data-unsnooze="${escapeHtml(s.key)}" class="${BTN} ml-auto shrink-0">${t("board.paused.bringBack")}</button>
</li>`;
}

/**
 * ✅ on the original message of a settled topic's thread: the thread shows everyone it is over. The reaction goes out
 * on behalf of the person served, so only on their click; once posted, its time replaces the button.
 */
function checkControl(s: Sujet, ctx: BoardContext): string {
  if (s.checked) return `<span class="ml-auto shrink-0 text-[12.5px] text-muted" title="${escapeHtml(t("board.check.done.tip"))}">✅ ${escapeHtml(ago(s.checked, nowOf(ctx)))}</span>`;
  if (!checkable(s)) return "";
  return `<button type="button" data-check="${escapeHtml(s.key)}" title="${escapeHtml(t("board.check.tip"))}" class="ml-auto shrink-0 ${BTN}">${t("board.check")}</button>`;
}

function closedRow(s: Sujet, ctx: BoardContext): string {
  const url = permalinkOfKey(s.key) ?? s.permalink;
  return `<li class="flex items-center gap-3 px-4 py-2.5 border-b border-line last:border-b-0">
<span class="mt-0.5 inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md bg-soft px-1.5 text-[12.5px] font-semibold text-muted">${escapeHtml(s.letter)}</span>
<div class="flex min-w-0 flex-col gap-0.5">
<div class="flex flex-wrap items-baseline gap-x-3 text-[13.5px]"><a href="/?sujet=${encodeURIComponent(s.key)}" class="font-medium text-ink hover:underline underline-offset-2">${escapeHtml(s.title)}</a><span class="text-[12.5px] text-muted">${when(s.updatedAt, ctx)}</span>${url ? `<span class="text-[12.5px]">${link(url, s.channel)}</span>` : ""}</div>
${s.summary ? `<p class="max-w-[78ch] text-[12.5px] text-muted">${escapeHtml(clip(s.summary, 200))}</p>` : ""}
</div>
${checkControl(s, ctx)}
</li>`;
}

/** All the open topics shown in the blocks. */
const openLines = (m: BoardModel) => [...m.attend, ...m.revoir, ...m.travail, ...m.attente];

/** "Revalidate cards": each open session rereads its thread and revalidates its card, without sending anything. */
function refreshControl(m: BoardModel): string {
  const n = openLines(m).filter((l) => l.sujet.sessionId && l.running !== "busy").length;
  if (!n) return "";
  const late = openLines(m).filter((l) => l.stale?.length).length;
  const vars = { n, parallel: settings().refresh.maxParallel, late };
  const title = t(!late ? "board.header.revalidateAll.tip" : late > 1 ? "board.header.revalidateAll.tipLate.other" : "board.header.revalidateAll.tipLate.one", vars);
  return `<button type="button" data-revalidate-all title="${escapeHtml(title)}" class="${BTN}">${t("board.header.revalidateAll")}${late ? ` <span class="text-muted">· ${escapeHtml(t("board.header.revalidateAll.late", vars))}</span>` : ""}</button>`;
}

/** The review menu entry for a window of REVUE_WINDOWS: its own key when the dictionary has one. */
const REVUE_WINDOW_KEYS: Record<string, MessageKey> = { "24h": "board.header.revue.window.24h", "3d": "board.header.revue.window.3d", "14d": "board.header.revue.window.14d" };
const revueWindowLabel = (k: string, label: string) => (REVUE_WINDOW_KEYS[k] ? t(REVUE_WINDOW_KEYS[k]) : label);

/**
 * "Recheck everything": asks the master to go over everything the person served received over a window (Slack, closed
 * topics, tickets, merge requests), to restart what was missed. Greyed out without a listener (nobody to receive it)
 * or during a review.
 */
function revueControl(m: BoardModel): string {
  const busy = m.revue && (m.revue.state === "queued" || m.revue.state === "running");
  const why = !m.listener.alive ? t("board.header.revue.noListener") : busy ? t("board.header.revue.busy") : "";
  const title = t("board.header.revue.tip");
  if (why) return `<button type="button" disabled title="${escapeHtml(why)}" class="${BTN} cursor-not-allowed opacity-50">${t("board.header.revue")}</button>`;
  return `<details class="relative" id="revue-menu" data-revue-menu><summary title="${escapeHtml(title)}" class="${BTN} cursor-pointer list-none select-none">${t("board.header.revue")}</summary><div class="absolute right-0 top-full z-10 mt-1 flex flex-col rounded-md border border-line bg-surface p-1 shadow-lg">${Object.entries(REVUE_WINDOWS)
    .map(([k, label]) => `<button type="button" data-revue="${escapeHtml(k)}" class="whitespace-nowrap rounded px-2.5 py-1 text-left text-[12.5px] text-ink hover:bg-soft">${escapeHtml(revueWindowLabel(k, label))}</button>`)
    .join("")}</div></details>`;
}

/** What the top bar shows of the installation's version: served by `GET /board/version`, refreshed by the page. */
export interface VersionState {
  local: LocalVersion;
  /** The last `checkUpdates()`, null before the first one ends (or with checks off). */
  check: UpdateCheck | null;
  /** An update is being applied: pull, install, checks. */
  running: boolean;
  /** The last update that failed, until the next attempt. */
  failure: Extract<UpdateResult, { ok: false }> | null;
}

const versionLabel = (version: string | null, sha: string) => (version ? `v${version}` : sha || "?");

function updateFailure(f: Extract<UpdateResult, { ok: false }>): string {
  const from = f.from.slice(0, 7);
  const text =
    f.reason === "dirty"
      ? t("board.update.failed.dirty", { files: (f.files ?? []).join(", ") })
      : f.reason === "checkFailed"
        ? t("board.update.failed.checkFailed", { from })
        : f.reason === "installFailed"
          ? t("board.update.failed.installFailed", { from })
          : f.reason === "pullFailed"
            ? t("board.update.failed.pullFailed")
            : f.reason === "noUpstream"
              ? t("board.update.failed.noUpstream")
              : t(`board.update.failed.${f.reason}`, { from });
  const output = f.output
    ? `<details><summary class="cursor-pointer select-none text-muted">${escapeHtml(t("board.update.failed.output"))}</summary><pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11.5px] text-ink">${escapeHtml(f.output)}</pre></details>`
    : "";
  return `<div class="flex flex-col gap-1.5 rounded-md border border-warn/40 bg-warn-soft/40 px-3 py-2 text-[12.5px] text-warn" data-update-failure="${escapeHtml(f.reason)}"><p>${escapeHtml(text)}</p>${output}</div>`;
}

/**
 * The version pill of the top bar (sha in its tooltip) and, when the upstream has new commits, the "Update · N changes"
 * button that opens what changed since the installed version: features, then fixes, the rest folded into a count.
 * A development clone without upstream shows only the pill.
 */
export function versionControl(v: VersionState): string {
  const { local, check } = v;
  const tipLines = [t(local.dirty.length ? "board.update.version.tipModified" : "board.update.version.tip", { version: versionLabel(local.version, "?"), sha: local.sha || "?", branch: local.branch || "?" })];
  if (check?.reason === "fetchFailed") tipLines.push(t("board.update.check.fetchFailed", { error: check.error ?? "" }));
  if (check?.reason === "diverged") tipLines.push(t("board.update.check.diverged", { upstream: check.upstream ?? "" }));
  if (check?.reason === "noAsset") tipLines.push(t("board.update.check.noAsset", { error: check.error ?? "" }));
  const pill = `<span data-version class="rounded-full border border-line px-2 py-px font-mono text-[11.5px] text-muted" title="${escapeHtml(tipLines.join("\n"))}">${escapeHtml(versionLabel(local.version, local.sha))}</span>`;
  if (v.running)
    return `${pill}<button type="button" disabled aria-busy="true" data-update-running title="${escapeHtml(t("board.update.running.tip"))}" class="${BTN}"><span class="mr-1.5 inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true"></span>${escapeHtml(t("board.update.running"))}</button>`;
  if (!check?.available) return pill;
  const n = check.commits.length;
  const from = versionLabel(local.version, local.sha);
  const to = check.newer && check.target ? `v${check.target}` : (check.commits[0]?.sha ?? "?");
  const list = (title: string, items: { sha: string; text: string }[]) =>
    items.length
      ? `<section class="flex flex-col gap-1"><h3 class="text-[11.5px] font-semibold uppercase tracking-wide text-muted">${escapeHtml(title)}</h3><ul class="flex flex-col gap-1">${items
          .map((c) => `<li class="flex gap-2 text-[13px] leading-snug text-ink" title="${escapeHtml(c.sha)}"><span class="text-muted" aria-hidden="true">·</span><span class="min-w-0">${escapeHtml(c.text)}</span></li>`)
          .join("")}</ul></section>`
      : "";
  const others = check.changes.other.length;
  return `${pill}<details class="relative" id="update-menu" data-update-menu><summary title="${escapeHtml(t("board.update.button.tip", { version: from }))}" class="${BTN} cursor-pointer list-none select-none">${escapeHtml(t(n === 1 ? "board.update.button.one" : "board.update.button.other", { n }))}</summary>
<div class="absolute left-0 top-full z-30 mt-2 flex w-[min(440px,88vw)] flex-col gap-3 rounded-lg border border-line bg-surface p-3.5 shadow-lg" data-update-panel>
<p class="text-[13.5px] font-semibold text-ink">${escapeHtml(t("board.update.title", { from, to }))}</p>
${v.failure ? updateFailure(v.failure) : ""}
<div class="flex max-h-[50vh] flex-col gap-3 overflow-y-auto">${list(t("board.update.features"), check.changes.features)}${list(t("board.update.fixes"), check.changes.fixes)}${others ? `<p class="text-[12.5px] text-muted">${escapeHtml(t(others === 1 ? "board.update.other.one" : "board.update.other.other", { n: others }))}</p>` : ""}</div>
<div class="flex justify-end"><button type="button" data-update-apply title="${escapeHtml(t("board.update.apply.tip"))}" class="${BTN}">${escapeHtml(t("board.update.apply"))}</button></div>
</div></details>`;
}

/**
 * What answers "is it in prod?" and "what is planned?" without opening a card: the merge requests of open topics not
 * yet in production (or that got there today), and the due dates past or less than 36 h away.
 * Folded into a one-line summary under "waiting on you"; the detail unfolds.
 */
function radar(m: BoardModel, ctx: BoardContext): string {
  const lines = [...openLines(m), ...m.paused.map((p) => p.line)];
  const today = new Date(m.now).toDateString();
  // the letter sits in the line's left margin: a wrapped merge request title stays aligned on the repo
  const chip = (l: BoardLine, top: string) => `<button type="button" data-jump="${escapeHtml(l.sujet.key)}" title="${escapeHtml(l.sujet.title)}" class="absolute left-0 ${top} inline-flex h-5 min-w-5 items-center justify-center rounded bg-soft px-1 text-[11.5px] font-semibold text-ink hover:bg-line">${escapeHtml(l.sujet.letter)}</button>`;
  const mrs = lines
    .flatMap((l) => (l.deliveries ?? []).filter((d) => d.stage !== "closed" && (d.stage !== "prod" || (d.at && new Date(d.at).toDateString() === today))).map((d) => ({ l, d })))
    .sort((a, b) => MR_STAGE_ORDER.indexOf(a.d.stage ?? "draft") - MR_STAGE_ORDER.indexOf(b.d.stage ?? "draft"));
  const horizon = m.now + 36 * 3600_000;
  const back: { l: BoardLine; d: DueView }[] = m.paused
    .filter((p) => Date.parse(p.until) < horizon)
    .map((p) => ({ l: p.line, d: { at: new Date(Date.parse(p.until)).toISOString(), text: p.reason ? t("board.radar.backFromPause.reason", { reason: p.reason }) : t("board.radar.backFromPause"), state: "later" as const, day: dayLabel(new Date(Date.parse(p.until)), new Date(m.now)) } }));
  const dues = [...lines.flatMap((l) => (l.dues ?? []).filter((d) => Date.parse(d.at) < horizon).map((d) => ({ l, d }))), ...back].sort((a, b) => a.d.at.localeCompare(b.d.at));
  if (!mrs.length && !dues.length) return "";
  const rctx = { ...ctx, now: ctx.now ?? m.now };
  const col = (title: string, items: string[]) => `<div class="flex min-w-0 flex-col gap-1.5"><span class="text-[12.5px] font-medium text-muted">${title}</span><ul class="flex flex-col gap-1 text-[12.5px]">${items.join("")}</ul></div>`;
  // a merge request line has its badge's height (24 px), a due date its text's (19 px)
  const withChip = (row: string, l: BoardLine, top: string) => row.replace(/^<li class="([^"]*)">/, `<li class="relative pl-7 $1">${chip(l, top)}`);
  const mrItems = mrs.map(({ l, d }) => withChip(deliveryRow(d, rctx), l, "top-0.5"));
  const dueItems = dues.map(({ l, d }) => withChip(dueRow(d, rctx), l, "-top-px"));
  const past = dues.filter((x) => x.d.state === "past").length;
  const parts: string[] = [];
  if (mrs.length) parts.push(escapeHtml(t(mrs.length > 1 ? "board.radar.mrs.other" : "board.radar.mrs.one", { n: mrs.length })));
  if (dues.length) parts.push(`${escapeHtml(t(dues.length > 1 ? "board.radar.dues.other" : "board.radar.dues.one", { n: dues.length }))}${past ? `, <span class="text-warn">${escapeHtml(t(past > 1 ? "board.radar.past.other" : "board.radar.past.one", { n: past }))}</span>` : ""}`);
  return `<details class="group" id="radar" data-radar><summary class="inline-flex cursor-pointer select-none list-none items-center gap-1.5 text-[13.5px] font-medium text-muted hover:text-ink"><span class="inline-block transition-transform group-open:rotate-90">▸</span><span class="tabular-nums">${parts.join(" · ")}</span></summary>
<div class="mt-2.5 grid gap-x-10 gap-y-4 rounded-lg border border-line bg-surface/60 px-4 py-3 md:grid-cols-2">${mrs.length ? col(t("board.radar.toProd"), mrItems) : ""}${dues.length ? col(t("board.radar.dues"), dueItems) : ""}</div>
</details>`;
}

/** The data of the top bar's pill, read by the script: it repaints itself, even without a redraw. */
function syncData(m: BoardModel): string {
  const a = m.sync;
  const n = (x: number | null) => (x ? String(x) : "");
  return `<span hidden data-sync data-tick="${n(a.tick)}" data-beat="${a.beat}" data-event="${n(a.lastEventAt)}" data-synced="${n(a.syncedAt)}" data-failed="${n(a.syncFailedAt)}" data-deaf="${a.deaf ? "1" : ""}"></span>`;
}

/** Removes a request or a master's report from the header: it stays in master.json, marked `dismissedAt`. */
const dismissButton = (id: string) =>
  `<button type="button" data-dismiss="${escapeHtml(id)}" title="${escapeHtml(t("board.dismiss.tip"))}" aria-label="${escapeHtml(t("board.dismiss"))}" class="-mt-0.5 shrink-0 rounded px-1.5 text-[15px] leading-6 text-muted opacity-60 hover:bg-soft hover:text-ink hover:opacity-100 focus:opacity-100">×</button>`;

/** Free requests to the master and its answers: the answer is read here, no longer in its chat. */
function demandesStatus(m: BoardModel, ctx: BoardContext): string {
  if (!m.demandes.length) return "";
  const row = ({ req, state }: BoardModel["demandes"][number]) => {
    const q = t("board.demande.quote", { text: clip(req.text ?? "", 90) });
    const tail =
      state === "done"
        ? `<span class="text-ink">${escapeHtml(req.summary ?? t("board.demande.done"))}</span> <span class="text-muted">(${escapeHtml(ctx.timeOf(req.doneAt ?? req.at))})</span>`
        : state === "running"
          ? `<span class="text-muted">${escapeHtml(t("board.demande.running", { time: ctx.timeOf(req.deliveredAt ?? req.at) }))}</span>`
          : state === "queued"
            ? `<span class="text-muted">${t("board.demande.queued")}</span>`
            : `<span class="text-warn">${escapeHtml(t("board.demande.stale", { time: ctx.timeOf(req.at) }))}</span>`;
    const lamp = state === "running" ? "lamp-green lit animate-pulse" : state === "stale" ? "lamp-red lit" : state === "queued" ? "lamp-green lit" : "lamp-green";
    return `<li class="group flex items-start gap-2"><span class="mt-[5px]"><span class="lamp ${lamp}" aria-hidden="true"></span></span><span class="min-w-0 flex-1"><span class="text-muted">${escapeHtml(q)}</span> → ${tail}</span>${dismissButton(req.id)}</li>`;
  };
  return `<ul class="flex max-w-[110ch] flex-col gap-1 text-[13.5px]" data-demandes>${m.demandes.map(row).join("")}</ul>`;
}

/** The window of a review inside the status sentence ("the last 24 h"), by key of REVUE_WINDOWS. */
const REVUE_STATUS_WINDOW_KEYS: Record<string, MessageKey> = { "24h": "board.revue.window.24h", "3d": "board.revue.window.3d", "14d": "board.revue.window.14d" };

/** Where the last review requested from the master stands, at the top of the board. */
function revueStatus(m: BoardModel, ctx: BoardContext): string {
  if (!m.revue) return "";
  const { req, state } = m.revue;
  const winKey = REVUE_STATUS_WINDOW_KEYS[req.since ?? ""];
  const win = winKey ? t(winKey) : (REVUE_WINDOWS[req.since ?? ""] ?? req.since);
  const text =
    state === "queued"
      ? t("board.revue.queued", { win, time: ctx.timeOf(req.at) })
      : state === "running"
        ? t("board.revue.running", { win, time: ctx.timeOf(req.deliveredAt ?? req.at) })
        : state === "stale"
          ? t("board.revue.stale", { win, time: ctx.timeOf(req.at) })
          : t("board.revue.done", { win, time: ctx.timeOf(req.doneAt ?? req.at), summary: req.summary ?? t("board.revue.noReport") });
  const lamp = state === "running" ? `<span class="lamp lamp-green lit animate-pulse" aria-hidden="true"></span>` : state === "stale" ? `<span class="lamp lamp-red lit" aria-hidden="true"></span>` : `<span class="lamp lamp-green${state === "done" ? "" : " lit"}" aria-hidden="true"></span>`;
  return `<p class="group flex max-w-[110ch] items-start gap-2 text-[13.5px] ${state === "stale" ? "text-warn" : "text-muted"}" data-revue-status="${state}"><span class="mt-[5px]">${lamp}</span><span class="min-w-0 flex-1">${escapeHtml(text)}</span>${state === "done" || state === "stale" ? dismissButton(req.id) : ""}</p>`;
}

/**
 * The page's content: review and banners at the top, "waiting on you" and the folded radar below, then "to review",
 * "at work", "waiting on someone", the snoozed topics, the sessions outside Strato and today's closed topics, folded.
 */
export function boardView(m: BoardModel, ctx: BoardContext): string {
  const vctx = { ...ctx, now: ctx.now ?? m.now };
  const hero = `<header class="flex flex-col gap-4">
<div class="flex flex-wrap items-center justify-end gap-x-2 gap-y-3">
${refreshControl(m)}
${revueControl(m)}
</div>
${revueStatus(m, vctx)}
${demandesStatus(m, vctx)}
${syncData(m)}
${process.env.STRATO_DEMO === "1" ? `<p data-demo class="rounded-lg border border-accent/40 bg-accent-soft/30 px-3.5 py-2 text-[13.5px] text-ink">${t("board.demo.banner", { command: `<code class="font-mono text-[12.5px]">${escapeHtml('claude -n strato "/strato setup"')}</code>` })}</p>` : ""}
${m.listener.alive ? "" : `<p class="flex items-center gap-2 rounded-lg border border-warn/40 bg-warn-soft/40 px-3.5 py-2 text-[13.5px] text-warn"><span class="lamp lamp-red lit" aria-hidden="true"></span>${t(m.listener.lastTick ? "board.listener.downSince" : "board.listener.down", { time: m.listener.lastTick ? escapeHtml(ctx.timeOf(m.listener.lastTick)) : "", command: `<code class="font-mono text-[12.5px]">${escapeHtml(masterCommand())}</code>` })}</p>`}
${m.listener.deaf ? `<p class="flex items-center gap-2 rounded-lg border border-warn/40 bg-warn-soft/40 px-3.5 py-2 text-[13.5px] text-warn"><span class="lamp lamp-red lit" aria-hidden="true"></span><span>${t(m.listener.lastEventAt ? "board.listener.deafSince" : "board.listener.deaf", { time: m.listener.lastEventAt ? escapeHtml(ctx.timeOf(m.listener.lastEventAt)) : "" })} ${m.listener.appId ? `<a class="underline underline-offset-2" href="${escapeHtml(slackEventsPage(m.listener.appId))}" target="_blank" rel="noopener">${t("board.listener.reenable")}</a>` : t("board.listener.reenableHere")}.</span></p>` : ""}
</header>`;
  const sessions =
    m.sessions.length || m.otherSessions
      ? `<section class="flex flex-col gap-2.5" id="bloc-sessions">
<h2 class="flex items-center gap-x-3"><span class="text-[17px] font-semibold tracking-tight text-ink" title="${escapeHtml(t("board.sessions.tip", { workspace: workspaceLabel() }))}">${t("board.sessions.title")}</span>${count(m.sessions.length)}</h2>
${m.sessions.length ? `<ul class="overflow-hidden rounded-lg border border-line">${m.sessions.map((x) => sessionLine(x, vctx)).join("\n")}</ul>` : ""}
${m.otherSessions ? `<p class="text-[12.5px] text-muted">${t(m.otherSessions > 1 ? "board.sessions.others.other" : "board.sessions.others.one", { n: m.otherSessions, workspace: escapeHtml(workspaceLabel()) })}</p>` : ""}
</section>`
      : "";
  const closed = m.closedToday.length
    ? `<details class="group" id="closed-today">
<summary class="cursor-pointer select-none list-none inline-flex items-center gap-1.5 text-[13.5px] font-medium text-muted hover:text-ink"><span class="inline-block transition-transform group-open:rotate-90">▸</span>${t(m.closedToday.length > 1 ? "board.closedToday.other" : "board.closedToday.one", { n: m.closedToday.length })}</summary>
<ul class="mt-2.5 overflow-hidden rounded-lg border border-line bg-surface">${m.closedToday.map((s) => closedRow(s, vctx)).join("")}</ul>
</details>`
    : "";
  const paused = m.paused.length
    ? `<details class="group" id="paused">
<summary class="cursor-pointer select-none list-none inline-flex items-center gap-1.5 text-[13.5px] font-medium text-muted hover:text-ink"><span class="inline-block transition-transform group-open:rotate-90">▸</span>${t(m.paused.length > 1 ? "board.paused.count.other" : "board.paused.count.one", { n: m.paused.length })}</summary>
<ul class="mt-2.5 overflow-hidden rounded-lg border border-line bg-surface">${m.paused.map((p) => pausedRow(p.line, p.until, vctx, p.reason)).join("")}</ul>
</details>`
    : "";
  return `<div class="flex flex-col gap-9" data-view="board" data-attend="${m.attend.length}">
${hero}
<div class="-mt-4 flex flex-col gap-4">
${blocView("attend", m.attend, vctx)}
${radar(m, vctx)}
</div>
${blocView("revoir", m.revoir, vctx)}
${blocView("travail", m.travail, vctx)}
${blocView("attente", m.attente, vctx)}
${paused}
${sessions}
${closed}
</div>`;
}

const THEME = `
@import "tailwindcss";
@theme {
  --font-sans: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --color-bg: #f4f5f7;
  --color-surface: #ffffff;
  --color-soft: #eceef1;
  --color-line: #dfe2e7;
  --color-ink: #171a1f;
  --color-muted: #667080;
  --color-link: #0a6f8c;
  --fresh-l: 44%;
  --color-accent: #d19a2a;
  --color-accent-soft: #fbefd3;
  --color-accent-ink: #8a5a08;
  --color-clear: #1f9d5a;
  --color-clear-soft: #dcf5e6;
  --color-clear-ink: #176f41;
  --color-wait: #2456c9;
  --color-wait-soft: #e2eafc;
  --color-wait-ink: #1e45a3;
  --color-warn: #b42318;
  --color-warn-soft: #fbe9e7;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --color-bg: #121417;
    --color-surface: #1a1d22;
    --color-soft: #23272e;
    --color-line: #2c313a;
    --color-ink: #e8eaed;
    --color-muted: #99a1ad;
    --color-link: #5ec8e5;
    --fresh-l: 58%;
    --color-accent: #f2b84b;
    --color-accent-soft: #3a2c10;
    --color-accent-ink: #f2b84b;
    --color-clear: #4fd18c;
    --color-clear-soft: #143523;
    --color-clear-ink: #6fe0a3;
    --color-wait: #8fb0ff;
    --color-wait-soft: #1d2a45;
    --color-wait-ink: #a9c1ff;
    --color-warn: #f0705f;
    --color-warn-soft: #3b1f1c;
  }
}
:root[data-theme="dark"] {
    --color-bg: #121417;
    --color-surface: #1a1d22;
    --color-soft: #23272e;
    --color-line: #2c313a;
    --color-ink: #e8eaed;
    --color-muted: #99a1ad;
    --color-link: #5ec8e5;
    --fresh-l: 58%;
    --color-accent: #f2b84b;
    --color-accent-soft: #3a2c10;
    --color-accent-ink: #f2b84b;
    --color-clear: #4fd18c;
    --color-clear-soft: #143523;
    --color-clear-ink: #6fe0a3;
    --color-wait: #8fb0ff;
    --color-wait-soft: #1d2a45;
    --color-wait-ink: #a9c1ff;
    --color-warn: #f0705f;
    --color-warn-soft: #3b1f1c;
  }
html { color-scheme: light dark; }
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }
kbd { display: inline-block; min-width: 1.35em; border: 1px solid var(--color-line); border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; font: 500 11.5px/1.45 var(--font-mono); text-align: center; color: var(--color-ink); background: var(--color-surface); }
/* the grid of a track diagram, barely visible, under the whole page */
body {
  color: var(--color-ink);
  background-color: var(--color-bg);
  background-image: radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--color-ink) 9%, transparent) 1px, transparent 1.5px);
  background-size: 22px 22px;
}
/* the signal lamps: off by default, lit with a halo when something waits */
.lamp { --lamp: var(--color-muted); display: inline-block; width: 10px; height: 10px; border-radius: 999px; background: color-mix(in srgb, var(--lamp) 28%, var(--color-bg)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--lamp) 35%, transparent); flex: none; }
.lamp-lg { width: 22px; height: 22px; }
.agent-tree, .agent-tree ul { list-style: none; margin: 0; padding: 0 0 0 16px; }
.agent-tree { margin-left: 3px; }
.agent-tree li { position: relative; padding: 1px 0; }
.agent-tree li::before { content: ""; position: absolute; left: -12px; top: 0; height: 100%; border-left: 1px solid var(--color-line); }
.agent-tree li:last-child::before { height: 11px; }
.agent-tree li::after { content: ""; position: absolute; left: -12px; top: 11px; width: 8px; border-top: 1px solid var(--color-line); }
.lamp-amber { --lamp: var(--color-accent); }
.lamp-red { --lamp: var(--color-warn); }
.lamp-green { --lamp: var(--color-clear); }
.lamp-blue { --lamp: var(--color-wait); }
.lamp.lit { background: var(--lamp); box-shadow: 0 0 0 3px color-mix(in srgb, var(--lamp) 22%, transparent), 0 0 14px color-mix(in srgb, var(--lamp) 55%, transparent); }
.lamp-lg.lit { box-shadow: 0 0 0 5px color-mix(in srgb, var(--lamp) 18%, transparent), 0 0 28px color-mix(in srgb, var(--lamp) 60%, transparent), inset 0 -3px 6px rgb(0 0 0 / 0.25); }
/* one shape per state, on top of the colour */
.shape { display: inline-block; width: 7px; height: 7px; flex: none; background: currentColor; }
.shape-dot { border-radius: 999px; }
/* freshness of what waits on you: hue --fh (120 green, 0 red), darkened by --fk beyond 24 h */
[data-fresh] { --fresh: hsl(var(--fh) 72% calc(var(--fresh-l) - var(--fk) * 18%)); border-left: 4px solid var(--fresh); }
[data-fresh] [data-age] { color: var(--fresh); font-weight: 600; }
/* each open task carries its own age: its badge is tinted by its own freshness, not the card's */
[data-task-fresh] { --fresh: hsl(var(--fh) 72% calc(var(--fresh-l) - var(--fk) * 18%)); }
[data-task-fresh] [data-age] { color: var(--fresh); font-weight: 600; }
.shape-tri { width: 9px; height: 8px; clip-path: polygon(50% 0, 100% 100%, 0 100%); }
.shape-sq { border-radius: 1.5px; }
.shape-ring { background: transparent; border-radius: 999px; box-shadow: inset 0 0 0 1.6px currentColor; }
/* the go queue: the draft folded to four lines, except under the cursor, or on the first card when there is no cursor */
.go-queue > li:not([data-cursor]) [data-draft-text] { max-height: 6.4em; overflow: hidden; -webkit-mask-image: linear-gradient(#000 55%, transparent); mask-image: linear-gradient(#000 55%, transparent); }
.go-queue:not(:has(> li[data-cursor])) > li:first-child [data-draft-text] { max-height: 20rem; overflow-y: auto; -webkit-mask-image: none; mask-image: none; }
#drawer.drawer-closed { visibility: hidden; transform: translateY(100%); pointer-events: none; }
#drawer.drawer-closed iframe { visibility: hidden !important; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;

/** The logo and the favicon live in core/brand.ts, the single source of the mark. */
export { faviconHref } from "./core/brand.ts";

const JS = `
(function () {
  // the board.js.* strings of the profile's locale, written into the page by boardPage (core/i18n.ts)
  var I18N = window.STRATO_I18N || {};
  function tr(key, vars) {
    var text = I18N[key] || key;
    if (vars) Object.keys(vars).forEach(function (k) { text = text.split("{" + k + "}").join(String(vars[k])); });
    return text;
  }
  // A task element (draft form, Go button, Done/Drop) is identified by its topic and its task: "<key>#<task>".
  function fidOf(el) { return el.getAttribute("data-key") + "#" + (el.getAttribute("data-task") || ""); }
  function goIdOf(b) { return b.getAttribute("data-go") + "#" + (b.getAttribute("data-task") || ""); }
  function keyOfId(id) { return id.slice(0, id.lastIndexOf("#")); }
  var app = document.getElementById("app");
  var toast = document.getElementById("toast");
  var timer;
  function flash(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(function () { toast.hidden = true; }, 3000);
  }
  // The board always redraws, including while the cursor is in a field: holding the redraw while a field had the focus
  // froze the page after each send (the focus stays in the emptied field). The active field is recreated identically
  // in the same task (text, caret, inner scroll, focus without scrolling the page), so no keystroke falls in between.
  // Only an ongoing composition (accents, IME) postpones the redraw.
  var composing = false, redrawPending = false;
  document.addEventListener("compositionstart", function () { composing = true; });
  document.addEventListener("compositionend", function () { composing = false; if (redrawPending) { redrawPending = false; redraw(true); } });
  function activeField() {
    var a = document.activeElement;
    if (!a || !(a.tagName === "TEXTAREA" || a.tagName === "INPUT") || !app.contains(a)) return null;
    var f = a.closest("form[data-key]");
    return { key: f ? f.getAttribute("data-key") : null, task: f ? f.getAttribute("data-task") : null, name: a.name || a.tagName, value: a.value, start: a.selectionStart, end: a.selectionEnd, top: a.scrollTop };
  }
  // Returns false when the field could not get the focus back (topic closed, form folded, draft gone): the focus then
  // falls on the page, and the rest of the typing would turn into shortcuts ("ok go": k then g would post another
  // topic's draft). The script then turns off one-letter shortcuts until the next click or Escape.
  function restoreField(st) {
    if (!st) return true;
    // a message sent with ⌘↩ empties its field on purpose: the writing is done
    if (st.name === "text" && st.key in sending) return true;
    if (st.key === null) return false;
    var a = null;
    app.querySelectorAll("form[data-key]").forEach(function (f) { if (!a && f.getAttribute("data-key") === st.key && (f.getAttribute("data-task") || null) === (st.task || null)) a = f.querySelector('[name="' + st.name + '"]'); });
    if (!a) return false;
    a.value = st.value;
    try { a.focus({ preventScroll: true }); a.setSelectionRange(st.start, st.end); } catch (e) {}
    a.scrollTop = st.top;
    return document.activeElement === a;
  }
  var keysLocked = false;
  function lockKeys() { keysLocked = true; }
  // a click anywhere gives the shortcuts back: the user knows where they are again
  document.addEventListener("pointerdown", function () { keysLocked = false; }, true);
  // Redraws leave in order but their answers can come back out of order: each request has its number, and an answer
  // older than the last one applied is dropped, otherwise it would put back a stale state.
  var drawSeq = 0, drawApplied = 0;
  function redraw(keepScroll) {
    if (composing) { redrawPending = true; return Promise.resolve(); }
    redrawPending = false;
    var y = window.scrollY;
    var seq = ++drawSeq;
    return fetch("/board/fragment", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
      .then(function (html) {
        if (seq < drawApplied) return;
        drawApplied = seq;
        // what the user opened or started writing survives the redraw
        var opened = {}, drafts = {};
        app.querySelectorAll("details[id]").forEach(function (d) { opened[d.id] = d.open; });
        app.querySelectorAll("[data-panel][id]").forEach(function (p) { opened[p.id] = !p.hidden; });
        app.querySelectorAll("form[data-send]").forEach(function (f) { var t = f.querySelector("textarea"); if (t && t.value) drafts[f.getAttribute("data-key")] = t.value; });
        var field = activeField();
        app.innerHTML = html;
        app.querySelectorAll("details[id]").forEach(function (d) { if (d.id in opened) d.open = opened[d.id]; });
        app.querySelectorAll("[data-panel][id]").forEach(function (p) { if (p.id in opened) setPanel(p.id, opened[p.id]); });
        // an unsent message comes back into its field; a send in progress keeps its greyed button and its "Sending…", not its text
        app.querySelectorAll("form[data-send]").forEach(function (f) {
          var k = f.getAttribute("data-key");
          if (k in sending) { paintSending(f, sending[k]); return; }
          if (k in drafts) { f.querySelector("textarea").value = drafts[k]; var wd = f.querySelector("details[data-write]"); if (wd) wd.open = true; }
          if (k in lastStatus) f.querySelector("[data-status]").textContent = lastStatus[k];
        });
        restoreDrafts();
        if (!restoreField(field)) lockKeys();
        afterRender();
        if (keepScroll) window.scrollTo(0, y);
      })
      .catch(function () { flash(tr("board.js.serverDown")); });
  }
  // a panel (card, context, message) opens with its button; the button's state follows the panel
  function setPanel(id, open) {
    var p = document.getElementById(id);
    if (!p) return;
    p.hidden = !open;
    app.querySelectorAll('[data-toggle="' + id + '"]').forEach(function (b) { b.setAttribute("aria-expanded", open ? "true" : "false"); });
  }
  document.addEventListener("click", function (ev) {
    var el = ev.target instanceof Element ? ev.target : null;
    if (!el) return;
    var refresh = el.closest("[data-refresh]");
    if (refresh) { ev.preventDefault(); redraw(true); return; }
    // the update: a first click arms, a second within 4 s starts it; the server answers at once and works in the
    // background, the top bar shows its progress, and the page reloads when the restarted server answers (onHello)
    var upd = el.closest("[data-update-apply]");
    if (upd) {
      ev.preventDefault(); ev.stopPropagation();
      if (!("update" in armed)) { arm("update", tr("board.js.update.confirm"), 4000); return; }
      disarm("update");
      runBusy(upd, tr("board.js.update.busy"), function () { return post("/api/update", {}).then(function (x) { flash(x.ok ? tr("board.js.update.started") : tr("board.js.update.failed", { error: x.error })); return refreshVersion(); }); });
      return;
    }
    var tog = el.closest("[data-toggle]");
    if (tog) {
      ev.preventDefault();
      var id = tog.getAttribute("data-toggle");
      var p = document.getElementById(id);
      setPanel(id, !p || p.hidden);
      return;
    }
    // a click on the line itself opens or closes its card; not on a link, a button, the form, a panel, or a text selection
    var row = el.closest("[data-row]");
    if (row && !el.closest("a, button, textarea, input, form, details, [data-panel], [data-gocard], code") && !String(window.getSelection && window.getSelection()).length) {
      var cid = row.getAttribute("data-row");
      var cp = document.getElementById(cid);
      setPanel(cid, !cp || cp.hidden);
      return;
    }
    var a = el.closest("a[data-open]");
    if (!a) return;
    ev.preventDefault();
    post("/api/open", { url: a.href }).then(function (x) { if (!x.ok) flash(tr("board.js.openFailed", { error: x.error })); });
  });
  // ⌘↩ (or Ctrl+↩) in the message sends it
  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter" || !(ev.metaKey || ev.ctrlKey)) return;
    var t = ev.target instanceof HTMLTextAreaElement ? ev.target : null;
    var form = t && t.closest("form[data-send]");
    if (!form) return;
    ev.preventDefault();
    form.requestSubmit();
  });
  // the sends in progress and the last feedback per topic: the page redraws during the 10 to 15 s of a send,
  // and the form held in hand is then no longer the one on screen
  var sending = {};
  var lastStatus = {};
  function paintSending(form, text) {
    form.querySelector("textarea").value = text;
    form.querySelector("button[type=submit]").disabled = true;
    form.querySelector("[data-status]").textContent = tr("board.js.sending");
  }
  function formFor(key) { return app.querySelector('form[data-send][data-key="' + key.replace(/"/g, '\\\\"') + '"]'); }
  // ---- pasting an image (⌘V or Ctrl V) into the message field: the server keeps it for the topic, and a short label
  // "[image 1]" goes into the text; on send it becomes "[image: <path>]", which the session reads with the Read tool.
  // A text paste is left alone.
  var uploading = {};
  /** Per topic: label number -> path of the image on disk. */
  var pasted = {};
  function expandImages(key, text) {
    var m = pasted[key] || {};
    return text.replace(/\\[image (\\d+)\\]/g, function (all, n) { return m[n] ? tr("board.js.image.ref", { path: m[n] }) : all; });
  }
  document.addEventListener("paste", function (ev) {
    var t = ev.target;
    var form = t instanceof HTMLTextAreaElement ? t.closest("form[data-send]") : null;
    if (!form || !ev.clipboardData) return;
    var files = [];
    for (var i = 0; i < ev.clipboardData.items.length; i++) {
      var it = ev.clipboardData.items[i];
      if (it.kind === "file" && it.type.indexOf("image/") === 0) { var f = it.getAsFile(); if (f) files.push(f); }
    }
    if (!files.length) return;
    ev.preventDefault();
    var key = form.getAttribute("data-key");
    files.forEach(function (file) {
      uploading[key] = (uploading[key] || 0) + 1;
      var status = form.querySelector("[data-status]");
      if (status) status.textContent = tr("board.js.image.uploading");
      form.querySelector("button[type=submit]").disabled = true;
      var reader = new FileReader();
      reader.onload = function () {
        var data = String(reader.result).replace(/^data:[^,]*,/, "");
        post("/api/paste-image", { key: key, type: file.type, data: data }).then(function (x) {
          uploading[key]--;
          var f2 = formFor(key);
          if (!f2) return;
          var ta = f2.querySelector("textarea");
          if (x.ok) {
            var m = pasted[key] || (pasted[key] = {});
            var n = Object.keys(m).length + 1;
            m[n] = x.d.path;
            var ins = "[image " + n + "]";
            var at = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
            var before = ta.value.slice(0, at), after = ta.value.slice(ta.selectionEnd == null ? at : ta.selectionEnd);
            var sep = before && !/\\s$/.test(before) ? " " : "";
            ta.value = before + sep + ins + (after && !/^\\s/.test(after) ? " " : "") + after;
            var pos = (before + sep + ins).length;
            ta.setSelectionRange(pos, pos);
          } else flash(tr("board.js.image.failed", { error: x.error }));
          if (x.ok) flash(tr("board.js.image.attached"));
          var st = f2.querySelector("[data-status]");
          if (st) st.textContent = "";
          if (!uploading[key]) f2.querySelector("button[type=submit]").disabled = false;
        });
      };
      reader.onerror = function () { uploading[key]--; flash(tr("board.js.image.unreadable")); };
      reader.readAsDataURL(file);
    });
  });
  document.addEventListener("submit", function (ev) {
    var form = ev.target;
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-send")) return;
    ev.preventDefault();
    var key = form.getAttribute("data-key");
    var text = expandImages(key, form.querySelector("textarea").value.trim());
    if (!text || key in sending) return;
    // a "go" typed or clicked (chip) follows the same rule as the Go button: one per version of the card
    var isGo = isGoText(text);
    if (isGo && (key + "#") in goLock) { flash(tr("board.js.go.already")); return; }
    if (isGo) lockGo(key + "#");
    sending[key] = text;
    paintSending(form, text);
    post("/api/send", { key: key, text: text })
      .then(function (x) { return { ok: x.ok, text: x.ok ? (x.d.note || tr("board.js.delivered")) : tr("board.js.notDelivered", { error: x.error }) }; })
      .then(function (r) {
        delete sending[key];
        lastStatus[key] = r.text;
        if (!r.ok) flash(r.text);
        if (isGo) goDelivered(key + "#", r.ok);
        var f = formFor(key);
        if (!f) return;
        f.querySelector("button[type=submit]").disabled = false;
        f.querySelector("[data-status]").textContent = r.text;
        // delivered: the field empties (and its images with it); refused: the text stays to fix or retry
        if (r.ok) delete pasted[key];
        f.querySelector("textarea").value = r.ok ? "" : text;
      });
  });
  // ---- the terminal drawer: one ttyd per topic, in an iframe outside #app to survive the redraws
  var drawer = document.getElementById("drawer");
  var tabs = document.getElementById("drawer-tabs");
  var body = document.getElementById("drawer-body");
  var showBtn = document.getElementById("drawer-show");
  // The drawer hides without display:none: a hidden terminal keeps its size. With display:none, xterm recomputed to zero
  // columns, claude redrew in narrow columns, and reopening showed a garbled screen until a second resize.
  function drawerOpen() { return !drawer.classList.contains("drawer-closed"); }
  function setDrawer(open) { drawer.classList.toggle("drawer-closed", !open); drawer.setAttribute("aria-hidden", open ? "false" : "true"); }
  var terms = {};
  var current = null;
  function paintTabs() {
    var keys = Object.keys(terms);
    tabs.innerHTML = keys.map(function (k) {
      var t = terms[k];
      var on = k === current;
      return '<span class="inline-flex items-center gap-1 rounded-md ' + (on ? "bg-soft text-ink" : "text-muted hover:text-ink") + ' px-2 py-1 text-[12.5px] whitespace-nowrap">' +
        '<button type="button" data-tab="' + k + '" class="font-medium"><span class="mr-1.5 rounded bg-ink/10 px-1 font-semibold">' + t.letter + '</span>' + t.title.replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }) + '</button>' +
        '<button type="button" data-tab-close="' + k + '" class="rounded px-1 text-muted hover:text-warn" title="' + esc(tr("board.js.terminal.close")) + '">×</button></span>';
    }).join("");
    var n = keys.length;
    showBtn.textContent = n ? (n === 1 ? tr("board.js.terminals.one") : tr("board.js.terminals.other", { n: n })) : "";
    showBtn.hidden = !n || drawerOpen();
    if (!n) { setDrawer(false); showBtn.hidden = true; }
  }
  function showTerm(k) {
    current = k;
    Object.keys(terms).forEach(function (o) { terms[o].frame.style.visibility = o === k ? "visible" : "hidden"; });
    setDrawer(true);
    paintTabs();
    var f = terms[k] && terms[k].frame;
    if (f) { try { f.contentWindow.focus(); } catch (e) {} }
  }
  function addTerm(t) {
    if (terms[t.key]) { showTerm(t.key); return; }
    var frame = document.createElement("iframe");
    frame.src = t.url;
    frame.title = t.letter + " · " + t.title;
    frame.className = "absolute inset-0 h-full w-full border-0";
    body.appendChild(frame);
    terms[t.key] = { letter: t.letter, title: t.title, url: t.url, frame: frame };
    showTerm(t.key);
  }
  function removeTerm(k) {
    var t = terms[k];
    if (!t) return;
    t.frame.remove();
    delete terms[k];
    if (current === k) { var rest = Object.keys(terms); current = rest[rest.length - 1] || null; }
    if (current) showTerm(current); else paintTabs();
  }
  function paintTheme() {
    var t = document.documentElement.getAttribute("data-theme");
    var b = document.querySelector("[data-theme-toggle]");
    if (b) b.textContent = tr(t === "light" ? "board.js.theme.light" : t === "dark" ? "board.js.theme.dark" : "board.js.theme.auto");
  }
  paintTheme();
  // Every POST of the board goes through here. The promise always resolves { ok, status, d, error }: a network cut or
  // an answer that is not JSON (error page, proxy) becomes a readable failure, never a swallowed exception.
  function post(url, data) {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
      .then(function (r) {
        return r.text().then(function (t) {
          var d = null;
          try { d = JSON.parse(t); } catch (e) {}
          if (!d || typeof d !== "object") return { ok: false, status: r.status, d: {}, error: tr("board.js.badResponse", { status: r.status }) };
          return { ok: r.ok, status: r.status, d: d, error: r.ok ? "" : (d.error || tr("board.js.httpFailed", { status: r.status })) };
        });
      })
      .catch(function () { return { ok: false, status: 0, d: {}, error: tr("board.js.serverDown") }; });
  }
  document.addEventListener("click", function (ev) {
    var el = ev.target instanceof Element ? ev.target : null;
    if (!el) return;
    var term = el.closest("[data-term]");
    if (term) {
      ev.preventDefault();
      var key = term.getAttribute("data-term");
      if (terms[key]) { showTerm(key); return; }
      var pane = term.closest("[data-pane]");
      var st = pane && pane.querySelector("[data-session-status]");
      runBusy(term, tr("board.js.opening"), function () {
        return post("/api/terminal", { key: key })
          .then(function (x) {
            if (x.ok) { addTerm(x.d); if (st) st.textContent = ""; return; }
            flash(tr("board.js.terminal.failed", { error: x.error }));
            if (st) st.textContent = x.error;
          });
      });
      return;
    }
    // stop or close: a first click arms the button ("Sure?"), a second within 4 s runs it
    var confirm = el.closest("[data-confirm]");
    if (confirm) {
      ev.preventDefault();
      var action = confirm.getAttribute("data-confirm");
      var ckey = confirm.getAttribute("data-key");
      var st3 = confirm.parentElement.querySelector("[data-session-status]");
      var cid2 = busyIdOf(confirm);
      if (!(cid2 in armed)) { arm(cid2, tr(action === "close" ? "board.js.close.confirm" : "board.js.stop.confirm"), 4000); return; }
      disarm(cid2);
      runBusy(confirm, tr(action === "close" ? "board.js.close.busy" : "board.js.stop.busy"), function () {
        return post("/api/" + action, { key: ckey })
          .then(function (x) {
            lastStatus[ckey] = x.ok ? x.d.note : x.error;
            if (!x.ok) flash(tr(action === "close" ? "board.js.close.failed" : "board.js.stop.failed", { error: x.error }));
            if (st3) st3.textContent = lastStatus[ckey];
            if (x.ok) removeTerm(ckey);
          });
      });
      return;
    }
    var dive = el.closest("[data-dive]");
    if (dive) {
      ev.preventDefault();
      var st2 = dive.parentElement.querySelector("[data-session-status]");
      runBusy(dive, tr("board.js.opening"), function () {
        return post("/api/dive", { key: dive.getAttribute("data-dive") })
          .then(function (x) {
            if (!x.ok) flash(tr("board.js.dive.failed", { error: x.error }));
            if (st2) st2.textContent = x.ok ? x.d.note : x.error;
          });
      });
      return;
    }
    // Done or Drop on a task: a first click arms the button, a second within 4 s sends it
    var top = el.closest("[data-task-op]");
    if (top) {
      ev.preventDefault(); ev.stopPropagation();
      var op = top.getAttribute("data-task-op"), tkey = top.getAttribute("data-key"), tid = top.getAttribute("data-task");
      var oid = busyIdOf(top);
      if (!(oid in armed)) { arm(oid, tr(op === "done" ? "board.js.task.done.confirm" : "board.js.task.drop.confirm", { id: tid }), 4000); return; }
      disarm(oid);
      runBusy(top, tr(op === "done" ? "board.js.task.done.busy" : "board.js.task.drop.busy"), function () {
        return post("/api/task", { key: tkey, taskId: tid, op: op === "done" ? "done" : "drop" }).then(function (x) {
          flash(x.ok ? x.d.note : tr("board.js.task.failed", { error: x.error }));
          return redraw(true);
        });
      });
      return;
    }
    var copy = el.closest("[data-copy]");
    if (copy) {
      ev.preventDefault();
      ev.stopPropagation();
      var box = copy.closest("[data-draft]");
      var bk = box && fidOf(box);
      // the raw text is copied (mentions <@U…> included), not the display: pasted into Slack, it still mentions
      var raw = box && box.querySelector("[data-draft-edit]");
      var value = bk && bk in editing ? editing[bk].text : raw ? raw.defaultValue : null;
      if (value && navigator.clipboard) navigator.clipboard.writeText(value).then(function () { flash(tr("board.js.copy.done")); }, function () { flash(tr("board.js.copy.refused")); });
      return;
    }
    var tab = el.closest("[data-tab]");
    if (tab) { showTerm(tab.getAttribute("data-tab")); return; }
    var close = el.closest("[data-tab-close]");
    if (close) {
      var ck = close.getAttribute("data-tab-close");
      removeTerm(ck);
      post("/api/terminal/close", { key: ck }).then(function (x) { if (!x.ok) flash(tr("board.js.terminal.closeFailed", { error: x.error })); });
      return;
    }
    if (el.closest("[data-drawer-hide]")) { setDrawer(false); paintTabs(); return; }
    if (el.closest("[data-drawer-show]")) { setDrawer(true); paintTabs(); return; }
  });
  // on load, the terminals already open on the server side take their place again
  fetch("/api/terminals", { cache: "no-store" })
    .then(function (r) { return r.json(); })
    .then(function (d) { (d.terminals || []).forEach(addTerm); if (Object.keys(terms).length) { setDrawer(false); paintTabs(); } })
    .catch(function () {});

  // ---- the draft: Send posts it from the server, on behalf of the person served, as shown (or as edited); Undo removes it
  // the three maps are keyed by "<key>#<task>": two drafts of the same topic are edited and posted apart
  var editing = {};   // fid -> { text: text being edited, base: raw draft text when the edit started }
  var posting = {};   // fid -> "Sending…" during the call
  var retrying = {};  // fid -> true when the last send may have gone out: Send becomes "Send again"
  var postNote = {};  // fid -> last feedback (text + permalink + undoable until)
  // the server renders data-retry when the task's last send may have gone out: a reloaded page still sends "again"
  function retryOf(f, fid) { return fid in retrying || f.hasAttribute("data-retry"); }
  function draftForm(fid) { var f = null; app.querySelectorAll("form[data-draft]").forEach(function (x) { if (fidOf(x) === fid) f = x; }); return f; }
  function setEdit(f, on, value) {
    var ta = f.querySelector("[data-draft-edit]"), tx = f.querySelector("[data-draft-text]"), b = f.querySelector("[data-edit]"), p = f.querySelector("[data-post]");
    ta.hidden = !on; tx.hidden = on;
    b.textContent = tr(on ? "board.js.edit.cancel" : "board.js.edit");
    var pl = p && (p.querySelector("[data-label]") || p);
    if (p && !p.disabled) pl.textContent = tr(on ? "board.js.send.edited" : retryOf(f, fidOf(f)) ? "board.js.post.again" : "board.js.send");
    if (on && typeof value === "string") ta.value = value;
  }
  function paintPost(f, key) {
    var st = f.querySelector("[data-draft-status]"), p = f.querySelector("[data-post]");
    if (key in posting) { p.disabled = true; st.textContent = tr("board.js.sending"); return; }
    if (retryOf(f, key) && !p.disabled) { var rl = p.querySelector("[data-label]") || p; rl.textContent = tr("board.js.post.again"); }
    var n = postNote[key];
    if (!n) return;
    st.innerHTML = "";
    st.appendChild(document.createTextNode(n.text));
    if (n.url) { var a = document.createElement("a"); a.href = n.url; a.setAttribute("data-open", ""); a.className = "ml-1 text-link hover:underline"; a.textContent = tr("board.js.post.view"); st.appendChild(a); }
    if (n.undoUntil && Date.now() < n.undoUntil) { var u = document.createElement("button"); u.type = "button"; u.setAttribute("data-unpost", keyOfId(key)); u.setAttribute("data-task", key.slice(key.lastIndexOf("#") + 1)); u.setAttribute("data-undo-until", String(n.undoUntil)); u.className = "ml-2 font-medium text-warn hover:underline"; u.textContent = tr("board.js.undo", { n: Math.ceil((n.undoUntil - Date.now()) / 1000) }); st.appendChild(u); }
  }
  // The countdown of the Undo buttons, rendered by the server ("Draft posted" line) or by paintPost, and their removal
  // when time is up: after 30 s, the server has told the session and can no longer remove the message.
  function paintUndo() {
    app.querySelectorAll("[data-undo-until]").forEach(function (b) {
      if (b.getAttribute("aria-busy") === "true") return;
      var left = Math.ceil((Number(b.getAttribute("data-undo-until")) - Date.now()) / 1000);
      if (left <= 0) b.remove(); else b.textContent = tr("board.js.undo", { n: left });
    });
  }
  setInterval(paintUndo, 1000);
  function restoreDrafts() {
    Object.keys(editing).forEach(function (k) { var f = draftForm(k); if (f) setEdit(f, true, editing[k].text); });
    Object.keys(posting).concat(Object.keys(postNote)).forEach(function (k) { var f = draftForm(k); if (f) paintPost(f, k); });
  }
  document.addEventListener("input", function (ev) {
    var t = ev.target;
    if (!(t instanceof HTMLTextAreaElement) || !t.hasAttribute("data-draft-edit")) return;
    var k = fidOf(t.closest("form"));
    if (k in editing) editing[k].text = t.value; else editing[k] = { text: t.value, base: t.defaultValue };
  });
  // In the "just a go" queue, only the line under the cursor (or the first one) shows its whole draft (CSS .go-queue).
  // A click on Send or Go of another line whose draft is cut unfolds it first, without sending anything: a text read
  // halfway is not posted. Returns true if the line was unfolded.
  function unfoldFirst(btn) {
    var row = btn.closest("[data-row]"), ul = row && row.parentElement, txt = row && row.querySelector("[data-draft-text]");
    if (!txt || !ul.classList.contains("go-queue") || row.hasAttribute("data-cursor")) return false;
    if (!ul.querySelector(":scope > li[data-cursor]") && ul.firstElementChild === row) return false;
    if (txt.scrollHeight <= txt.clientHeight + 1) return false;
    var key = row.getAttribute("data-key");
    setCursor(key, true);
    markSeen(key);
    flash(tr(btn.hasAttribute("data-post") ? "board.js.unfold.send" : "board.js.unfold.go"));
    return true;
  }
  function postDraft(f) {
    var key = fidOf(f), topic = f.getAttribute("data-key"), task = f.getAttribute("data-task");
    if (key in posting || f.getAttribute("data-postable") !== "1") return;
    // The server posts exactly the text sent here: the one shown, or its edited version. It also receives the raw draft
    // the person served decided on and its destination, and refuses (409, code draft-changed) if the card changed in
    // the meantime: posting the draft reread from disk could post a text a session rewrote after it was shown.
    var ta = f.querySelector("[data-draft-edit]"), ed = editing[key];
    // sha: the hash of the plan shown, which the gate checks; retry: the person was told the last send may have gone out
    var body = { key: topic, taskId: task, text: ed ? ed.text : ta.defaultValue, draft: ed ? ed.base : ta.defaultValue, draftTo: f.getAttribute("data-draft-to") || "", sha: f.getAttribute("data-sha") || "", retry: retryOf(f, key) };
    posting[key] = true;
    paintPost(f, key);
    post("/api/post-draft", body)
      .then(function (x) {
        delete posting[key];
        if (!x.ok && x.d.code === "draft-changed") {
          postNote[key] = { text: tr(ed ? "board.js.draft.changedWhileEditing" : "board.js.draft.changed") };
          flash(tr("board.js.draft.changedFlash"));
          redraw(true);
          return;
        }
        // the last send may have gone out: the person checks, then the same button sends again
        if (!x.ok && x.d.code === "unknown") retrying[key] = true;
        if (!x.ok) { postNote[key] = { text: tr("board.js.post.failedNote", { error: x.error }) }; flash(tr("board.js.post.failed", { error: x.error })); return; }
        delete retrying[key];
        delete editing[key];
        postNote[key] = { text: tr("board.js.post.done", { at: x.d.at }), url: x.d.permalink, undoUntil: Date.now() + x.d.undoMs };
        markSeen(topic);
        flash(tr("board.js.post.flash"));
        setTimeout(function () { var g = draftForm(key); if (g) paintPost(g, key); }, x.d.undoMs + 200);
      })
      .then(function () { var g = draftForm(key); if (g) { g.querySelector("[data-post]").disabled = g.getAttribute("data-postable") !== "1"; paintPost(g, key); } });
  }
  // The actions in progress, per button: a click greys the button and shows a spinner until the answer, and that
  // survives the redraw. Otherwise the redraws during the 10 to 15 s of a delivery bring the Go button back active
  // without a spinner, and each new click sends another "go" to the session.
  var busy = {};
  var BUSY_SEL = "[data-update-apply],[data-ask-texts],[data-check],[data-revalidate],[data-revalidate-all],[data-go],[data-term],[data-dive],[data-confirm],[data-task-op],[data-revue],[data-unsnooze],[data-dismiss],[data-snooze],[data-unpost],form[data-snooze-date] button[type=submit]";
  var SPIN = '<span class="mr-1.5 inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-r-transparent align-[-2px]" aria-hidden="true"></span>';
  function busyIdOf(b) {
    if (b.hasAttribute("data-go")) return "go:" + goIdOf(b);
    if (b.hasAttribute("data-term")) return "term:" + b.getAttribute("data-term");
    if (b.hasAttribute("data-dive")) return "dive:" + b.getAttribute("data-dive");
    if (b.hasAttribute("data-confirm")) return b.getAttribute("data-confirm") + ":" + b.getAttribute("data-key");
    if (b.hasAttribute("data-task-op")) return "task-" + b.getAttribute("data-task-op") + ":" + fidOf(b);
    if (b.hasAttribute("data-revue")) return "revue";
    if (b.hasAttribute("data-update-apply")) return "update";
    if (b.hasAttribute("data-unsnooze")) return "unsnooze:" + b.getAttribute("data-unsnooze");
    if (b.hasAttribute("data-dismiss")) return "dismiss:" + b.getAttribute("data-dismiss");
    if (b.hasAttribute("data-ask-texts")) return "ask-texts:" + b.getAttribute("data-ask-texts");
    if (b.hasAttribute("data-check")) return "check:" + b.getAttribute("data-check");
    if (b.hasAttribute("data-revalidate")) return "revalidate:" + b.getAttribute("data-revalidate");
    if (b.hasAttribute("data-revalidate-all")) return "revalidate-all";
    if (b.hasAttribute("data-unpost")) return "unpost:" + b.getAttribute("data-unpost") + "#" + (b.getAttribute("data-task") || "");
    if (b.hasAttribute("data-chip-confirm")) { var cf = b.closest("form[data-send]"); return "chip:" + (cf && cf.getAttribute("data-key")) + ":" + b.getAttribute("data-chip"); }
    // the ready-made snoozes and the "until" form of the same topic share their lock
    if (b.hasAttribute("data-snooze")) return "snooze:" + b.getAttribute("data-key");
    var sf = b.closest("form[data-snooze-date]");
    if (sf) return "snooze:" + sf.getAttribute("data-key");
    return null;
  }
  function paintBusy() {
    document.querySelectorAll(BUSY_SEL).forEach(function (b) {
      var id = busyIdOf(b);
      if (id && id in busy) {
        if (!b.hasAttribute("data-idle")) b.setAttribute("data-idle", b.innerHTML);
        b.disabled = true;
        b.setAttribute("aria-busy", "true");
        b.innerHTML = SPIN + busy[id];
      } else if (b.hasAttribute("data-idle")) {
        b.innerHTML = b.getAttribute("data-idle");
        b.removeAttribute("data-idle");
        b.removeAttribute("aria-busy");
        b.disabled = false;
      }
    });
    // the feedback of the last go stays shown after a redraw
    app.querySelectorAll("[data-go]").forEach(function (b) {
      var k = goIdOf(b), st = b.parentElement.querySelector("[data-go-status]");
      if (st && !st.textContent && k in lastStatus) st.textContent = lastStatus[k];
    });
    paintGoLock();
  }
  // A delivered go is not sent again until the card has been rewritten: the Go button and the go chip stay greyed until
  // the line's data-sig signature changes. runBusy alone only blocks during the request, and two clicks 700 ms apart
  // would send two "go" to the session.
  // keyed by "<key>#<task>" (a task's Go) or "<key>#" (a go written in the message box)
  var goLock = {};  // id -> signature of the line when the go was delivered, or null during the delivery
  function rowSig(id) { var r = rowOf(keyOfId(id)); return r ? r.getAttribute("data-sig") : null; }
  function isGoText(t) { return /^go[.!]?$/i.test(String(t).trim()); }
  function lockGo(key) { goLock[key] = null; paintGoLock(); }
  function goDelivered(key, ok) {
    if (!ok) { delete goLock[key]; paintGoLock(); return; }
    // the answer can arrive before the redraw that carries the card rewritten by the server (session restarted, card
    // gone "working"): the page is reread before keeping the signature to get past
    redraw(true).then(function () { if (key in goLock) { goLock[key] = rowSig(key); paintGoLock(); } });
  }
  function paintGoLock() {
    Object.keys(goLock).forEach(function (k) { if (goLock[k] !== null && goLock[k] !== rowSig(k)) delete goLock[k]; });
    app.querySelectorAll("[data-go]").forEach(function (b) {
      if (b.getAttribute("aria-busy") === "true") return;
      var locked = goIdOf(b) in goLock;
      b.disabled = locked;
      if (locked) b.setAttribute("data-go-locked", ""); else b.removeAttribute("data-go-locked");
    });
    app.querySelectorAll("form[data-send]").forEach(function (f) {
      var locked = (f.getAttribute("data-key") + "#") in goLock;
      f.querySelectorAll("[data-chip]").forEach(function (c) { if (isGoText(c.getAttribute("data-chip"))) c.disabled = locked; });
    });
  }
  // The two-step buttons (Stop, Close, Drop): a first click arms ("Sure?"), a second within 4 s runs it. The armed state
  // is kept by id and repainted after each render: kept in the button itself, a redraw between the two clicks would
  // disarm it silently.
  var armed = {};   // id (the one of busyIdOf) -> { label, token }
  function arm(id, label, ms) {
    var token = {};
    armed[id] = { label: label, token: token };
    paintArmed();
    setTimeout(function () { if (armed[id] && armed[id].token === token) { delete armed[id]; paintArmed(); } }, ms);
  }
  function disarm(id) { delete armed[id]; paintArmed(); }
  function paintArmed() {
    document.querySelectorAll("[data-confirm],[data-task-op],[data-chip-confirm],[data-update-apply]").forEach(function (b) {
      var id = busyIdOf(b);
      if (id && id in armed && !(id in busy)) {
        if (!b.hasAttribute("data-unarmed")) b.setAttribute("data-unarmed", b.textContent);
        b.textContent = armed[id].label;
        b.classList.add("bg-warn-soft", "text-warn");
      } else if (b.hasAttribute("data-unarmed")) {
        b.textContent = b.getAttribute("data-unarmed");
        b.removeAttribute("data-unarmed");
        b.classList.remove("bg-warn-soft", "text-warn");
      }
    });
    // g armed on the keyboard: the button the second g will press is ringed, and only it (the first ready task's)
    app.querySelectorAll("[data-row]").forEach(function (r) {
      var on = ("g:" + r.getAttribute("data-key")) in armed, tgt = on ? gTarget(r) : null;
      r.querySelectorAll("[data-post],[data-go]").forEach(function (b) { ["ring-2", "ring-accent", "ring-offset-2", "ring-offset-bg"].forEach(function (c) { b.classList.toggle(c, b === tgt); }); });
    });
  }
  /** Runs the button's action once: while it runs, another click does nothing. */
  function runBusy(btn, label, start) {
    var id = busyIdOf(btn);
    if (!id || id in busy) return;
    busy[id] = label;
    paintBusy();
    Promise.resolve().then(start)
      .catch(function (e) { flash(tr("board.js.unexpected", { error: e && e.message ? e.message : String(e) })); })
      .then(function () { delete busy[id]; paintBusy(); });
  }
  // taskId: the go names the task, the server tells the session which one
  function sendText(key, text, statusEl, taskId) {
    if (statusEl) statusEl.textContent = tr("board.js.sending");
    return post("/api/send", taskId ? { key: key, text: text, taskId: taskId } : { key: key, text: text })
      .then(function (x) {
        var t = x.ok ? (x.d.note || tr("board.js.delivered")) : tr("board.js.notDelivered", { error: x.error });
        lastStatus[taskId ? key + "#" + taskId : key] = t;
        if (!x.ok) flash(t);
        if (statusEl) statusEl.textContent = t;
        return x.ok;
      });
  }
  function snoozeUntil(w) {
    var d = new Date();
    if (w === "1h") return new Date(d.getTime() + 3600e3);
    if (w === "pm") { d.setHours(14, 0, 0, 0); return d; }
    if (w === "eod") { d.setHours(17, 30, 0, 0); return d; }
    d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d;
  }
  function snoozeLabels() {
    var now = new Date();
    // the "until" form starts from tomorrow, and refuses a past date
    var ymd = function (d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
    var tomorrow = new Date(now.getTime() + 86400e3);
    app.querySelectorAll("form[data-snooze-date] input[name=day]").forEach(function (i) { i.min = ymd(now); if (!i.value) i.value = ymd(tomorrow); });
    app.querySelectorAll("[data-snooze]").forEach(function (b) {
      var w = b.getAttribute("data-snooze"), u = snoozeUntil(w);
      var hm = String(u.getHours()).padStart(2, "0") + ":" + String(u.getMinutes()).padStart(2, "0");
      b.textContent = w === "1h" ? tr("board.js.snooze.1h", { time: hm }) : w === "pm" ? tr("board.js.snooze.pm") : w === "eod" ? tr("board.js.snooze.eod") : tr("board.js.snooze.tomorrow");
      b.hidden = u.getTime() <= now.getTime() + 15 * 60e3;
    });
  }
  document.addEventListener("submit", function (ev) {
    var f = ev.target instanceof Element ? ev.target.closest("form[data-snooze-date]") : null;
    if (!f) return;
    ev.preventDefault(); ev.stopPropagation();
    var day = f.elements.day.value, hour = f.elements.hour.value || "09:00";
    var until = new Date(day + "T" + hour);
    if (!day || isNaN(until.getTime()) || until.getTime() <= Date.now()) { flash(tr("board.js.snooze.pickFuture")); return; }
    var reason = f.elements.reason.value.trim();
    runBusy(f.querySelector("button[type=submit]"), tr("board.js.snooze.busy"), function () {
      return post("/api/snooze", { key: f.getAttribute("data-key"), until: until.toISOString(), reason: reason }).then(function (x) {
        flash(x.ok ? tr("board.js.snooze.untilDay", { day: until.toLocaleDateString(document.documentElement.lang || undefined, { weekday: "short", day: "2-digit", month: "2-digit" }), time: hour }) : tr("board.js.snooze.failed", { error: x.error }));
        return redraw(true);
      });
    });
  }, true);
  document.addEventListener("click", function (ev) {
    var el = ev.target instanceof Element ? ev.target : null;
    if (!el) return;
    var pb = el.closest("[data-post]");
    if (pb) { ev.preventDefault(); ev.stopPropagation(); if (!unfoldFirst(pb)) postDraft(pb.closest("form[data-draft]")); return; }
    var eb = el.closest("[data-edit]");
    if (eb) {
      ev.preventDefault(); ev.stopPropagation();
      // the editor starts from the raw text rendered by the server (the textarea's defaultValue), not from the display:
      // the rendered textContent would lose the mentions <@U…>, the links <url|text> and the channels <#C…>
      var f = eb.closest("form[data-draft]"), k = fidOf(f), ta = f.querySelector("[data-draft-edit]");
      if (k in editing) { delete editing[k]; setEdit(f, false); ta.value = ta.defaultValue; }
      else { editing[k] = { text: ta.defaultValue, base: ta.defaultValue }; setEdit(f, true, editing[k].text); ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); }
      return;
    }
    var ex = el.closest("[data-expand]");
    if (ex) { ev.stopPropagation(); ex.classList.toggle("line-clamp-4"); return; }
    var up = el.closest("[data-unpost]");
    if (up) {
      ev.preventDefault(); ev.stopPropagation();
      var uk = up.getAttribute("data-unpost"), ut = up.getAttribute("data-task"), ufid = uk + "#" + (ut || "");
      runBusy(up, tr("board.js.unpost.busy"), function () {
        return post("/api/unpost", { key: uk, taskId: ut }).then(function (x) {
          postNote[ufid] = { text: x.ok ? tr("board.js.unpost.done") : tr("board.js.unpost.failed", { error: x.error }) };
          flash(postNote[ufid].text);
          var g = draftForm(ufid);
          if (g) paintPost(g, ufid);
          return redraw(true);
        });
      });
      return;
    }
    var go = el.closest("[data-go]");
    if (go) {
      ev.preventDefault(); ev.stopPropagation();
      var gkey = go.getAttribute("data-go"), gtask = go.getAttribute("data-task"), gid = goIdOf(go);
      if (gid in goLock || unfoldFirst(go)) return;
      lockGo(gid);
      runBusy(go, tr("board.js.go.busy"), function () {
        return sendText(gkey, "go", go.parentElement.querySelector("[data-go-status]"), gtask).then(function (ok) {
          var b2 = null;
          app.querySelectorAll("[data-go]").forEach(function (b) { if (goIdOf(b) === gid) b2 = b; });
          var st = b2 && b2.parentElement.querySelector("[data-go-status]");
          if (st) st.textContent = lastStatus[gid] || "";
          goDelivered(gid, ok);
        });
      });
      return;
    }
    var th = el.closest("[data-theme-toggle]");
    if (th) {
      // auto, then light, then dark: the choice stays in this browser
      var root = document.documentElement, cur = root.getAttribute("data-theme") || "auto";
      var next = cur === "auto" ? "light" : cur === "light" ? "dark" : "auto";
      if (next === "auto") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", next);
      try { if (next === "auto") localStorage.removeItem("aiguilleur-theme"); else localStorage.setItem("aiguilleur-theme", next); } catch (e) {}
      paintTheme();
      return;
    }
    // "Revalidate" (one card) and "Revalidate cards": data-revalidate, never data-refresh, which is the page's redraw
    // button at the top right
    var at = el.closest("[data-ask-texts]");
    if (at) {
      ev.preventDefault(); ev.stopPropagation();
      runBusy(at, "", function () {
        return post("/api/send", { key: at.getAttribute("data-ask-texts"), text: at.getAttribute("data-msg") }).then(function (x) {
          flash(x.ok ? (x.d.note || tr("board.js.askTexts.done")) : tr("board.js.askTexts.failed", { error: x.error }));
          return redraw(true);
        });
      });
      return;
    }
    var ck = el.closest("[data-check]");
    if (ck) {
      ev.preventDefault(); ev.stopPropagation();
      runBusy(ck, "", function () {
        return post("/api/check", { key: ck.getAttribute("data-check") }).then(function (x) {
          flash(x.ok ? tr("board.js.check.done") : tr("board.js.check.failed", { error: x.error }));
          return redraw(true);
        });
      });
      return;
    }
    var rf = el.closest("[data-revalidate],[data-revalidate-all]");
    if (rf) {
      ev.preventDefault(); ev.stopPropagation();
      var one = rf.getAttribute("data-revalidate");
      runBusy(rf, "", function () {
        return post("/api/refresh", one ? { key: one } : { all: true }).then(function (x) {
          flash(x.ok ? x.d.note : tr("board.js.refresh.failed", { error: x.error }));
          return redraw(true);
        });
      });
      return;
    }
    var dis = el.closest("[data-dismiss]");
    if (dis) {
      ev.preventDefault(); ev.stopPropagation();
      runBusy(dis, "", function () { return post("/api/master/dismiss", { id: dis.getAttribute("data-dismiss") }).then(function (x) { if (!x.ok) flash(tr("board.js.unpost.failed", { error: x.error })); return redraw(true); }); });
      return;
    }
    var chip = el.closest("[data-chip]");
    if (chip) {
      ev.preventDefault(); ev.stopPropagation();
      // "it's settled" closes the topic: a first click arms ("Sure?"), a second within 4 s sends
      if (chip.hasAttribute("data-chip-confirm")) {
        var chid = busyIdOf(chip);
        if (!(chid in armed)) { arm(chid, tr("board.js.sure"), 4000); return; }
        disarm(chid);
      }
      var form = chip.closest("form[data-send]");
      form.querySelector("textarea").value = chip.getAttribute("data-chip");
      form.requestSubmit();
      return;
    }
    var sz = el.closest("[data-snooze]");
    if (sz) {
      ev.preventDefault(); ev.stopPropagation();
      var until = snoozeUntil(sz.getAttribute("data-snooze"));
      runBusy(sz, tr("board.js.snooze.busy"), function () {
        return post("/api/snooze", { key: sz.getAttribute("data-key"), until: until.toISOString() }).then(function (x) { flash(x.ok ? tr("board.js.snooze.untilTime", { time: String(until.getHours()).padStart(2, "0") + ":" + String(until.getMinutes()).padStart(2, "0") }) : tr("board.js.snooze.failed", { error: x.error })); return redraw(true); });
      });
      return;
    }
    var un = el.closest("[data-unsnooze]");
    if (un) { ev.preventDefault(); runBusy(un, tr("board.js.unsnooze.busy"), function () { return post("/api/snooze", { key: un.getAttribute("data-unsnooze"), until: null }).then(function (x) { if (!x.ok) flash(tr("board.js.unsnooze.failed", { error: x.error })); return redraw(true); }); }); return; }
    if (el.closest("[data-snooze-menu] summary")) { snoozeLabels(); ev.stopPropagation(); return; }
    var jump = el.closest("[data-jump]");
    if (jump) { ev.preventDefault(); ev.stopPropagation(); setCursor(jump.getAttribute("data-jump"), true); return; }
    var rv = el.closest("[data-revue]");
    if (rv) {
      ev.preventDefault(); ev.stopPropagation();
      runBusy(rv, tr("board.js.revue.busy"), function () { return post("/api/revue", { since: rv.getAttribute("data-revue") }).then(function (x) { flash(x.ok ? tr("board.js.revue.done") : tr("board.js.request.failed", { error: x.error })); return redraw(true); }); });
      return;
    }
  }, true);

  // ---- "new since your last visit": the page remembers what you saw when leaving (tab hidden or closed)
  var SEEN = "aiguilleur.seen";
  function readSeen() { try { return JSON.parse(localStorage.getItem(SEEN) || "null"); } catch (e) { return null; } }
  function writeSeen(v) { try { localStorage.setItem(SEEN, JSON.stringify(v)); } catch (e) {} }
  var seenAtLoad = readSeen();
  function snapshot() { var v = {}; app.querySelectorAll("[data-row][data-sig]").forEach(function (r) { v[r.getAttribute("data-key")] = r.getAttribute("data-sig"); }); return v; }
  function markSeen(key) { if (!seenAtLoad) return; var r = rowOf(key); if (r) { seenAtLoad[key] = r.getAttribute("data-sig"); paintNew(); } }
  function paintNew() {
    app.querySelectorAll("[data-row][data-sig]").forEach(function (r) {
      var b = r.querySelector("[data-new]");
      if (b) b.hidden = !seenAtLoad || seenAtLoad[r.getAttribute("data-key")] === r.getAttribute("data-sig");
    });
  }
  document.addEventListener("visibilitychange", function () { if (document.hidden) { seenAtLoad = snapshot(); writeSeen(seenAtLoad); } });
  window.addEventListener("pagehide", function () { writeSeen(snapshot()); });
  app.addEventListener("click", function (ev) { var r = ev.target instanceof Element && ev.target.closest("[data-row]"); if (r) markSeen(r.getAttribute("data-key")); });

  // ---- counter in the tab's title and lit favicon when something waits on you
  function paintTitle() {
    var v = app.querySelector("[data-view=board]");
    var n = v ? Number(v.getAttribute("data-attend") || 0) : 0;
    document.title = n ? "(" + n + ") Strato" : "Strato";
    var fav = document.getElementById("favicon");
    if (fav) fav.href = fav.getAttribute(n ? "data-on" : "data-off");
  }

  // ---- keyboard: j/k move from topic to topic, g twice sends (draft or go), e edits the draft, m writes to the session,
  // c opens the card, o opens the thread, p snoozes 1 h, ? shows the help. Nothing while a field has the focus.
  var cursorKey = null;
  function rowOf(key) { var r = null; app.querySelectorAll("[data-row]").forEach(function (x) { if (x.getAttribute("data-key") === key) r = x; }); return r; }
  function rows() { return Array.prototype.slice.call(app.querySelectorAll("[data-row]")); }
  // what g g sends on a card: the primary button of its first ready task, in the order of the page (oldest first)
  function gTarget(row) { return row.querySelector("[data-post]:not([disabled]),[data-go]:not([disabled])"); }
  function setCursor(key, scroll) {
    rows().forEach(function (r) { r.removeAttribute("data-cursor"); });
    cursorKey = key;
    var r = key && rowOf(key);
    if (!r) { cursorKey = null; return; }
    r.setAttribute("data-cursor", "");
    if (scroll) r.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  var HELP = tr("board.js.help");
  document.addEventListener("keydown", function (ev) {
    var t = ev.target;
    if (ev.key === "Escape" && t instanceof HTMLElement && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) { t.blur(); return; }
    if (ev.key === "Escape" && keysLocked) { keysLocked = false; flash(tr("board.js.keys.back")); return; }
    if (ev.metaKey || ev.ctrlKey || ev.altKey || (t instanceof HTMLElement && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable))) return;
    if (keysLocked) {
      if (ev.key.length === 1) { ev.preventDefault(); flash(tr("board.js.keys.locked")); }
      return;
    }
    var list = rows();
    if (!list.length) return;
    var i = list.findIndex(function (r) { return r.getAttribute("data-key") === cursorKey; });
    var row = i >= 0 ? list[i] : null;
    var k = ev.key;
    if (k === "j" || k === "k") { ev.preventDefault(); var n = k === "j" ? Math.min(list.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1); setCursor(list[n].getAttribute("data-key"), true); markSeen(list[n].getAttribute("data-key")); return; }
    if (k === "?") { ev.preventDefault(); flash(HELP); clearTimeout(timer); timer = setTimeout(function () { toast.hidden = true; }, 9000); return; }
    if (!row) return;
    var key = row.getAttribute("data-key");
    // g arms, a second g within 2 s sends: a single stray key never posts anything to Slack
    if (k === "g") {
      ev.preventDefault();
      var target = gTarget(row);
      if (!target) { flash(tr("board.js.gg.none")); return; }
      var gid = "g:" + key;
      if (gid in armed) { disarm(gid); target.click(); return; }
      arm(gid, "", 2000);
      var item = target.closest("[data-task-item]");
      flash(tr(target.hasAttribute("data-post") ? "board.js.gg.post" : "board.js.gg.go", { id: item ? item.getAttribute("data-task") : "", letter: row.getAttribute("data-letter") || "" }));
      return;
    }
    if (k === "e") { ev.preventDefault(); var eb2 = row.querySelector("[data-edit]"); if (eb2) eb2.click(); return; }
    if (k === "m") { ev.preventDefault(); var w2 = row.querySelector("details[data-write]"); if (w2) w2.open = true; var ta2 = row.querySelector("form[data-send] textarea"); if (ta2) ta2.focus({ preventScroll: false }); return; }
    if (k === "c") { ev.preventDefault(); var cid = row.getAttribute("data-row"), cp = document.getElementById(cid); setPanel(cid, !cp || cp.hidden); return; }
    if (k === "o") { ev.preventDefault(); var a2 = row.querySelector("a[data-open]"); if (a2) a2.click(); return; }
    if (k === "p") { ev.preventDefault(); var sb = row.querySelector('[data-snooze="1h"]'); if (sb) sb.click(); return; }
  });
  app.addEventListener("click", function (ev) { var r = ev.target instanceof Element && ev.target.closest("[data-row]"); if (r) setCursor(r.getAttribute("data-key"), false); });

  function afterRender() {
    paintBusy();
    paintArmed();
    paintUndo();
    paintSync();
    paintNew();
    paintTitle();
    if (cursorKey) setCursor(cursorKey, false);
  }
  afterRender();

  // The ⌘K bar: a single field to find a topic (word, letter, Slack or tracker link, closed ones included) or to write
  // to the master (question, link to sort, draft to write). The master's answer shows under the board's counter.
  var palette = document.getElementById("palette");
  var pin = palette.querySelector("input");
  var plist = palette.querySelector("[data-palette-list]");
  // pQuery: the input the shown results answer. An Enter typed before the search answers waits for that answer (pEnter)
  // instead of acting on the results of the previous input; pSending blocks a second Enter while sending to the master.
  var pItems = [], pSel = 0, pTimer = null, pSeq = 0, pQuery = null, pEnter = false, pSending = false;
  var STATUS = { working: tr("board.js.status.working"), preparing: tr("board.js.status.preparing"), gate: tr("board.js.status.gate"), waiting: tr("board.js.status.waiting"), closed: tr("board.js.status.closed") };
  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function openPalette() { palette.hidden = false; pin.value = ""; findP(); setTimeout(function () { pin.focus(); }, 0); }
  function closePalette() { palette.hidden = true; pEnter = false; }
  function findP() {
    clearTimeout(pTimer);
    var q = pin.value, seq = ++pSeq;
    pTimer = setTimeout(function () {
      fetch("/api/find?q=" + encodeURIComponent(q), { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (d) {
        if (seq !== pSeq) return;
        var t = q.trim();
        pItems = (d.hits || []).map(function (h) { return { type: "sujet", h: h }; });
        if (t) pItems.push({ type: "master", text: t, link: d.link && !(d.hits || []).length });
        pQuery = q;
        pSel = 0;
        paintP();
        if (pEnter) { pEnter = false; runP(pSel); }
      }).catch(function () { if (seq === pSeq && pEnter) { pEnter = false; flash(tr("board.js.search.failed")); } });
    }, 80);
  }
  function paintP() {
    if (!pItems.length) { plist.innerHTML = '<li class="px-3 py-2 text-[13.5px] text-muted">' + esc(tr("board.js.search.empty")) + '</li>'; return; }
    plist.innerHTML = pItems.map(function (it, i) {
      var on = i === pSel ? " bg-soft" : "";
      if (it.type === "master") {
        var label = it.link ? esc(tr("board.js.search.linkToMaster")) : esc(tr("board.js.search.askMaster", { text: it.text.length > 90 ? it.text.slice(0, 89) + "…" : it.text }));
        return '<li><button type="button" data-pi="' + i + '" class="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-[13.5px] text-ink hover:bg-soft' + on + '"><span class="inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-soft px-1 text-[12.5px] font-semibold">↵</span><span class="min-w-0 truncate">' + label + '</span></button></li>';
      }
      var h = it.h;
      return '<li><button type="button" data-pi="' + i + '" class="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-soft' + on + '"><span class="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md bg-soft px-1.5 text-[12.5px] font-semibold ' + (h.open ? "text-ink" : "text-muted") + '">' + esc(h.letter) + '</span><span class="min-w-0 flex-1 truncate text-[13.5px] ' + (h.open ? "text-ink" : "text-muted") + '">' + esc(h.title) + '</span><span class="shrink-0 text-[12.5px] text-muted">' + esc((STATUS[h.status] || h.status) + " · " + h.asker + " · " + h.channel) + '</span></button></li>';
    }).join("");
    var sel = plist.querySelector('[data-pi="' + pSel + '"]');
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }
  function runP(i) {
    var it = pItems[i];
    if (!it) return;
    if (it.type === "master") {
      if (pSending) return;
      // the text is reread from the field at send time, not taken from the last search's results
      var typed = pin.value.trim() || it.text;
      var text = it.link ? tr("board.js.master.isItOurs", { text: typed }) : typed;
      pSending = true;
      post("/api/master", { text: text }).then(function (x) {
        pSending = false;
        flash(x.ok ? tr("board.js.master.delivered") : tr("board.js.request.failed", { error: x.error }));
        if (x.ok) { closePalette(); redraw(true); }
      });
      return;
    }
    closePalette();
    var key = it.h.key;
    if (it.h.open && rowOf(key)) { setCursor(key, false); rowOf(key).scrollIntoView({ block: "center", behavior: "smooth" }); markSeen(key); return; }
    var paused = document.getElementById("paused");
    if (it.h.open && paused) { paused.open = true; paused.scrollIntoView({ block: "center", behavior: "smooth" }); flash(tr("board.js.search.paused", { letter: it.h.letter })); return; }
    window.open("/?sujet=" + encodeURIComponent(key), "_blank", "noopener");
  }
  pin.addEventListener("input", findP);
  pin.addEventListener("keydown", function (ev) {
    if (ev.key === "ArrowDown") { ev.preventDefault(); pSel = Math.min(pItems.length - 1, pSel + 1); paintP(); return; }
    if (ev.key === "ArrowUp") { ev.preventDefault(); pSel = Math.max(0, pSel - 1); paintP(); return; }
    if (ev.key === "Enter") {
      ev.preventDefault();
      if (pSending || pEnter) return;
      if (pin.value !== pQuery) { pEnter = true; findP(); return; }
      runP(pSel);
      return;
    }
    if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closePalette(); }
  });
  plist.addEventListener("click", function (ev) { var b = ev.target instanceof Element ? ev.target.closest("[data-pi]") : null; if (b) runP(Number(b.getAttribute("data-pi"))); });
  palette.addEventListener("click", function (ev) { if (ev.target === palette) closePalette(); });
  document.addEventListener("keydown", function (ev) {
    var t = ev.target;
    var inField = t instanceof HTMLElement && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable);
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === "k" || ev.key === "K")) { ev.preventDefault(); if (palette.hidden) openPalette(); else closePalette(); return; }
    if (ev.key === "/" && !inField && palette.hidden && !keysLocked) { ev.preventDefault(); openPalette(); }
  }, true);
  document.addEventListener("click", function (ev) { if (ev.target instanceof Element && ev.target.closest("[data-palette-open]")) { ev.preventDefault(); openPalette(); } });

  // The top bar's pill: the state of Strato and of the board, repainted every 5 s without waiting for a redraw.
  // Red if the server's stream is cut, or if the Slack listener missed three heartbeats; amber if Slack no longer
  // delivers live or if the last catch-up failed; green otherwise, with the time of the last heartbeat.
  var streamOk = true;
  function hhmm(ms) { var d = new Date(ms); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
  function paintSync() {
    var pill = document.getElementById("sync-pill"), data = app.querySelector("[data-sync]");
    if (!pill || !data) return;
    var n = function (k) { return Number(data.getAttribute("data-" + k)) || 0; };
    var now = Date.now(), tick = n("tick"), beat = n("beat") || 300000, ev = n("event"), synced = n("synced"), failed = n("failed");
    var tone, label, tip = [];
    if (tick) tip.push(tr("board.js.sync.tip.tick", { time: hhmm(tick) }));
    if (ev) tip.push(tr("board.js.sync.tip.event", { time: hhmm(ev) }));
    if (synced) tip.push(tr("board.js.sync.tip.synced", { time: hhmm(synced) }));
    if (streamOk === false) { tone = "red"; label = tr("board.js.sync.disconnected"); tip.unshift(tr("board.js.sync.disconnected.tip")); }
    else if (!tick || now - tick > 3 * beat + 30000) { tone = "red"; label = tick ? tr("board.js.sync.silent", { time: hhmm(tick) }) : tr("board.js.sync.stopped"); tip.unshift(tr("board.js.sync.silent.tip")); }
    else if (data.getAttribute("data-deaf")) { tone = "amber"; label = tr("board.js.sync.deaf"); tip.unshift(tr("board.js.sync.deaf.tip")); }
    else if (failed && failed > synced) { tone = "amber"; label = tr("board.js.sync.failed"); tip.unshift(tr("board.js.sync.failed.tip", { time: hhmm(failed) })); }
    else { tone = "green"; label = tr("board.js.sync.ok", { time: hhmm(tick) }); }
    pill.querySelector(".lamp").className = "lamp lamp-" + tone + " lit";
    pill.querySelector("[data-sync-label]").textContent = label;
    pill.className = "inline-flex items-center gap-2 rounded-full border px-2.5 py-0.5 text-[12.5px] " + (tone === "red" ? "border-warn/50 text-warn" : tone === "amber" ? "border-accent/50 text-accent-ink" : "border-line text-muted");
    pill.title = tip.join("\\n");
  }
  setInterval(paintSync, 5000);

  // SSE stream. After the Mac sleeps, the previous connection is half open: neither error nor message, and the page
  // stays frozen. The server sends a "ping" every 15 s; 40 s without anything, or a clock jump, and the page reopens
  // the stream then redraws, because everything that changed during the gap is lost.
  var events = null, lastBeat = Date.now(), lastTickAt = Date.now();
  // A restarted server serves a new script, which the open page does not have. The hello event carries the server's
  // version, "<boot>.<focus>"; only the boot part counts, the iTerm2 focus changes without a restart. When it changes,
  // the page reloads, after setting aside in sessionStorage what was being typed (messages to sessions, drafts being
  // edited), which the next load puts back.
  var bootSeen = null, RELOAD_KEY = "aiguilleur.reload";
  function saveTyping() {
    var st = { send: {}, editing: editing, cursor: cursorKey, y: window.scrollY };
    app.querySelectorAll("form[data-send]").forEach(function (f) { var t = f.querySelector("textarea"); if (t && t.value) st.send[f.getAttribute("data-key")] = t.value; });
    try { sessionStorage.setItem(RELOAD_KEY, JSON.stringify(st)); } catch (e) {}
  }
  function restoreTyping() {
    var st = null;
    try { st = JSON.parse(sessionStorage.getItem(RELOAD_KEY) || "null"); sessionStorage.removeItem(RELOAD_KEY); } catch (e) {}
    if (!st) return;
    Object.keys(st.editing || {}).forEach(function (k) { editing[k] = st.editing[k]; });
    restoreDrafts();
    Object.keys(st.send || {}).forEach(function (k) { var f = formFor(k); if (f) f.querySelector("textarea").value = st.send[k]; });
    if (st.cursor) setCursor(st.cursor, false);
    if (st.y) window.scrollTo(0, st.y);
  }
  // The version and the update button live in the top bar, outside #app: the fragment does not redraw them.
  // They are refetched on each board event and every minute; an open "what changed" panel stays open, including
  // across the busy state (which has no panel), so that a failed update shows its reason where the click was made.
  var updateOpen = false;
  function refreshVersion() {
    var slot = document.getElementById("version-slot");
    if (!slot) return Promise.resolve();
    return fetch("/board/version", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
      .then(function (html) {
        var d = slot.querySelector("details");
        if (d) updateOpen = d.open;
        slot.innerHTML = html;
        var nd = slot.querySelector("details");
        if (nd && updateOpen) nd.open = true;
        paintBusy(); paintArmed();
      })
      .catch(function () {});
  }
  function onHello(e) {
    var v = "";
    try { v = JSON.parse(e.data).version || ""; } catch (x) {}
    var boot = String(v).split(".")[0];
    if (!boot) return;
    if (bootSeen === null) { bootSeen = boot; return; }
    if (boot !== bootSeen) { saveTyping(); location.reload(); }
  }
  function connect() {
    if (events) { try { events.close(); } catch (e) {} }
    lastBeat = Date.now();
    events = new EventSource("/events");
    events.addEventListener("open", function () { lastBeat = Date.now(); streamOk = true; redraw(true); });
    events.addEventListener("error", function () { streamOk = false; paintSync(); });
    events.addEventListener("hello", function (e) { lastBeat = Date.now(); onHello(e); });
    events.addEventListener("ping", function () { lastBeat = Date.now(); if (!streamOk) { streamOk = true; paintSync(); } });
    events.addEventListener("update", function () { lastBeat = Date.now(); redraw(true); });
    events.addEventListener("board", function () { lastBeat = Date.now(); redraw(true); refreshVersion(); });
    // a ttyd that dies (claude closed) removes its tab
    events.addEventListener("terminals", function (e) {
      lastBeat = Date.now();
      var open = JSON.parse(e.data).open || [];
      Object.keys(terms).forEach(function (k) { if (open.indexOf(k) < 0) removeTerm(k); });
    });
  }
  restoreTyping();
  connect();
  setInterval(function () {
    var now = Date.now(), slept = now - lastTickAt > 20000;
    lastTickAt = now;
    if (now - lastBeat > 40000) { streamOk = false; paintSync(); }
    if (slept || now - lastBeat > 40000) connect();
  }, 5000);
  // relative ages are computed by the server: one redraw per minute keeps them right when nothing moves
  setInterval(function () { if (!document.hidden) { redraw(true); refreshVersion(); } }, 60000);
  // back on the tab or back online: redraw without waiting for the next event
  document.addEventListener("visibilitychange", function () { if (!document.hidden) redraw(true); });
  window.addEventListener("online", connect);
})();
`;

/** The board's whole page: Tailwind shell, sticky bar, content, toast, script. */
export function boardPage(view: string, version = ""): string {
  return `<!doctype html>
<html lang="${locale()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Strato</title>
<link rel="icon" type="image/svg+xml" id="favicon" href="${faviconHref()}" data-on="${faviconHref(true)}" data-off="${faviconHref(false)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<script>try { var t = localStorage.getItem("aiguilleur-theme"); if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t); } catch (e) {}</script>
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.3.3" integrity="sha384-aJ9rL4k6lF+91guGvUFVSkpIcge7Zd9EiI4TQDLoK9kFaFJgKHgjEXVvG/qA5COj" crossorigin="anonymous"></script>
<style type="text/tailwindcss">${THEME}</style>
</head>
<body class="font-sans antialiased text-[13.5px]">
<nav class="sticky top-0 z-10 border-b border-line bg-bg/85 backdrop-blur">
<div class="mx-auto flex max-w-[1080px] items-center justify-between gap-4 px-5 py-2.5">
<div class="flex items-center gap-2.5 text-ink"><span class="inline-flex text-ink">${stratoMark(22)}</span><span class="text-[15px] font-semibold tracking-tight">Strato</span><span class="text-[12.5px] text-muted">board</span><div id="version-slot" class="ml-1 flex items-center gap-2">${version}</div></div>
<button type="button" data-palette-open title="${escapeHtml(t("board.header.search.tip"))}" class="mx-2 hidden h-8 min-w-0 max-w-[420px] flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-left text-[12.5px] text-muted hover:border-muted/60 hover:text-ink sm:flex"><span aria-hidden="true">⌕</span><span class="min-w-0 flex-1 truncate">${escapeHtml(t("board.header.search"))}</span><kbd class="shrink-0">⌘K</kbd></button>
<div class="flex items-center gap-1 text-[12.5px]"><span id="sync-pill" class="mr-2 inline-flex items-center gap-2 rounded-full border border-line px-2.5 py-0.5 text-[12.5px] text-muted"><span class="lamp" aria-hidden="true"></span><span data-sync-label>…</span></span><button type="button" id="drawer-show" hidden data-drawer-show class="${BTN} mr-1" title="${escapeHtml(t("board.drawer.show.tip"))}"></button><button type="button" data-theme-toggle class="${BTN_TEXT}" title="${escapeHtml(t("board.header.theme.tip"))}">${t("board.js.theme.auto")}</button><a href="/?liste" class="${BTN_TEXT}" title="${escapeHtml(t("board.header.list.tip"))}">${t("board.header.list")}</a><button type="button" data-refresh class="${BTN_TEXT}" title="${escapeHtml(t("board.header.refresh.tip"))}">${t("board.header.refresh")}</button></div>
</div>
</nav>
<main id="app" class="mx-auto max-w-[1080px] px-5 pb-24 pt-8">${view}</main>
<aside id="drawer" aria-hidden="true" class="drawer-closed fixed inset-x-0 bottom-0 z-20 flex h-[46vh] min-h-[240px] flex-col border-t border-line bg-[#121417] shadow-[0_-8px_24px_rgb(0_0_0/0.25)]">
<div class="flex items-center gap-1 border-b border-line bg-bg px-3 py-1.5">
<div id="drawer-tabs" class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"></div>
<button type="button" data-drawer-hide class="${BTN_TEXT}" title="${escapeHtml(t("board.drawer.hide.tip"))}">${t("board.drawer.hide")}</button>
</div>
<div id="drawer-body" class="relative min-h-0 flex-1"></div>
</aside>
<div id="palette" hidden class="fixed inset-0 z-30 flex items-start justify-center bg-black/40 px-4 pt-[12vh]"><div class="w-full max-w-[640px] overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"><div class="flex items-center gap-2 border-b border-line px-3"><span class="text-muted">⌕</span><input type="text" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(t("board.palette.placeholder"))}" class="h-11 w-full bg-transparent text-[13.5px] text-ink outline-none placeholder:text-muted"><kbd class="shrink-0">${t("board.palette.escape")}</kbd></div><ul data-palette-list class="max-h-[50vh] overflow-y-auto p-1.5"></ul></div></div>
<div id="toast" role="status" hidden class="fixed bottom-5 left-1/2 -translate-x-1/2 rounded-md bg-ink px-3.5 py-2 text-[13.5px] text-bg shadow-lg"></div>
<script>window.STRATO_I18N = ${JSON.stringify(clientMessages()).replace(/</g, "\\u003c")};</script>
<script>${JS}</script>
</body>
</html>
`;
}
