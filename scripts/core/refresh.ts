/**
 * The card sweep: spot, without calling Claude, the cards that have probably gone stale, and say why.
 * A card only moves when a message of its thread arrives and the master relays it; an answer given elsewhere
 * (DM, another thread, ticket), a dead topic or a reworded answer from the person served leave it open forever.
 * The signals are checkable facts (dates from the log and from the card); the session decides, when relaunched.
 *
 * The signal texts are read by the session and shown on the board: they are still French, pending i18n.
 * The `StaleCode` values are part of the refresh signature stored on the card: do not rename them.
 */
import { t } from "./i18n.ts";
import type { RefreshSettings } from "./settings.ts";
import { type Snooze, type Sujet, sujetKeys } from "./sujet.ts";
import { openTasks, taskDraftText } from "./tasks.ts";
import { untrusted } from "./text.ts";

/** A line of the events.ndjson log, reduced to what the sweep reads. */
export interface SweepEvent {
  at: string;
  type: string;
  kind?: string;
  key?: string;
  from?: string;
}

export type StaleCode = "reponse" | "fil" | "attente" | "porte";

export interface StaleSignal {
  code: StaleCode;
  /** What the session reads, and what the board shows: one sentence, the fact first. */
  text: string;
}

const DAY_MS = 86_400_000;

function ageDays(from: number, now: number): number {
  return Math.floor((now - from) / DAY_MS);
}

/** The Slack messages of the topic's thread that arrived after its card, most recent last. */
function messagesAfterCard(s: Sujet, events: SweepEvent[]): SweepEvent[] {
  const keys = new Set(sujetKeys(s));
  const cardAt = Date.parse(s.updatedAt);
  return events.filter((e) => e.type === "slack" && e.key && keys.has(e.key) && Date.parse(e.at) > cardAt).sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Why the card has probably gone stale, or [] if nothing says so. Only looks at cards that wait (gate or waiting):
 * a session that is preparing or working will rewrite its card by itself.
 * A recent message is a signal only after `graceMinutes`: the master has that long to relay it.
 */
export function staleSignals(s: Sujet, events: SweepEvent[], now: number, opts: Pick<RefreshSettings, "staleDays" | "graceMinutes">): StaleSignal[] {
  if (s.status !== "gate" && s.status !== "waiting") return [];
  const signals: StaleSignal[] = [];
  const after = messagesAfterCard(s, events).filter((e) => now - Date.parse(e.at) >= opts.graceMinutes * 60_000);
  const mine = after.filter((e) => e.kind === "moi");
  const others = after.filter((e) => e.kind !== "moi");
  // what waits is the open tasks: a draft is one of their drafts, never a draft left on the card
  const open = openTasks(s);
  const hasDraft = open.some((x) => !!taskDraftText(x));
  if (mine.length && (hasDraft || s.status === "gate")) {
    signals.push({ code: "reponse", text: t(hasDraft ? "stale.replyDraft" : "stale.reply") });
  }
  if (others.length) {
    const last = others[others.length - 1];
    signals.push({ code: "fil", text: t(others.length > 1 ? "stale.thread.other" : "stale.thread.one", { n: others.length, from: untrusted(last.from ?? "?") }) });
  }
  const age = ageDays(Date.parse(s.updatedAt), now);
  if (!after.length && age >= opts.staleDays) {
    // who is awaited is already on the card (the "waiting on …" badge): the signal only gives the duration
    if (s.status === "waiting") signals.push({ code: "attente", text: t("stale.waiting", { n: age }) });
    else if (open.length) signals.push({ code: "porte", text: t("board.stale.task", { id: open[0].id, n: Math.max(age, ageDays(Date.parse(open[0].createdAt), now)) }) });
    else signals.push({ code: "porte", text: t("stale.gate", { gate: s.gate && s.gate !== "none" ? s.gate : t("stale.gateOpen"), n: age }) });
  }
  return signals;
}

/**
 * What identifies a card state already relaunched: the signals, the date of the card and, for a wait, the
 * `staleDays` slice it has reached. A relaunch that changes nothing on the card does not go again on the next
 * pass; a wait that grows by a whole slice goes again once.
 */
export function refreshSignature(s: Sujet, signals: StaleSignal[], now: number, staleDays: number): string {
  const slice = Math.floor(ageDays(Date.parse(s.updatedAt), now) / Math.max(1, staleDays));
  return `${signals.map((x) => x.code).join("+")}@${s.updatedAt}#${slice}`;
}

/** A card to relaunch automatically: signals, a session, not snoozed, not working, and not already relaunched for this state. */
export function shouldAutoRefresh(s: Sujet, signals: StaleSignal[], sig: string, ctx: { busy: boolean; snooze?: Snooze; now: number }): boolean {
  if (!signals.length || !s.sessionId || ctx.busy) return false;
  if (ctx.snooze && Date.parse(ctx.snooze.until) > ctx.now) return false;
  return s.refresh?.sig !== sig;
}
