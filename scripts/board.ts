/**
 * The board: Strato's overview in a browser tab (http://127.0.0.1:<ui.port>/board).
 * Everything is computed from what Strato has already seen: sujets.json, events.ndjson, live/ and ~/.claude/sessions.
 * No Slack or tracker call: a topic's freshness is the last event of its threads compared with the date of its card.
 * This module is pure: it receives the data read by strato.ts and renders HTML, which makes it testable without a server.
 * The page has its own shell (Tailwind v4 from a CDN, IBM Plex), separate from the iTerm2 panel, which stays in panel.ts.
 * Every visible word goes through core/i18n.ts: t() on the server, tr() in the page's script.
 */
import { faviconHref, stratoMark } from "./core/brand.ts";
import { isItemEvent, handedToSession, postOnlyAction, truncate, t, clientMessages, locale, type MessageKey, type ActivityStep, type AgentNode, agentCounts, type Due, type MasterRequest, type MrStage, MR_STAGE_ORDER, parseDue, REVUE_STALE_MS, REVUE_WINDOWS, draftText, isSnoozed, type Snooze, parseSteps, permalinkOfKey, providerKeyLabel, providerLabel, repoLabel, isResolved, maxTextOf, planOfTask, planSha, providerOfKey, unknownOf, renderHtml, resolveTarget, type ResolvedTarget, targetLink, threadInfoOfKey, type UnresolvedTarget, type SessionContext, settings, shellQuote, ticketUrl, type SocketHealth, socketDeaf, type Sujet, sujetKeys, takenBy, freshness, gateSince, checkable, hasDoneMarker, descriptorOf, openTasks, tasksOf, taskDraftText, taskReady, sendsUnseenMessage, type Task, type TaskKind } from "./lib.ts";
import { type StaleSignal, staleSignals } from "./core/refresh.ts";
import type { StateSource } from "./claude/mod-state.ts";
import { roleT } from "./core/i18n.ts";
import { masterCommandFor } from "./core/paths.ts";
import { speaksCode } from "./core/roles.ts";
import { escapeHtml, textToHtml } from "./panel.ts";
import { slackEventsPage } from "./providers/slack/model.ts";
import { type CardContext, type CardTask, type CardView, cardOf, cardTasks, isQuickGo, previewFits, span, type ThreadRef } from "./views/card.ts";
import type { LocalVersion, UpdateCheck, UpdateResult } from "./app/update.ts";
import clientActions from "./client/actions.js" with { type: "text" };
import clientBoot from "./client/boot.js" with { type: "text" };
import clientCore from "./client/core.js" with { type: "text" };
import clientDrawer from "./client/drawer.js" with { type: "text" };
import clientFocus from "./client/focus.js" with { type: "text" };
import clientKeyboard from "./client/keyboard.js" with { type: "text" };
import clientSheet from "./client/sheet.js" with { type: "text" };
import clientSync from "./client/sync.js" with { type: "text" };

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
  /** The message's text, cut at 200 characters (item and info events). */
  text?: string;
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
  /** An excerpt of the message, when the event carries it. */
  text?: string;
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
  /** Where the session's state comes from: its own declaration (Strato's mod) or Claude Code's files; null without a live session. */
  stateSource?: StateSource | null;
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
  /** Set by pinLine on the line the person is working on: where it is shown, and whether that differs from where it belongs. */
  pin?: { shownIn: Bloc; quick: boolean; held: boolean };
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
  /** Where each topic session's state was read from, by sessionId (server/serve.ts). */
  sources?: Map<string, StateSource>;
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
  /** The installation's state folder, for the command that restarts its master. */
  stateDir?: string;
}

const blocTitle = (b: Bloc) => t(`board.bloc.${b}.title` as MessageKey);
const blocHint = (b: Bloc) => t(`board.bloc.${b}.tip` as MessageKey);

/** The signal lamps: amber = waiting on you, red = to review, green = running, blue = waiting on someone. */
export type Lamp = "amber" | "red" | "green" | "blue";
const BLOC_LAMP: Record<Bloc, Lamp> = { attend: "amber", revoir: "red", travail: "green", attente: "blue" };

/** The empty state of a block, in the words of the person's role (core/roles.ts). */
const blocEmpty = (b: Bloc) => roleT(`board.bloc.${b}.empty` as MessageKey);

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
  return last ? { kind: last.kind ?? "", from: last.from ?? "?", at: last.at, channel: last.channel, permalink: last.permalink, ...(last.text ? { text: last.text } : {}) } : null;
}

/** What the gate asks of the person served, in two words, for the card's badge. */
const GATE_KEYS: Record<string, MessageKey> = { draft: "board.gate.draft", release: "board.gate.release", merge: "board.gate.merge", decision: "board.gate.decision", question: "board.gate.question" };
/** The badge of a task: what it asks of the person served, in two words. */
const TASK_KIND_KEYS: Record<TaskKind, MessageKey> = { draft: "board.gate.draft", action: "board.gate.none", decision: "board.gate.decision", question: "board.gate.question" };
export const taskKindLabel = (kind: TaskKind) => roleT(TASK_KIND_KEYS[kind]);

/** Gates that speak of code delivery: without it (core/roles.ts speaksCode), they read as a plain go. */
const CODE_GATES = new Set(["release", "merge"]);

export const gateLabel = (gate: string | undefined) => {
  const key = GATE_KEYS[gate ?? ""];
  if (key && CODE_GATES.has(gate ?? "") && !speaksCode()) return t("board.gate.none");
  if (key) return roleT(key);
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
    l.stateSource = (l.sujet.sessionId && input.sources?.get(l.sujet.sessionId)) || null;
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

/** The line the person is working on, and where it was on screen: the block, its index among the block's rows, and in "waiting on you" whether it sat in the "just a go" sub-list. */
export interface Pin {
  key: string;
  bloc: Bloc;
  index: number;
  quick?: boolean;
}

export const BLOCS: readonly Bloc[] = ["attend", "revoir", "travail", "attente"];

/** The pin a fragment request carries (`pin`, `pinBloc`, `pinIndex`, `pinQuick`), or null when it is absent or malformed. */
export function pinOf(params: URLSearchParams): Pin | null {
  const key = params.get("pin");
  const bloc = params.get("pinBloc") as Bloc | null;
  const index = Number(params.get("pinIndex") ?? "-");
  if (!key || !bloc || !BLOCS.includes(bloc) || !Number.isInteger(index) || index < 0) return null;
  return { key, bloc, index, quick: bloc === "attend" && params.get("pinQuick") === "1" };
}

/** A block's lines in the order the page shows them: in "waiting on you", the quick gos come first. */
export function blocOrder(bloc: Bloc, lines: BoardLine[]): BoardLine[] {
  if (bloc !== "attend") return lines;
  return [...lines.filter(isQuickGo), ...lines.filter((l) => !isQuickGo(l))];
}

/**
 * Keeps the line the person is working on where they saw it: their own action changes its session's state, and the
 * line would otherwise jump to another block under their eyes. The line shows its new state in place; once the client
 * stops sending the pin, the next render puts it where it belongs.
 */
export function pinLine(m: BoardModel, pin: Pin | null): BoardModel {
  if (!pin) return m;
  const from = BLOCS.find((b) => m[b].some((l) => l.sujet.key === pin.key));
  if (!from) return m;
  const line = m[from].find((l) => l.sujet.key === pin.key) as BoardLine;
  const natural = blocOrder(from, m[from]).indexOf(line);
  const target = blocOrder(pin.bloc, m[pin.bloc].filter((l) => l !== line));
  const index = Math.min(pin.index, target.length);
  const quick = pin.bloc === "attend" && !!pin.quick;
  target.splice(index, 0, { ...line, pin: { shownIn: pin.bloc, quick, held: from !== pin.bloc || natural !== index || (quick !== isQuickGo(line) && pin.bloc === "attend") } });
  return { ...m, [from]: m[from].filter((l) => l !== line), [pin.bloc]: target };
}

// ------------------------------------------------------------------ rendering

const link = (url: string, label: string, cls = "text-link hover:underline underline-offset-2") => `<a href="${escapeHtml(url)}" class="${cls}" data-open>${escapeHtml(label)}</a>`;
/** The command that starts this installation's master: from its working folder, otherwise another master starts. */
export const masterCommand = (state: string | null = null) => masterCommandFor(settings().workspace, state, shellQuote);

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

export { isQuickGo, span };

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

/** A thread or ticket of the topic, as a link when it has one (labels decided by views/card.ts threadRefs). */
const refLink = (r: ThreadRef) => (r.url ? link(r.url, r.label) : escapeHtml(r.label));

/** The topic's threads besides the origin: tickets and the latest ones, the older ones folded in a panel that survives the redraws. */
function threadLinks(key: string, c: CardContext): string {
  const shown = c.threads.map((r) => `<span>${refLink(r)}</span>`);
  if (!c.older.length) return shown.join("");
  const id = `threads-${key}`;
  return [
    ...shown,
    `<button type="button" data-toggle="${escapeHtml(id)}" class="rounded px-1 text-muted hover:bg-soft hover:text-ink aria-expanded:text-ink" aria-expanded="false" title="${escapeHtml(t("board.line.olderThreads.tip"))}">${escapeHtml(t("board.line.olderThreads", { n: c.older.length }))}</button>`,
    `<span id="${escapeHtml(id)}" data-panel hidden class="inline-flex flex-wrap gap-x-4 gap-y-1">${c.older.map((r) => `<span>${refLink(r)}</span>`).join("")}</span>`,
  ].join("");
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
/** The secondary button in a dense line (a task's line, the stale line): same look, 24 px. */
const BTN_SM = "inline-flex h-6 items-center rounded-md border border-line bg-surface px-2 text-[12.5px] font-medium text-ink hover:bg-soft disabled:cursor-not-allowed disabled:opacity-50";
const BTN_TEXT = "inline-flex h-7 items-center whitespace-nowrap rounded-md px-2 text-[12.5px] font-medium text-muted hover:bg-soft hover:text-ink";

/** The keyboard key that triggers the primary button, inside the button. */
const KEY_HINT = `<span class="ml-2 text-[11.5px] font-medium opacity-60" aria-hidden="true">g g</span>`;

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

/** A merge request in production for longer than this no longer needs its own row: it joins the shipped line. */
const SHIPPED_AFTER_MS = 60 * 60_000;

/**
 * The merge requests: those still moving keep a full row; those in production for more than an hour fold into one
 * line of links, the state and the titles being settled.
 */
function deliveryRows(mrs: Delivery[], ctx: BoardContext): string {
  const now = nowOf(ctx);
  const settled = (d: Delivery) => d.stage === "prod" && !d.blocker && d.at !== null && now - Date.parse(d.at) > SHIPPED_AFTER_MS;
  const shipped = mrs.filter(settled);
  const moving = mrs.filter((d) => !settled(d)).map((d) => deliveryRow(d, ctx));
  if (shipped.length < 2) return mrs.map((d) => deliveryRow(d, ctx)).join("");
  const links = shipped.map((d) => `<a href="${escapeHtml(d.url)}" target="_blank" rel="noopener" title="${escapeHtml(mrTitle(d.title))}" class="font-mono text-[12.5px] text-link hover:underline underline-offset-2">${escapeHtml(d.repo)}!${d.iid}</a>`).join(" ");
  const line = `<li class="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">${badge(t("board.delivery.shipped", { n: shipped.length }), STAGE_TONE.prod, false, "")}${links}</li>`;
  return [...moving, line].join("");
}

const DUE_CLASS: Record<DueView["state"], string> = { past: "text-warn", soon: "text-ink font-medium", later: "text-muted" };

function dueRow(d: DueView, ctx: BoardContext): string {
  return `<li class="flex flex-wrap items-baseline gap-x-2.5 ${DUE_CLASS[d.state]}"><span class="text-[12.5px]">${when(d.at, ctx)}</span><span>${escapeHtml(clip(d.text, 140))}</span>${d.state === "past" ? `<span class="text-[11.5px] font-medium">${t("board.due.past")}</span>` : ""}</li>`;
}

/**
 * The card may have aged: what the sweep saw, the last relaunch, and a button to have its session revalidate it.
 * Nothing when there is no signal and no recent relaunch, or when the session does not exist.
 */
export function staleLine(l: BoardLine, ctx: BoardContext): string {
  return staleView(l.sujet.key, cardOf(l, { now: nowOf(ctx) }).stale, ctx);
}

function staleView(key: string, st: CardView["stale"], ctx: BoardContext): string {
  if (!st) return "";
  const button = `<button type="button" data-revalidate="${escapeHtml(key)}" title="${escapeHtml(t("board.card.revalidate.tip"))}" class="${BTN_SM}">${t("board.card.revalidate")}</button>`;
  const what = st.signals.length ? t("board.stale.line", { signals: escapeHtml(st.signals.join(t("board.stale.separator"))) }) : "";
  const since = st.requestedAt ? ` <span class="text-muted">${t("board.stale.requested", { when: when(st.requestedAt, ctx) })}</span>` : "";
  return `<p class="flex max-w-[88ch] flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] leading-relaxed text-muted" data-stale>${what ? `<span>${what}</span>` : ""}${since}${st.requestedAt ? "" : button}</p>`;
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
  return `<p class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] ${quiet ? "text-muted" : "text-clear-ink"}" data-posted>${quiet ? "" : `<span class="lamp lamp-green" aria-hidden="true"></span>`}<span>${t("board.posted.at", { at })}</span><span aria-hidden="true">·</span><span><a href="${escapeHtml(m[2])}" target="_blank" rel="noopener" class="underline underline-offset-2">${t("board.posted.view")}</a>${tail}</span>${undo}</p>`;
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
 * Who receives a draft, from the plan the Go covers: its recipients, copies, subject and visibility, on a tool that
 * declares them (mail, support desks). Empty for a plan without them, so a Slack draft renders as it always did.
 */
function audienceLine(plan: ReturnType<typeof planOfTask>): string {
  const p = "plan" in plan ? plan.plan : null;
  const a = p?.actions[0];
  if (!p || !a || (a.kind !== "post" && a.kind !== "reply" && a.kind !== "comment")) return "";
  const audience = a.audience ?? {};
  const subject = a.kind !== "comment" ? a.subject : undefined;
  // a tool that has subjects and a task that names none: the person still sees, before the Go, which one goes out
  const ownSubject = a.kind !== "comment" && !subject && descriptorOf(p.provider)?.audience?.[a.kind]?.subject;
  const parts = [
    ...(audience.to?.length ? [t("board.draft.to", { list: audience.to.join(", ") })] : []),
    ...(audience.cc?.length ? [t("board.draft.cc", { list: audience.cc.join(", ") })] : []),
    ...(subject ? [t("board.draft.subject", { subject })] : []),
    ...(ownSubject ? [t(a.kind === "reply" ? "board.draft.subjectThread" : "board.draft.subjectNone")] : []),
    ...(audience.visibility ? [t(audience.visibility === "internal" ? "board.draft.visibility.internal" : "board.draft.visibility.public")] : []),
  ];
  return parts.length ? `\n<p class="mt-1 break-words text-[12.5px] leading-snug text-muted" data-draft-audience>${parts.map(escapeHtml).join(" · ")}</p>` : "";
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
 * The box of a structured action on a ticket (`act=setStatus` or `act=assign`): the sentence of the change, its
 * target as a link to the ticket, and a Go that the server carries out through the gate (`/api/act-task`), with the
 * hash of the plan shown (`data-sha`). Nothing in it is free text but the value, which is escaped.
 */
function actBox(s: Sujet, x: Task, hint: boolean, ops: string, shadow: boolean): string {
  const dest = resolveTarget(s, { to: x.to?.trim() || s.key });
  const plan = planOfTask(s, x);
  const why = "plan" in plan ? "" : plan.message;
  const href = isResolved(dest) ? targetLink(dest) : null;
  const name = escapeHtml((isResolved(dest) ? dest.target.label : dest.label) || "?");
  const target = href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener" data-act-dest class="text-link hover:underline underline-offset-2">${name}</a>` : `<span class="text-muted">${name}</span>`;
  // the sentence is escaped whole, then the target's link takes the place of its marker
  const MARK = "\u0001";
  const sentence = escapeHtml(t(x.act === "setStatus" ? "board.act.setStatus" : "board.act.assign", { target: MARK, value: x.value ?? "" })).replace(MARK, target);
  const tool = dest.provider ? providerLabel(dest.provider) : "?";
  const maybe = unknownOf(x, Date.now());
  const sha = "plan" in plan ? ` data-sha="${planSha(plan.plan)}"` : "";
  const button = shadow
    ? shadowButton()
    : `<button type="button" data-act-go class="${BTN_PRIMARY}"${why ? ` disabled title="${escapeHtml(why)}"` : ` title="${escapeHtml(t("board.act.go.tip"))}"`}>${t(maybe && !why ? "board.js.post.again" : "board.task.go")}${hint && !why ? KEY_HINT : ""}</button>`;
  const status = why ? escapeHtml(why) : maybe ? escapeHtml(t("gate.mayHaveGone", { id: x.id, link: maybe.link ?? s.permalink })) : "";
  return `<div class="cursor-auto rounded-lg border border-accent/40 bg-accent-soft/30 px-4 py-3" data-actbox data-key="${escapeHtml(s.key)}" data-task="${escapeHtml(x.id)}"${sha}${maybe ? " data-retry" : ""}>
<div class="text-[12.5px] font-semibold text-accent-ink">${escapeHtml(t("board.act.label", { tool }))}</div>
<p class="mt-1 max-w-[88ch] text-[13.5px] leading-relaxed text-ink">${sentence}</p>
<div class="mt-2.5 flex items-center gap-2">${button}<span class="min-w-0 truncate text-[12.5px] ${why || maybe ? "text-warn" : "text-muted"}" data-go-status>${status}</span>${ops}</div>
</div>`;
}

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
  if (x.kind === "action" && x.act) return actBox(s, x, hint, ops, shadow);
  if (text) {
    const dest = resolveTarget(s, x);
    const tool = dest.provider;
    const max = tool ? maxTextOf(tool) : null;
    // a destination the board cannot post to (another tool, an edit): the go goes to the session with the exact text
    const handed = handedToSession(s, x);
    const why = handed ? "" : !isResolved(dest) ? dest.error : max !== null && text.length > max ? t("board.draft.tooLong", { tool: providerLabel(dest.provider), n: text.length }) : "";
    const legacy = !x.draft?.trim();
    // the action does more than post (merge then post…): Go to the session, which runs everything in order
    const viaSession = !postOnlyAction(x);
    // the last send may have gone out (no answer, or a board that stopped mid-send): said before any new click, and
    // Send becomes "Send again" (data-retry), which tells the gate the person checked
    const maybe = unknownOf(x, Date.now());
    const postButtons = `<div class="mt-2.5 flex flex-wrap items-center gap-1.5">${shadow ? shadowButton() : `<button type="button" data-post class="${BTN_PRIMARY}"${why ? ` disabled title="${escapeHtml(why)}"` : ` title="${escapeHtml(t("board.draft.send.tip"))}"`}><span data-label>${t(maybe && !why ? "board.js.post.again" : "board.draft.send")}</span>${keyHint}</button>`}<button type="button" data-edit class="${BTN}">${t("board.draft.edit")}</button><button type="button" data-copy class="${BTN}">${t("board.draft.copy")}</button>${ops}</div>`;
    // handed to the session: Go sends it the exact text (edited or not); Edit and Copy stay
    const handedButtons = `<div class="mt-2.5 flex flex-wrap items-center gap-1.5">${shadow ? shadowButton() : `<button type="button" data-go="${key}" data-task="${id}" class="${BTN_PRIMARY}" title="${escapeHtml(t("board.draft.handed.tip"))}">${t("board.draft.handed")}${keyHint}</button>`}<button type="button" data-edit class="${BTN}">${t("board.draft.edit")}</button><button type="button" data-copy class="${BTN}">${t("board.draft.copy")}</button><span class="min-w-0 truncate text-[12.5px] text-muted" data-go-status></span>${ops}</div>`;
    // the hash of the plan shown: Send sends it back, and the gate acts only if the task still hashes to it
    const plan = planOfTask(s, x);
    const sha = "plan" in plan ? ` data-sha="${planSha(plan.plan)}"` : "";
    return `<form class="cursor-auto rounded-lg border border-accent/40 bg-accent-soft/30 px-4 py-3" data-draft data-key="${key}" data-task="${id}" data-draft-to="${escapeHtml(x.draftTo ?? "")}"${sha}${maybe ? " data-retry" : ""} data-postable="${why || viaSession || handed || shadow ? "0" : "1"}">
<div class="flex items-center gap-2 text-[12.5px]"><span class="font-semibold text-accent-ink">${t("board.draft.label")}</span>${draftToLink(x, dest)}<span class="ml-auto shrink-0 text-[11.5px] tabular-nums text-muted">${t("board.draft.chars", { n: text.length })}</span></div>${audienceLine(plan)}
<div class="mt-1.5 max-h-80 max-w-[88ch] overflow-y-auto whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink" data-draft-text>${draftHtml(tool ?? providerOfKey(s.key), text)}</div>
<textarea name="draft" rows="${Math.min(14, Math.max(4, text.split("\n").length + Math.ceil(text.length / 90)))}" hidden data-draft-edit class="mt-1.5 w-full resize-y rounded-md border border-line bg-bg px-2.5 py-2 text-[13.5px] leading-relaxed focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20">${escapeHtml(text)}</textarea>
${legacy ? `<p class="mt-1 text-[11.5px] text-muted">${t("board.draft.legacy")}</p>` : ""}
${viaSession ? `<div class="mt-2.5 flex flex-wrap items-center gap-2">${shadow ? shadowButton() : `<button type="button" data-go="${key}" data-task="${id}" class="${BTN_PRIMARY}" title="${escapeHtml(t("board.draft.viaSession.tip"))}">${t("board.draft.viaSession")}${keyHint}</button>`}<span class="min-w-0 truncate text-[12.5px] text-muted" data-go-status>${escapeHtml(truncate(x.action ?? "", 140))}</span>${ops}</div>` : handed ? handedButtons : postButtons}
<p class="mt-1.5 text-[12.5px] leading-snug ${why || maybe ? "text-warn" : "text-muted"} empty:hidden" data-draft-status>${why ? escapeHtml(why) : handed && !isResolved(dest) ? escapeHtml(t("board.draft.handed.why", { why: dest.error })) : maybe ? escapeHtml(t("gate.mayHaveGone", { id: x.id, link: maybe.link ?? s.permalink })) : ""}</p>
</form>`;
  }
  if (x.action?.trim() && sendsUnseenMessage(x)) {
    // posting words the person never saw: no Go, the session is asked for one draft per message
    return `<div class="cursor-auto rounded-lg border border-warn/40 bg-warn-soft/30 px-4 py-3" data-key="${key}" data-task="${id}" data-unseen>
<div class="text-[12.5px] font-semibold text-warn">${t("board.card.onYourGo")}</div>
<p class="mt-1 max-w-[88ch] text-[13.5px] leading-relaxed text-ink">${escapeHtml(x.action.replace(/\\n/g, " "))}</p>
<p class="mt-1.5 text-[12.5px] leading-snug text-warn">${escapeHtml(t("board.task.textsMissing"))}</p>
<div class="mt-2.5 flex items-center gap-2"><button type="button" data-ask-texts="${key}" data-msg="${escapeHtml(t("task.askTexts", { id: x.id }))}" class="${BTN}" title="${escapeHtml(t("board.task.askTexts.tip"))}">${escapeHtml(t("board.task.askTexts"))}</button><span class="min-w-0 truncate text-[12.5px] text-muted" data-go-status></span>${ops}</div>
</div>`;
  }
  if (x.action?.trim()) {
    return `<div class="cursor-auto rounded-lg border border-accent/40 bg-accent-soft/30 px-4 py-3" data-gocard data-key="${key}" data-task="${id}">
<div class="text-[12.5px] font-semibold text-accent-ink">${t("board.card.onYourGo")}</div>
<p class="mt-1 max-w-[88ch] text-[13.5px] leading-relaxed text-ink">${escapeHtml(x.action.replace(/\\n/g, " "))}</p>
<div class="mt-2.5 flex items-center gap-2">${shadow ? shadowButton() : `<button type="button" data-go="${key}" data-task="${id}" class="${BTN_PRIMARY}" title="${escapeHtml(t("board.task.go.tip"))}">${t("board.task.go")}${keyHint}</button>`}<span class="min-w-0 truncate text-[12.5px] text-muted" data-go-status></span>${ops}</div>
</div>`;
  }
  const missing = x.kind === "draft" ? `<p class="mr-auto text-[12.5px] text-warn">${escapeHtml(t("board.task.draftMissing"))}</p>` : "";
  // no box: Done and Drop on the right, where the draft and the action boxes put them
  return `<div class="flex flex-wrap items-center gap-2" data-task-ops>${missing}${ops}</div>`;
}

/**
 * Light markdown for what sessions write in prose (last word, proposal): **bold** and `code`, escaped first. Display
 * only: what a button sends is the raw text.
 */
export function mdLite(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong class="font-semibold text-ink">$1</strong>')
    .replace(/`([^`\n]+?)`/g, '<code class="rounded bg-soft px-1 font-mono text-[12.5px]">$1</code>');
}

/** A task's need at reading weight: its first sentence semibold, the rest normal, so a long ask never reads as a shout. */
function needHtml(need: string): string {
  const m = need.match(/^(.{8,160}?[.?!:])(\s+[\s\S]*)$/);
  return m ? `<span class="font-semibold text-ink">${escapeHtml(m[1])}</span>${escapeHtml(m[2])}` : need.length <= 160 ? `<span class="font-semibold text-ink">${escapeHtml(need)}</span>` : escapeHtml(need);
}

/** The kind of a task, in the colours of what it asks: a decision, an answer, a draft to read, a go on an action. */
const KIND_CHIP: Record<CardTask["kind"], string> = {
  decide: "bg-accent-soft text-accent-ink",
  answer: "bg-wait-soft text-wait-ink",
  draft: "bg-link/10 text-link",
  go: "bg-warn-soft text-warn",
};
/** The task's id ("t2") before its kind: the name the person uses to point a session at it ("go on t2"). */
const kindChip = (k: CardTask["kind"], id: string) => `<span class="shrink-0 font-mono text-[11.5px] tabular-nums text-muted" data-task-id>${escapeHtml(id)}</span><span class="inline-flex h-5 shrink-0 items-center rounded px-1.5 text-[11.5px] font-semibold ${KIND_CHIP[k]}">${escapeHtml(t(`board.card.kind.${k}` as MessageKey))}</span>`;

/**
 * One open task: a line with its kind, its need and its age (tinted by its own freshness), and its body (proposal,
 * then the draft, the action or the decision's buttons). The first open task is expanded; the others stay on one
 * line, and their button only opens them in place: a folded draft or command is never sent from its line. The body is
 * a panel (`data-panel`): what the person opened or folded survives the redraws. The id stays in data attributes.
 */
export function taskBlock(s: Sujet, x: CardTask, hint = false): string {
  const fresh = freshness(x.ageMs);
  const k = escapeHtml(s.key);
  const id = escapeHtml(x.id);
  const body = `tb-${k}#${id}`;
  const expanded = x.open ? "true" : "false";
  const proposalText = (x.task.proposal ?? "").replace(/\\n/g, "\n").trim();
  const proposal = proposalText ? `<p class="max-w-[88ch] whitespace-pre-wrap text-[13.5px] leading-snug text-ink/85" data-proposal>${mdLite(proposalText)}</p>` : "";
  // a decision or a question whose proposal is on screen: one click approves exactly that text, through the session
  const approvable = (x.kind === "decide" || x.kind === "answer") && proposalText && !taskDraftText(x.task) && !x.task.action?.trim() && s.sessionId;
  const open = `<button type="button" data-toggle="${body}" aria-expanded="${expanded}" class="${BTN_SM} shrink-0 group-aria-expanded:hidden" title="${escapeHtml(t("board.card.task.open.tip"))}">${escapeHtml(t(x.kind === "draft" ? "board.card.task.review" : "board.card.task.view"))}</button>`;
  return `<div class="border-t border-line first:border-t-0" id="task-${k}#${id}" data-task-item data-task="${id}" data-task-fresh style="--fh:${fresh.h};--fk:${fresh.k}">
<div role="button" tabindex="0" data-toggle="${body}" aria-expanded="${expanded}" class="group flex cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-soft/40" title="${escapeHtml(x.task.ask.replace(/\\n/g, " "))}">${kindChip(x.kind, x.id)}<span class="min-w-0 flex-1 truncate text-[13.5px] text-ink/85 group-aria-expanded:whitespace-normal">${needHtml(x.need)}</span><span class="shrink-0 text-[12.5px] tabular-nums text-muted"><span data-age>${escapeHtml(x.age)}</span></span>${open}</div>
<div id="${body}" data-panel${x.open ? "" : " hidden"} class="flex cursor-auto flex-col gap-2.5 px-3 pb-3">${proposal}${approvable ? approveRow(s, x, proposalText) : taskBox(s, x.task, hint)}</div>
</div>`;
}

/**
 * The buttons of a decision or a question with a proposal: Approve writes "go: <the proposal shown>" to the session,
 * through the same endpoint as the instruction form (nothing goes to the thread from here); Answer something else
 * opens that form. Done and Drop on the right.
 */
function approveRow(s: Sujet, x: CardTask, proposal: string): string {
  const k = escapeHtml(s.key);
  const msg = t("board.card.task.approve.text", { proposal });
  const approve = settings().workers.shadow || msg.length > 4000 ? "" : `<button type="button" data-validate data-key="${k}" data-task="${escapeHtml(x.id)}" data-msg="${escapeHtml(msg)}" class="${BTN_PRIMARY}" title="${escapeHtml(t("board.card.task.approve.tip"))}">${escapeHtml(t("board.card.task.approve"))}</button>`;
  return `<div class="flex flex-wrap items-center gap-2" data-approve>${approve}<button type="button" data-write-open="${k}" class="${BTN}">${escapeHtml(t("board.card.task.other"))}</button><span class="min-w-0 truncate text-[12.5px] text-muted" data-go-status></span>${taskOps(s.key, x.task)}</div>`;
}

/** The tasks of a card, oldest first. g g sends the first one when it is ready: the only one expanded by default. */
function tasksStack(s: Sujet, tasks: CardTask[]): string {
  if (!tasks.length) return "";
  const hint = taskReady(tasks[0].task) ? tasks[0].id : null;
  return `<div class="flex flex-col overflow-hidden rounded-lg border border-line bg-surface" data-tasks>${tasks.map((x) => taskBlock(s, x, x.id === hint)).join("")}</div>`;
}

/** The action zone of a card: its open tasks. Empty when none is open: a closed task never shows a Go nor an amber box. */
export function actionCard(l: BoardLine, ctx?: BoardContext): string {
  return tasksStack(l.sujet, cardTasks(l.sujet, ctx ? nowOf(ctx) : Date.now()));
}

/** The last finished tasks, newest first: what was done or dropped, when, and why; the rest is in the report. */
function finishedField(s: Sujet, c: CardContext, ctx: BoardContext): string {
  if (!c.finished.length) return "";
  const item = (x: Task) =>
    `<li class="flex flex-wrap items-baseline gap-x-2 text-[12.5px]" data-closed-task="${escapeHtml(x.id)}"><span class="font-medium ${x.status === "done" ? "text-clear-ink" : "text-muted"}">${escapeHtml(t(x.status === "done" ? "board.task.status.done" : "board.task.status.dropped"))}</span>${when(x.closedAt ?? x.updatedAt, ctx)}<span class="min-w-0 text-ink/85">${escapeHtml(clip(x.ask, 120))}</span>${x.note ? `<span class="min-w-0 text-muted">${textToHtml(clip(x.note, 200))}</span>` : ""}</li>`;
  const more = c.finishedCount - c.finished.length;
  const rest = more > 0 ? `<li><a href="/?sujet=${encodeURIComponent(s.key)}" class="text-[12.5px] text-link hover:underline underline-offset-2">${escapeHtml(t("board.card.ctx.finishedMore", { n: more }))}</a></li>` : "";
  return fieldRow(escapeHtml(t("board.card.closedTasks")), `<ul class="flex flex-col gap-1">${c.finished.map(item).join("")}${rest}</ul>`);
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


/** The colour of the status line: the board's tones, amber for what waits on the person served. */
const STATUS_INK: Record<Tone, string> = { accent: "text-accent-ink", warn: "text-warn", clear: "text-clear-ink", wait: "text-wait-ink", muted: "text-muted" };
const PULSE = `<span class="relative inline-flex h-1.5 w-1.5"><span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60 motion-reduce:hidden"></span><span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-current"></span></span>`;

/** The one line that says the session's state: a sentence, its age, and the time the card was written on hover. */
function statusView(c: CardView, cardAt: string, ctx: BoardContext): string {
  const st = c.status;
  const tip = [st.text, t("board.card.status.cardAt", { time: ctx.timeOf(cardAt) }), ...(st.source ? [t(`board.card.status.source.${st.source}`)] : [])].join("\n");
  const age = st.age ? `<span class="text-muted" data-age>· ${escapeHtml(st.age)}</span>` : "";
  return `<span class="inline-flex min-w-0 max-w-full items-center gap-1.5 text-[12.5px] font-medium tabular-nums ${STATUS_INK[st.tone]}" data-status-kind="${st.kind}" title="${escapeHtml(tip)}">${st.pulse ? PULSE : shape(st.tone)}<span class="min-w-0 truncate">${escapeHtml(st.text)}</span>${age ? `<span class="shrink-0">${age}</span>` : ""}</span>`;
}

/** The last message of the thread, in its author's words: the quote itself opens it in the tool, like its age. */
function saidView(c: CardView, ctx: BoardContext): string {
  const m = c.said;
  if (!m) return "";
  const age = m.age ? `<time datetime="${escapeHtml(m.at)}" title="${escapeHtml(ctx.timeOf(m.at))}" class="tabular-nums">${escapeHtml(m.age)}</time>` : "";
  const tail = m.url ? `<a href="${escapeHtml(m.url)}" data-open class="shrink-0 whitespace-nowrap text-[12.5px] text-muted hover:text-link hover:underline underline-offset-2" title="${escapeHtml(t("board.card.said.open"))}">${age || "↗"}</a>` : age ? `<span class="shrink-0 whitespace-nowrap text-[12.5px] text-muted">${age}</span>` : "";
  return `<p class="flex min-w-0 max-w-[88ch] items-baseline gap-x-2 text-[13.5px] leading-snug text-ink/85" data-said><span class="shrink-0 font-semibold text-ink">${escapeHtml(m.who)}</span>${m.where ? `<span class="shrink-0 text-muted">${escapeHtml(m.where)}</span>` : ""}${m.text ? (m.url ? `<a href="${escapeHtml(m.url)}" data-open class="min-w-0 hover:text-link hover:underline underline-offset-2" title="${escapeHtml(t("board.card.said.open"))}"><q class="italic">${escapeHtml(m.text)}</q></a>` : `<q class="min-w-0 italic">${escapeHtml(m.text)}</q>`) : ""}${tail}</p>`;
}

/** What the session said since the card was written. */
function wordView(c: CardView, ctx: BoardContext): string {
  const w = c.word;
  if (!w) return "";
  const age = w.age ? ` · <time datetime="${escapeHtml(w.at)}" title="${escapeHtml(ctx.timeOf(w.at))}" class="tabular-nums">${escapeHtml(w.age)}</time>` : "";
  const id = `word-${c.key}`;
  // two buttons, one shown: the clamp class on the text (kept across redraws) says which
  const btn = (label: string, cls: string) => `<button type="button" data-expand-for="${escapeHtml(id)}" class="${cls} mt-0.5 text-[12.5px] font-medium text-muted hover:text-ink">${label}</button>`;
  const more = w.text.length > 160 ? `${btn(t("board.card.word.more"), "hidden peer-[.line-clamp-2]:inline")}${btn(t("board.card.word.less"), "peer-[.line-clamp-2]:hidden")}` : "";
  return `<div class="flex min-w-0 max-w-[88ch] items-baseline gap-x-2 gap-y-0.5 text-[12.5px] leading-snug text-muted max-sm:flex-col max-sm:items-stretch" data-word><span class="shrink-0">${t("board.card.word")}${age}</span><div class="flex min-w-0 flex-col items-start"><p id="${escapeHtml(id)}" data-expand="line-clamp-2" class="peer line-clamp-2 w-full whitespace-pre-wrap text-ink/80 [overflow-wrap:anywhere]">${mdLite(w.text)}</p>${more}</div></div>`;
}

/** The plan in one strip: ✓ done, ● now, ○ next. */
function planView(c: CardView): string {
  const p = c.plan;
  if (!p) return "";
  const glyph = { done: "✓", now: "●", todo: "○" } as const;
  const cls = { done: "text-muted/70", now: "font-semibold text-ink", todo: "text-muted" } as const;
  const mark = { done: "", now: "text-accent", todo: "" } as const;
  const item = (state: keyof typeof glyph, text: string) => `<li class="inline-flex items-baseline gap-1.5 ${cls[state]}"><span class="${mark[state]}" aria-hidden="true">${glyph[state]}</span><span>${escapeHtml(text)}</span></li>`;
  const items = [...(p.doneHidden ? [item("done", t(p.doneHidden > 1 ? "board.card.plan.doneHidden.other" : "board.card.plan.doneHidden.one", { n: p.doneHidden }))] : []), ...p.steps.map((x) => item(x.state, x.text)), ...(p.todoHidden ? [`<li class="text-muted">+${p.todoHidden}</li>`] : [])];
  return `<ol class="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] leading-snug" data-plan aria-label="${escapeHtml(t("board.card.plan"))}">${items.join("")}</ol>`;
}

/** A card without open task: its request and proposal, or where it stands. */
function needView(c: CardView): string {
  const n = c.need;
  if (!n) return "";
  return `<div class="flex max-w-[88ch] flex-col gap-1 text-[13.5px] leading-snug" data-need>${n.ask ? `<p class="text-ink">${escapeHtml(n.ask)}</p>` : ""}${n.proposal ? `<p class="text-ink/80">${escapeHtml(n.proposal)}</p>` : ""}${n.summary ? `<p class="text-ink/80">${escapeHtml(n.summary)}</p>` : ""}</div>`;
}

/** The context, folded behind one line of counts: origin, threads, merge requests, the next due date, finished tasks. Open in the focus mode's detail. */
function contextView(l: BoardLine, c: CardView, ctx: BoardContext, open = false): string {
  const s = l.sujet;
  const x = c.context;
  const k = escapeHtml(s.key);
  const now = nowOf(ctx);
  const bits = [escapeHtml(t("board.line.askerIn", { asker: x.asker, where: x.origin.label }))];
  if (x.threadCount > 1) bits.push(escapeHtml(t("board.card.ctx.threads", { n: x.threadCount })));
  if (x.mrs.length) {
    const text = x.mrProd === x.mrs.length ? t("board.card.ctx.mrsProd", { n: x.mrProd }) : x.mrProd ? t("board.card.ctx.mrsSome", { n: x.mrs.length, p: x.mrProd }) : t("board.card.ctx.mrs", { n: x.mrs.length });
    bits.push(`<span class="${x.mrHard ? "text-warn" : x.mrProd === x.mrs.length ? "text-clear-ink" : ""}">${escapeHtml(text)}</span>`);
  }
  if (x.dueSoon) bits.push(`<span class="${x.dueSoon.state === "past" ? "text-warn" : "font-medium text-ink"}">${escapeHtml(ago(x.dueSoon.at, now))}</span>`);
  if (x.finishedCount) bits.push(escapeHtml(t(x.finishedCount > 1 ? "board.card.ctx.finished.other" : "board.card.ctx.finished.one", { n: x.finishedCount })));
  const id = `card-${s.key}`;
  const summary = `<button type="button" data-toggle="${escapeHtml(id)}" aria-expanded="${open}" class="group -ml-2 inline-flex w-fit max-w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md px-2 py-0.5 text-left text-[12.5px] text-muted hover:bg-soft hover:text-ink aria-expanded:text-ink" title="${escapeHtml(t(speaksCode() ? "board.card.ctx.tip" : "board.card.ctx.tip.noCode"))}" data-ctx><span class="inline-block transition-transform group-aria-expanded:rotate-90" aria-hidden="true">▸</span>${bits.join(`<span class="text-muted/60" aria-hidden="true">·</span>`)}</button>`;
  const list = (items: string) => `<ul class="flex min-w-0 flex-col gap-1 text-[12.5px]">${items}</ul>`;
  const prose = (v: string) => `<div class="whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink/85">${textToHtml(v)}</div>`;
  const live = l.running === "busy" || agentCounts(l.agents).running > 0 ? trailBlock(l, ctx) : "";
  const rows = [
    fieldRow(escapeHtml(t("board.card.ctx.origin")), `<span class="text-[13.5px] text-ink/85">${t("board.line.askerIn", { asker: escapeHtml(x.asker), where: refLink(x.origin) })}</span>`),
    x.threads.length || x.older.length ? fieldRow(escapeHtml(t("board.card.ctx.threadsLabel")), `<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px]">${threadLinks(s.key, x)}</div>`) : "",
    x.mrs.length ? fieldRow(t("board.card.delivery"), list(deliveryRows(x.mrs, ctx)), " data-delivery") : "",
    x.dues.length ? fieldRow(t("board.card.due"), list(x.dues.map((d) => dueRow(d, ctx)).join(""))) : "",
    live ? fieldRow(escapeHtml(t("board.card.ctx.session")), live) : "",
    x.why ? fieldRow(escapeHtml(t("board.card.why", { owner: settings().owner.name })), prose(x.why)) : "",
    x.unverified ? fieldRow(t("board.card.unverified"), prose(x.unverified)) : "",
    x.summary ? fieldRow(t("board.card.summary"), prose(x.summary)) : "",
    finishedField(s, x, ctx),
  ].filter(Boolean);
  return `${summary}
<div id="card-${k}" data-panel${open ? "" : " hidden"} class="cursor-auto"><dl class="flex flex-col gap-2.5 rounded-lg bg-bg px-4 py-3">${rows.join("")}</dl></div>`;
}

/**
 * Ready-made answers, under the message: one click sends them to the session. "go" disappears when the card already has
 * its Go or Send button. The "go" text is a protocol value (the server and the go lock recognise it): it is never
 * translated.
 */
const chips = (): { label: string; text: string }[] => [
  { label: "go", text: "go" },
  { label: t("board.chip.later"), text: t("board.chip.later.text") },
  { label: t("board.chip.dig"), text: t("board.chip.dig.text") },
];

const CHIP = "inline-flex h-6 items-center rounded-full border border-muted/50 px-2 text-[11.5px] text-ink/80 hover:border-ink/60 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40";

/**
 * "it's settled": not a message to the session but the board's own close, the same as the "…" menu's "Settled ✅":
 * the topic closes and, on a tool with a settled marker, ✅ goes on its original message (the click is the Go). It
 * asks for a second click ("Close and add ✅?"); on a ticket it only closes.
 */
export function settledChip(s: Pick<Sujet, "key">): string {
  const key = escapeHtml(s.key);
  return hasDoneMarker(s.key)
    ? `<button type="button" data-confirm="settle" data-key="${key}" title="${escapeHtml(t("board.chip.settled.tip"))}" class="${CHIP}">${escapeHtml(t("board.chip.settledCheck"))}</button>`
    : `<button type="button" data-confirm="close" data-key="${key}" title="${escapeHtml(t("board.chip.settled.tipNoMarker"))}" class="${CHIP}">${escapeHtml(t("board.chip.settled"))}</button>`;
}

/** The instruction to the session, folded under "Write to X": the most frequent action, one click away. Always shown in the focus mode's detail. */
function writePanel(l: BoardLine, c: CardView, open = false): string {
  const s = l.sujet;
  const key = escapeHtml(s.key);
  // in shadow mode the go chip is hidden too: nothing goes out on a go
  const shown = chips().filter((x) => !(x.text === "go" && (c.tasks.length || settings().workers.shadow)));
  return `<div id="write-${key}" data-panel${open ? "" : " hidden"} class="cursor-auto">
<form class="flex flex-col gap-2" id="send-${key}" data-send data-key="${key}">
<textarea name="text" rows="2" required placeholder="${escapeHtml(t("board.send.placeholder"))}" title="${escapeHtml(t("board.send.tip"))}" class="w-full resize-y rounded-lg border border-line bg-bg px-3 py-2 text-[13.5px] leading-relaxed placeholder:text-muted focus:border-muted focus:outline-none focus:ring-2 focus:ring-ink/10"></textarea>
<div class="flex flex-wrap items-center gap-1">${shown.map((x) => `<button type="button" data-chip="${escapeHtml(x.text)}" class="${CHIP}">${escapeHtml(x.label)}</button>`).join("")}${settledChip(s)}<span class="ml-auto flex items-center gap-3"><span class="min-w-0 truncate text-[12.5px] text-muted" data-status></span><button type="submit" class="${BTN}">${t("board.send.button", { letter: escapeHtml(s.letter) })}<span class="ml-1.5 font-normal text-muted">⌘↩</span></button></span></div>
</form>
</div>`;
}

/**
 * The "…" menu's close: "Settled ✅" closes the topic and puts ✅ on its original message (the click is the Go on it),
 * "Close without ✅" only closes. A topic whose tool has no settled marker (a ticket) keeps a single "Close".
 */
function closeItems(s: Pick<Sujet, "key">, item: string): string {
  const key = escapeHtml(s.key);
  const quiet = (label: string, tip: string) => `<button type="button" data-confirm="close" data-key="${key}" class="${item} hover:bg-warn-soft hover:text-warn" title="${escapeHtml(tip)}">${label}</button>`;
  if (!hasDoneMarker(s.key)) return quiet(t("board.session.close"), t("board.session.close.tip"));
  return `<button type="button" data-confirm="settle" data-key="${key}" class="${item} hover:bg-clear-soft hover:text-clear-ink" title="${escapeHtml(t("board.session.settle.tip"))}">${t("board.session.settle")}</button>${quiet(t("board.session.closeQuiet"), t("board.session.closeQuiet.tip"))}`;
}

/** The tools of the card: write to the session (when its form is folded), its terminal, the report, and the rare actions behind "…". */
function toolsRow(l: BoardLine, writeToggle = true): string {
  const s = l.sujet;
  const key = escapeHtml(s.key);
  const live = !!s.sessionId;
  const item = "flex w-full items-center whitespace-nowrap rounded px-2.5 py-1 text-left text-[12.5px] text-ink hover:bg-soft";
  const snooze = `<p class="px-2.5 pb-0.5 pt-1 text-[11.5px] font-medium text-muted" title="${escapeHtml(t("board.snooze.tip"))}">${t("board.snooze")}</p>${["1h", "pm", "eod", "tomorrow"].map((w) => `<button type="button" data-snooze="${w}" data-key="${key}" class="${item}"></button>`).join("")}<form data-snooze-date data-key="${key}" class="mt-1 flex flex-col gap-1.5 border-t border-line px-1.5 pb-1 pt-2"><span class="text-[11.5px] font-medium text-muted">${t("board.snooze.until")}</span><div class="flex gap-1.5"><input type="date" name="day" required class="min-w-0 flex-1 rounded border border-line bg-bg px-1.5 py-0.5 text-[12.5px] text-ink"><input type="time" name="hour" value="09:00" required class="w-[88px] rounded border border-line bg-bg px-1.5 py-0.5 text-[12.5px] text-ink"></div><input type="text" name="reason" maxlength="200" placeholder="${escapeHtml(t("board.snooze.reason"))}" class="rounded border border-line bg-bg px-1.5 py-0.5 text-[12.5px] text-ink placeholder:text-muted"><button type="submit" class="${BTN} self-start">${t("board.snooze.submit")}</button></form>`;
  const session = live
    ? `<div class="my-1 border-t border-line"></div><button type="button" data-confirm="stop" data-key="${key}" class="${item}" title="${escapeHtml(t("board.session.stop.tip"))}">${t("board.session.stop")}</button>${closeItems(s, item)}${settings().ui.iterm ? `<button type="button" data-dive="${key}" class="${item}">iTerm2</button>` : ""}${l.remoteUrl ? `<a href="${escapeHtml(l.remoteUrl)}" data-open class="${item}">claude.ai</a>` : ""}`
    : "";
  const more = `<details class="relative" id="more-${key}" data-snooze-menu data-menu><summary class="inline-flex h-7 cursor-pointer list-none items-center rounded-md px-2.5 text-[15px] font-medium leading-none tracking-widest text-muted hover:bg-soft hover:text-ink [[open]>&]:bg-soft [[open]>&]:text-ink" title="${escapeHtml(t(live ? "board.card.more.tip" : "board.card.more.tipNoSession"))}" aria-label="${escapeHtml(t("board.card.more"))}">…</summary><div class="absolute right-0 top-full z-20 mt-1 flex w-60 flex-col rounded-md border border-line bg-surface p-1 shadow-lg">${snooze}${session}</div></details>`;
  const write = live && !writeToggle ? "" : live ? `<button type="button" data-toggle="write-${key}" aria-expanded="false" class="${BTN_TEXT} aria-expanded:bg-soft aria-expanded:text-ink" title="${escapeHtml(t("board.send.tip"))}">${t("board.send.button", { letter: escapeHtml(s.letter) })}</button>` : `<span class="px-2 text-[12.5px] text-muted">${t("board.session.none")}</span>`;
  const term = live ? `<button type="button" data-term="${key}" data-letter="${escapeHtml(s.letter)}" data-title="${escapeHtml(s.title)}" class="${BTN_TEXT}"${s.shortId ? ` title="${escapeHtml(t("board.session.terminal.tip", { id: s.shortId }))}"` : ""}>${t("board.session.terminal")}</button>` : "";
  return `<div class="-ml-2 flex flex-wrap items-center gap-x-1 gap-y-1" data-tools>${write}${term}<span class="min-w-0 flex-1 truncate px-2 text-[12.5px] text-muted empty:hidden" data-session-status></span><a href="/?sujet=${encodeURIComponent(s.key)}" class="${BTN_TEXT} ml-auto">${t("board.card.report")}</a>${more}</div>`;
}

/** On a line kept in place by the pin: one line saying it stays put, and where it belongs now when that is another block. */
function heldNote(l: BoardLine): string {
  if (!l.pin?.held) return "";
  const text = l.pin.shownIn === l.bloc ? t("board.line.held") : t("board.line.heldMoved", { bloc: escapeHtml(blocTitle(l.bloc)) });
  return `<p data-held-note class="text-[12.5px] text-accent-ink">${text}</p>`;
}

/**
 * The card's first line: the title, the "new" mark, the status. On a flow card the title opens the sheet; ⌘ or Ctrl-click,
 * or the detail's own title, still reaches the report it links to.
 */
function cardHead(l: BoardLine, c: CardView, ctx: BoardContext, sheet: boolean): string {
  const s = l.sujet;
  const opens = sheet ? ` data-sheet-open="${escapeHtml(s.key)}" title="${escapeHtml(t("board.sheet.open.tip"))}"` : "";
  return `<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1"><a href="/?sujet=${encodeURIComponent(s.key)}"${opens} class="min-w-0 text-[15px] font-semibold leading-snug text-ink hover:underline underline-offset-2">${escapeHtml(s.title)}</a><span data-new hidden class="shrink-0 rounded-full bg-soft px-2 py-0.5 text-[11.5px] font-medium leading-4 text-ink">${t("board.line.new")}</span><span class="ml-auto flex min-w-0 max-w-full sm:max-w-[26rem]">${statusView(c, s.updatedAt, ctx)}</span></div>`;
}

/**
 * A topic's card body, rendered from its CardView in the reading order: title and status, the thread's last message,
 * the session's last word, the stale line, the plan, the tasks, the folded context, the tools. The flow card and the
 * focus mode's detail are this body; the detail opens the context and keeps the instruction form shown.
 */
function cardBody(l: BoardLine, c: CardView, ctx: BoardContext, detail: boolean): string {
  const s = l.sujet;
  const blocker = c.blocker ? `<p class="max-w-[88ch] text-[12.5px] leading-snug text-muted" data-blocker-line><span class="font-medium">${t("board.card.blocker")}</span> <span class="text-ink/85" data-blocker>${escapeHtml(c.blocker)}</span></p>` : "";
  const tail = detail ? `${s.sessionId ? writePanel(l, c, true) : ""}\n${toolsRow(l, false)}` : `${toolsRow(l)}\n${s.sessionId ? writePanel(l, c) : ""}`;
  return `${cardHead(l, c, ctx, !detail)}
${saidView(c, ctx)}
${wordView(c, ctx)}
${blocker}
${staleView(s.key, c.stale, ctx)}
${planView(c)}
${needView(c)}
${tasksStack(s, c.tasks)}
${postedLine(s, ctx, Date.now(), l.undoUntil ?? null, l.bloc, l.undoTask ?? null)}
${draftMissing(s)}${heldNote(l)}
${contextView(l, c, ctx, detail)}
${tail}`;
}

const letterChip = (letter: string) => `<span class="inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-md bg-soft px-1.5 text-[13.5px] font-semibold text-ink">${escapeHtml(letter)}</span>`;

/**
 * A topic's card in the flow mode. `inSheet`: its detail is open in the sheet, and the card keeps only its first line
 * and its place: the actions live once on the page, in the sheet, so no id or form exists twice.
 */
export function lineView(l: BoardLine, ctx: BoardContext, inSheet = false): string {
  const s = l.sujet;
  const now = nowOf(ctx);
  const c = cardOf(l, { now, channelNames: CHANNEL_NAMES });
  const sig = `${s.updatedAt}|${l.lastMessage?.at ?? ""}|${l.bloc}`;
  const k = escapeHtml(s.key);
  // what waits on you carries its freshness: a side border and the status's age, from green (recent) to dark red (3 days and more)
  const fresh = l.bloc === "attend" && l.waitingSince ? freshness(now - Date.parse(l.waitingSince)) : null;
  const freshAttr = fresh ? ` data-fresh style="--fh:${fresh.h};--fk:${fresh.k}"` : "";
  const held = l.pin?.held ? " data-held" : "";
  return `<li${freshAttr}${held} id="line-${k}" class="cursor-pointer scroll-mt-20 px-5 py-4 border-b border-line last:border-b-0 hover:bg-soft/40 data-[cursor]:bg-soft/60 data-[held]:bg-accent/5 data-[cursor]:shadow-[inset_3px_0_0_var(--color-ink)]" data-row="card-${k}" data-key="${k}" data-letter="${escapeHtml(s.letter)}" data-sig="${escapeHtml(sig)}">
<div class="flex min-w-0 items-start gap-4">
${letterChip(s.letter)}
<div class="flex min-w-0 flex-1 flex-col gap-2.5">
${inSheet ? `${cardHead(l, c, ctx, true)}\n<p class="text-[12.5px] text-muted" data-in-sheet>${escapeHtml(t("board.sheet.shown"))}</p>` : cardBody(l, c, ctx, false)}
</div>
</div>
</li>`;
}

/** A block's count, discreet: a number in a pill, not a big counter. */
const count = (n: number) => `<span class="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-soft px-1.5 text-[11.5px] font-medium tabular-nums text-muted">${n}</span>`;

function blocView(bloc: Bloc, lines: BoardLine[], ctx: BoardContext, sheetKey: string | null = null): string {
  // the go queue: only the card under the cursor, or the first one, shows its whole draft (CSS .go-queue)
  const list = (ls: BoardLine[], queue = false, quickList = false) => `<ul class="overflow-hidden rounded-lg border border-line bg-surface${queue ? " go-queue" : ""}"${quickList ? " data-quick" : ""}>${ls.map((l) => lineView(l, ctx, l.sujet.key === sheetKey)).join("\n")}</ul>`;
  const p = lines.findIndex((l) => l.pin);
  const others = blocOrder(bloc, lines.filter((_, i) => i !== p));
  const quick = bloc === "attend" ? others.filter(isQuickGo) : [];
  const rest = others.filter((l) => !quick.includes(l));
  // the pinned line keeps its sub-list and its index in the order shown
  if (p >= 0) {
    const pl = lines[p];
    if (pl.pin?.quick) quick.splice(Math.min(p, quick.length), 0, pl);
    else rest.splice(Math.max(0, p - quick.length), 0, pl);
  }
  const sub = (label: string, hint: string, ls: BoardLine[], queue = false, quickList = false) => `<p class="mt-1 flex items-center gap-2 text-[12.5px]" title="${escapeHtml(hint)}"><span class="font-semibold text-ink">${label}</span>${count(ls.length)}</p>${list(ls, queue, quickList)}`;
  const body = !lines.length
    ? `<p class="rounded-lg border border-dashed border-line px-4 py-3 text-[13.5px] text-muted">${blocEmpty(bloc)}</p>`
    : quick.length
      ? `${sub(roleT("board.bloc.quick.title"), roleT("board.bloc.quick.tip"), quick, quick.length > 1, true)}${rest.length ? sub(roleT("board.bloc.decision.title"), roleT("board.bloc.decision.tip"), rest) : ""}`
      : list(rest);
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
  const sub: string[] = [escapeHtml(x.name), escapeHtml(x.branch && speaksCode() ? t("board.session.onBranch", { repo, branch: x.branch }) : repo)];
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
  return `<button type="button" data-revalidate-all title="${escapeHtml(title)}" class="${BTN}">${t("board.header.revalidateAll")}${late ? `<span class="ml-1 text-muted">· ${escapeHtml(t("board.header.revalidateAll.late", vars))}</span>` : ""}</button>`;
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
  const title = t(speaksCode() ? "board.header.revue.tip" : "board.header.revue.tip.noCode");
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
          .map((c) => `<li class="flex gap-2 text-[13.5px] leading-snug text-ink" title="${escapeHtml(c.sha)}"><span class="text-muted" aria-hidden="true">·</span><span class="min-w-0">${escapeHtml(c.text)}</span></li>`)
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

/** The board-wide actions and banners, the same in both modes: revalidate, recheck, the master's answers, the listener. */
function heroView(m: BoardModel, ctx: BoardContext, vctx: BoardContext, lead = ""): string {
  return `<header class="flex flex-col gap-4">
<div class="flex flex-wrap items-center justify-end gap-x-2 gap-y-3">
${lead}${refreshControl(m)}
${revueControl(m)}
</div>
${revueStatus(m, vctx)}
${demandesStatus(m, vctx)}
${syncData(m)}
${process.env.STRATO_DEMO === "1" ? `<p data-demo class="rounded-lg border border-accent/40 bg-accent-soft/30 px-3.5 py-2 text-[13.5px] text-ink">${t("board.demo.banner", { command: `<code class="font-mono text-[12.5px]">${escapeHtml('claude -n strato "/strato setup"')}</code>` })}</p>` : ""}
${m.listener.alive ? "" : `<p class="flex items-center gap-2 rounded-lg border border-warn/40 bg-warn-soft/40 px-3.5 py-2 text-[13.5px] text-warn"><span class="lamp lamp-red lit" aria-hidden="true"></span><span class="min-w-0 [overflow-wrap:anywhere]">${t(m.listener.lastTick ? "board.listener.downSince" : "board.listener.down", { time: m.listener.lastTick ? escapeHtml(ctx.timeOf(m.listener.lastTick)) : "", command: `<code class="font-mono text-[12.5px]">${escapeHtml(masterCommand(ctx.stateDir ?? null))}</code>` })}</span></p>`}
${m.listener.deaf ? `<p class="flex items-center gap-2 rounded-lg border border-warn/40 bg-warn-soft/40 px-3.5 py-2 text-[13.5px] text-warn"><span class="lamp lamp-red lit" aria-hidden="true"></span><span>${t(m.listener.lastEventAt ? "board.listener.deafSince" : "board.listener.deaf", { time: m.listener.lastEventAt ? escapeHtml(ctx.timeOf(m.listener.lastEventAt)) : "" })} ${m.listener.appId ? `<a class="underline underline-offset-2" href="${escapeHtml(slackEventsPage(m.listener.appId))}" target="_blank" rel="noopener">${t("board.listener.reenable")}</a>` : t("board.listener.reenableHere")}.</span></p>` : ""}
</header>`;
}

/**
 * The page's content: review and banners at the top, "waiting on you" and the folded radar below, then "to review",
 * "at work", "waiting on someone", the snoozed topics, the sessions outside Strato and today's closed topics, folded.
 */
export function boardView(m: BoardModel, ctx: BoardContext, sel: string | null = null): string {
  const vctx = { ...ctx, now: ctx.now ?? m.now };
  const inSheet = (sel && openLines(m).find((l) => l.sujet.key === sel)) || null;
  const sk = inSheet ? inSheet.sujet.key : null;
  const hero = heroView(m, ctx, vctx);
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
  // the tab's counter says what really waits on you, wherever a pinned line is shown
  return `<div class="flex flex-col gap-9" data-view="board" data-attend="${openLines(m).filter((l) => l.bloc === "attend").length}">
${hero}
<div class="-mt-4 flex flex-col gap-4">
${blocView("attend", m.attend, vctx, sk)}
${radar(m, vctx)}
</div>
${blocView("revoir", m.revoir, vctx, sk)}
${blocView("travail", m.travail, vctx, sk)}
${blocView("attente", m.attente, vctx, sk)}
${paused}
${sessions}
${closed}${inSheet ? `\n${sheetView(inSheet, vctx)}` : ""}
</div>`;
}

/**
 * The sheet of the flow mode (docs/design/board-modes.md, section 5.1): the topic's detail, the focus mode's own
 * renderer, sliding in from the left so it never covers a terminal docked on the right. `sel` in the URL keeps it open
 * across redraws and reloads; its stable ids let the morph keep what is typed and opened inside it.
 */
function sheetView(l: BoardLine, ctx: BoardContext): string {
  const s = l.sujet;
  return `<div id="sheet" data-sheet data-key="${escapeHtml(s.key)}" class="sheet">
<div class="sheet-backdrop" data-sheet-close aria-hidden="true"></div>
<div class="sheet-panel flex flex-col border-r border-line bg-bg" role="dialog" aria-modal="true" aria-label="${escapeHtml(s.title)}" tabindex="-1" data-sheet-panel>
<div class="sticky top-0 z-[1] flex items-center gap-2 border-b border-line bg-bg/90 px-5 py-2 backdrop-blur max-sm:px-4"><span class="min-w-0 flex-1 truncate text-[12.5px] text-muted">${escapeHtml(t("board.sheet.title"))}</span><button type="button" data-sheet-close class="${BTN_TEXT}" title="${escapeHtml(t("board.sheet.close.tip"))}">${t("board.sheet.close")} <kbd class="ml-1">Esc</kbd></button></div>
<div class="min-w-0 px-6 pb-16 pt-5 max-sm:px-4">
${focusDetail(l, ctx, true)}
</div>
</div>
</div>`;
}

// ------------------------------------------------------------------ focus mode

/** The board's two layouts over the same cards (docs/design/board-modes.md, section 5): flow by default. */
export type BoardMode = "flow" | "focus";

/** The mode a request asks for (`mode`): anything but "focus" is the flow mode. */
export const modeOf = (params: URLSearchParams): BoardMode => (params.get("mode") === "focus" ? "focus" : "flow");

/**
 * What the primary button of a task sends from a focus list row, when one click may send it from there: the button
 * exists in the detail, enabled, with no warning to read first (a send that may have gone, an old-format draft, an
 * audience, a session action), and its whole content fits the row's two-line preview. Null: the row only opens it.
 * `sha` is the hash of the same plan the detail's button carries: the gate checks it either way.
 */
export interface RowAction {
  kind: "post" | "go" | "act" | "validate";
  /** Exactly what is shown and sent: the draft, the action, the change on the ticket, the proposal approved. */
  text: string;
  sha?: string;
  /** The draft's destination, as the detail labels it, and the tool that renders it. */
  dest?: string;
  provider?: string;
  /** What Approve writes to the session. */
  msg?: string;
}

export function rowAction(s: Sujet, x: CardTask): RowAction | null {
  const task = x.task;
  if (settings().workers.shadow || unknownOf(task, Date.now())) return null;
  const fits = (a: RowAction) => (previewFits(a.text) ? a : null);
  if (task.kind === "action" && task.act) {
    const plan = planOfTask(s, task);
    if (!("plan" in plan)) return null;
    const dest = resolveTarget(s, { to: task.to?.trim() || s.key });
    const target = (isResolved(dest) ? dest.target.label : dest.label) || "?";
    return fits({ kind: "act", text: t(task.act === "setStatus" ? "board.act.setStatus" : "board.act.assign", { target, value: task.value ?? "" }), sha: planSha(plan.plan) });
  }
  const draft = taskDraftText(task);
  if (draft) {
    if (!task.draft?.trim() || !postOnlyAction(task)) return null;
    const dest = resolveTarget(s, task);
    if (!isResolved(dest)) return handedToSession(s, task) ? fits({ kind: "go", text: draft, dest: dest.label || "?", provider: dest.provider ?? undefined }) : null;
    const max = maxTextOf(dest.provider);
    if (max !== null && draft.length > max) return null;
    const plan = planOfTask(s, task);
    if (!("plan" in plan) || audienceLine(plan)) return null;
    return fits({ kind: "post", text: draft, sha: planSha(plan.plan), dest: dest.target.label || "?", provider: dest.provider });
  }
  if (task.action?.trim()) return sendsUnseenMessage(task) ? null : fits({ kind: "go", text: task.action.replace(/\\n/g, " ").trim() });
  const proposal = (task.proposal ?? "").replace(/\\n/g, "\n").trim();
  if ((x.kind === "decide" || x.kind === "answer") && proposal && s.sessionId) {
    const msg = t("board.card.task.approve.text", { proposal });
    return msg.length > 4000 ? null : fits({ kind: "validate", text: proposal, msg });
  }
  return null;
}

const BTN_PRIMARY_SM = "inline-flex h-6 shrink-0 items-center rounded-md bg-accent px-2.5 text-[12.5px] font-semibold text-[#1b1406] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40";
const PREVIEW = "ml-1 max-w-[72ch] border-l-2 border-line pl-2.5 text-[12.5px] leading-snug text-muted [overflow-wrap:anywhere]";

/** What a task would send, shown in full beside its one-click button; clipped to two lines when the row only opens it. */
function rowPreview(s: Sujet, x: CardTask, a: RowAction | null): string {
  if (a) {
    const body = a.kind === "post" ? draftHtml(a.provider ?? providerOfKey(s.key), a.text) : a.kind === "validate" ? mdLite(a.text) : escapeHtml(a.text);
    const dest = a.dest ? `<span class="mr-1.5 text-link">→ ${escapeHtml(clip(a.dest, 44))}</span>` : "";
    return `<p class="${PREVIEW} whitespace-pre-wrap text-ink/80" data-row-preview>${dest}${body}</p>`;
  }
  const flat = (v: string) => v.replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
  const draft = taskDraftText(x.task);
  const dest = draft ? resolveTarget(s, x.task) : null;
  const html = draft ? draftHtml(dest?.provider ?? providerOfKey(s.key), flat(draft)) : escapeHtml(flat(x.task.action?.trim() || x.task.proposal?.trim() || ""));
  return html ? `<p class="${PREVIEW} line-clamp-2" data-row-preview>${html}</p>` : "";
}

/** One open task on a list row: its kind, its need, and its button; the first one also shows what that button sends. */
function rowTask(s: Sujet, x: CardTask, first: boolean): string {
  const k = escapeHtml(s.key);
  const id = escapeHtml(x.id);
  const a = first ? rowAction(s, x) : null;
  const open = `<button type="button" data-open-task="tb-${k}#${id}" data-key="${k}" class="${BTN_SM} shrink-0" title="${escapeHtml(t("board.focus.open.tip"))}">${escapeHtml(t("board.focus.open"))}</button>`;
  const label = a?.kind === "post" ? t("board.draft.send") : a?.kind === "validate" ? t("board.card.task.approve") : t("board.task.go");
  const tip = a?.kind === "post" ? t("board.draft.send.tip") : a?.kind === "validate" ? t("board.card.task.approve.tip") : a?.kind === "act" ? t("board.act.go.tip") : t("board.task.go.tip");
  const button = !a
    ? open
    : a.kind === "post"
      ? `<button type="button" data-post class="${BTN_PRIMARY_SM}" title="${escapeHtml(tip)}"><span data-label>${label}</span></button>`
      : a.kind === "go"
        ? `<button type="button" data-go="${k}" data-task="${id}" class="${BTN_PRIMARY_SM}" title="${escapeHtml(tip)}">${label}</button>`
        : a.kind === "act"
          ? `<button type="button" data-act-go class="${BTN_PRIMARY_SM}" title="${escapeHtml(tip)}">${label}</button>`
          : `<button type="button" data-validate data-key="${k}" data-task="${id}" data-msg="${escapeHtml(a.msg ?? "")}" class="${BTN_PRIMARY_SM}" title="${escapeHtml(tip)}">${label}</button>`;
  const line = `<div class="flex min-w-0 items-center gap-2">${kindChip(x.kind, x.id)}<span class="min-w-0 flex-1 truncate text-[12.5px] text-ink/85" title="${escapeHtml(x.need)}">${escapeHtml(x.need)}</span>${button}</div>`;
  const preview = first ? rowPreview(s, x, a) : "";
  // the same attributes as the detail's draft form and action box: the click posts the same plan, checked by the same hash
  const sha = a?.sha ? ` data-sha="${a.sha}"` : "";
  if (a?.kind === "post")
    return `<form class="flex min-w-0 flex-col gap-1" data-draft data-preview data-key="${k}" data-task="${id}" data-draft-to="${escapeHtml(x.task.draftTo ?? "")}"${sha} data-postable="1">${line}${preview}<textarea hidden data-draft-edit>${escapeHtml(a.text)}</textarea><p class="text-[12.5px] leading-snug text-muted empty:hidden" data-draft-status></p></form>`;
  if (a?.kind === "act") return `<div class="flex min-w-0 flex-col gap-1" data-actbox data-preview data-key="${k}" data-task="${id}"${sha}>${line}${preview}</div>`;
  return `<div class="flex min-w-0 flex-col gap-1" data-task="${id}">${line}${preview}</div>`;
}

/** The compact status of a list row: the state's shape (or the working dot) and its age; the sentence on hover. */
function rowStatus(c: CardView): string {
  const st = c.status;
  return `<span class="inline-flex shrink-0 items-center gap-1.5 text-[12.5px] font-medium tabular-nums ${STATUS_INK[st.tone]}" data-status-kind="${st.kind}" title="${escapeHtml(st.source ? `${st.text}\n${t(`board.card.status.source.${st.source}`)}` : st.text)}">${st.pulse ? PULSE : shape(st.tone)}${st.age ? `<span class="text-muted" data-age>${escapeHtml(st.age)}</span>` : ""}</span>`;
}

/**
 * A topic's row in the focus list, from its CardView: letter, title, compact status, the thread's last message, then
 * its first two open tasks (the first with its preview and one-click button) and "+N other tasks"; a topic without
 * task says the session's last word, or where the card stands.
 */
export function focusRow(l: BoardLine, ctx: BoardContext): string {
  const s = l.sujet;
  const now = nowOf(ctx);
  const c = cardOf(l, { now, channelNames: CHANNEL_NAMES });
  const k = escapeHtml(s.key);
  const sig = `${s.updatedAt}|${l.lastMessage?.at ?? ""}|${l.bloc}`;
  const fresh = l.bloc === "attend" && l.waitingSince ? freshness(now - Date.parse(l.waitingSince)) : null;
  const freshAttr = fresh ? ` data-fresh style="--fh:${fresh.h};--fk:${fresh.k}"` : "";
  const held = l.pin?.held ? " data-held" : "";
  // in "waiting on you", the client tells the server whether the row sat among the quick gos (the pin keeps it there)
  const quick = l.bloc === "attend" && (l.pin ? l.pin.quick : isQuickGo(l)) ? " data-quick" : "";
  const m = c.said;
  const said = m
    ? `<p class="flex min-w-0 items-baseline gap-x-1.5 text-[12.5px] leading-snug text-ink/80" data-said><span class="shrink-0 font-semibold text-ink">${escapeHtml(m.who)}</span>${m.text ? `<q class="min-w-0 truncate italic">${escapeHtml(m.text)}</q>` : ""}${m.age ? `<span class="shrink-0 tabular-nums text-muted">${escapeHtml(m.age)}</span>` : ""}</p>`
    : "";
  const more = c.tasks.length - 2;
  const tasks = c.tasks.length
    ? `${c.tasks.slice(0, 2).map((x, i) => rowTask(s, x, i === 0)).join("")}${more > 0 ? `<p class="text-[12.5px] text-muted">${escapeHtml(t(more > 1 ? "board.focus.more.other" : "board.focus.more.one", { n: more }))}</p>` : ""}`
    : "";
  const last = c.word?.text ?? c.need?.summary ?? c.need?.proposal ?? c.need?.ask ?? "";
  const word = !c.tasks.length && last ? `<p class="line-clamp-2 text-[12.5px] leading-snug text-muted [overflow-wrap:anywhere]" data-row-word>${mdLite(last.replace(/\\n/g, " ").replace(/\s+/g, " ").trim())}</p>` : "";
  return `<li${freshAttr}${held}${quick} id="row-${k}" class="group cursor-pointer border-b border-line px-4 py-3 last:border-b-0 hover:bg-soft/40 data-[held]:bg-accent/5 data-[cursor]:bg-soft data-[cursor]:shadow-[inset_3px_0_0_var(--color-ink)]" data-row="" data-key="${k}" data-letter="${escapeHtml(s.letter)}" data-sig="${escapeHtml(sig)}" role="option" aria-selected="false">
<div class="flex min-w-0 items-start gap-3">
<span class="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md bg-soft px-1.5 text-[12.5px] font-semibold text-ink group-data-[cursor]:bg-surface">${escapeHtml(s.letter)}</span>
<div class="flex min-w-0 flex-1 flex-col gap-1.5">
<div class="flex min-w-0 items-baseline gap-2"><span class="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink" title="${escapeHtml(s.title)}">${escapeHtml(s.title)}</span><span data-new hidden class="shrink-0 rounded-full bg-soft px-1.5 text-[11.5px] font-medium leading-4 text-ink">${t("board.line.new")}</span>${rowStatus(c)}</div>
${said}${tasks}${word}
</div>
</div>
</li>`;
}

/** The detail of a topic in the focus mode: the flow card's body, context open, instruction form shown. */
export function focusDetail(l: BoardLine, ctx: BoardContext, selected: boolean): string {
  const s = l.sujet;
  const c = cardOf(l, { now: nowOf(ctx), channelNames: CHANNEL_NAMES });
  return `<article id="detail-${escapeHtml(s.key)}" data-detail data-key="${escapeHtml(s.key)}"${selected ? "" : " hidden"} class="max-w-[860px]">
<div class="flex min-w-0 items-start gap-4">
${letterChip(s.letter)}
<div class="flex min-w-0 flex-1 flex-col gap-3">
${cardBody(l, c, ctx, true)}
</div>
</div>
</article>`;
}

/** A block's rows in the order shown: the pinned row where the server kept it, the quick gos first otherwise. */
const focusOrder = (bloc: Bloc, lines: BoardLine[]) => (lines.some((l) => l.pin) ? lines : blocOrder(bloc, lines));

/**
 * The focus mode: the board-wide strip, then the list of open topics by block on the left and the detail of the
 * selected one in the centre (`sel`, else the first row). Every open topic's detail is rendered, the others hidden:
 * the selection moves without a round trip, and each detail keeps its own panels and typing.
 */
export function focusView(m: BoardModel, ctx: BoardContext, sel: string | null = null): string {
  const vctx = { ...ctx, now: ctx.now ?? m.now };
  const blocs = BLOCS.map((b) => ({ b, lines: focusOrder(b, m[b]) })).filter((x) => x.lines.length);
  const shown = blocs.flatMap((x) => x.lines);
  const selected = shown.find((l) => l.sujet.key === sel) ?? shown[0] ?? null;
  const list = blocs
    .map(
      ({ b, lines }) => `<section id="bloc-${b}">
<h2 class="flex items-center gap-2 px-4 pb-1.5 pt-3.5 text-[12.5px] font-semibold text-muted" title="${escapeHtml(blocHint(b))}"><span class="lamp lamp-${BLOC_LAMP[b]} lit" aria-hidden="true"></span><span class="text-ink">${blocTitle(b)}</span>${count(lines.length)}</h2>
<ul role="listbox" aria-label="${escapeHtml(blocTitle(b))}">${lines.map((l) => focusRow(l, vctx)).join("\n")}</ul>
</section>`,
    )
    .join("\n");
  const empty = `<p class="px-4 py-6 text-[13.5px] text-muted">${escapeHtml(t("board.focus.empty"))}</p>`;
  const folds = [
    m.paused.length ? `<details class="group" id="paused"><summary class="flex cursor-pointer select-none list-none items-center gap-1.5 px-4 py-2.5 text-[12.5px] font-medium text-muted hover:text-ink"><span class="inline-block transition-transform group-open:rotate-90">▸</span>${t(m.paused.length > 1 ? "board.paused.count.other" : "board.paused.count.one", { n: m.paused.length })}</summary><ul class="border-t border-line">${m.paused.map((p) => pausedRow(p.line, p.until, vctx, p.reason)).join("")}</ul></details>` : "",
    m.closedToday.length ? `<details class="group" id="closed-today"><summary class="flex cursor-pointer select-none list-none items-center gap-1.5 px-4 py-2.5 text-[12.5px] font-medium text-muted hover:text-ink"><span class="inline-block transition-transform group-open:rotate-90">▸</span>${t(m.closedToday.length > 1 ? "board.closedToday.other" : "board.closedToday.one", { n: m.closedToday.length })}</summary><ul class="border-t border-line">${m.closedToday.map((s) => closedRow(s, vctx)).join("")}</ul></details>` : "",
  ].filter(Boolean);
  const radarHtml = radar(m, vctx);
  const lead = radarHtml ? `<div class="mr-auto min-w-0 max-sm:basis-full sm:flex-1">${radarHtml}</div>\n` : "";
  return `<div class="flex flex-col" data-view="board" data-mode="focus" data-attend="${openLines(m).filter((l) => l.bloc === "attend").length}">
<div class="border-b border-line px-5 py-3">${heroView(m, ctx, vctx, lead)}</div>
<div class="grid md:grid-cols-[minmax(320px,400px)_minmax(0,1fr)]">
<aside class="focus-list flex flex-col overflow-y-auto [scrollbar-width:thin] border-line bg-surface max-md:border-b md:border-r" data-focus-list aria-label="${escapeHtml(t("board.focus.list"))}">
${shown.length ? list : empty}
${folds.length ? `<div class="mt-auto border-t border-line">${folds.join("")}</div>` : ""}
</aside>
<div class="min-w-0 px-7 pb-24 pt-5 max-sm:px-4" data-focus-detail>
${openLines(m)
  .filter((l) => shown.includes(l))
  .map((l) => focusDetail(l, vctx, l === selected))
  .join("\n")}
</div>
</div>
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
/* the drawer docks at the bottom (over the board) or on the right (beside it: the board gives up the drawer's width) */
#drawer[data-dock="bottom"] { height: var(--dock-h, 46vh); }
#drawer[data-dock="right"] { top: 0; left: auto; width: var(--dock-w, 46vw); height: auto; min-width: 360px; border-top: 0; border-left: 1px solid var(--color-line); box-shadow: -8px 0 24px rgb(0 0 0 / 0.25); }
#drawer[data-dock="right"].drawer-closed { transform: translateX(100%); }
body[data-split="right"] { padding-right: max(var(--dock-w, 46vw), 360px); }
body[data-split="bottom"] { padding-bottom: max(var(--dock-h, 46vh), 240px); }
#drawer-grip { position: absolute; z-index: 1; touch-action: none; }
#drawer[data-dock="bottom"] #drawer-grip { top: -3px; left: 0; right: 0; height: 6px; cursor: ns-resize; }
#drawer[data-dock="right"] #drawer-grip { top: 0; bottom: 0; left: -3px; width: 6px; cursor: ew-resize; }
#drawer-grip:hover, body[data-resizing] #drawer-grip { background: var(--color-muted); opacity: 0.5; }
/* while dragging, the terminals must not swallow the pointer */
body[data-resizing] iframe { pointer-events: none; }
body[data-resizing] { user-select: none; }
/* the focus list stays in view while the detail scrolls the page, and ends above a drawer docked at the bottom */
@media (min-width: 768px) {
  .focus-list { position: sticky; top: var(--nav-h, 53px); align-self: start; height: calc(100dvh - var(--nav-h, 53px)); }
  body[data-split="bottom"] .focus-list { height: calc(100dvh - var(--nav-h, 53px) - max(var(--dock-h, 46vh), 240px)); }
}
/* the flow mode's sheet: from the left, over the board, under the drawer, which stays usable on the right or at the bottom */
.sheet { position: fixed; inset: 0; z-index: 15; pointer-events: none; }
.sheet-backdrop { position: absolute; inset: 0; pointer-events: auto; background: rgb(0 0 0 / 0.32); animation: sheet-fade 0.2s ease-out; }
.sheet-panel { position: absolute; top: 0; bottom: 0; left: 0; width: min(780px, calc(100vw - 56px)); overflow-y: auto; overscroll-behavior: contain; pointer-events: auto; box-shadow: 8px 0 28px rgb(0 0 0 / 0.22); animation: sheet-in 0.22s cubic-bezier(0.2, 0.8, 0.2, 1); outline: none; }
body[data-split="right"] .sheet-backdrop { right: max(var(--dock-w, 46vw), 360px); }
body[data-split="right"] .sheet-panel { width: max(320px, min(780px, calc(100vw - max(var(--dock-w, 46vw), 360px) - 56px))); }
body[data-split="bottom"] .sheet-backdrop, body[data-split="bottom"] .sheet-panel { bottom: max(var(--dock-h, 46vh), 240px); }
.sheet[data-closing] .sheet-panel { animation: sheet-out 0.16s ease-in forwards; }
.sheet[data-closing] .sheet-backdrop { animation: sheet-fade 0.16s ease-in reverse forwards; }
@media (max-width: 639px) { .sheet-panel, body[data-split="right"] .sheet-panel { width: 100vw; box-shadow: none; } }
@keyframes sheet-in { from { transform: translateX(-100%); } }
@keyframes sheet-out { to { transform: translateX(-100%); } }
@keyframes sheet-fade { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;

/** The logo and the favicon live in core/brand.ts, the single source of the mark. */
export { faviconHref } from "./core/brand.ts";

/**
 * The client script, in parts that share one scope (client/*.js), concatenated in this order inside one function.
 * Imported as text: `bun build --compile` embeds them, and the binary has no file next to its code.
 */
const CLIENT = [clientCore, clientSync, clientActions, clientDrawer, clientKeyboard, clientFocus, clientSheet, clientBoot];
const JS = `\n(function () {\n${CLIENT.join("")}})();\n`;

/** The Flow / Focus switch of the top bar: links, so the URL carries the mode; the script remembers the choice. */
function modeSwitch(mode: BoardMode): string {
  const item = (m: BoardMode) =>
    `<a href="/board?mode=${m}" data-mode-switch="${m}"${m === mode ? ' aria-current="page"' : ""} title="${escapeHtml(t(m === "flow" ? "board.header.mode.flow.tip" : "board.header.mode.focus.tip"))}" class="inline-flex h-6 items-center rounded-md px-2.5 text-[12.5px] font-medium ${m === mode ? "bg-soft text-ink" : "text-muted hover:text-ink"}">${escapeHtml(t(m === "flow" ? "board.header.mode.flow" : "board.header.mode.focus"))}</a>`;
  return `<div role="group" aria-label="${escapeHtml(t("board.header.mode"))}" class="mr-2 inline-flex rounded-lg border border-line p-0.5">${item("flow")}${item("focus")}</div>`;
}

/** The board's whole page: Tailwind shell, sticky bar, content, toast, script. */
export function boardPage(view: string, version = "", mode: BoardMode = "flow"): string {
  const width = mode === "focus" ? "max-w-none" : "max-w-[1080px]";
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
<script>try { if (!/[?&]mode=/.test(location.search) && localStorage.getItem("strato-mode") === "focus" && "${mode}" !== "focus") location.replace("/board?mode=focus" + (location.search ? "&" + location.search.slice(1) : "")); } catch (e) {}</script>
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.3.3" integrity="sha384-aJ9rL4k6lF+91guGvUFVSkpIcge7Zd9EiI4TQDLoK9kFaFJgKHgjEXVvG/qA5COj" crossorigin="anonymous"></script>
<script src="https://cdn.jsdelivr.net/npm/idiomorph@0.8.0/dist/idiomorph.min.js" integrity="sha384-e8O/d5cD6uoo78UI/d99hf1dEsbvkgBZNIetwKEi79V9qexl0Bdc2wxEqLEaj58U" crossorigin="anonymous"></script>
<style type="text/tailwindcss">${THEME}</style>
</head>
<body class="font-sans antialiased text-[13.5px]" data-mode="${mode}">
<nav class="sticky top-0 z-10 border-b border-line bg-bg/85 backdrop-blur">
<div class="mx-auto flex ${width} flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-2.5">
<div class="flex items-center gap-2.5 text-ink"><span class="inline-flex text-ink">${stratoMark(22)}</span><span class="text-[15px] font-semibold tracking-tight">Strato</span><span class="text-[12.5px] text-muted">board</span><div id="version-slot" class="ml-1 flex items-center gap-2">${version}</div></div>
<button type="button" data-palette-open title="${escapeHtml(t("board.header.search.tip"))}" class="mx-2 hidden h-8 min-w-0 max-w-[420px] flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-left text-[12.5px] text-muted hover:border-muted/60 hover:text-ink sm:flex"><span aria-hidden="true">⌕</span><span class="min-w-0 flex-1 truncate">${escapeHtml(t("board.header.search"))}</span><kbd class="shrink-0">⌘K</kbd></button>
<div class="flex flex-wrap items-center justify-end gap-1 text-[12.5px]">${modeSwitch(mode)}<span id="sync-pill" class="mr-2 inline-flex items-center gap-2 rounded-full border border-line px-2.5 py-0.5 text-[12.5px] text-muted"><span class="lamp" aria-hidden="true"></span><span data-sync-label>…</span></span><button type="button" id="drawer-show" hidden data-drawer-show class="${BTN} mr-1" title="${escapeHtml(t("board.drawer.show.tip"))}"></button><button type="button" data-theme-toggle class="${BTN_TEXT}" title="${escapeHtml(t("board.header.theme.tip"))}">${t("board.js.theme.auto")}</button><a href="/?liste" class="${BTN_TEXT}" title="${escapeHtml(t("board.header.list.tip"))}">${t("board.header.list")}</a><button type="button" data-refresh class="${BTN_TEXT}" title="${escapeHtml(t("board.header.refresh.tip"))}">${t("board.header.refresh")}</button></div>
</div>
</nav>
<main id="app" class="${mode === "focus" ? "w-full" : "mx-auto max-w-[1080px] px-5 pb-24 pt-8"}">${view}</main>
<aside id="drawer" aria-hidden="true" data-dock="bottom" class="drawer-closed fixed inset-x-0 bottom-0 z-20 flex min-h-[240px] flex-col border-t border-line bg-[#121417] shadow-[0_-8px_24px_rgb(0_0_0/0.25)]">
<div id="drawer-grip" title="${escapeHtml(t("board.drawer.grip.tip"))}"></div>
<div class="flex items-center gap-1 border-b border-line bg-bg px-3 py-1.5">
<div id="drawer-tabs" class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"></div>
<button type="button" data-drawer-dock class="${BTN_TEXT}"></button>
<button type="button" data-drawer-hide class="${BTN_TEXT}" title="${escapeHtml(t("board.drawer.hide.tip"))}">${t("board.drawer.hide")}</button>
</div>
<div id="drawer-body" class="relative min-h-0 flex-1"></div>
</aside>
<div id="palette" hidden class="fixed inset-0 z-30 flex items-start justify-center bg-black/40 px-4 pt-[12vh]"><div class="w-full max-w-[640px] overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"><div class="flex items-center gap-2 border-b border-line px-3"><span class="text-muted">⌕</span><input type="text" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(t("board.palette.placeholder"))}" class="h-11 w-full bg-transparent text-[13.5px] text-ink outline-none placeholder:text-muted"><kbd class="shrink-0">${t("board.palette.escape")}</kbd></div><ul data-palette-list class="max-h-[50vh] overflow-y-auto p-1.5"></ul></div></div>
<div id="toast" role="status" hidden class="fixed z-40 bottom-5 left-1/2 -translate-x-1/2 rounded-md bg-ink px-3.5 py-2 text-[13.5px] text-bg shadow-lg"></div>
<script>window.STRATO_I18N = ${JSON.stringify(clientMessages()).replace(/</g, "\\u003c")};</script>
<script>${JS}</script>
</body>
</html>
`;
}
