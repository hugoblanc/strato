/**
 * The session collector (core/gc.ts): the listener runs it every `gc.everyMinutes`, the `gc` command on demand.
 * Every stop is logged (gc-stop) with its reason: Strato keeps track of what it stopped.
 */
import { agentsBySessionAsync, declaredAttention, purgeLive, stopSession } from "../app/claude.ts";
import { ensureState, loadSujets, logEvent, purgeUploads } from "../app/store.ts";
import { flags, out } from "../app/env.ts";
import { type GcStop, sessionsToStop } from "../core/gc.ts";
import { settings } from "../core/settings.ts";

/** What the collector would stop now. [] if `claude agents` does not answer: without a state, nothing is stopped. */
export async function planGc(now = Date.now(), closedOnly = false): Promise<GcStop[]> {
  const rows = await agentsBySessionAsync();
  if (!rows) return [];
  const lastTurnAt = (sid: string) => {
    const d = declaredAttention(sid) as { at?: number } | null;
    return typeof d?.at === "number" ? d.at : null;
  };
  return sessionsToStop(loadSujets(), rows, lastTurnAt, now, settings().gc.idleHours, closedOnly);
}

/** Stops the planned sessions one by one, then purges the declarations of closed topics' sessions. */
export async function runGc(origin: string, closedOnly = false): Promise<{ stop: GcStop; ok: boolean }[]> {
  const done: { stop: GcStop; ok: boolean }[] = [];
  for (const stop of await planGc(Date.now(), closedOnly)) {
    const ok = await stopSession(stop.id);
    logEvent({ type: "gc-stop", key: stop.key, reason: stop.reason, origin, ok });
    done.push({ stop, ok });
  }
  purgeLive();
  purgeUploads();
  return done;
}

/** `gc [--dry]`: stops the sessions of closed topics and those idle for gc.idleHours. */
export async function gc(args: string[]) {
  ensureState();
  const { opts } = flags(args);
  if (opts.dry === "true") {
    const plan = await planGc();
    if (!plan.length) out("no session to stop");
    for (const s of plan) out(`${s.letter} · ${s.id} · ${s.reason}`);
    return;
  }
  const done = await runGc("cli");
  if (!done.length) out("no session to stop");
  for (const d of done) out(`${d.stop.letter} · ${d.ok ? "stopped" : "stop failed"} · ${d.stop.reason}`);
}
