/**
 * Hands a message to a topic's session whatever its state: alive, it gets it through SendMessage (a throwaway
 * `claude -p`); stopped, it is resumed with it (`claude --bg --resume`), only once even when two messages arrive
 * together (claimResume). Shared by the board, the card refresh and the listener: no `process.exit`, nothing on
 * stdout, a result the caller displays.
 * The `note` and `error` strings are shown on the board: they go through core/i18n.ts.
 */
import { inboundNote, routeDecision } from "../claude/model.ts";
import { t } from "../core/i18n.ts";
import { settings } from "../core/settings.ts";
import { applyAssignments, findSujet } from "../core/sujet.ts";
import { agentsBySessionAsync, deliverToLiveSession, sessionIdOf, spawnBackgroundAsync } from "./claude.ts";
import { nowIso } from "./env.ts";
import { claimResume, endResume, loadSujets, logEvent, updateSujet } from "./store.ts";

export type Delivery = { ok: true; note: string; via: "sendmessage" | "resume" } | { ok: false; error: string; status: number };

/** `origin` names the sender in the event log (board, refresh): `<origin>-send`, `<origin>-send-failed`. */
export async function deliverToSujet(key: string, message: string, origin: string): Promise<Delivery> {
  const s = findSujet(loadSujets(), key);
  if (!s) return { ok: false, error: t("board.api.topicMissing"), status: 404 };
  if (s.status === "closed") return { ok: false, error: t("board.api.topicClosedReopen", { letter: s.letter }), status: 409 };
  if (!s.sessionId) return { ok: false, error: t("board.api.noSession", { letter: s.letter }), status: 409 };
  const sessionId = s.sessionId;
  const rows = await agentsBySessionAsync();
  if (!rows) return { ok: false, error: t("board.api.agentsSilent"), status: 503 };
  const toLive = async (): Promise<Delivery> => {
    const r = await deliverToLiveSession(s.name, `${message}\n\n${inboundNote(settings().owner.name)}`);
    if (!r.ok) {
      logEvent({ type: `${origin}-send-failed`, key: s.key, error: r.error });
      return { ok: false, error: t("board.api.deliverFailed", { letter: s.letter, error: r.error }), status: 502 };
    }
    logEvent({ type: `${origin}-send`, key: s.key, via: "sendmessage" });
    return { ok: true, note: t("board.api.delivered", { letter: s.letter }), via: "sendmessage" };
  };
  if (routeDecision(rows.get(sessionId)) === "sendmessage") return toLive();
  const busyUntil = await claimResume(s.key);
  if (busyUntil !== null) {
    // another message is already resuming the session: wait until it runs, then hand this one over
    while (Date.now() < busyUntil) {
      await Bun.sleep(1_000);
      if (routeDecision((await agentsBySessionAsync())?.get(sessionId)) === "sendmessage") return toLive();
    }
    return { ok: false, error: t("board.api.resumeBusy", { letter: s.letter }), status: 409 };
  }
  let shortId: string;
  try {
    shortId = await spawnBackgroundAsync(["--resume", sessionId, message]);
  } catch (e) {
    await endResume(s.key);
    return { ok: false, error: (e as Error).message, status: 500 };
  }
  const resumedId = shortId !== s.shortId ? await sessionIdOf(shortId) : null;
  await updateSujet(s.key, (x) => {
    const { resumingUntil: _, ...next } = applyAssignments(x, { status: "working" }, nowIso());
    return shortId !== x.shortId ? { ...next, shortId, sessionId: resumedId ?? x.sessionId } : next;
  });
  logEvent({ type: "resume", key: s.key, shortId, origin });
  return { ok: true, note: t("board.api.resumed", { letter: s.letter, shortId }), via: "resume" };
}
