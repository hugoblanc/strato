/**
 * Closing a topic, with or without the tool's settled marker (Slack: ✅ on the topic's original message). The board's
 * "Settled ✅" and its "it's settled" chip, and the master's `close <letter> --settled`, all come here: the topic is
 * closed first, then the marker goes out through the single act path (app/act.ts `actDone`, gate and event log), so a
 * marker that cannot go out never keeps a topic open.
 */
import { type ActOrigin, donePlan } from "../core/gate.ts";
import { t } from "../core/i18n.ts";
import { toolLabel } from "../core/targets.ts";
import { parseKey } from "../core/keys.ts";
import { applyAssignments, findSujet, type Sujet } from "../core/sujet.ts";
import { actDone } from "./act.ts";
import { nowIso } from "./env.ts";
import { loadSujets, logEvent, updateSujet } from "./store.ts";

/**
 * What became of the marker: put on the original message (`posted`, also when it was already there), already noted on
 * the topic (`already`), held back by shadow mode (`shadow`), not asked for (`skipped`), not available for this tool
 * (`none`: a ticket, a tool without a `done` marker), or refused or failed at the tool (`failed`, with `error`).
 */
export type Reaction = "posted" | "already" | "shadow" | "skipped" | "none" | "failed";

export interface CloseOutcome {
  topic: Sujet;
  reaction: Reaction;
  error?: string;
  /** One line for the person: what was closed and what became of the marker. */
  note: string;
}

/** The tool of a topic's key, for the words of the note ("Linear has no settled marker"). */
function toolOfKey(key: string): string {
  const p = parseKey(key);
  return p ? toolLabel(p.provider, p.account) : key;
}

/**
 * Closes the topic `key` (status closed, no gate, no one waited for) and, when `settled`, puts the tool's settled
 * marker on its original message. Returns null when the topic does not exist. `by` names who asked, for the event log:
 * the board (the click is the Go on the marker) or the master (`close --settled`, rule 1 of `suite` messages).
 */
export async function closeTopic(req: { key: string; settled: boolean; by: ActOrigin }): Promise<CloseOutcome | null> {
  const before = findSujet(loadSujets(), req.key);
  if (!before) return null;
  const closed = await updateSujet(before.key, (x) => applyAssignments(x, { status: "closed", gate: "none", waiting: "-" }, nowIso()));
  if (!closed) return null;
  const letter = closed.letter;
  const done = (reaction: Reaction, note: string, topic: Sujet = closed, error?: string): CloseOutcome => {
    logEvent({ type: req.by === "board" ? "board-close" : "close", by: req.by, key: closed.key, settled: req.settled, react: reaction === "posted", reaction, ...(error ? { error } : {}) });
    return { topic, reaction, note, ...(error ? { error } : {}) };
  };
  if (!req.settled) return done("skipped", t("board.api.topicClosedNote", { letter }));
  if (closed.checked) return done("already", t("close.note.already", { letter }));
  // a ticket, or a tool without a settled marker: closing is all there is to do
  const plan = donePlan(closed);
  if ("code" in plan) return done("none", t("close.note.noMarker", { letter, tool: toolOfKey(closed.key) }));
  // the gate refuses first in shadow mode, and logs it: the topic is closed all the same
  const at = nowIso();
  const r = await actDone({ key: closed.key, by: req.by, after: (x) => ({ ...x, checked: at }) });
  if (r.ok) return done("posted", t("close.note.posted", { letter }), r.topic ?? closed);
  if ("refused" in r && r.refused.code === "shadow") return done("shadow", t("close.note.shadow", { letter }));
  const error = "refused" in r ? r.refused.message : r.failed.message;
  return done("failed", t("close.note.failed", { letter, error }), closed, error);
}
