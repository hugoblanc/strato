/**
 * Refreshing cards that went stale: the sweep (core/refresh.ts) says which ones and why, each session rereads its
 * thread and brings its card back to the real state. Three triggers: the listener (`listen` or `watch`) at startup
 * then every `refresh.everyMinutes`, the board's button, and the `refresh` command.
 */
import { agentsBySessionAsync } from "../app/claude.ts";
import { deliverToSujet } from "../app/deliver.ts";
import { F, flags, nowIso, out, readJson, SCRIPT } from "../app/env.ts";
import { ensureState, loadSujets, logEvent, readEvents, updateSujet } from "../app/store.ts";
import { refreshSignature, shouldAutoRefresh, type StaleSignal, staleSignals, type SweepEvent } from "../core/refresh.ts";
import { settings } from "../core/settings.ts";
import { findSujet, type Snooze, type Sujet } from "../core/sujet.ts";
import { openTasks } from "../core/tasks.ts";
import { refreshMessage } from "../policy/prompts.ts";

export interface RefreshPick {
  sujet: Sujet;
  signals: StaleSignal[];
  sig: string;
}

export interface RefreshResult {
  letter: string;
  key: string;
  reasons: string;
  ok: boolean;
  note: string;
}

/**
 * The cards to refresh. `stale`: only those the sweep flags and that were not already refreshed for this state.
 * `refs`: those topics, signals or not. Neither: every open card that has a session.
 * A working session is never refreshed: it will rewrite its card by itself.
 */
export async function pickCards(sel: { stale?: boolean; refs?: string[] }, now = Date.now()): Promise<RefreshPick[]> {
  const cfg = settings().refresh;
  const sujets = loadSujets();
  const events = readEvents<SweepEvent>();
  const snooze = readJson<Record<string, Snooze>>(F.snooze, {});
  const rows = await agentsBySessionAsync();
  const busy = (s: Sujet) => Boolean(s.sessionId && rows?.get(s.sessionId)?.status === "busy");
  const wanted = sel.refs?.length ? sel.refs.map((r) => findSujet(sujets, r)).filter((s): s is Sujet => Boolean(s)) : sujets;
  const picks: RefreshPick[] = [];
  for (const s of wanted) {
    if (s.status === "closed" || !s.sessionId) continue;
    const signals = staleSignals(s, events, now, cfg);
    const sig = refreshSignature(s, signals, now, cfg.staleDays);
    if (sel.stale) {
      if (shouldAutoRefresh(s, signals, sig, { busy: busy(s), snooze: snooze[s.key], now })) picks.push({ sujet: s, signals, sig });
    } else if (!busy(s)) picks.push({ sujet: s, signals, sig });
  }
  return picks;
}

/**
 * Refreshes the chosen cards, `maxParallel` at a time. The refresh is marked in the topic under the lock before
 * sending: the listener and the board sweeping at the same time do not refresh the same card twice for the same state.
 */
export async function refreshCards(picks: RefreshPick[], origin: string, force = false): Promise<RefreshResult[]> {
  const cfg = settings().refresh;
  const owner = settings().owner.name;
  const results: RefreshResult[] = [];
  const queue = [...picks];
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const reasons = p.signals.map((x) => x.text);
      const why = reasons.join("; ") || `refresh requested by ${owner}`;
      const sig = p.sig;
      const claimed = await updateSujet(p.sujet.key, (x) => (force || x.refresh?.sig !== sig ? { ...x, refresh: { at: nowIso(), sig, reasons: why } } : null));
      if (!claimed) continue;
      const r = await deliverToSujet(p.sujet.key, refreshMessage(reasons.length ? reasons : [why], SCRIPT, p.sujet.key, openTasks(p.sujet)), "refresh");
      logEvent({ type: "refresh", key: p.sujet.key, origin, reasons: why, ok: r.ok, ...(r.ok ? {} : { error: r.error }) });
      results.push({ letter: p.sujet.letter, key: p.sujet.key, reasons: why, ok: r.ok, note: r.ok ? r.note : r.error });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, cfg.maxParallel) }, worker));
  return results;
}

/** `refresh [--stale] [--dry] [letters…]`: without argument, every open card; --stale, those the sweep flags. */
export async function refresh(args: string[]) {
  ensureState();
  const { positional, opts } = flags(args);
  const stale = opts.stale === "true";
  const picks = await pickCards({ stale, refs: positional });
  if (!picks.length) {
    out(stale ? "no stale card" : "no card to refresh (closed, without a session, or session working)");
    return;
  }
  if (opts.dry === "true") {
    for (const p of picks) out(`${p.sujet.letter} · ${p.sujet.title} · ${p.signals.map((x) => x.text).join("; ") || "no signal"}`);
    return;
  }
  const results = await refreshCards(picks, "cli", !stale);
  for (const r of results) out(`${r.letter} · ${r.ok ? "refreshed" : "failed"} · ${r.reasons}${r.ok ? "" : ` · ${r.note}`}`);
}
