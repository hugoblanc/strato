/**
 * The session collector: which topic sessions to stop, without deciding anything on their behalf.
 * A session whose topic is closed has nothing left to do; a session idle for a long time resumes on its own at the
 * next message (`claude --resume`), its card stays intact. Stopping keeps the conversation.
 * Never a session that is working or waiting for a permission, never a session that belongs to no topic.
 */
import type { AgentRow } from "../claude/model.ts";
import type { Sujet } from "./sujet.ts";

export interface GcStop {
  key: string;
  letter: string;
  /** The short id from `claude agents`, the one `claude stop` takes. */
  id: string;
  reason: string;
}

/**
 * `rows`: live sessions by sessionId; `lastTurnAt`: when the session declared its last turn (Stop hook), in ms, or
 * null if it never declared anything (it is then never stopped for inactivity).
 */
export function sessionsToStop(sujets: Sujet[], rows: Map<string, AgentRow>, lastTurnAt: (sessionId: string) => number | null, now: number, idleHours: number, closedOnly = false): GcStop[] {
  const stops: GcStop[] = [];
  for (const s of sujets) {
    if (!s.sessionId) continue;
    const row = rows.get(s.sessionId);
    if (!row?.id || row.status === "busy" || row.status === "waiting") continue;
    if (s.status === "closed") {
      stops.push({ key: s.key, letter: s.letter, id: row.id, reason: "topic closed" });
      continue;
    }
    if (closedOnly || row.status !== "idle" || idleHours <= 0) continue;
    const at = lastTurnAt(s.sessionId);
    if (at === null) continue;
    const hours = (now - at) / 3_600_000;
    if (hours >= idleHours) stops.push({ key: s.key, letter: s.letter, id: row.id, reason: `idle for ${Math.floor(hours)} h` });
  }
  return stops;
}
