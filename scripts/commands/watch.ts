/**
 * Listening: `listen` (push: Socket Mode for Slack), `watch` (polling), the catch-ups, `backlog` and `digest`.
 * Every account that brings items in runs here, each in its own loop (app/ingest.ts), and every item goes through
 * the same triage (`processItems`), printing the same lines for the master's Monitor. The default Slack account keeps
 * the loop, the state files (seen.json, tick.json) and the lines it always had.
 */
import { existsSync, mkdirSync, readFileSync, watch as fsWatch } from "node:fs";
import { join } from "node:path";
import { agentsBySessionAsync, declaredAttention, purgeLive } from "../app/claude.ts";
import { dayTime, durationOrFail, F, fail, HEARTBEAT_MS, localTime, mtimeOf, nowIso, out, readJson, STATE, writeJson } from "../app/env.ts";
import {
  accountLabel,
  accountSeen,
  announcedLine,
  cappedLine,
  catchUpThreads,
  connectAccount,
  ingestAccounts,
  itemKeyOf,
  legacySeen,
  outageLines,
  participatedOf,
  processItems,
  runAccount,
  type SeenStore,
  type Source,
  slackSource,
  sourceOf,
  threadKeyOf,
  triageErrorLine,
  triageItem,
} from "../app/ingest.ts";
import { appToken, defaultSlack, tokenCandidates } from "../app/slack.ts";
import { runGc } from "./gc.ts";
import { pickCards, refreshCards } from "./refresh.ts";
import { type Counters, ensureState, loadSujets, logEvent, withLock } from "../app/store.ts";
import { type Config, socketDeaf, type SocketHealth } from "../chat/slack-model.ts";
import { type AgentRow, attentionChanged, sessionAttention } from "../claude/model.ts";
import { digestLines, gateLine, type InfoEvent } from "../core/cards.ts";
import { type MasterRequest, revueLine } from "../core/master.ts";
import { settings } from "../core/settings.ts";
import { dueReminders, findSujet, type Snooze, type Sujet, trackedKeys } from "../core/sujet.ts";
import { t } from "../core/i18n.ts";
import { isSilent } from "../core/triage.ts";
import { providerError } from "../providers/api.ts";
import { type AccountEntry, accountContext } from "../providers/registry.ts";
import type { Item } from "../providers/sdk.ts";
import { slackProvider } from "../providers/slack/index.ts";

export { connexionSocket, type FinSocket, type SocketDeps } from "../app/slack.ts";
export { processMatches, triageErrorLine } from "../app/ingest.ts";

export function sessionLine(s: Sujet, label: string): string {
  return `[strato] session · ${label} · ${gateLine(s)} · claude attach ${s.shortId}`;
}

/**
 * Rereads the Slack threads of open topics since `since` (Unix seconds) and passes their messages through the shared
 * triage, on the default Slack account (`catchUpThreads` in app/ingest.ts). `failed` counts threads unreadable for a
 * transient reason: the pass is not complete and the cursor must not move. `base` is the workspace's URL.
 */
export async function backfillThreads(cfg: Config, seen: Set<string>, participated: Set<string>, base: string, since: number): Promise<{ items: Item[]; failed: number }> {
  if (base) defaultSlack.base = base.replace(/\/$/, "");
  return catchUpThreads(slackSource(cfg, legacySeen(seen), participated), since * 1000);
}

// ------------------------------------------------------------------ the default Slack account

/** The default Slack account, connected: the source its loop reads. */
interface SlackRun {
  src: Source;
}

/**
 * Whether the default Slack account is listened to. Alone, always, as before: a profile without Slack stops with the
 * reason. Next to other accounts, when the `slack` section names the person or the workspace, or a Slack token is found.
 */
function slackInUse(others: AccountEntry[]): boolean {
  const s = settings().slack;
  return others.length === 0 || !!(s.team || s.me) || tokenCandidates().length > 0;
}

/**
 * Connects the default Slack account. Alone, a failure stops the command as before (exit 78); next to other accounts,
 * it is one line and the others carry on.
 */
async function connectDefaultSlack(alone: boolean, seen: SeenStore): Promise<SlackRun | null> {
  const cfg = settings().slack;
  const probe = slackSource(cfg, seen);
  try {
    const identity = await slackProvider.connect(probe.ctx);
    return { src: slackSource(cfg, seen, new Set(), identity) };
  } catch (e) {
    const pe = providerError(e);
    if (alone) fail(pe.message, 78);
    outageLines("Slack", out).failed(pe.message, true);
    return null;
  }
}

/** A Slack line, or the end of the command when Slack is alone. */
function slackStops(alone: boolean, message: string, code: number): null {
  if (alone) fail(message, code);
  outageLines("Slack", out).failed(message, true);
  return null;
}

/** The labels of the other accounts, for the armed line. */
const labelsOf = (entries: AccountEntry[]) => entries.map((e) => `${e.account.provider}${e.account.id === "default" ? "" : `@${e.account.id}`}`).join(", ");

/** A macOS notification, without dependencies: osascript. Fails silently outside macOS. */
function notifyMac(title: string, body: string): void {
  const q = (t: string) => JSON.stringify(t);
  try {
    Bun.spawn(["/usr/bin/osascript", "-e", `display notification ${q(body)} with title ${q("Strato")} subtitle ${q(title)} sound name "Glass"`], { stdout: "ignore", stderr: "ignore" });
  } catch {}
}

/** The starting state, read as `pollSessions` will read it next: a restart announces nothing that did not change. */
async function knownAttention(prev: Map<string, string | null>): Promise<void> {
  const rows = await agentsBySessionAsync();
  for (const s of loadSujets()) {
    if (!s.sessionId || s.status === "closed") continue;
    const cur = sessionAttention(declaredAttention(s.sessionId), rows?.get(s.sessionId), rows !== null);
    if (cur !== undefined) prev.set(s.key, cur);
  }
}

/** One `claude agents` at a time: the 5 min safety net must not pile up processes if the previous one lags. */
let agentsRunning = false;

/** Topic sessions whose attention state changed: one line each. Does not touch Slack. */
async function pollSessions(prev: Map<string, string | null>, opts: { spawn?: boolean } = {}): Promise<void> {
  // `claude agents --json` is still the only way to see a session that died abruptly and could declare nothing.
  // So it runs only as a safety net, not on every transition, and asynchronously: the socket keeps acknowledging meanwhile.
  let rows: Map<string, AgentRow> | null = null;
  if (opts.spawn !== false) {
    if (agentsRunning) return;
    agentsRunning = true;
    try {
      rows = await agentsBySessionAsync();
    } finally {
      agentsRunning = false;
    }
  }
  // no await until the end: two polls do not interleave on `prev`
  for (const s of loadSujets()) {
    if (!s.sessionId || s.status === "closed") continue;
    const cur = sessionAttention(declaredAttention(s.sessionId), rows?.get(s.sessionId), rows !== null);
    if (cur === undefined) continue;
    if (attentionChanged(prev.get(s.key), cur)) {
      out(sessionLine(s, cur as string));
      logEvent({ type: "session", key: s.key, attention: cur });
    }
    prev.set(s.key, cur);
  }
}

/**
 * Watches the state of topic sessions without a fixed tick.
 * The sessions' hooks rewrite `<state>/live/<sessionId>.json` on each change: polling happens only after a real
 * change. `claude agents --json` stays the only source of `state` and `waitingFor`, but it no longer runs every
 * minute for nothing: zero processes while nothing moves, at most one every `minGap` seconds when things get busy.
 * If `fs.watch` is unavailable, fall back to a slow tick rather than watch nothing.
 */
function watchSessions(prev: Map<string, string | null>, minGap = 5): () => void {
  const dir = join(STATE, "live");
  mkdirSync(dir, { recursive: true });
  let last = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;

  const trigger = () => {
    if (pending) return;
    const left = Math.max(0, last + minGap * 1000 - Date.now());
    pending = setTimeout(() => {
      pending = null;
      last = Date.now();
      pollSessions(prev, { spawn: false }).catch(() => {});
    }, Math.max(1000, left));
    pending.unref?.();
  };

  try {
    const w = fsWatch(dir, trigger);
    return () => w.close();
  } catch {
    const t = setInterval(() => {
      pollSessions(prev).catch(() => {});
    }, minGap * 3000);
    t.unref?.();
    return () => clearInterval(t);
  }
}

/**
 * Listening: the default Slack account through Socket Mode (messages arrive over the WebSocket instead of being
 * searched for every 60 s in the search index), and every other account in its own loop (app/ingest.ts): a push
 * account by its connection, a poll account by polling. Same output lines as `watch`.
 * At startup, a catch-up through search and the threads of open topics covers the downtime; then the socket alone,
 * with a catch-up every 5 min and on wake. Topics are polled by a light tick that does not call Slack.
 */
export async function listen(opts: Record<string, string>) {
  ensureState();
  const others = ingestAccounts();
  const alone = others.length === 0;
  const stop = new AbortController();

  const seenIds = new Set(readJson<string[]>(F.seen, []));
  const seen = legacySeen(seenIds);
  let slack = slackInUse(others) ? await connectDefaultSlack(alone, seen) : null;
  const xapp = slack ? appToken() : null;
  if (slack && !xapp) slack = slackStops(alone, settings().slack.appTokenFile ? t("cli.listen.noAppTokenFile", { file: settings().slack.appTokenFile }) : t("cli.listen.noAppToken"), 78);
  const base = slack ? (defaultSlack.base ?? (await defaultSlack.workspaceUrl())) : "";
  if (slack && !base) slack = slackStops(alone, t("cli.listen.noWorkspaceUrl"), 78);

  const minGap = Number(opts.sessions ?? 20);
  const saved = readJson<{ lastTick?: number; syncedTo?: number }>(F.tick, {});
  const firstRun = saved.lastTick === undefined;
  // up to where everything was surely read (`nextSyncCursor`); an installation older than the cursor starts from the heartbeat
  let syncedTo = saved.syncedTo ?? saved.lastTick ?? Date.now() / 1000 - 3600;
  if (slack) slack.src.participated = await participatedOf(slack.src);
  const prev = new Map<string, string | null>();
  await knownAttention(prev);

  // Socket health, written with each tick: the board reads it to tell whether Slack still delivers.
  const health: SocketHealth = { lastEventAt: Date.now(), missedAt: 0, missed: 0, wokeAt: 0, syncedAt: 0 };
  const writeTick = () => writeJson(F.tick, slack ? { lastTick: Date.now() / 1000, syncedTo, beat: HEARTBEAT_MS / 1000, socket: health } : { lastTick: Date.now() / 1000, ...(saved.syncedTo ? { syncedTo: saved.syncedTo } : {}), beat: HEARTBEAT_MS / 1000 });

  /**
   * Catch-up of the default Slack account through search and through the threads of open topics, from `fromSec`.
   * At startup it covers the downtime; then it runs every 5 min and on wake from sleep, because a dead socket says
   * nothing: neither a half-open connection after sleep, nor a delivery cut by Slack (Slack can disable an app's
   * events, and the socket then stays open and silent for as long as nobody notices).
   * `countMissed`: a message caught up here, older than 2 min, is a message the socket should have brought.
   */
  let syncing: Promise<void> | null = null;
  const resync = (fromSec: number, why: string, countMissed: boolean): Promise<void> => {
    if (!slack) return Promise.resolve();
    const { src } = slack;
    if (syncing) return syncing;
    syncing = (async () => {
      const startedSec = Date.now() / 1000;
      let found: Item[] = [];
      // the pass moves the cursor only if it read everything: search and threads
      let ok = true;
      let next = syncedTo;
      try {
        const r = await src.provider.poll?.(src.ctx, { value: String(fromSec), at: fromSec * 1000 }, { since: fromSec * 1000, maxItems: 3000 });
        if (!r) throw new Error("no poll");
        if (!r.complete) out(cappedLine(null, 3000));
        found = r.items.filter((it) => !seen.has(itemKeyOf(src, it.id) ?? ""));
        await processItems(src, r.items, firstRun && why === "startup");
        next = Number(r.cursor.value);
      } catch {
        ok = false;
        health.syncFailedAt = Date.now();
        if (why !== "periodic") out(`[strato] search catch-up failed (${why})`);
      }
      if (!firstRun) {
        try {
          const threads = await catchUpThreads(src, (fromSec - 300) * 1000);
          found.push(...threads.items);
          if (threads.failed) {
            ok = false;
            health.syncFailedAt = Date.now();
            if (why !== "periodic") out(`[strato] thread catch-up incomplete (${why}): ${threads.failed} unreadable thread(s), retried on the next pass`);
          }
        } catch (e) {
          ok = false;
          health.syncFailedAt = Date.now();
          if (why !== "periodic") out(`[strato] thread catch-up failed (${why}): ${(e as Error).message}`);
        }
      }
      // a failed pass leaves the cursor where it was; a cursor never moves back
      if (ok && Number.isFinite(next)) syncedTo = Math.max(syncedTo, next);
      seen.save();
      const late = countMissed ? found.filter((it) => it.time / 1000 < startedSec - 120) : [];
      if (late.length) {
        health.missed += late.length;
        health.missedAt = Date.now();
      }
      if (late.length && socketDeaf(health, Date.now()))
        out(`[strato] the socket has delivered nothing since ${dayTime(new Date(health.lastEventAt).toISOString())} while search finds messages: Slack probably disabled the app's events, re-enable them on its Event Subscriptions page`);
      health.syncedAt = Date.now();
      writeTick();
    })().finally(() => {
      syncing = null;
    });
    return syncing;
  };

  // Catch-up: what arrived while stopped, before opening the socket. Dedup absorbs the overlap.
  // Search only sees what mentions the person served; replies in the threads of open topics are reread separately,
  // otherwise follow-ups in those threads would be missed.
  if (slack) {
    await resync(syncedTo, "startup", false);
    out(`[strato] Socket Mode listener armed · ${firstRun ? "first run: history marked as read" : "catch-up done"} · topics declared by hook`);
  }
  if (!alone) out(`[strato] listener armed · ${labelsOf(others)} · each account in its own loop`);

  // Topics are watched through the file system, not by a tick.
  const stopSessions = watchSessions(prev, minGap);
  // A slow tick: state on disk, dead sessions, and catch-up of what the socket may have missed, from the cursor.
  const timer = setInterval(() => {
    try {
      if (slack) seen.save();
      writeTick();
      // The safety net: the one thing no hook can say is that a session died abruptly.
      pollSessions(prev, { spawn: true }).catch(() => {});
      purgeLive();
    } catch {}
    void resync(syncedTo, "periodic", true);
  }, 300_000);
  timer.unref?.();

  // Wake from sleep: the clock jumps. The WebSocket from before sleep is half open (Slack closed it, the machine does
  // not know): close it to open a new one, and catch up on what arrived during sleep.
  let connection: AbortController | null = null;
  let lastBeat = Date.now();
  let lastWrite = Date.now();
  const beat = setInterval(() => {
    const now = Date.now();
    const gap = now - lastBeat;
    lastBeat = now;
    // one-minute heartbeat in tick.json: the board's pill sees Strato silent within 3 min, without a line in the chat
    if (now - lastWrite >= HEARTBEAT_MS) {
      lastWrite = now;
      try {
        writeTick();
      } catch {}
    }
    if (gap < 60_000) return;
    health.wokeAt = now;
    connection?.abort();
    void resync(Math.min(syncedTo, (now - gap) / 1000), "wake", false);
  }, 10_000);
  beat.unref?.();

  const stopChannel = boardToMaster();
  // every other account in its own loop: one that fails never stops the others, nor Slack
  const loops = others.map((entry) => runAccount(entry, { mode: "listen", stop: stop.signal }));
  if (!slack) writeTick();

  // Messages are handled one at a time: processItems reads and writes `seen`.
  let file: Promise<void> = Promise.resolve();
  const outage = suiviOuverture(out);
  let backoff = 1;
  while (slack) {
    const { src } = slack;
    connection = new AbortController();
    const r = await src.provider.subscribe?.(
      { ...src.ctx, signal: connection.signal },
      (items) => {
        health.lastEventAt = Date.now();
        if (!items.length) return;
        file = file.then(async () => {
          try {
            await processItems(src, items);
            seen.save();
          } catch (err) {
            // never silently: the master must know a message was not triaged
            out(triageErrorLine(items[0].link || items[0].id, err));
          }
        });
      },
      {
        opened: () => {
          outage.ouverte();
          backoff = 1;
        },
      },
    );
    if (!r) break;
    if (r.refused) outage.refus(r.refused, r.end === "fatal");
    if (r.end === "fatal") break;
    // Slack's Retry-After first (capped at 15 min), else the backoff
    await Bun.sleep(Math.max(backoff, Math.min(900, (r.retryAfterMs ?? 0) / 1000)) * 1000);
    backoff = r.end === "clean" ? 1 : Math.min(60, backoff * 2);
  }
  await file;
  await Promise.all(loops);
  stop.abort();
  clearInterval(beat);
  clearInterval(timer);
  stopChannel();
  stopSessions();
}

/**
 * The lines of an opening outage: one when it starts, one when the socket is back. A line per attempt would flood
 * the master with up to one line a minute for the whole outage. `refus` = refused, `ouverte` = opened.
 */
export function suiviOuverture(say: (line: string) => void): { refus: (reason: string, fatal: boolean) => void; ouverte: () => void } {
  let outage: string | null = null;
  return {
    refus(reason, fatal) {
      if (fatal) say(`[strato] socket opening refused: ${reason}, listener stopped`);
      else if (outage === null) say(`[strato] socket opening refused: ${reason} · retrying silently, one line when it is back`);
      outage = reason;
    },
    ouverte() {
      if (outage !== null) say(`[strato] Slack socket back after « ${outage} »`);
      outage = null;
    },
  };
}

/**
 * What the board sends the master: the requests ("Recheck everything", master.json) and the snoozes that ran out.
 * The listener (`listen` or `watch`) is the only way into its conversation, through the Monitor: both must carry it,
 * or a review requested from the board of an installation running `watch` would wait for the master forever.
 * Returns the function that stops everything.
 */
function boardToMaster(): () => void {
  const deliverRequests = () => {
    void withLock(() => {
      const list = readJson<MasterRequest[]>(F.master, []);
      let changed = false;
      for (const r of list) {
        if (r.deliveredAt || r.doneAt) continue;
        out(revueLine(r));
        r.deliveredAt = nowIso();
        changed = true;
      }
      if (changed) writeJson(F.master, list);
    }).catch(() => {});
  };
  deliverRequests();

  // Snooze reminders: a snooze "until the 13th" must come back to the person served for sure, even two weeks later,
  // even if the machine was asleep at that time. The reminder goes out on the first pass after the deadline, once
  // (notifiedAt): a line to the master, which sends a push notification, and a direct macOS notification.
  const remind = () => {
    void withLock(() => {
      const all = readJson<Record<string, Snooze>>(F.snooze, {});
      const keys = dueReminders(all, Date.now());
      if (!keys.length) return;
      const sujets = loadSujets();
      for (const k of keys) {
        const z = all[k];
        const s = findSujet(sujets, k);
        z.notifiedAt = nowIso();
        if (!s || s.status === "closed") continue;
        const why = z.reason ? ` · ${z.reason}` : "";
        out(`[strato] reminder · ${s.letter} · ${s.title}${why} · pause over, the topic is back on the board · send a push notification to ${settings().owner.name}`);
        logEvent({ type: "snooze-reminder", key: s.key, reason: z.reason });
        notifyMac(`${s.letter} · ${s.title}`, z.reason ? t("cli.notify.snoozeOverReason", { reason: z.reason }) : t("cli.notify.snoozeOver"));
      }
      writeJson(F.snooze, all);
    }).catch(() => {});
  };
  remind();
  const reminders = setInterval(remind, 60_000);
  reminders.unref?.();
  let masterMtime = mtimeOf(F.master);
  const requests = setInterval(() => {
    const m = mtimeOf(F.master);
    if (m === masterMtime) return;
    masterMtime = m;
    deliverRequests();
  }, 2_000);
  requests.unref?.();

  // Card sweep (commands/refresh.ts): one minute after startup, then every refresh.everyMinutes.
  // The listener may be re-armed often: each relaunch's signature prevents relaunching the same state twice.
  let sweeping = false;
  const sweep = () => {
    if (sweeping || !settings().refresh.auto) return;
    sweeping = true;
    pickCards({ stale: true })
      .then((picks) => refreshCards(picks, "sweep"))
      .catch((e: Error) => out(`[strato] card sweep failed: ${e.message}`))
      .finally(() => {
        sweeping = false;
      });
  };
  const firstSweep = setTimeout(sweep, 60_000);
  firstSweep.unref?.();
  const sweeps = setInterval(sweep, Math.max(5, settings().refresh.everyMinutes) * 60_000);
  sweeps.unref?.();
  // Session collector (commands/gc.ts): sessions of closed topics every 5 min, those idle for gc.idleHours once
  // every gc.everyMinutes. One pass at a time.
  let collecting = false;
  const collect = (closedOnly: boolean) => {
    if (collecting || settings().gc.everyMinutes <= 0) return;
    collecting = true;
    runGc(closedOnly ? "close" : "gc", closedOnly)
      .catch((e: Error) => out(`[strato] session collection failed: ${e.message}`))
      .finally(() => {
        collecting = false;
      });
  };
  const firstCollect = setTimeout(() => collect(false), 120_000);
  firstCollect.unref?.();
  const closedCollects = setInterval(() => collect(true), 5 * 60_000);
  closedCollects.unref?.();
  const fullCollects = setInterval(() => collect(false), Math.max(5, settings().gc.everyMinutes) * 60_000);
  fullCollects.unref?.();
  return () => {
    clearInterval(requests);
    clearInterval(reminders);
    clearTimeout(firstSweep);
    clearInterval(sweeps);
    clearTimeout(firstCollect);
    clearInterval(closedCollects);
    clearInterval(fullCollects);
  };
}

/**
 * Polling, for the Monitor: the default Slack account through search every `interval` seconds, every other account
 * in its own loop at its own `pollInterval` (or `interval` when given). A fatal Slack error stops the command when
 * Slack is alone (exit 75), as before; next to other accounts, it is one line and the others carry on.
 */
export async function watch(intervalArg?: string) {
  ensureState();
  const cfg = settings().slack;
  const others = ingestAccounts();
  const alone = others.length === 0;
  const stop = new AbortController();
  const seen = legacySeen();
  let slack = slackInUse(others) ? await connectDefaultSlack(alone, seen) : null;
  const interval = Number(intervalArg ?? cfg.pollInterval);
  const saved = readJson<{ lastTick?: number; syncedTo?: number }>(F.tick, {});
  const firstRun = saved.lastTick === undefined;
  // the catch-up cursor (`nextSyncCursor`), separate from the `lastTick` heartbeat the board reads
  let syncedTo = saved.syncedTo ?? saved.lastTick ?? Date.now() / 1000 - 3600;
  const prev = new Map<string, string | null>();
  if (slack) slack.src.participated = await participatedOf(slack.src);
  await knownAttention(prev);
  boardToMaster();

  if (slack) out(`[strato] polling armed · every ${interval} s · ${firstRun ? "first run: history marked as read" : "messages that arrived while stopped will come out"}`);
  if (!alone) out(`[strato] polling armed · ${labelsOf(others)} · each account in its own loop`);
  // runAccount never rejects; the catch is a last guard so that one account can never take the process down
  for (const entry of others) void runAccount(entry, { mode: "watch", stop: stop.signal, ...(intervalArg ? { intervalSec: interval } : {}) }).catch((e) => outageLines(accountLabel(entry.account), out).failed(providerError(e).message, true));

  let backoff = 0;
  for (let tick = 0; ; tick++) {
    if (tick > 0) await Bun.sleep((interval + backoff) * 1000);
    try {
      const tickStart = Date.now() / 1000;
      if (slack) {
        const { src } = slack;
        // 5 min margin for the Slack index lag (in the provider), dedup absorbs the overlap
        const r = await src.provider.poll?.(src.ctx, { value: String(syncedTo), at: syncedTo * 1000 }, { since: syncedTo * 1000, maxItems: 3000 });
        if (!r) throw new Error("no poll");
        if (!r.complete) out(cappedLine(null, 3000));
        await processItems(src, r.items, tick === 0 && firstRun);
        seen.save();
        // incomplete pass: not beyond the oldest message read; a cursor never moves back
        syncedTo = Math.max(syncedTo, Number(r.cursor.value) || syncedTo);
      }
      writeJson(F.tick, { lastTick: tickStart, ...(slack || saved.syncedTo ? { syncedTo } : {}) });

      await pollSessions(prev);
      backoff = 0;
    } catch (e) {
      const pe = providerError(e);
      if (pe.fatal) {
        // alone, the command stops as before; next to other accounts, only Slack stops, said like any other account
        if (alone) {
          out(`[strato] FATAL: ${pe.code}, polling stopped`);
          process.exit(75);
        }
        outageLines("Slack", out).failed(pe.message, true);
        slack = null;
      }
      backoff = Math.min(300, backoff === 0 ? interval : backoff * 2);
    }
  }
}

/** Recent relevant messages of every account that can be polled, over `--since` (12 h by default), without writing the log. */
export async function backlog(opts: Record<string, string>) {
  ensureState();
  const others = ingestAccounts();
  const alone = others.length === 0;
  const slack = slackInUse(others) ? await connectDefaultSlack(alone, legacySeen(new Set())) : null;
  const since = opts.since ?? "12h";
  const ms = durationOrFail(since);
  const sujets = loadSujets();
  const tracked = trackedKeys(sujets);
  const count = { n: 0, silent: 0 };
  if (slack) {
    slack.src.participated = await participatedOf(slack.src);
    try {
      const r = await slack.src.provider.poll?.(slack.src.ctx, null, { since: Date.now() - ms, maxItems: 6000 });
      if (r && !r.complete) out(cappedLine(null, 6000, true));
      await backlogItems(slack.src, r?.items ?? [], sujets, tracked, count);
    } catch (e) {
      if (alone) fail(providerError(e).message);
      outageLines("Slack", out).failed(providerError(e).message);
    }
  }
  for (const entry of others) await backlogAccount(entry, Date.now() - ms, sujets, tracked, count);
  out(`[strato] ${count.n} relevant message(s) over ${since} · ${count.silent} set aside (third parties, bots)`);
}

/** The relevant items of one batch, printed; set aside ones counted. Nothing is logged nor marked as read. */
async function backlogItems(src: Source, items: Item[], sujets: Sujet[], tracked: Set<string>, count: { n: number; silent: number }): Promise<void> {
  for (const item of items) {
    const key = threadKeyOf(src, item.thread);
    if (!key) continue;
    if (item.author.isMe) src.participated.add(key);
    const r = await triageItem(src, item, key, tracked);
    if (!r) continue;
    if (isSilent(r.kind)) {
      count.silent++;
      continue;
    }
    out(announcedLine(src, r, itemKeyOf(src, item.id) ?? undefined, sujets));
    count.n++;
  }
}

/** The backlog of another account: connected for this command only, a failure is one line. */
async function backlogAccount(entry: AccountEntry, sinceMs: number, sujets: Sujet[], tracked: Set<string>, count: { n: number; silent: number }): Promise<void> {
  const lines = outageLines(accountLabel(entry.account), out);
  if (!entry.provider?.poll) return;
  try {
    const identity = await connectAccount(entry, accountContext(entry));
    const src = sourceOf(entry, identity, accountSeen(entry.account));
    src.participated = await participatedOf(src);
    const r = await entry.provider.poll(src.ctx, null, { since: sinceMs, maxItems: 6000 });
    if (!r.complete) out(cappedLine(src.label, 6000, true));
    await backlogItems(src, r.items, sujets, tracked, count);
  } catch (e) {
    lines.failed(providerError(e).message);
  }
}

/** The messages the listener set aside, read from events.ndjson: no Slack call. */
export async function digest(opts: Record<string, string>) {
  ensureState();
  const counters = readJson<Counters>(F.counters, {});
  const now = Date.now();
  const sinceMs = opts.since ? now - durationOrFail(opts.since) : counters.digest ? Date.parse(counters.digest) : now - 6 * 3_600_000;
  const events: InfoEvent[] = [];
  const raw = existsSync(F.events) ? readFileSync(F.events, "utf8") : "";
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as InfoEvent;
      if (e.type === "info" && Date.parse(e.at) > sinceMs) events.push(e);
    } catch {}
  }
  out(`[strato] digest since ${dayTime(new Date(sinceMs).toISOString())} · ${events.length} message(s) set aside`);
  for (const line of digestLines(events, localTime)) out(line);
  await withLock(() => writeJson(F.counters, { ...readJson<Counters>(F.counters, {}), digest: new Date(now).toISOString() }));
}
