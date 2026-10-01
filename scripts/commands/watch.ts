/**
 * Listening: `listen` (Socket Mode), `watch` (fallback polling), the catch-ups, `backlog` and `digest`.
 * Both listeners go through the same triage (`processMatches`) and print the same lines for the master's Monitor.
 */
import { existsSync, mkdirSync, readFileSync, watch as fsWatch } from "node:fs";
import { join } from "node:path";
import { agentsBySessionAsync, declaredAttention, purgeLive } from "../app/claude.ts";
import { dayTime, durationOrFail, F, fail, HEARTBEAT_MS, localTime, mtimeOf, nowIso, out, readJson, STATE, writeJson } from "../app/env.ts";
import { appToken, channelOf, fetchSince, initSlack, matchFromEvent, participatedThreads, repliesOf, slack, SlackError, triage } from "../app/slack.ts";
import { runGc } from "./gc.ts";
import { pickCards, refreshCards } from "./refresh.ts";
import { type Counters, ensureState, keepMessage, loadSujets, logEvent, updateSujet, withLock } from "../app/store.ts";
import { classify, type Config, isSilent, nextSyncCursor, permalinkFor, type SlackMatch, socketDeaf, type SocketHealth, threadKey } from "../chat/slack-model.ts";
import { type AgentRow, attentionChanged, sessionAttention } from "../claude/model.ts";
import { digestLines, eventLine, gateLine, type InfoEvent } from "../core/cards.ts";
import { type MasterRequest, revueLine } from "../core/master.ts";
import { threadOfKey } from "../core/keys.ts";
import { settings } from "../core/settings.ts";
import { applyAssignments, draftMatches, dueReminders, findSujet, type Snooze, type Sujet, sujetKeys, trackedKeys } from "../core/sujet.ts";
import { closeTask, openTasks, taskDraftText } from "../core/tasks.ts";
import { t } from "../core/i18n.ts";
import { truncate } from "../core/text.ts";

export function sessionLine(s: Sujet, label: string): string {
  return `[strato] session · ${label} · ${gateLine(s)} · claude attach ${s.shortId}`;
}

/**
 * Rereads the Slack threads of open topics since `since` (Unix seconds) and passes their messages through the shared
 * triage. `seen` absorbs what was already handled; returns the new messages. No write outside seen and events.
 * `failed` counts threads unreadable for a transient reason (network, rate limit): the pass is not complete and the
 * cursor must not move. A thread unreadable for good (archived or left channel) does not hold the cursor back.
 */
export async function backfillThreads(cfg: Config, seen: Set<string>, participated: Set<string>, base: string, since: number): Promise<{ matches: SlackMatch[]; failed: number }> {
  const matches: SlackMatch[] = [];
  let failed = 0;
  for (const s of loadSujets()) {
    if (s.status === "closed") continue;
    for (const key of sujetKeys(s)) {
      // a ticket, or a key of another tool or account, has no Slack thread to catch up
      const thread = threadOfKey(key);
      if (!thread) continue;
      const { channel: channelId, ts } = thread;
      let replies: SlackMatch[];
      try {
        replies = await repliesOf(channelId, ts, { oldest: String(since) });
      } catch (e) {
        if (transientSlackError(e)) failed++;
        continue;
      }
      const channel = await channelOf(channelId);
      for (const m of replies) {
        if (!m.ts || m.ts === ts || Number(m.ts) < since) continue;
        if (seen.has(`${channelId}:${m.ts}`)) continue;
        matches.push({ ...m, channel, permalink: permalinkFor(base, channelId, m.ts, ts) });
      }
    }
  }
  if (matches.length) await processMatches(matches, cfg, seen, participated);
  return { matches, failed };
}

/** An error that may clear on the next try: network, timeout, rate limit, Slack-side outage. */
function transientSlackError(e: unknown): boolean {
  if (!(e instanceof SlackError)) return true;
  return ["ratelimited", "internal_error", "fatal_error", "request_timeout", "service_unavailable"].includes(e.code);
}

/**
 * Handles a batch of messages: dedup by `channel:ts`, triage by `classify`, one line per kept event.
 * Shared by `watch` (which reads search.messages) and `listen` (which reads the WebSocket): triage must live only here.
 * `markOnly` marks as read without a word, for the first pass of a fresh state.
 * A message enters `seen` only once handled (line printed, logged, or ignored): a triage error leaves it for the next
 * pass and says so on stdout. Marking it before would lose it silently on an error.
 */
export async function processMatches(
  matches: SlackMatch[],
  cfg: Config,
  seen: Set<string>,
  participated: Set<string>,
  markOnly = false,
): Promise<void> {
  const sujets = loadSujets();
  const tracked = trackedKeys(sujets);
  for (const m of matches) {
    if (m.user === cfg.me) participated.add(threadKey(m));
    const id = `${m.channel.id}:${m.ts}`;
    if (m.previous) {
      // an edit that adds the mention: the original is often already read (ignored silently), it must still come out,
      // unless its previous version already did (watched channel, tracked thread, DM): one line per message
      const before = classify(m.previous, cfg, tracked, participated);
      if (before && !isSilent(before)) continue;
    } else if (seen.has(id)) continue;
    if (markOnly) {
      seen.add(id);
      continue;
    }
    try {
      await sortOne(m, cfg, tracked, participated, sujets, () => seen.add(id));
    } catch (e) {
      out(triageErrorLine(m.permalink ?? id, e));
    }
  }
}

/** The line saying a message could not be triaged: the master reads it, the message will be retried. */
export function triageErrorLine(permalink: string, e: unknown): string {
  return `[strato] triage error ${permalink}: ${e instanceof Error ? e.message : String(e)}`;
}

/** Triages one message and prints its line; `done` marks it read as soon as its trace is written, not before. */
async function sortOne(m: SlackMatch, cfg: Config, tracked: Set<string>, participated: Set<string>, sujets: Sujet[], done: () => void): Promise<void> {
  const t = await triage(m, cfg, tracked, participated);
  if (!t) return void done();
  const { kind, d } = t;
  if (isSilent(kind)) {
    logEvent({ type: "info", kind, key: d.key, from: d.from, channel: d.channel, text: truncate(d.text, 200), permalink: d.permalink });
    return void done();
  }
  if (kind === "moi") await dropSentDraft(d.key, d.text, d.permalink);
  out(eventLine(kind, d, sujets, keepMessage(d)));
  // the line is out: even if the log fails next, do not repeat it on the next pass
  done();
  logEvent({ type: "slack", kind, key: d.key, from: d.from, channel: d.channel, permalink: d.permalink });
}

/** A macOS notification, without dependencies: osascript. Fails silently outside macOS. */
function notifyMac(title: string, body: string): void {
  const q = (t: string) => JSON.stringify(t);
  try {
    Bun.spawn(["/usr/bin/osascript", "-e", `display notification ${q(body)} with title ${q("Strato")} subtitle ${q(title)} sound name "Glass"`], { stdout: "ignore", stderr: "ignore" });
  } catch {}
}

/**
 * The person served posted the text of a draft in a thread of the topic (the master sent it on a go, or they copied
 * it): its task closes and the card waits for the rest of the thread at once, as after Send, without waiting for the
 * session's turn. Otherwise the draft would stay on the board with its button until the session removed it.
 */
async function dropSentDraft(key: string, text: string, permalink: string): Promise<void> {
  const s = findSujet(loadSujets(), key);
  if (!s || s.status === "closed") return;
  // the open task whose draft is the message posted: the first one that matches
  const match = (x: Sujet) => openTasks(x).find((y) => taskDraftText(y) && draftMatches(taskDraftText(y), text));
  if (!match(s)) return;
  const at = nowIso();
  let taskId = "";
  // checked again under the lock: the session may have changed its draft or closed the topic meanwhile
  const done = await updateSujet(s.key, (x) => {
    const y = x.status === "closed" ? undefined : match(x);
    if (!y) return null;
    taskId = y.id;
    const next = closeTask(x, y.id, "done", at, t("task.note.postedByHand", { permalink }));
    return applyAssignments(next, openTasks(next).length ? { posted: `${at} ${permalink}` } : { status: "waiting", waiting: t("task.waiting.restOfThread"), posted: `${at} ${permalink}` }, at);
  });
  if (done) logEvent({ type: "draft-dropped", key: s.key, task: taskId, permalink });
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

/** Purges keys older than three days and writes `seen.json`. */
function saveSeen(seen: Set<string>): void {
  const horizon = Date.now() / 1000 - 3 * 86400;
  for (const id of seen) if (Number(threadOfKey(id)?.ts) < horizon) seen.delete(id);
  writeJson(F.seen, [...seen]);
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
 * Listening through Socket Mode: same output lines as `watch`, but messages arrive over the WebSocket instead of
 * being searched for every 60 s in the search index.
 * At startup, a catch-up through search.messages covers the downtime; then the socket alone.
 * Topics are polled by a light tick that does not call Slack.
 */
export async function listen(opts: Record<string, string>) {
  ensureState();
  const cfg = settings().slack;
  await initSlack(cfg);

  const xapp = appToken();
  if (!xapp) fail(settings().slack.appTokenFile ? t("cli.listen.noAppTokenFile", { file: settings().slack.appTokenFile }) : t("cli.listen.noAppToken"), 78);

  const auth = await slack("auth.test");
  const base = String(auth.url ?? "").replace(/\/$/, "");
  if (!base) fail(t("cli.listen.noWorkspaceUrl"), 78);

  const minGap = Number(opts.sessions ?? 20);
  const seen = new Set(readJson<string[]>(F.seen, []));
  const saved = readJson<{ lastTick?: number; syncedTo?: number }>(F.tick, {});
  const firstRun = saved.lastTick === undefined;
  // up to where everything was surely read (`nextSyncCursor`); an installation older than the cursor starts from the heartbeat
  let syncedTo = saved.syncedTo ?? saved.lastTick ?? Date.now() / 1000 - 3600;
  const participated = await participatedThreads(cfg);
  const prev = new Map<string, string | null>();
  await knownAttention(prev);

  // Socket health, written with each tick: the board reads it to tell whether Slack still delivers.
  const health: SocketHealth = { lastEventAt: Date.now(), missedAt: 0, missed: 0, wokeAt: 0, syncedAt: 0 };
  const writeTick = () => writeJson(F.tick, { lastTick: Date.now() / 1000, syncedTo, beat: HEARTBEAT_MS / 1000, socket: health });

  /**
   * Catch-up through search and through the threads of open topics, since `sinceSec`.
   * At startup it covers the downtime; then it runs every 5 min and on wake from sleep, because a dead socket says
   * nothing: neither a half-open connection after sleep, nor a delivery cut by Slack (Slack can disable an app's
   * events, and the socket then stays open and silent for as long as nobody notices).
   * `countMissed`: a message caught up here, older than 2 min, is a message the socket should have brought.
   */
  let syncing: Promise<void> | null = null;
  const resync = (sinceSec: number, why: string, countMissed: boolean): Promise<void> => {
    if (syncing) return syncing;
    syncing = (async () => {
      const startedSec = Date.now() / 1000;
      let found: SlackMatch[] = [];
      // the pass moves the cursor only if it read everything: search and threads
      const pass: { ok: boolean; complete: boolean; oldestReadSec?: number } = { ok: true, complete: true };
      try {
        const { matches, complete } = await fetchSince(sinceSec, 30);
        if (!complete) out("[strato] more than 3,000 messages since the last pass: the oldest were not read, run backlog if needed");
        pass.complete = complete;
        pass.oldestReadSec = matches.length ? Number(matches[0].ts) : undefined;
        found = matches.filter((m) => !seen.has(`${m.channel.id}:${m.ts}`));
        await processMatches(matches, cfg, seen, participated, firstRun && why === "startup");
      } catch {
        pass.ok = false;
        health.syncFailedAt = Date.now();
        if (why !== "periodic") out(`[strato] search catch-up failed (${why})`);
      }
      if (!firstRun) {
        try {
          const threads = await backfillThreads(cfg, seen, participated, base, sinceSec);
          found.push(...threads.matches);
          if (threads.failed) {
            pass.ok = false;
            health.syncFailedAt = Date.now();
            if (why !== "periodic") out(`[strato] thread catch-up incomplete (${why}): ${threads.failed} unreadable thread(s), retried on the next pass`);
          }
        } catch (e) {
          pass.ok = false;
          health.syncFailedAt = Date.now();
          if (why !== "periodic") out(`[strato] thread catch-up failed (${why}): ${(e as Error).message}`);
        }
      }
      syncedTo = nextSyncCursor(syncedTo, startedSec, pass);
      saveSeen(seen);
      const late = countMissed ? found.filter((m) => Number(m.ts) < startedSec - 120) : [];
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
  await resync(syncedTo - 300, "startup", false);

  out(`[strato] Socket Mode listener armed · ${firstRun ? "first run: history marked as read" : "catch-up done"} · topics declared by hook`);

  // Topics are watched through the file system, not by a tick.
  const stopSessions = watchSessions(prev, minGap);
  // A slow tick: state on disk, dead sessions, and catch-up of what the socket may have missed, from the cursor.
  const timer = setInterval(() => {
    try {
      saveSeen(seen);
      writeTick();
      // The safety net: the one thing no hook can say is that a session died abruptly.
      pollSessions(prev, { spawn: true }).catch(() => {});
      purgeLive();
    } catch {}
    void resync(syncedTo - 300, "periodic", true);
  }, 300_000);
  timer.unref?.();

  // Wake from sleep: the clock jumps. The WebSocket from before sleep is half open (Slack closed it, the machine does
  // not know): close it to open a new one, and catch up on what arrived during sleep.
  const socket: { ws: WebSocket | null } = { ws: null };
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
    try {
      socket.ws?.close();
    } catch {}
    void resync(Math.min(syncedTo, (now - gap) / 1000) - 300, "wake", false);
  }, 10_000);
  beat.unref?.();

  const stopChannel = boardToMaster();

  // Events are handled one at a time: processMatches reads and writes `seen`.
  let file: Promise<void> = Promise.resolve();
  const onEvent = (e: Record<string, any>) => {
    health.lastEventAt = Date.now();
    file = file.then(async () => {
      try {
        const match = await matchFromEvent(e, base, cfg);
        if (!match) return;
        await processMatches([match], cfg, seen, participated);
        saveSeen(seen);
      } catch (err) {
        // never silently: the master must know a message was not triaged
        out(triageErrorLine(permalinkFor(base, String(e.channel ?? "?"), String(e.ts ?? "?"), e.thread_ts), err));
      }
    });
  };

  const outage = suiviOuverture(out);
  let backoff = 1;
  for (;;) {
    const r = await connexionSocket(xapp, onEvent, socket, {
      onOpen: () => {
        outage.ouverte();
        backoff = 1;
      },
    });
    if (r.refus) outage.refus(r.refus, r.fin === "fatal");
    if (r.fin === "fatal") break;
    // Slack's Retry-After first (capped at 15 min), else the backoff
    await Bun.sleep(Math.max(backoff, Math.min(900, r.retryAfterSec ?? 0)) * 1000);
    backoff = r.fin === "propre" ? 1 : Math.min(60, backoff * 2);
  }
  clearInterval(beat);
  clearInterval(timer);
  stopChannel();
  stopSessions();
}

/**
 * How a connection ended: "propre" (clean, Slack asked for a reconnect), "coupee" (cut), "fatal" (do not retry).
 * `refus`: Slack refused to open (or answered something other than JSON).
 */
export interface FinSocket {
  fin: "propre" | "coupee" | "fatal";
  refus?: string;
  /** Retry-After of apps.connections.open, in seconds. */
  retryAfterSec?: number;
}

/** What tests replace: fetch, the WebSocket class, the delays. */
export interface SocketDeps {
  fetch?: typeof fetch;
  WebSocket?: new (url: string) => WebSocket;
  /** Beyond this silence (no frame, ping or pong included), the socket is considered dead. */
  silenceMs?: number;
  /** Watchdog period. */
  checkMs?: number;
  /** Timeout of apps.connections.open. */
  openTimeoutMs?: number;
  /** The socket just opened. */
  onOpen?: () => void;
}

const FATAL_OPEN_ERRORS = new Set(["invalid_auth", "token_revoked", "not_authed"]);

/**
 * One WebSocket connection, from opening to closing. Resolves "propre" on a disconnect requested by Slack.
 * Never hangs: an HTML page in answer to apps.connections.open (Slack outage, captive portal) must not throw outside
 * any try inside a `new Promise(async …)`, or the promise never resolves and the listener stays deaf for good.
 * The watchdog sends a ping at half the silence and closes the socket if nothing, not even a pong, came back: a
 * half-open connection (sleep, network change) is invisible otherwise.
 */
export async function connexionSocket(xapp: string, onEvent: (e: Record<string, any>) => void, socket: { ws: WebSocket | null }, deps: SocketDeps = {}): Promise<FinSocket> {
  let url: string;
  try {
    const r = await (deps.fetch ?? fetch)("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: { Authorization: `Bearer ${xapp}`, "Content-type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(deps.openTimeoutMs ?? 15_000),
    });
    const retryAfterSec = Number(r.headers.get("retry-after")) || undefined;
    let j: { ok?: boolean; url?: string; error?: string };
    try {
      j = (await r.json()) as typeof j;
    } catch {
      return { fin: "coupee", refus: `unreadable answer from Slack (HTTP ${r.status})`, retryAfterSec };
    }
    if (!j.ok || !j.url) {
      // a revoked or invalid token is not fixed by reconnecting
      const fatal = FATAL_OPEN_ERRORS.has(j.error ?? "");
      return { fin: fatal ? "fatal" : "coupee", refus: j.error ?? `unknown error (HTTP ${r.status})`, retryAfterSec };
    }
    url = j.url;
  } catch {
    // network down or timeout: no line per attempt, the board's pill says it
    return { fin: "coupee" };
  }

  const silenceMs = deps.silenceMs ?? 120_000;
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new (deps.WebSocket ?? WebSocket)(url);
    } catch {
      return resolve({ fin: "coupee" });
    }
    socket.ws = ws;
    let reconnectRequested = false;
    let lastFrame = Date.now();
    let ended = false;
    const frame = () => {
      lastFrame = Date.now();
    };
    const end = (fin: FinSocket["fin"]) => {
      if (ended) return;
      ended = true;
      clearInterval(watchdog);
      if (socket.ws === ws) socket.ws = null;
      resolve({ fin });
    };
    const watchdog = setInterval(() => {
      const silence = Date.now() - lastFrame;
      if (silence >= silenceMs) {
        // a half-open socket does not always fire its onclose: do not wait for it
        try {
          ws.terminate();
        } catch {}
        end("coupee");
      } else if (silence >= silenceMs / 2) {
        try {
          ws.ping();
        } catch {}
      }
    }, deps.checkMs ?? 30_000);
    watchdog.unref?.();

    ws.addEventListener("ping", frame);
    ws.addEventListener("pong", frame);
    ws.onopen = () => {
      frame();
      deps.onOpen?.();
    };
    ws.onmessage = (ev: MessageEvent) => {
      frame();
      let m: Record<string, any>;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.type === "disconnect") {
        reconnectRequested = true;
        return;
      }
      // Acknowledge at once: without an ack within 3 s, Slack redelivers three times.
      if (m.envelope_id) ws.send(JSON.stringify({ envelope_id: m.envelope_id }));
      if (m.type !== "events_api") return;
      const e = m.payload?.event;
      if (e) onEvent(e);
    };
    ws.onclose = () => end(reconnectRequested ? "propre" : "coupee");
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  });
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

export async function watch(intervalArg?: string) {
  ensureState();
  const cfg = settings().slack;
  await initSlack(cfg);
  const interval = Number(intervalArg ?? cfg.pollInterval);
  const seen = new Set(readJson<string[]>(F.seen, []));
  const saved = readJson<{ lastTick?: number; syncedTo?: number }>(F.tick, {});
  const firstRun = saved.lastTick === undefined;
  // the catch-up cursor (`nextSyncCursor`), separate from the `lastTick` heartbeat the board reads
  let syncedTo = saved.syncedTo ?? saved.lastTick ?? Date.now() / 1000 - 3600;
  const prev = new Map<string, string | null>();
  const participated = await participatedThreads(cfg);
  await knownAttention(prev);
  boardToMaster();

  out(`[strato] polling armed · every ${interval} s · ${firstRun ? "first run: history marked as read" : "messages that arrived while stopped will come out"}`);
  let backoff = 0;
  for (let tick = 0; ; tick++) {
    if (tick > 0) await Bun.sleep((interval + backoff) * 1000);
    try {
      const tickStart = Date.now() / 1000;
      // 5 min margin for the Slack index lag, dedup absorbs the overlap
      const { matches, complete } = await fetchSince(syncedTo - 300, 30);
      if (!complete) out("[strato] more than 3,000 messages since the last pass: the oldest were not read, run backlog if needed");
      await processMatches(matches, cfg, seen, participated, tick === 0 && firstRun);
      saveSeen(seen);
      // incomplete pass: not beyond the oldest message read (results are sorted oldest first)
      syncedTo = nextSyncCursor(syncedTo, tickStart, { ok: true, complete, oldestReadSec: matches.length ? Number(matches[0].ts) : undefined });
      writeJson(F.tick, { lastTick: tickStart, syncedTo });

      await pollSessions(prev);
      backoff = 0;
    } catch (e) {
      if (e instanceof SlackError && e.fatal) {
        out(`[strato] FATAL: ${e.code}, polling stopped`);
        process.exit(75);
      }
      backoff = Math.min(300, backoff === 0 ? interval : backoff * 2);
    }
  }
}

export async function backlog(opts: Record<string, string>) {
  ensureState();
  const cfg = settings().slack;
  await initSlack(cfg);
  const since = opts.since ?? "12h";
  const ms = durationOrFail(since);
  const sujets = loadSujets();
  const tracked = trackedKeys(sujets);
  let n = 0;
  let silent = 0;
  const participated = await participatedThreads(cfg);
  const { matches, complete } = await fetchSince((Date.now() - ms) / 1000, 60);
  if (!complete) out("[strato] more than 6,000 messages over the period: only the most recent are read");
  for (const m of matches) {
    if (m.user === cfg.me) participated.add(threadKey(m));
    const t = await triage(m, cfg, tracked, participated);
    if (!t) continue;
    if (isSilent(t.kind)) {
      silent++;
      continue;
    }
    out(eventLine(t.kind, t.d, sujets, keepMessage(t.d)));
    n++;
  }
  out(`[strato] ${n} relevant message(s) over ${since} · ${silent} set aside (third parties, bots)`);
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
