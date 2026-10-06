/**
 * The card as the person reads it: what is said, and in which order (docs/design/board-modes.md, sections 4 and 6.2).
 * `cardOf` is the only place that decides it; the views render what it returns and decide nothing.
 * Pure: no I/O, no HTML. Its rules keep each thing said once: one status line, one age per instant, a blocker only
 * when it adds someone, the task ids and the seconds of thread times out of sight.
 */
import type { Bloc, BoardLine, Delivery, DueView, Tone } from "../board.ts";
import type { StateSource } from "../claude/mod-state.ts";
import { agentCounts, freshness, openTasks, parseSteps, permalinkOfKey, providerKeyLabel, settings, type Sujet, sujetKeys, t, type Task, type TaskKind, taskReady, tasksOf, threadInfoOfKey, ticketIdOfKey, ticketUrl } from "../lib.ts";

/** A short duration, rounded down: "< 1 min", "48 min", "3 h", "5 d". */
export function span(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return t("board.span.underMinute");
  if (m < 60) return t("board.span.minutes", { n: m });
  const h = Math.floor(m / 60);
  return h < 24 ? t("board.span.hours", { n: h }) : t("board.span.days", { n: Math.floor(h / 24) });
}

/** A gate whose action is ready (draft or written action): one click is enough, no thinking. */
export function isQuickGo(l: BoardLine): boolean {
  const open = openTasks(l.sujet);
  return l.bloc === "attend" && l.sujet.status === "gate" && l.tone === "accent" && open.length > 0 && open.every((x) => (x.kind === "draft" || x.kind === "action") && taskReady(x));
}

export type StatusKind = "go" | "work" | "wait" | "idle";

/** The session's state, said once: what replaces the badge, the pane's title and the action box's status. */
export interface CardStatus {
  kind: StatusKind;
  /** The colour and the shape, as the rest of the board uses them. */
  tone: Tone;
  text: string;
  /** The instant the age counts from, ISO, or null. */
  since: string | null;
  age: string | null;
  /** A session at work: the dot pulses. */
  pulse: boolean;
  /** Where the session's state was read from, said on hover; null without a live session. */
  source: StateSource | null;
}

/** The last message of the topic's threads: who, where, an excerpt, how long ago. */
export interface CardSaid {
  who: string;
  me: boolean;
  where: string;
  text: string | null;
  at: string;
  url: string | null;
  /** null when the same age is already said higher on the card. */
  age: string | null;
}

/** What the session said last, shown only when it is newer than the card. */
export interface CardWord {
  text: string;
  at: string;
  age: string | null;
}

export interface CardPlan {
  steps: { state: "done" | "now" | "todo"; text: string }[];
  /** Done steps folded into a count, oldest first. */
  doneHidden: number;
  todoHidden: number;
}

/** A task's kind as the card names it. */
export type CardTaskKind = "decide" | "answer" | "draft" | "go";
const TASK_KIND: Record<TaskKind, CardTaskKind> = { decision: "decide", question: "answer", draft: "draft", action: "go" };

export interface CardTask {
  id: string;
  kind: CardTaskKind;
  /** The whole ask: the folded line cuts it, the expanded one wraps it. */
  need: string;
  age: string;
  ageMs: number;
  /** The first open task is expanded; the others stay on one line and open in place. */
  open: boolean;
  task: Task;
}

/** A thread or a ticket of the topic, labelled for reading. */
export interface ThreadRef {
  key: string;
  label: string;
  url: string | null;
}

export interface CardContext {
  asker: string;
  origin: ThreadRef;
  /** Tickets and the most recent threads, then the older threads folded behind "+N older". */
  threads: ThreadRef[];
  older: ThreadRef[];
  /** All the threads and tickets, the origin included. */
  threadCount: number;
  mrs: Delivery[];
  mrProd: number;
  mrHard: number;
  dues: DueView[];
  /** The first due date past or within 24 h: said on the folded line. */
  dueSoon: DueView | null;
  why: string | null;
  unverified: string | null;
  summary: string | null;
  /** The last two finished tasks, newest first; the rest is in the report. */
  finished: Task[];
  finishedCount: number;
}

export interface CardStale {
  signals: string[];
  /** A revalidation asked and not answered yet (the card was not rewritten since), ISO. */
  requestedAt: string | null;
}

export interface CardView {
  key: string;
  letter: string;
  title: string;
  status: CardStatus;
  said: CardSaid | null;
  word: CardWord | null;
  blocker: string | null;
  stale: CardStale | null;
  plan: CardPlan | null;
  /** A card without open task: its request and proposal, or its summary, in place of the tasks. */
  need: { ask: string | null; proposal: string | null; summary: string | null } | null;
  tasks: CardTask[];
  context: CardContext;
}

export interface CardOptions {
  /** Reference time of the ages, ms. */
  now: number;
  /** Readable conversation names ("#requests", "DM") by their tool's id. */
  channelNames?: Map<string, string>;
}

const BLOC_KIND: Record<Bloc, StatusKind> = { attend: "go", revoir: "go", travail: "work", attente: "wait" };

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const oneLine = (text: string) => text.replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
function clip(text: string, max: number): string {
  const x = oneLine(text);
  return x.length > max ? `${x.slice(0, max - 1)}…` : x;
}

export function statusOf(l: BoardLine, now: number): CardStatus {
  const step = l.running === "busy" ? l.trail[l.trail.length - 1] : undefined;
  const text = step ? t("board.card.status.workingOn", { step: clip(step.text, 80) }) : sentence(l.verdict);
  // an alert without a wait of its own (a session stopped, blocked) dates from when Claude Code reported that state
  const since = l.waitingSince ?? l.runningSince ?? null;
  const at = since ? Date.parse(since) : Number.NaN;
  return {
    kind: l.tone === "muted" ? "idle" : BLOC_KIND[l.bloc],
    tone: l.tone,
    text,
    since,
    age: Number.isFinite(at) ? span(now - at) : null,
    pulse: l.running === "busy" || agentCounts(l.agents).running > 0,
    source: l.stateSource ?? null,
  };
}

const fold = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
const words = (text: string) => new Set(fold(text).match(/[a-z0-9]{4,}/g) ?? []);

/** Does the blocker point at the person served? Their name, or the second person ("your go", "ton go"). */
export function namesPersonServed(text: string, owner = settings().owner.name): boolean {
  const x = ` ${fold(text)} `;
  const names = fold(owner).match(/[a-z]{2,}/g) ?? [];
  if (names.some((n) => new RegExp(`[^a-z]${n}[^a-z]`).test(x))) return true;
  return /[^a-z](you|your|yours|toi|ton|ta|tes|te|tu)[^a-z]|[^a-z]t['’]/.test(x);
}

/** "Nothing", "rien, je vérifie à 17:32": a blocker that says nothing blocks. */
export const saysNothingBlocks = (text: string) => /^(rien|aucune?|personne|nothing|none|nobody|no one|n\/a)\b/i.test(text.trim());

/** Does the blocker say again what the task already asks? Half of the shorter one's words in common. */
export function repeatsNeed(blocker: string, need: string): boolean {
  const a = words(blocker);
  const b = words(need);
  if (!a.size || !b.size) return false;
  const shared = [...a].filter((w) => b.has(w)).length;
  return shared >= 2 && shared / Math.min(a.size, b.size) >= 0.5;
}

/**
 * What blocks, on a topic waiting on the person served: `blocker`, else `next` for older cards. Nothing for a "just a
 * go" (its box says what goes out), nothing when it points at the person served (the open task already says what is
 * wanted from them), nothing when it repeats the first open task's need.
 */
export function blockerOf(l: BoardLine, first: Task | undefined): string | null {
  const s = l.sujet;
  const text = (s.blocker || s.next || "").trim();
  if (l.bloc !== "attend" || !text || isQuickGo(l)) return null;
  if (saysNothingBlocks(text) || namesPersonServed(text)) return null;
  if (first && repeatsNeed(text, first.ask)) return null;
  return clip(text, 200);
}

/** The plan as one strip: the last done step (the others counted), the now step, and the next three. */
export function planOf(s: Sujet): CardPlan | null {
  const all = parseSteps(s.steps).map((x) => ({ state: x.state, text: clip(x.text, 80) }));
  if (!all.length) return null;
  const done = all.filter((x) => x.state === "done");
  const todo = all.filter((x) => x.state === "todo");
  const doneHidden = Math.max(0, done.length - 1);
  const todoHidden = Math.max(0, todo.length - 3);
  let todoSeen = 0;
  let doneSeen = 0;
  const steps = all.filter((x) => (x.state === "done" ? ++doneSeen > doneHidden : x.state === "todo" ? ++todoSeen <= 3 : true));
  return { steps, doneHidden, todoHidden };
}

/**
 * The threads and tickets of a topic, labelled: the origin keeps the channel's name; another thread says its
 * conversation and its date to the minute, with the seconds only when two threads of one conversation share a minute.
 */
export function threadRefs(s: Sujet, channelNames: Map<string, string> = new Map()): ThreadRef[] {
  const keys = sujetKeys(s);
  const pad = (n: number) => String(n).padStart(2, "0");
  return keys.map((key) => {
    const ticket = ticketIdOfKey(key);
    if (ticket) return { key, label: ticket, url: ticketUrl(ticket) };
    const url = permalinkOfKey(key);
    const thread = threadInfoOfKey(key);
    if (!thread) return { key, label: key === s.key ? s.channel : providerKeyLabel(key), url };
    if (key === s.key) return { key, label: s.channel, url };
    const when = thread.at !== undefined ? new Date(thread.at) : null;
    const valid = when && !Number.isNaN(when.getTime()) ? when : null;
    const date = valid ? ` ${pad(valid.getDate())}/${pad(valid.getMonth() + 1)} ${pad(valid.getHours())}:${pad(valid.getMinutes())}` : "";
    const twin =
      valid &&
      keys.some((k) => {
        const other = k !== key ? threadInfoOfKey(k) : null;
        return other !== null && other.provider === thread.provider && other.account === thread.account && other.conversation === thread.conversation && Math.floor((other.at ?? Number.NaN) / 60_000) === Math.floor(valid.getTime() / 60_000);
      });
    const name = channelNames.get(thread.conversation) ?? `${thread.tool} ${thread.conversation}`;
    return { key, label: `${name}${date}${twin && valid ? `:${pad(valid.getSeconds())}` : ""}`, url };
  });
}

/** Threads shown besides the origin; the older ones fold behind "+N", tickets always show. */
const RECENT_THREADS = 2;

function contextOf(l: BoardLine, tasksShown: boolean, needShowsSummary: boolean, opts: CardOptions): CardContext {
  const s = l.sujet;
  const refs = threadRefs(s, opts.channelNames);
  const others = refs.filter((r) => r.key !== s.key);
  const tickets = others.filter((r) => ticketIdOfKey(r.key));
  const threads = others
    .filter((r) => !ticketIdOfKey(r.key))
    .map((r, i) => ({ r, i, at: threadInfoOfKey(r.key)?.at ?? -Infinity }))
    .sort((a, b) => b.at - a.at || b.i - a.i)
    .map((x) => x.r);
  // folding a single thread would save nothing: it takes as much room as the "+1" that replaces it
  const foldOlder = threads.length > RECENT_THREADS + 1;
  const mrs = l.deliveries ?? [];
  const dues = l.dues ?? [];
  const finished = tasksOf(s)
    .filter((x) => x.status !== "open")
    .sort((a, b) => (b.closedAt ?? b.updatedAt).localeCompare(a.closedAt ?? a.updatedAt));
  const text = (v: string | undefined) => (v?.trim() ? v.replace(/\\n/g, "\n").trim() : null);
  return {
    asker: s.asker,
    origin: refs[0],
    threads: foldOlder ? [...tickets, ...threads.slice(0, RECENT_THREADS)] : others,
    older: foldOlder ? threads.slice(RECENT_THREADS) : [],
    threadCount: refs.length,
    mrs,
    mrProd: mrs.filter((d) => d.stage === "prod").length,
    mrHard: mrs.filter((d) => d.blocker && d.hard).length,
    dues,
    dueSoon: dues.find((d) => d.state === "past" || Date.parse(d.at) - opts.now < 24 * 3600_000) ?? null,
    why: text(s.why),
    unverified: text(s.unverified),
    summary: tasksShown || !needShowsSummary ? text(s.summary) : null,
    finished: finished.slice(0, 2),
    finishedCount: finished.length,
  };
}

/** The card may have aged: what the sweep saw, and a revalidation asked and not answered yet. */
function staleOf(l: BoardLine): CardStale | null {
  const s = l.sujet;
  if (!s.sessionId || l.running === "busy") return null;
  const signals = (l.stale ?? []).map((x) => x.text);
  const r = s.refresh;
  // a relaunch is "recent" as long as the card has not been rewritten since
  const requestedAt = r && Date.parse(r.at) >= Date.parse(s.updatedAt) ? r.at : null;
  return signals.length || requestedAt ? { signals, requestedAt } : null;
}

/** The open tasks of a topic, oldest first: the first one expanded, the others on one line. */
export function cardTasks(s: Sujet, now: number): CardTask[] {
  return openTasks(s).map((x, i) => {
    const ageMs = now - Date.parse(x.createdAt);
    return { id: x.id, kind: TASK_KIND[x.kind], need: oneLine(x.ask), age: span(ageMs), ageMs, open: i === 0, task: x };
  });
}

/** The presentation model of one card. */
export function cardOf(l: BoardLine, opts: CardOptions): CardView {
  const s = l.sujet;
  const now = opts.now;
  const status = statusOf(l, now);
  const open = openTasks(s);
  const shown = new Set(status.age ? [status.age] : []);
  // one age per instant: an age already said higher on the card is not said again
  const ageOnce = (at: string | null) => {
    const ms = at ? Date.parse(at) : Number.NaN;
    if (!Number.isFinite(ms)) return null;
    const age = span(now - ms);
    if (shown.has(age)) return null;
    shown.add(age);
    return age;
  };
  const m = l.lastMessage;
  // "Ann wrote · 5 min" already says who and when: a last message without its words would only repeat it
  const saysNothing = m && !m.text?.trim() && l.bloc === "revoir";
  const said: CardSaid | null = m && !saysNothing ? { who: m.kind === "moi" ? t("board.line.you") : m.from, me: m.kind === "moi", where: m.channel ?? "", text: m.text?.trim() ? clip(m.text, 220) : null, at: m.at, url: m.permalink ?? null, age: ageOnce(m.at) } : null;
  const a = l.lastAgent;
  // the status of a working session already quotes its current step, often the same sentence
  const step = l.running === "busy" ? l.trail[l.trail.length - 1]?.text : undefined;
  const quoted = !!step && !!a?.text && fold(oneLine(a.text)).startsWith(fold(oneLine(step)).slice(0, 40));
  const newer = a?.text?.trim() && a.at && Date.parse(a.at) > Date.parse(s.updatedAt) && !quoted;
  const word: CardWord | null = newer && a?.at ? { text: a.text.trim().slice(0, 2000), at: a.at, age: ageOnce(a.at) } : null;
  const tasks = cardTasks(s, now);
  const ask = !open.length && s.ask?.trim() ? clip(s.ask, 200) : null;
  const proposal = !open.length && s.proposal?.trim() ? clip(s.proposal, 280) : null;
  const summary = !open.length && !ask && !proposal && s.summary?.trim() ? clip(s.summary, 280) : null;
  const need = ask || proposal || summary ? { ask, proposal, summary } : null;
  return {
    key: s.key,
    letter: s.letter,
    title: s.title,
    status,
    said,
    word,
    blocker: blockerOf(l, open[0]),
    stale: staleOf(l),
    plan: planOf(s),
    need,
    tasks,
    context: contextOf(l, open.length > 0, !!summary, opts),
  };
}

/** A task's freshness, for its age's tint. */
export const taskFreshness = (x: CardTask) => freshness(x.ageMs);

/** Beyond this, a task's content does not fit the two lines of a focus list row. */
export const PREVIEW_MAX = 120;

/**
 * Does what a button sends fit the two-line preview of a focus list row? One click acts only on what is on screen: a
 * longer content keeps its button in the detail, and the row only opens it.
 */
export function previewFits(text: string): boolean {
  const x = text.trim();
  return !!x && x.length <= PREVIEW_MAX && x.split("\n").length <= 2;
}
