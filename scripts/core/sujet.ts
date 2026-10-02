import { normalizeDue } from "./due.ts";
import { isTicketKey, parseKey, sujetKey } from "./keys.ts";
import { descriptorOf } from "./links.ts";
import { applySetToTasks, legacyTasks, syncTaskStatus, type Task } from "./tasks.ts";
import { isItemEvent } from "./triage.ts";
import { truncate } from "./text.ts";

/**
 * A topic ("sujet" in the code and on disk: sujets.json): one request, one session, one card.
 * French spellings that remain in this file are values read from disk or written by sessions with a French
 * policy (step prefixes, closing summaries, action verbs): they are recognized next to their English forms.
 */

export const SUJET_STATUSES = ["preparing", "working", "gate", "waiting", "closed"] as const;
export type SujetStatus = (typeof SUJET_STATUSES)[number];

export interface Sujet {
  /** Main key: the one the topic was opened with, which also names the report. */
  key: string;
  /** All the keys of the topic (Slack threads, tickets), the main key first. */
  threads: string[];
  /**
   * The conversation of the item the topic was opened from, as `<provider>[@<account>]:<id>` (core/keys.ts
   * `conversationRef`), when its key does not say it: a Slack key names its channel, another tool's key does not.
   */
  conversation?: string;
  /** Stable letter (A, B… AA) the person served uses to give a go: "A send". */
  letter: string;
  title: string;
  channel: string;
  permalink: string;
  asker: string;
  sessionId: string | null;
  shortId: string | null;
  name: string;
  status: SujetStatus;
  gate: string;
  waiting: string;
  next: string;
  summary: string;
  /** Card: what is asked, in one sentence. */
  ask?: string;
  /** Card: why it is for the person served. */
  why?: string;
  /** Card: what the session proposes. */
  proposal?: string;
  /** Card: the exact action that goes out on go (message with channel and thread, ticket, command). */
  action?: string;
  /** Card: what is not checked, or "nothing". */
  unverified?: string;
  /** Card: the message as it will go out. Nothing else in this field. */
  draft?: string;
  /** Card: where the draft goes (channel and thread link, or DM). */
  draftTo?: string;
  /** Card: the plan, 3 to 7 steps separated by "|", each prefixed done:, now: or todo:. A single now. */
  steps?: string;
  /** Card: what blocks the now step, and who, in one sentence. */
  blocker?: string;
  /** Card: the topic's merge requests, "api!1042 | web!2671" or their links. The board reads their state from GitLab. */
  mrs?: string;
  /** Card: the deadlines, "18:00 merge the MRs | 2026-09-30 10:00 send the notice", local time. */
  due?: string;
  /** The last draft posted from the board: "<ISO> <permalink>". Written by the server, not by the session. */
  posted?: string;
  /** Path of the session's full report. */
  report?: string;
  /** A `claude --resume` is in progress until this ISO date: a second relay does not resume again. Written under lock. */
  resumingUntil?: string;
  /** Note to hand to the session at `at` (a draft posted from the board, once the undo window is over). Survives a restart of serve. */
  notify?: { at: string; text: string; byTask?: Record<string, string> };
  /** When ✅ was added on the thread's original message, from the board: the topic is settled, the thread shows it. */
  checked?: string;
  /** Last relaunch by the card sweep (core/refresh.ts): when, for which state, and why. */
  refresh?: { at: string; sig: string; reasons: string };
  /** What waits for the person served, one task per thing to decide or to send (core/tasks.ts). Filled on load. */
  tasks?: Task[];
  createdAt: string;
  updatedAt: string;
  history: { at: string; what: string }[];
}

/** A topic as written on disk before letters and threads were added. */
export type StoredSujet = Omit<Sujet, "threads" | "letter"> & Partial<Pick<Sujet, "threads" | "letter">>;

/** All the keys of a topic, the main one first, without duplicates. */
export function sujetKeys(s: { key: string; threads?: string[] }): string[] {
  return [...new Set([s.key, ...(s.threads ?? [])])];
}

/** All the keys of all topics: what `watch` and `backlog` consider tracked. */
export function trackedKeys(list: Sujet[]): Set<string> {
  return new Set(list.flatMap(sujetKeys));
}

/** An open topic comes before a closed one, then the most recently updated. */
export function preferOpen(list: Sujet[]): Sujet | undefined {
  const rank = (s: Sujet) => (s.status === "closed" ? 1 : 0);
  return [...list].sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt))[0];
}

/** Thread or ticket key -> topic, preferring the open topic when a key is attached to several topics. */
export function sujetsByKey(list: Sujet[]): Map<string, Sujet> {
  const map = new Map<string, Sujet>();
  for (const key of trackedKeys(list)) {
    const best = preferOpen(list.filter((s) => sujetKeys(s).includes(key)));
    if (best) map.set(key, best);
  }
  return map;
}

const LETTER_REF = /^[A-Za-z]{1,3}$/;

/** Finds a topic by letter, by any of its keys, by link, by short id or by sessionId. */
export function findSujet(list: Sujet[], ref: string | undefined): Sujet | undefined {
  if (!ref) return undefined;
  const key = sujetKey(ref) ?? ref;
  const hits = list.filter((s) => sujetKeys(s).includes(key) || s.shortId === ref || s.sessionId === ref);
  if (hits.length) return preferOpen(hits);
  if (!LETTER_REF.test(ref)) return undefined;
  return preferOpen(list.filter((s) => s.letter === ref.toUpperCase()));
}

/** Adds a key to the topic. No effect if it is already there. The history entry stays in French: it is stored on disk. */
export function attachThread(s: Sujet, key: string, now: string): Sujet {
  if (sujetKeys(s).includes(key)) return s;
  return { ...s, threads: [...sujetKeys(s), key], updatedAt: now, history: [...s.history, { at: now, what: `rattaché ${key}` }] };
}

// ------------------------------------------------------------------ letters

/** 0 -> A, 25 -> Z, 26 -> AA, 27 -> AB, like spreadsheet columns. */
export function letterOf(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Next letter of day `day` from the counter: skips the letters of topics still open (yesterday's topic still open
 * keeps its own) and those already given that day.
 */
export function pickLetter(
  list: { letter?: string; status: string; createdAt: string }[],
  day: string,
  counter: number,
  dayOf: (iso: string) => string,
): { letter: string; counter: number } {
  const taken = new Set(
    list.filter((s) => s.letter && (s.status !== "closed" || dayOf(s.createdAt) === day)).map((s) => s.letter as string),
  );
  let i = Math.max(0, counter);
  while (taken.has(letterOf(i))) i++;
  return { letter: letterOf(i), counter: i + 1 };
}

/**
 * Defaults on load: `threads` = [key], and a letter for topics without one, given in opening order, day by day.
 * Deterministic as long as the file is not rewritten, and the first write freezes the letters.
 */
export function normalizeSujets(raw: StoredSujet[], dayOf: (iso: string) => string): Sujet[] {
  // a card written before tasks: its open gate becomes the task t1 (core/tasks.ts, legacyTasks)
  const out: StoredSujet[] = raw.map((s) => ({ ...s, threads: sujetKeys(s), tasks: s.tasks ?? legacyTasks(s) }));
  const counters = new Map<string, number>();
  const missing = out
    .map((_, i) => i)
    .filter((i) => !out[i].letter)
    .sort((a, b) => out[a].createdAt.localeCompare(out[b].createdAt) || a - b);
  for (const i of missing) {
    const day = dayOf(out[i].createdAt);
    const { letter, counter } = pickLetter(out, day, counters.get(day) ?? 0, dayOf);
    out[i] = { ...out[i], letter };
    counters.set(day, counter);
  }
  return out as Sujet[];
}

export interface Trigger {
  from: string;
  channel: string;
  text: string;
  permalink: string;
  /** The key of its thread, and its conversation (`conversationRef`): kept with a message surfaced to the master. */
  key?: string;
  conversation?: string;
}

// ------------------------------------------------------------------ state

export function parseAssignments(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of args) {
    const i = a.indexOf("=");
    if (i <= 0) throw new Error(`expected key=value, got "${a}"`);
    out[a.slice(0, i)] = a.slice(i + 1);
  }
  return out;
}

export const CARD_FIELDS = ["ask", "why", "proposal", "action", "draft", "draftTo", "steps", "blocker", "mrs", "due", "unverified", "report"] as const;
const EDITABLE = new Set<string>(["status", "gate", "waiting", "next", "summary", "title", "posted", ...CARD_FIELDS]);
/** Fields a "-" value empties. */
const CLEARABLE = new Set<string>(["waiting", ...CARD_FIELDS]);

export function applyAssignments(s: Sujet, kv: Record<string, string>, now: string): Sujet {
  const next = { ...s, history: [...s.history] };
  for (const [k, v] of Object.entries(kv)) {
    if (!EDITABLE.has(k)) throw new Error(`field not editable: ${k}`);
    if (k === "status" && !(SUJET_STATUSES as readonly string[]).includes(v))
      throw new Error(`unknown status: ${v} (${SUJET_STATUSES.join(", ")})`);
    (next as Record<string, unknown>)[k] = CLEARABLE.has(k) && v === "-" ? "" : k === "due" ? normalizeDue(v, new Date(Date.parse(now))) : v;
  }
  next.updatedAt = now;
  next.history.push({ at: now, what: Object.entries(kv).map(([k, v]) => `${k}=${truncate(v, 80)}`).join(" ") });
  // the card fields of a legacy `set` become tasks, and the status follows the open tasks (core/tasks.ts)
  return syncTaskStatus(applySetToTasks(next, kv, now), now);
}

/** A teammate's message in the thread, without a mention of the person: `mention` and `dm` are requests, not a takeover. */
const TAKEN_KINDS = new Set(["suite", "fil", "canal"]);

/**
 * A teammate took the topic over: the team alias means "someone from the team", not the person served. If a member
 * of `teammates` wrote in a thread of the topic after it was opened, and the person served did not write after them,
 * the person served does not have to answer.
 */
export function takenBy(
  s: { createdAt: string; key: string; threads?: string[] },
  events: { at: string; type: string; kind?: string; key?: string; from?: string }[],
  teammates: string[] | undefined,
): { from: string; at: string } | null {
  if (!teammates?.length) return null;
  const team = new Set(teammates.map((t) => t.trim().toLowerCase()));
  const keys = new Set(sujetKeys(s));
  let taken: { from: string; at: string } | null = null;
  let ownerAfter = "";
  for (const e of events) {
    if (!isItemEvent(e) || !e.key || !keys.has(e.key) || e.at <= s.createdAt) continue;
    if (e.kind === "moi") ownerAfter = e.at > ownerAfter ? e.at : ownerAfter;
    else if (TAKEN_KINDS.has(e.kind ?? "") && e.from && team.has(e.from.trim().toLowerCase()) && (!taken || e.at > taken.at)) taken = { from: e.from, at: e.at };
  }
  return taken && taken.at > ownerAfter ? taken : null;
}

/** A step of a topic's plan, as the session writes it in `steps`. */
export interface Step {
  state: "done" | "now" | "todo";
  text: string;
}

/** `steps` -> steps. Separator "|" or line break; prefix done: / now: / todo: (or ✓ ◉ ○, or the French fait: / encours: / à faire:), else todo. */
export function parseSteps(raw: string | undefined): Step[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/\s*\|\s*|\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const m = x.match(/^(done|now|todo|fait|encours|à faire|✓|◉|○)\s*:?\s*(.*)$/i);
      const tag = (m?.[1] ?? "").toLowerCase();
      const state: Step["state"] = ["done", "fait", "✓"].includes(tag) ? "done" : ["now", "encours", "◉"].includes(tag) ? "now" : "todo";
      return { state, text: (m ? m[2] : x).trim() || x };
    });
}

/**
 * Does the card's action boil down to posting the draft? If it does anything else (merge, run, create…), the board
 * does not post by itself: it gives the go to the session, which carries everything out in order. Otherwise, on an
 * action like "merge then post", Send would post "it is live" before the merge. When in doubt, no: going through the
 * session is always safe. A card from before the draft field, whose `action` carries the text itself, is posted directly.
 */
export function postOnlyAction(s: Pick<Sujet, "draft" | "action">): boolean {
  if (!s.draft?.trim()) return true;
  const a = (s.action ?? "").replace(/\\n/g, " ").trim().toLowerCase();
  if (!a || a === "-") return true;
  // the verbs and the chaining words in French (the installations' profiles) and in English (the default policy)
  if (!/^(poster|poste|répondre|envoyer|post|reply|send)\b/.test(a)) return false;
  return !/(\bpuis\b|\bensuite\b|\bavant\b|\baprès\b| et |\bthen\b|\bbefore\b|\bafter\b| and |;|\+|merg|releas|déplo|deplo|deploy|\blanc|\bcré|\bcreat|\bouvr|\bopen\b|\bferm|\bclose\b|ticket|script|commande|command|exécut|execut|\bpush|\brun\b)/.test(a);
}

/** The draft text as it will go out: the "\\n" written literally by sessions become line breaks again. */
export function draftText(s: Pick<Sujet, "draft" | "gate" | "action">): string {
  const raw = s.draft?.trim() ? s.draft : s.gate === "draft" ? (s.action ?? "") : "";
  return raw.replace(/\\n/g, "\n").trim();
}

/** A topic snoozed by the person served ("remind me later"): until when, and since when. */
export interface Snooze {
  until: string;
  since: string;
  /** Why we wait, in a few words ("answer from the vendor"), repeated in the reminder. */
  reason?: string;
  /** When the reminder went out. An expired snooze without a reminder is reminded on the next pass, even after sleep. */
  notifiedAt?: string;
}

/** The expired snoozes whose reminder has not gone out yet. */
export function dueReminders(all: Record<string, Snooze>, now: number): string[] {
  return Object.entries(all)
    .filter(([, z]) => !z.notifiedAt && Date.parse(z.until) <= now)
    .map(([k]) => k);
}

/**
 * Is the message the person served just posted the card's draft? Posted by the master on go, copied by hand, or
 * touched up before sending: words are compared, not characters. Slack rewrites links (<url|text>) and mentions
 * (<@U…>), they are removed on both sides.
 */
export function draftMatches(draft: string, posted: string): boolean {
  const words = (t: string) =>
    t
      .replace(/<([^>|]+)\|([^>]+)>/g, "$2")
      .replace(/<[^>]+>/g, " ")
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/:[a-z0-9_+-]+:/g, " ")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1);
  // the log cuts the received text at 500 characters ("…"): then only the start of the draft is compared
  const cut = posted.endsWith("…");
  const a = words(cut ? draft.slice(0, posted.length - 1) : draft);
  const b = words(cut ? posted.slice(0, -1) : posted);
  if (!a.length || !b.length) return false;
  if (a.length <= 4) return a.join(" ") === b.join(" ");
  const sb = new Set(b);
  const common = new Set(a.filter((w) => sb.has(w))).size;
  return common / Math.max(new Set(a).size, sb.size) >= 0.7;
}

/**
 * Snoozed as long as the time has not passed and nobody but the person served has written in the thread since the
 * snooze: a new message wakes the topic up, otherwise the snooze would hide exactly what needs to be seen.
 */
export function isSnoozed(z: Snooze | undefined, lastMessage: { at: string; kind: string } | null, now: number): boolean {
  if (!z) return false;
  if (Date.parse(z.until) <= now) return false;
  if (lastMessage && lastMessage.kind !== "moi" && Date.parse(lastMessage.at) > Date.parse(z.since)) return false;
  return true;
}

/** A result of the board's ⌘K bar. */
export interface SujetHit {
  key: string;
  letter: string;
  title: string;
  status: string;
  asker: string;
  channel: string;
  updatedAt: string;
  open: boolean;
}

/**
 * The ⌘K search. A Slack or Linear link finds the topic that carries that thread, open or closed; a text looks for
 * each word in the letter, the title, the asker, the channel and the summary, ignoring accents and case. Open topics
 * first, then the most recent; closed ones older than 30 days are ignored.
 */
export function searchSujets(list: Sujet[], q: string, now: number): { link: boolean; hits: SujetHit[] } {
  const hit = (s: Sujet): SujetHit => ({ key: s.key, letter: s.letter, title: s.title, status: s.status, asker: s.asker, channel: s.channel, updatedAt: s.updatedAt, open: s.status !== "closed" });
  const order = (a: Sujet, b: Sujet) => Number(b.status !== "closed") - Number(a.status !== "closed") || b.updatedAt.localeCompare(a.updatedAt);
  const query = q.trim();
  if (!query) return { link: false, hits: list.filter((s) => s.status !== "closed").sort(order).slice(0, 12).map(hit) };
  const key = sujetKey(query);
  if (key) return { link: true, hits: list.filter((s) => sujetKeys(s).includes(key)).sort(order).map(hit) };
  const fold = (t: string) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const words = fold(query).split(/\s+/).filter(Boolean);
  const recent = (s: Sujet) => s.status !== "closed" || now - Date.parse(s.updatedAt) < 30 * 86_400_000;
  return {
    link: false,
    hits: list
      .filter(recent)
      .filter((s) => {
        if (words.length === 1 && s.letter.toLowerCase() === words[0]) return true;
        const hay = fold([s.title, s.asker, s.channel, s.summary ?? "", s.ask ?? "", ...sujetKeys(s)].join(" "));
        return words.every((w) => hay.includes(w));
      })
      .sort((a, b) => Number(words.length === 1 && b.letter.toLowerCase() === words[0]) - Number(words.length === 1 && a.letter.toLowerCase() === words[0]) || order(a, b))
      .slice(0, 12)
      .map(hit),
  };
}

/**
 * The freshness of a wait, for the tint: `h` goes from green (0 min) to yellow (2 h) then red (24 h), on a
 * logarithmic scale; `k` darkens the red from 0 (24 h) to 1 (3 days and more).
 */
export function freshness(ms: number): { h: number; k: number } {
  const hours = Math.max(0, ms) / 3_600_000;
  const t = Math.min(1, Math.log1p(hours) / Math.log1p(24));
  const h = Math.round(120 * (1 - t));
  const k = Math.round(Math.min(1, Math.max(0, (hours - 24) / 48)) * 100) / 100;
  return { h, k };
}

/**
 * The closing summaries that do not mean "settled": the topic was not for the person served, or changed hands.
 * English forms are those of the default policy ("not for …", "taken by …"); French forms are kept for the summaries
 * written by French policies and for the topics already on disk.
 */
const NOT_SETTLED = /^\s*((clos|closed)\s*:\s*)?(pas pour|pris par|passé à|doublon|rattaché|not for|taken by|handed (?:over )?to|duplicate|attached to)/i;

/**
 * A closed topic whose original thread may receive the tool's settled marker (Slack: ✅): settled (not "not for …",
 * "taken by …"), not already checked, and of a tool that declares a `done` marker, the test the gate's `donePlan`
 * applies (a ticket, a mail thread or a tool without one never shows the button).
 */
export function checkable(s: Pick<Sujet, "status" | "key" | "summary" | "checked">): boolean {
  if (s.status !== "closed" || s.checked || isTicketKey(s.key)) return false;
  const p = parseKey(s.key);
  if (!p || p.long || !descriptorOf(p.provider)?.done) return false;
  return !NOT_SETTLED.test(s.summary ?? "");
}
