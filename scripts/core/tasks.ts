/**
 * Tasks: what waits for the person served inside a topic. A topic is one session; it can wait on several things at
 * once (a draft to send, a merge to approve, a question), and each one is a task with its own request, its own box
 * and its own age. A task is closed explicitly (done or dropped): it never lingers under a request it no longer
 * belongs to. Before tasks, the card was a patch of fields: a session could change its request several times without
 * clearing `action`, and the board kept showing a stale action (say, "replay a SQL script in prod") with an active Go.
 *
 * Sessions started before tasks still write `set gate=… draft=… action=…`: `applySetToTasks` turns those writes into
 * tasks of origin "set", and `legacyTasks` migrates a stored card on load. Tasks of origin "task" are only ever
 * changed by the `task` command and by the board.
 *
 * Pure module: no I/O. It imports only types from sujet.ts, which imports it.
 */
import type { Audience } from "../providers/sdk.ts";
import type { InFlight, SentRecord, UnknownOutcome } from "./gate.ts";
import { t } from "./i18n.ts";
import { parseKey } from "./keys.ts";
import type { Sujet } from "./sujet.ts";
import { truncate } from "./text.ts";

export const TASK_KINDS = ["draft", "action", "decision", "question"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export type TaskStatus = "open" | "done" | "dropped";

export interface Task {
  /** Short id, unique within the topic: t1, t2… Never reused. */
  id: string;
  kind: TaskKind;
  /** What is asked, one sentence. */
  ask: string;
  /** What the session proposes. */
  proposal?: string;
  /** The exact action that goes out on go (for a draft: "post the draft in <draftTo>"). */
  action?: string;
  /** The message as it will go out. */
  draft?: string;
  /** Where the draft goes: channel and thread link, or a channel id and "new message". */
  draftTo?: string;
  /**
   * Where the draft goes, typed: the key of a thread (a reply) or of a conversation (a separate message), on any
   * connected tool. It wins over `draftTo`, which then only describes it.
   */
  to?: string;
  /**
   * A structured action on a ticket, carried out by the board's Go behind the gate (docs/design/providers.md, section
   * 4.6): a status change or an assignment of the ticket named by `to` (or of the topic's own ticket), to `value`.
   */
  act?: TaskAct;
  /** What `act` sets: the status's name, or the assignee (an email, a name, "me", "none"). */
  value?: string;
  /**
   * Who sees the draft, on a tool whose descriptor declares an audience (mail, support desks): recipients, copies,
   * public reply or internal note. Written as `audience.to`, `audience.cc` and `visibility`; the gate keeps the fields
   * the tool declares, and the person sees them before the Go.
   */
  audience?: Audience;
  /** The subject line of the draft, on a tool that declares one (mail). */
  subject?: string;
  createdAt: string;
  updatedAt: string;
  status: TaskStatus;
  closedAt?: string;
  note?: string;
  /** "task": created by the `task` command; "set": translated from a legacy `set` (or migrated from a stored card). */
  origin: "task" | "set";
  // ---- written by the gate only (core/gate.ts, app/act.ts): no command writes them
  /** The attempt of the next write: grows after an Undo or a write refused for sure, never after an unknown outcome. */
  attempt?: number;
  /** A write on its way out. */
  inFlight?: InFlight;
  /** The last write may have gone out: the person checks, then sends again or marks the task done. */
  unknown?: UnknownOutcome;
  /** What went out, frozen. */
  sent?: SentRecord;
}

/** The structured actions a task can carry; a comment is a draft whose `to` is the ticket. */
export const TASK_ACTS = ["setStatus", "assign"] as const;
export type TaskAct = (typeof TASK_ACTS)[number];

/** The fields a session writes on a task. */
export const TASK_FIELDS = ["kind", "ask", "proposal", "action", "draft", "draftTo", "to", "act", "value", "audience.to", "audience.cc", "visibility", "subject"] as const;
type TaskField = (typeof TASK_FIELDS)[number];

/** The fields that write a task's `audience` and `subject` rather than a field of the same name. */
const AUDIENCE_FIELDS = ["audience.to", "audience.cc", "visibility", "subject"] as const;
type AudienceField = (typeof AUDIENCE_FIELDS)[number];
const isAudienceField = (k: string): k is AudienceField => (AUDIENCE_FIELDS as readonly string[]).includes(k);
/** At most this many addresses in `audience.to` or `audience.cc`. */
const MAX_RECIPIENTS = 50;

/** What the task functions read and write on a topic. */
type TaskHost = Pick<Sujet, "status" | "gate" | "updatedAt" | "history" | "title"> &
  Partial<Pick<Sujet, "tasks" | "ask" | "proposal" | "action" | "draft" | "draftTo" | "waiting">>;

const clean = (v: string | undefined) => {
  const x = (v ?? "").trim();
  return x === "-" ? "" : x;
};

/** The legacy gate -> the kind of the task it stands for. */
export function gateKind(gate: string | undefined): TaskKind {
  return gate === "draft" || gate === "decision" || gate === "question" ? gate : "action";
}

/**
 * Since when the topic waits for the person served: the start of the current gate, read in the history. A relaunch
 * goes through `working` and reopens the gate: that does not reset the age. Only `waiting` or `closed` ends the wait.
 * Without a trace in the history, the date of the card.
 */
export function gateSince(s: Pick<Sujet, "status" | "updatedAt" | "history">): string {
  let since: string | null = null;
  for (const h of s.history) {
    const m = h.what.match(/(?:^| )status=(\w+)/);
    if (!m) continue;
    if (m[1] === "gate") since ??= h.at;
    else if (m[1] === "waiting" || m[1] === "closed") since = null;
  }
  return s.status === "gate" && since ? since : s.updatedAt;
}

const HISTORY_KEYS = "status|gate|waiting|next|summary|title|posted|ask|why|proposal|action|draft|draftTo|steps|blocker|mrs|due|unverified|report";
const HISTORY_FIELD = new RegExp(`(?:^| )(${HISTORY_KEYS})=`, "g");

/** The fields an entry of the history wrote, with their (truncated) values. */
function historyFields(what: string): Map<string, string> {
  const marks = [...what.matchAll(HISTORY_FIELD)].map((m) => ({ key: m[1], at: (m.index ?? 0) + m[0].length, start: m.index ?? 0 }));
  const out = new Map<string, string>();
  marks.forEach((m, i) => out.set(m.key, what.slice(m.at, i + 1 < marks.length ? marks[i + 1].start : undefined).trim()));
  return out;
}

/**
 * The action or the draft of a stored card was written before the current request or before the current gate: it
 * answers something else. Read in the history (values truncated at 80 characters, enough to see a change).
 */
export function staleCardAction(s: Pick<Sujet, "history">, since: string): boolean {
  let lastWrite: string | null = null;
  let lastAskChange: string | null = null;
  let ask: string | null = null;
  for (const h of s.history) {
    const f = historyFields(h.what);
    if (f.has("ask")) {
      const v = f.get("ask") ?? "";
      if (ask !== null && v !== ask) lastAskChange = h.at;
      ask = v;
    }
    if (f.has("action") || f.has("draft")) lastWrite = h.at;
  }
  if (!lastWrite) return false;
  return lastWrite < since || (lastAskChange !== null && lastWrite < lastAskChange);
}

/**
 * The migration of a stored card without tasks: an open gate (status gate) with a draft or an action becomes the
 * task t1, of origin "set", aged from the start of the gate. An action or a draft older than the current request or
 * gate is not carried over: the task keeps the request and the proposal, as a decision, without a Go.
 */
export function legacyTasks(s: TaskHost): Task[] {
  if (s.status !== "gate") return [];
  const draft = clean(s.draft);
  const action = clean(s.action);
  if (!draft && !action) return [];
  const since = gateSince(s);
  const stale = staleCardAction(s, since);
  const kind = gateKind(s.gate);
  const task: Task = {
    id: "t1",
    kind: stale ? (kind === "question" ? "question" : "decision") : kind,
    ask: clean(s.ask) || s.title,
    proposal: clean(s.proposal),
    action: stale ? "" : action,
    draft: stale ? "" : draft,
    draftTo: stale ? "" : clean(s.draftTo),
    createdAt: since,
    updatedAt: s.updatedAt,
    status: "open",
    origin: "set",
  };
  return [task];
}

/** The tasks of a topic; a topic never written since tasks exist is migrated in memory. */
export function tasksOf(s: TaskHost): Task[] {
  return s.tasks ?? legacyTasks(s);
}

/** The open tasks, oldest first. */
export function openTasks(s: TaskHost): Task[] {
  return tasksOf(s)
    .filter((x) => x.status === "open")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The open tasks an older binary would carry out elsewhere than meant: a typed target (`to`), a tool action (`act`)
 * or an audience. Before providers, a task only had a free-text `draftTo`, and an empty one meant the topic's own
 * Slack thread: a ticket comment or a mail reply would be posted there after `update --rollback`. One line each.
 */
export function rollbackHazards(list: (TaskHost & { key: string; letter?: string })[]): string[] {
  return list
    .filter((s) => s.status !== "closed")
    .flatMap((s) =>
      openTasks(s)
        .filter((x) => x.to || x.act || x.audience || x.subject)
        .map((x) => `${s.letter ?? s.key} ${x.id}: ${[x.to ? `to=${x.to}` : "", x.act ? `act=${x.act}` : "", x.audience || x.subject ? "audience" : ""].filter(Boolean).join(" ")}`),
    );
}

export function findTask(s: TaskHost, id: string): Task | undefined {
  return tasksOf(s).find((x) => x.id === id);
}

/** The next free id: t<max+1>. */
export function nextTaskId(tasks: Task[]): string {
  const n = tasks.reduce((m, x) => Math.max(m, Number(x.id.replace(/^t/, "")) || 0), 0);
  return `t${n + 1}`;
}

/** The draft text as it will go out: "\n" written literally become line breaks. A draft task without draft reads its action (cards before the draft field). */
export function taskDraftText(x: Pick<Task, "kind" | "draft" | "action">): string {
  const raw = clean(x.draft) || (x.kind === "draft" ? clean(x.action) : "");
  return raw.replace(/\\n/g, "\n").trim();
}

/** A task the board can carry out with one click: a draft to send, or an action written out. */
/**
 * An action task that would post or send one or more messages without their text: a go on it would publish in the
 * person's name words they never saw. The board offers no Go on it, and asks the session for one draft task per
 * message instead (each with its exact text and its destination).
 */
export function sendsUnseenMessage(x: Pick<Task, "kind" | "action" | "draft">): boolean {
  if (x.kind !== "action" || taskDraftText(x as Task)) return false;
  return /\b(post(er)?|poste|send|envoy\w*|repl(y|ies)|répond\w*|relanc\w*|dm|message|notice|annonc\w*|ping)\b/i.test(clean(x.action) ?? "");
}

export function taskReady(x: Task): boolean {
  if (x.kind === "draft") return !!taskDraftText(x);
  if (x.kind === "action" && x.act) return !!clean(x.value);
  if (x.kind === "action") return !!clean(x.action) && !sendsUnseenMessage(x);
  return false;
}

// ------------------------------------------------------------------ validation

function parseFields(kv: Record<string, string>): Partial<Record<TaskField, string>> {
  const out: Partial<Record<TaskField, string>> = {};
  for (const [k, v] of Object.entries(kv)) {
    if (!(TASK_FIELDS as readonly string[]).includes(k)) throw new Error(`unknown task field: ${k} (${TASK_FIELDS.join(", ")})`);
    if (k === "kind" && !(TASK_KINDS as readonly string[]).includes(v)) throw new Error(`unknown kind: ${v} (${TASK_KINDS.join(", ")})`);
    if (k === "act" && clean(v) && !(TASK_ACTS as readonly string[]).includes(clean(v))) throw new Error(`unknown act: ${v} (${TASK_ACTS.join(", ")})`);
    if (k === "visibility" && clean(v) && !["public", "internal"].includes(clean(v))) throw new Error(`unknown visibility: ${v} (public, internal)`);
    out[k as TaskField] = k === "kind" ? v : clean(v);
  }
  return out;
}

/** Addresses written `alice@acme.example, bob@acme.example`: trimmed, the empty ones left out. */
const addressList = (v: string): string[] =>
  v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * The task with the audience fields a session wrote applied: `audience.to` and `audience.cc` as lists of addresses,
 * `visibility`, `subject`; an empty value (or "-") removes one. The other fields are left to the caller.
 */
function withAudience(x: Task, f: Partial<Record<TaskField, string>>): Task {
  if (!AUDIENCE_FIELDS.some((k) => k in f)) return x;
  const audience: Audience = { ...(x.audience ?? {}) };
  if ("audience.to" in f) audience.to = addressList(f["audience.to"] ?? "");
  if ("audience.cc" in f) audience.cc = addressList(f["audience.cc"] ?? "");
  if ("visibility" in f) audience.visibility = (f.visibility || undefined) as Audience["visibility"];
  const kept = Object.fromEntries(Object.entries(audience).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length))) as Audience;
  const subject = "subject" in f ? (f.subject ?? "") : (x.subject ?? "");
  const { audience: _a, subject: _s, ...rest } = x;
  return { ...rest, ...(Object.keys(kept).length ? { audience: kept } : {}), ...(subject ? { subject } : {}) };
}

/** The fields of a task that are not audience fields, as the task stores them. */
const plainFields = (f: Partial<Record<TaskField, string>>): Partial<Task> => Object.fromEntries(Object.entries(f).filter(([k]) => !isAudienceField(k))) as Partial<Task>;

/** What is wrong in a task's audience and subject, or null: they go with a draft, one address per entry, one line. */
function invalidAudience(x: Pick<Task, "draft" | "audience" | "subject">): string | null {
  const a = x.audience ?? {};
  if ((a.to?.length || a.cc?.length || a.visibility || x.subject) && !x.draft) return "audience.to, audience.cc, visibility and subject go with a draft: the text they are about";
  for (const [field, list] of [["audience.to", a.to ?? []], ["audience.cc", a.cc ?? []]] as const) {
    if (list.length > MAX_RECIPIENTS) return `${field} names more than ${MAX_RECIPIENTS} addresses`;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
    const bad = list.find((v) => v.length > 254 || /[\s<>"\u0000-\u001f\u007f]/.test(v) || !v.includes("@"));
    if (bad !== undefined) return `${field}: "${truncate(bad, 80)}" is not one address; write addresses separated by commas, such as alice@acme.example, bob@acme.example`;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
  if (x.subject && (x.subject.length > 998 || /[\u0000-\u001f\u007f]/.test(x.subject))) return "subject is one line of at most 998 characters";
  return null;
}

/** A task that cannot be shown or carried out as written: the reason, or null. */
function invalid(x: Pick<Task, "kind" | "ask" | "draft" | "draftTo" | "to" | "action" | "act" | "value" | "audience" | "subject">): string | null {
  if (!x.ask) return "ask is required: what is asked, one sentence";
  if (x.act) {
    if (x.kind !== "action") return `act=${x.act} goes with kind=action`;
    if (!x.value) return `act=${x.act} requires value: ${x.act === "setStatus" ? "the name of the status" : "the assignee (an email, a name, me or none)"}`;
    if (x.draft) return `act=${x.act} carries no draft: a comment is a kind=draft task with to=<the ticket's key>`;
  }
  if (x.kind === "draft" && !x.draft) return "kind=draft requires draft: the text as it will go out";
  if (x.draft && !x.draftTo && !x.to) return "draft requires draftTo: the channel and the thread link, or the channel id and \"new message\" (or to=<key>)";
  if (x.to && !parseKey(x.to)) return `to=${x.to} is not a key: the key of a thread or of a conversation, such as C0123456789:1759219200.000100`;
  if (x.kind === "action" && !x.action && !x.act) return "kind=action requires action: the exact action that goes out on go";
  return invalidAudience(x);
}

// ------------------------------------------------------------------ state of the topic

/**
 * Keeps the topic's status consistent with its tasks: a closed topic has no open task (they are dropped, "topic
 * closed"); a topic with an open task is a gate; a gate whose tasks are all closed goes back to the session (working).
 * A gate with no task at all (a legacy decision without action) is left as it is.
 */
export function syncTaskStatus<S extends TaskHost>(s: S, now: string): S {
  const tasks = tasksOf(s);
  if (s.status === "closed") {
    if (!tasks.some((x) => x.status === "open")) return s.tasks ? s : { ...s, tasks };
    const note = t("task.note.topicClosed");
    return { ...s, tasks: tasks.map((x) => (x.status === "open" ? { ...x, status: "dropped" as const, closedAt: now, updatedAt: now, note } : x)) };
  }
  const open = tasks.filter((x) => x.status === "open").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (open.length) return { ...s, tasks, status: "gate", gate: !s.gate || s.gate === "none" ? open[0].kind : s.gate };
  if (s.status === "gate" && tasks.length) return { ...s, tasks, status: "working", gate: "none" };
  return { ...s, tasks };
}

const historyLine = (what: string, now: string) => ({ at: now, what });

/** Adds a task. Throws on a closed topic, an unknown field or kind, or a task that cannot be carried out as written. */
export function addTask<S extends TaskHost>(s: S, kv: Record<string, string>, now: string, origin: Task["origin"] = "task"): { sujet: S; task: Task } {
  if (s.status === "closed") throw new Error("the topic is closed: reopen it before adding a task");
  const f = parseFields(kv);
  if (!f.kind) throw new Error(`kind is required (${TASK_KINDS.join(", ")})`);
  const tasks = tasksOf(s);
  const task: Task = withAudience({
    id: nextTaskId(tasks),
    kind: f.kind as TaskKind,
    ask: f.ask ?? "",
    proposal: f.proposal ?? "",
    action: f.action ?? "",
    draft: f.draft ?? "",
    draftTo: f.draftTo ?? "",
    ...(f.to ? { to: f.to } : {}),
    ...(f.act ? { act: f.act as TaskAct } : {}),
    ...(f.value ? { value: f.value } : {}),
    createdAt: now,
    updatedAt: now,
    status: "open",
    origin,
  }, f);
  const why = invalid(task);
  if (why) throw new Error(why);
  const next = { ...s, tasks: [...tasks, task], updatedAt: now, history: [...s.history, historyLine(`task add ${task.id} kind=${task.kind} ask=${truncate(task.ask, 80)}`, now)] };
  return { sujet: syncTaskStatus(next, now), task };
}

/** Closes an open task: done (carried out) or dropped (no longer applies). Throws if it does not exist or is not open. */
export function closeTask<S extends TaskHost>(s: S, id: string, status: "done" | "dropped", now: string, note?: string): S {
  const tasks = tasksOf(s);
  const x = tasks.find((y) => y.id === id);
  if (!x) throw new Error(`no task ${id} in this topic (${tasks.map((y) => y.id).join(", ") || "none"})`);
  if (x.status !== "open") throw new Error(`task ${id} is already ${x.status}`);
  const closed: Task = { ...x, status, closedAt: now, updatedAt: now, ...(note?.trim() ? { note: note.trim() } : {}) };
  const next = { ...s, tasks: tasks.map((y) => (y.id === id ? closed : y)), updatedAt: now, history: [...s.history, historyLine(`task ${status === "done" ? "done" : "drop"} ${id}${note?.trim() ? ` note=${truncate(note.trim(), 80)}` : ""}`, now)] };
  return syncTaskStatus(next, now);
}

/** Reopens a closed task (the board's Undo after Send). */
export function reopenTask<S extends TaskHost>(s: S, id: string, now: string): S {
  const tasks = tasksOf(s);
  const x = tasks.find((y) => y.id === id);
  if (!x) throw new Error(`no task ${id} in this topic`);
  if (x.status === "open") return s;
  const { closedAt: _c, note: _n, ...rest } = x;
  const next = { ...s, tasks: tasks.map((y) => (y.id === id ? { ...rest, status: "open" as const, updatedAt: now } : y)), updatedAt: now, history: [...s.history, historyLine(`task reopen ${id}`, now)] };
  return syncTaskStatus(next, now);
}

/** Edits an open task in place (same request): only the given fields change, "-" empties one. */
export function editTask<S extends TaskHost>(s: S, id: string, kv: Record<string, string>, now: string): S {
  const f = parseFields(kv);
  if (!Object.keys(f).length) throw new Error(`nothing to edit: key=value expected (${TASK_FIELDS.join(", ")})`);
  const tasks = tasksOf(s);
  const x = tasks.find((y) => y.id === id);
  if (!x) throw new Error(`no task ${id} in this topic (${tasks.map((y) => y.id).join(", ") || "none"})`);
  if (x.status !== "open") throw new Error(`task ${id} is ${x.status}: add a new task instead`);
  const edited: Task = withAudience({ ...x, ...plainFields(f), updatedAt: now }, f);
  const why = invalid(edited);
  if (why) throw new Error(why);
  const next = { ...s, tasks: tasks.map((y) => (y.id === id ? edited : y)), updatedAt: now, history: [...s.history, historyLine(`task edit ${id} ${Object.keys(f).join(" ")}`, now)] };
  return syncTaskStatus(next, now);
}

// ------------------------------------------------------------------ compatibility with `set`

/** The card fields whose write by `set` concerns the tasks. */
const SET_TASK_KEYS = new Set(["status", "gate", "ask", "proposal", "action", "draft", "draftTo"]);

const sameText = (a: string | undefined, b: string | undefined) => clean(a).replace(/\s+/g, " ") === clean(b).replace(/\s+/g, " ");

/** A done task closed less than a day ago carried exactly this request and this draft or action: a legacy `set` that rewrites it does not resurrect it. */
function alreadyDone(tasks: Task[], fields: Pick<Task, "ask" | "action" | "draft">, now: string): boolean {
  if (!clean(fields.draft) && !clean(fields.action)) return false;
  return tasks.some(
    (x) => x.status === "done" && Date.parse(now) - Date.parse(x.closedAt ?? x.updatedAt) < 86_400_000 && sameText(x.ask, fields.ask) && sameText(x.draft, fields.draft) && sameText(x.action, fields.action),
  );
}

/**
 * A `set` from a session started before tasks, applied to the tasks. `next` is the topic with the fields already
 * written, `kv` what `set` received.
 * - status gate with a gate: the open "set" task is updated if the request is the same; if the request changed, it is
 *   dropped ("replaced by a new request") and a new task is created. Either way, only
 *   the fields this `set` wrote reach the task, never what an earlier gate left on the card.
 * - gate=none or status waiting: the open "set" task is done (the session says nothing waits any more).
 * - status closed: every open task is dropped (syncTaskStatus).
 * - status working or preparing: a relaunch in progress, the task stays.
 * Tasks of origin "task" are never touched here.
 */
export function applySetToTasks<S extends TaskHost>(next: S, kv: Record<string, string>, now: string): S {
  if (!Object.keys(kv).some((k) => SET_TASK_KEYS.has(k))) return next;
  let tasks = [...tasksOf(next)];
  const open = tasks.find((x) => x.status === "open" && x.origin === "set");
  const closeOpen = (status: "done" | "dropped", note: string) => {
    if (!open) return;
    tasks = tasks.map((x) => (x.id === open.id ? { ...x, status, closedAt: now, updatedAt: now, note } : x));
  };
  if (next.status === "gate" && next.gate && next.gate !== "none") {
    // Only what this very `set` wrote goes into the task: a field left on the card by an earlier gate (an action
    // never cleared) belongs to another request and never reaches a new task.
    const given = (k: "proposal" | "action" | "draft" | "draftTo") => (k in kv ? { [k]: clean(kv[k]) } : {});
    const ask = clean(next.ask) || next.title;
    if (open && sameText(open.ask, ask)) {
      const patch: Partial<Task> = { ...("gate" in kv ? { kind: gateKind(next.gate) } : {}), ...given("proposal"), ...given("action"), ...given("draft"), ...given("draftTo") };
      const changed = (Object.keys(patch) as (keyof Task)[]).some((k) => !sameText(open[k] as string | undefined, patch[k] as string | undefined));
      if (changed) tasks = tasks.map((x) => (x.id === open.id ? { ...x, ...patch, updatedAt: now } : x));
    } else {
      closeOpen("dropped", t("task.note.replaced"));
      const fields = { kind: gateKind(next.gate), ask, proposal: "", action: "", draft: "", draftTo: "", ...given("proposal"), ...given("action"), ...given("draft"), ...given("draftTo") };
      if (!alreadyDone(tasks, fields, now)) tasks.push({ id: nextTaskId(tasks), ...fields, createdAt: now, updatedAt: now, status: "open", origin: "set" });
    }
  } else if (kv.gate === "none" || next.status === "waiting") {
    closeOpen("done", t("task.note.gateDropped"));
  }
  return { ...next, tasks };
}
