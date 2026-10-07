/**
 * Hands a message to a topic's session whatever its state: alive with Strato's mod, through its inbox (app/mod.ts),
 * acknowledged within seconds; alive without it, through SendMessage (a throwaway `claude -p`); stopped, it is resumed
 * with it (`claude --bg --resume`), only once even when two messages arrive together (claimResume). Shared by the board, the card refresh and the listener: no `process.exit`, nothing on
 * stdout, a result the caller displays.
 * The `note` and `error` strings are shown on the board: they go through core/i18n.ts.
 */
import { inboundNote, routeDecision } from "../claude/model.ts";
import { t } from "../core/i18n.ts";
import { settings } from "../core/settings.ts";
import { applyAssignments, findSujet } from "../core/sujet.ts";
import { agentsBySessionAsync, deliverToLiveSession, sessionIdOf, spawnBackgroundAsync } from "./claude.ts";
import { resumeArgs } from "../claude/model.ts";
import { nowIso, STATE } from "./env.ts";
import { deliverThroughInbox } from "./mod.ts";
import { claimResume, endResume, loadSujets, logEvent, updateSujet } from "./store.ts";

/** A message that is a slash command ("/compact", "/compact keep the plan"): only the mod or a resume can run it. */
export const isSlashCommand = (text: string): boolean => /^\/[A-Za-z0-9_:-]+(?:\s|$)/.test(text.trim());

export type Delivery = { ok: true; note: string; via: "inbox" | "sendmessage" | "resume" } | { ok: false; error: string; status: number };

/**
 * `origin` names the sender in the event log (board, refresh): `<origin>-send`, `<origin>-send-failed`.
 * `ackTimeoutMs`: how long the mod has to acknowledge an inbox message before the relay takes it (tests shorten it).
 */
export async function deliverToSujet(key: string, message: string, origin: string, opts: { ackTimeoutMs?: number } = {}): Promise<Delivery> {
  const s = findSujet(loadSujets(), key);
  if (!s) return { ok: false, error: t("board.api.topicMissing"), status: 404 };
  if (s.status === "closed") return { ok: false, error: t("board.api.topicClosedReopen", { letter: s.letter }), status: 409 };
  if (!s.sessionId) return { ok: false, error: t("board.api.noSession", { letter: s.letter }), status: 409 };
  const sessionId = s.sessionId;
  const inbox = await deliverThroughInbox(STATE, sessionId, message, { timeoutMs: opts.ackTimeoutMs });
  if (inbox.via === "inbox" && inbox.ack === "refused") {
    logEvent({ type: `${origin}-send-failed`, key: s.key, error: "unknown command" });
    return { ok: false, error: t("board.api.commandUnknown", { letter: s.letter, command: message.trim().split(/\s/)[0] }), status: 409 };
  }
  if (inbox.via === "inbox") {
    logEvent({ type: `${origin}-send`, key: s.key, via: "inbox", ack: inbox.ack });
    return { ok: true, note: t(inbox.ack === "submitted" ? "board.api.inboxDelivered" : "board.api.inboxQueued", { letter: s.letter }), via: "inbox" };
  }
  // the mod is there but did not answer: the message goes the old way, and the note says so
  const noted = (note: string) => (inbox.reason === "unacknowledged" ? `${t("board.api.inboxUnacknowledged", { letter: s.letter })} ${note}` : note);
  const rows = await agentsBySessionAsync();
  if (!rows) return { ok: false, error: t("board.api.agentsSilent"), status: 503 };
  const toLive = async (): Promise<Delivery> => {
    const r = await deliverToLiveSession(s.name, `${message}\n\n${inboundNote(settings().owner.name)}`);
    if (!r.ok) {
      logEvent({ type: `${origin}-send-failed`, key: s.key, error: r.error });
      return { ok: false, error: t("board.api.deliverFailed", { letter: s.letter, error: r.error }), status: 502 };
    }
    logEvent({ type: `${origin}-send`, key: s.key, via: "sendmessage" });
    return { ok: true, note: noted(t("board.api.delivered", { letter: s.letter })), via: "sendmessage" };
  };
  // SendMessage hands the text to the model as a message from another agent: a slash command would only be read
  if (routeDecision(rows.get(sessionId)) === "sendmessage") return isSlashCommand(message) ? { ok: false, error: t("board.api.commandNeedsMod", { letter: s.letter }), status: 409 } : toLive();
  const busyUntil = await claimResume(s.key);
  if (busyUntil !== null) {
    // another message is already resuming the session: wait until it runs, then hand this one over
    while (Date.now() < busyUntil) {
      await Bun.sleep(1_000);
      if (routeDecision((await agentsBySessionAsync())?.get(sessionId)) === "sendmessage") return isSlashCommand(message) ? { ok: false, error: t("board.api.commandNeedsMod", { letter: s.letter }), status: 409 } : toLive();
    }
    return { ok: false, error: t("board.api.resumeBusy", { letter: s.letter }), status: 409 };
  }
  let shortId: string;
  try {
    shortId = await spawnBackgroundAsync(resumeArgs(sessionId, message));
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
  return { ok: true, note: noted(t("board.api.resumed", { letter: s.letter, shortId })), via: "resume" };
}
