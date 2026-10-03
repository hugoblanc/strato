import { settings } from "./settings.ts";

/**
 * A request from the person served to the master, made from the board ("Recheck everything", the ⌘K bar, an update).
 * The board writes it to `<state>/master.json`, `listen` prints it in the master's Monitor (the only way into its
 * conversation without SendMessage, which an interactive master does not accept), and the master closes it with `revue-done`.
 */
export interface MasterRequest {
  id: string;
  /**
   * revue: "Recheck everything". demande: free text typed in the ⌘K bar (question, link to triage, draft to write).
   * update: Strato was updated from the board, the master rereads SKILL.md and re-arms its listener.
   * The values are stored in master.json: keep them.
   */
  kind: "revue" | "demande" | "update";
  /** Key of REVUE_WINDOWS, for a review. */
  since?: string;
  /** The text typed by the person served, for a demande. */
  text?: string;
  /** For an update: the version before and after, "0.1.0 (abc1234)". */
  from?: string;
  to?: string;
  at: string;
  deliveredAt?: string;
  doneAt?: string;
  /** The master's answer, one or two sentences, shown on the board. */
  summary?: string;
  /** Removed from the board header by the person served (× button): kept in master.json, no longer shown. */
  dismissedAt?: string;
}

/**
 * Review windows offered by the board, in display order: key passed to `backlog --since`, label. The label is also
 * what the master reads in its request line ("full review over the last 2 weeks"); the board translates its own
 * labels (board.header.revue.window.*).
 */
export const REVUE_WINDOWS: Record<string, string> = { "24h": "last 24 h", "3d": "last 3 days", "14d": "last 2 weeks" };

/** A review left open for less than 45 min blocks the next one: two reviews in parallel would step on each other. */
export const REVUE_STALE_MS = 45 * 60_000;

export function pendingRevue(list: MasterRequest[], now: number): MasterRequest | null {
  return [...list].reverse().find((r) => r.kind === "revue" && !r.doneAt && now - Date.parse(r.at) < REVUE_STALE_MS) ?? null;
}

/** The line `listen` prints in the master's Monitor (English, see SKILL.md). */
export function revueLine(r: MasterRequest): string {
  if (r.kind === "update")
    return `[strato] update · ${settings().owner.name} updated Strato from the board, ${r.from ?? "?"} -> ${r.to ?? "?"} · id=${r.id} · the code on disk changed and the board server already restarted on it: reread SKILL.md in full now (it may have changed), then stop your Monitor and re-arm the listener with the same command so it runs the new code, then bun $S revue-done ${r.id} "<one line: what you reloaded>"`;
  if (r.kind === "demande")
    return `[strato] request · ${settings().owner.name} from the board · « ${(r.text ?? "").replace(/\s+/g, " ").trim()} » · id=${r.id} · handle it as if they had typed it here (a link alone: triage it like an incoming message, and say whether it concerns us), then answer in one or two sentences with bun $S revue-done ${r.id} "<answer>": the answer shows on the board`;
  return `[strato] request · ${settings().owner.name} from the board · full review over the ${REVUE_WINDOWS[r.since ?? ""] ?? r.since} (--since ${r.since}) · id=${r.id} · follow the "Full review" section of the skill, then bun $S revue-done ${r.id} "<summary>"`;
}
