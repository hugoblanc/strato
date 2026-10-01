/**
 * The local server of the iTerm2 panel and the board, on 127.0.0.1: rendering, SSE, and the board's actions
 * (write to a session, post a draft, terminal, stop, close, review).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, watch as fsWatch } from "node:fs";
import { join } from "node:path";
import { agentsBySessionAsync, CLAUDE_DIR, declaredAttention, findTranscript, type PanelSession, pathWithClaude, pidAlive, sessionAgents, transcriptContext } from "../app/claude.ts";
import { CLAUDE_BIN, dayTime, F, fail, flags, mtimeOf, nowIso, out, readJson, run, STATE, WORKSPACE, writeJson } from "../app/env.ts";
import { selfArgv, selfCommand } from "../app/self.ts";
import { deliverToSujet } from "../app/deliver.ts";
import { deliveryTracker } from "../app/gitlab.ts";
import { pickCards, refreshCards } from "../commands/refresh.ts";
import { SHADOW_REFUSAL, shadowNow } from "../commands/setup.ts";
import { actDone, type ActOutcome, actOnTask, undoTask } from "../app/act.ts";
import { connectSlack, hasSlackToken, NO_TOKEN, threadDump } from "../app/slack.ts";
import { ensureState, loadSujets, logEvent, reportOf, saveUpload, updateSujet, withLock } from "../app/store.ts";
import { type BoardEvent, boardPage, type BoardSession, boardView, buildBoard, draftConflict, type LiveState, type VersionState, versionControl } from "../board.ts";
import { applyUpdate, checkUpdates, localVersion } from "../app/update.ts";
import { type SocketHealth } from "../chat/slack-model.ts";
import { type AgentRow, claudeRefs, parsePs } from "../claude/model.ts";
import { type ActivityStep, type AgentNode, agentTree } from "../claude/transcript.ts";
import { type ThreadDump } from "../core/cards.ts";
import { planOfTask, planSha } from "../core/gate.ts";
import { permalinkOfKey } from "../core/keys.ts";
import { hostOwner, pureOf } from "../core/links.ts";
import { deepLinkOf } from "../core/targets.ts";
import { accountContext, accountOf } from "../providers/registry.ts";
import type { Identity } from "../providers/sdk.ts";
import { type MasterRequest, pendingRevue, REVUE_WINDOWS } from "../core/master.ts";
import { settings } from "../core/settings.ts";
import { applyAssignments, checkable, findSujet, searchSujets, type Snooze, type Sujet, sujetKeys } from "../core/sujet.ts";
import { t } from "../core/i18n.ts";
import { closeTask, findTask, openTasks, sendsUnseenMessage, type Task, taskDraftText, tasksOf } from "../core/tasks.ts";
import { panelPage, sessionView, sujetListView, sujetView } from "../panel.ts";
import { cleanSessionName, itermTtyScript, sujetForFocus, ttyName } from "../terminal/iterm.ts";
import { hostAllowed, ORIGINLESS_ROUTES, originAllowed, terminalBasePath } from "./guard.ts";

/** Hosts the panel may open in the browser, over https only. */
/** The board opens only the links of a configured account's hosts (core/links.ts): Slack, and the tracker when there is one. */
const openable = (hostname: string) => hostOwner(hostname) !== null;
const THREAD_TTL_MS = 60_000;

/** The view of a session whose transcript moves is redrawn at most every 10 s. */
const TRANSCRIPT_REDRAW_MS = 10_000;
/** The board is redrawn at most every 3 s when events or sessions move, without ever losing a change. */
const BOARD_REDRAW_MS = 3_000;
/** The upstream is fetched at startup, then every 30 min: the board offers the update when it has new commits. */
const UPDATE_CHECK_MS = 30 * 60_000;

/**
 * Local server of the Strato panel, shown in iTerm2's sidebar by the AutoLaunch script, and of the board.
 * It only listens on 127.0.0.1. The focus lives in memory: it is given by POST /api/focus on each change of active
 * session. A session without a topic is followed to its Claude Code conversation, read-only (AppleScript, ps, ~/.claude).
 */
export async function serve(args: string[]) {
  ensureState();
  const { opts } = flags(args);
  const port = Number(opts.port ?? settings().ui.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) fail(t("cli.serve.invalidPort", { port: String(opts.port) }));
  const cfg = settings().slack;
  const boot = Date.now().toString(36);
  let focusVersion = 0;
  let focus: {
    key: string | null;
    sessionName: string;
    /** iTerm2 unique ID of the active pane. */
    sessionId: string | null;
    /** The pane's Claude Code conversation, when it has no topic. */
    panel: PanelSession | null;
    /** Why no conversation was found. */
    reason: string | null;
    /** What redraws the page when it changes: topic, conversation, or pane without Claude. */
    identity: string;
  } = { key: null, sessionName: "", sessionId: null, panel: null, reason: null, identity: "" };
  let focusSeq = 0;
  const version = () => `${boot}.${focusVersion}`;

  /** One Slack thread per key, kept 60 s, shared by the topics and sessions that quote it. null for a ticket. */
  const threadCache = new Map<string, { at: number; dump: ThreadDump | null }>();
  async function threadsFor(keys: string[], refresh: boolean): Promise<{ at: number; dumps: ThreadDump[]; error?: string }> {
    const slackKeys = keys.filter((k) => !k.startsWith("linear:"));
    const stale = slackKeys.filter((k) => {
      const hit = threadCache.get(k);
      return refresh || !hit || Date.now() - hit.at >= THREAD_TTL_MS;
    });
    if (stale.length && !hasSlackToken()) await connectSlack(cfg);
    if (stale.length && !hasSlackToken()) return { at: Date.now(), dumps: [], error: NO_TOKEN(cfg) };
    await Promise.all(
      stale.map(async (key) => {
        let dump: ThreadDump | null;
        try {
          dump = await threadDump(key);
        } catch (e) {
          dump = { key, permalink: permalinkOfKey(key) ?? key, messages: [{ at: "--", from: "strato", text: t("panel.thread.unreadable", { error: (e as Error).message }) }] };
        }
        threadCache.set(key, { at: Date.now(), dump });
      }),
    );
    const entries = slackKeys.map((k) => threadCache.get(k)).filter((x): x is { at: number; dump: ThreadDump | null } => x !== undefined);
    return {
      at: Math.min(Date.now(), ...entries.map((x) => x.at)),
      dumps: entries.map((x) => x.dump).filter((d): d is ThreadDump => d !== null),
    };
  }

  /** iTerm2 unique ID -> tty. A pane's tty never changes in its life; a failure is retried after 30 s. */
  const ttys = new Map<string, { tty: string | null; at: number }>();
  async function ttyOfPanel(itermId: string): Promise<string | null> {
    const hit = ttys.get(itermId);
    if (hit && (hit.tty || Date.now() - hit.at < 30_000)) return hit.tty;
    const r = await run(["osascript", "-e", itermTtyScript(itermId)]);
    const tty = r.code === 0 ? ttyName(r.out) : null;
    ttys.set(itermId, { tty, at: Date.now() });
    return tty;
  }

  let agentsCache: { at: number; rows: AgentRow[] } | null = null;
  async function agentByShortId(shortId: string): Promise<AgentRow | undefined> {
    if (!agentsCache || Date.now() - agentsCache.at > 15_000) {
      const r = await run([CLAUDE_BIN, "agents", "--json"], 15_000);
      let rows: AgentRow[] = [];
      try {
        if (r.code === 0) rows = JSON.parse(r.out) as AgentRow[];
      } catch {}
      agentsCache = { at: Date.now(), rows };
    }
    return agentsCache.rows.find((x) => x.id === shortId);
  }

  /**
   * Current branch of a folder, by `git branch --show-current` (read-only), kept 30 s; null outside a repository or on
   * a detached HEAD. Needed because Claude Code may write `gitBranch: "HEAD"` in every transcript entry.
   */
  const branches = new Map<string, { at: number; branch: string | null }>();
  async function branchOf(cwd: string): Promise<string | null> {
    const hit = branches.get(cwd);
    if (hit && Date.now() - hit.at < 30_000) return hit.branch;
    const r = await run(["git", "-C", cwd, "branch", "--show-current"]);
    const branch = r.code === 0 && r.out.trim() ? r.out.trim() : null;
    branches.set(cwd, { at: Date.now(), branch });
    return branch;
  }

  const transcriptPaths = new Map<string, string>();
  function transcriptOf(sessionId: string): string | null {
    const hit = transcriptPaths.get(sessionId);
    if (hit && mtimeOf(hit) > 0) return hit;
    const found = findTranscript(sessionId);
    if (found) transcriptPaths.set(sessionId, found);
    return found;
  }

  /**
   * iTerm2 pane -> Claude Code conversation, read-only: the pane's tty by AppleScript, the processes of that tty by ps,
   * then for each Claude process, ~/.claude/sessions/<pid>.json, `claude agents --json` for `claude attach <id>`,
   * or the sessionId of `--resume`. Returns the conversation, or why it was not found.
   */
  async function resolvePanel(itermId: string): Promise<{ session: PanelSession } | { reason: string }> {
    const tty = await ttyOfPanel(itermId);
    if (!tty) return { reason: t("panel.focus.paneMissing") };
    const ps = await run(["ps", "-o", "pid=,stat=,command=", "-t", tty]);
    const refs = claudeRefs(parsePs(ps.out));
    if (!refs.length) return { reason: t("panel.focus.noClaude", { tty }) };
    let orphan: string | null = null;
    for (const ref of refs) {
      let found: Omit<PanelSession, "transcript"> | null = null;
      if ("pid" in ref) {
        const f = readJson<{ pid?: number; sessionId?: string; cwd?: string; name?: string }>(join(CLAUDE_DIR, "sessions", `${ref.pid}.json`), {});
        if (f.pid === ref.pid && f.sessionId) found = { sessionId: f.sessionId, cwd: f.cwd ?? null, name: f.name ?? null };
      } else if ("shortId" in ref) {
        const row = await agentByShortId(ref.shortId);
        if (row?.sessionId) found = { sessionId: row.sessionId, cwd: row.cwd ?? null, name: row.name ?? null };
      } else found = { sessionId: ref.sessionId, cwd: null, name: null };
      if (!found) continue;
      const transcript = transcriptOf(found.sessionId);
      if (transcript) return { session: { ...found, transcript } };
      orphan = found.sessionId;
    }
    return { reason: orphan ? t("panel.focus.noTranscript", { id: orphan }) : t("panel.focus.conversationMissing", { tty }) };
  }

  /** events.ndjson, reread only when it changed: one line per routed message or session transition. */
  let eventsCache: { mtime: number; events: BoardEvent[] } = { mtime: -1, events: [] };
  function boardEvents(): BoardEvent[] {
    const m = mtimeOf(F.events);
    if (m === eventsCache.mtime) return eventsCache.events;
    const events: BoardEvent[] = [];
    const raw = existsSync(F.events) ? readFileSync(F.events, "utf8") : "";
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as BoardEvent);
      } catch {}
    }
    eventsCache = { mtime: m, events };
    return events;
  }
  /** What each session of an open topic declared through its hooks. */
  function liveStates(sujets: Sujet[]): Map<string, LiveState> {
    const out = new Map<string, LiveState>();
    for (const s of sujets) {
      if (!s.sessionId || s.status === "closed") continue;
      const d = declaredAttention(s.sessionId) as LiveState | null;
      if (d) out.set(s.sessionId, d);
    }
    return out;
  }
  /**
   * The live Claude Code sessions started in the workspace without Strato: ~/.claude/sessions/<pid>.json gives the
   * sessionId, the cwd and the status; the transcript gives what they quote. Those quoting neither a Slack thread nor
   * a ticket are only counted. Topic sessions are already on the board through their topic.
   */
  async function boardSessions(sujets: Sujet[]): Promise<{ sessions: BoardSession[]; others: number; running: Map<string, string>; remote: Map<string, string>; since: Map<string, string>; lastAgent: Map<string, { text: string; at: string | null }>; trail: Map<string, ActivityStep[]>; agents: Map<string, AgentNode[]> }> {
    const known = new Set(sujets.map((s) => s.sessionId).filter((x): x is string => !!x));
    const sessions: BoardSession[] = [];
    /** Claude Code status (busy, idle, waiting) of live topic sessions, by sessionId: what tells a session is working. */
    const running = new Map<string, string>();
    /** Remote Control id of live sessions: the conversation at claude.ai/code/<id>. */
    const remote = new Map<string, string>();
    /** Since when the session has been in this status, ISO, by sessionId: the evidence shown next to the state. */
    const since = new Map<string, string>();
    /** Last message of each live topic session, read from its transcript (incremental read, cached). */
    const lastAgent = new Map<string, { text: string; at: string | null }>();
    const trail = new Map<string, ActivityStep[]>();
    const agents = new Map<string, AgentNode[]>();
    let others = 0;
    let files: string[] = [];
    try {
      files = readdirSync(join(CLAUDE_DIR, "sessions")).filter((f) => f.endsWith(".json"));
    } catch {}
    for (const f of files) {
      const r = readJson<{ pid?: number; sessionId?: string; cwd?: string; name?: string; status?: string; kind?: string; startedAt?: number; bridgeSessionId?: string; statusUpdatedAt?: number }>(join(CLAUDE_DIR, "sessions", f), {});
      if (!r.sessionId || !r.cwd || !r.pid || !pidAlive(r.pid)) continue;
      if (r.bridgeSessionId) remote.set(r.sessionId, r.bridgeSessionId);
      if (known.has(r.sessionId)) {
        if (r.status) running.set(r.sessionId, r.status);
        if (r.statusUpdatedAt) since.set(r.sessionId, new Date(r.statusUpdatedAt).toISOString());
        const tr = transcriptOf(r.sessionId);
        const ctxt = tr ? transcriptContext(tr) : null;
        if (ctxt?.lastAgent) lastAgent.set(r.sessionId, ctxt.lastAgent);
        if (ctxt?.trail.length) trail.set(r.sessionId, ctxt.trail);
        const tree = tr ? agentTree(sessionAgents(tr, ctxt?.turnAt ?? null, true)) : [];
        if (tree.length) agents.set(r.sessionId, tree);
        continue;
      }
      if (!r.cwd.startsWith(WORKSPACE)) continue;
      const transcript = transcriptOf(r.sessionId);
      const context = transcript ? transcriptContext(transcript) : null;
      if (!context?.master && !context?.slackThreads.length && !context?.linearIssues.length) {
        others++;
        continue;
      }
      sessions.push({
        sessionId: r.sessionId,
        name: r.name ?? r.sessionId.slice(0, 8),
        status: r.status ?? "?",
        kind: r.kind ?? "?",
        cwd: r.cwd,
        branch: await branchOf(r.cwd),
        startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null,
        context,
        remote: r.bridgeSessionId ?? null,
      });
    }
    return { sessions, others, running, remote, since, lastAgent, trail, agents };
  }
  /**
   * The board's terminals: one ttyd per open topic, on the loopback interface, running `strato.ts term <topic>`.
   * The topic is fixed at launch: nothing comes from the URL, so nothing to validate client-side.
   * ttyd dies when the drawer tab is closed, when claude exits, or with this server.
   */
  interface BoardTerminal {
    key: string;
    letter: string;
    title: string;
    port: number;
    url: string;
    proc: ReturnType<typeof Bun.spawn>;
  }
  const terminals = new Map<string, BoardTerminal>();
  const TTYD = Bun.which("ttyd") ?? ["/opt/homebrew/bin/ttyd", "/usr/local/bin/ttyd"].find((p) => existsSync(p)) ?? null;
  const TERM_PORTS: [number, number] = [7700, 7799];
  function freePort(): number {
    const used = new Set([...terminals.values()].map((t) => t.port));
    for (let p = TERM_PORTS[0]; p <= TERM_PORTS[1]; p++) {
      if (used.has(p)) continue;
      try {
        const probe = Bun.listen({ hostname: "127.0.0.1", port: p, socket: { data() {} } });
        probe.stop(true);
        return p;
      } catch {}
    }
    throw new Error(t("board.api.terminal.noPort", { from: TERM_PORTS[0], to: TERM_PORTS[1] }));
  }
  async function openTerminal(s: Sujet): Promise<BoardTerminal> {
    const existing = terminals.get(s.key);
    if (existing) return existing;
    if (!TTYD) throw new Error(t("board.api.terminal.noTtyd"));
    const port = freePort();
    const base = terminalBasePath();
    const theme = JSON.stringify({ background: "#121417", foreground: "#e8eaed", cursor: "#f2b84b", selectionBackground: "#3a2c10" });
    const proc = Bun.spawn(
      [
        TTYD,
        "-i", "127.0.0.1",
        "-p", String(port),
        "-b", base,
        "-O",
        "-W",
        "-q",
        "-t", "fontSize=13",
        "-t", "fontFamily=Menlo, monospace",
        "-t", `theme=${theme}`,
        "-t", "disableLeaveAlert=true",
        "-t", `titleFixed=${s.letter} · ${s.title}`,
        ...selfArgv(), "term", s.key,
      ],
      { cwd: WORKSPACE, stdin: "ignore", stdout: "ignore", stderr: "pipe", env: { ...process.env, PATH: pathWithClaude(), TERM: "xterm-256color", LANG: process.env.LANG ?? "en_US.UTF-8" } },
    );
    const term: BoardTerminal = { key: s.key, letter: s.letter, title: s.title, port, url: `http://127.0.0.1:${port}${base}/`, proc };
    terminals.set(s.key, term);
    proc.exited.then(() => {
      if (terminals.get(s.key) === term) terminals.delete(s.key);
      broadcast("terminals", { open: [...terminals.keys()] });
    });
    // ttyd listens within a few tens of milliseconds; wait until it answers before giving the URL to the iframe
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      try {
        const r = await fetch(term.url, { signal: AbortSignal.timeout(250) });
        ready = r.ok;
      } catch {}
      if (ready) break;
      if (proc.exitCode !== null) {
        const err = await new Response(proc.stderr as ReadableStream).text();
        terminals.delete(s.key);
        throw new Error(t("board.api.terminal.exited", { error: err.trim().split("\n").pop() || t("board.api.terminal.noMessage") }));
      }
      await Bun.sleep(50);
    }
    if (!ready) {
      closeTerminal(s.key);
      throw new Error(t("board.api.terminal.noAnswer"));
    }
    broadcast("terminals", { open: [...terminals.keys()] });
    return term;
  }
  function closeTerminal(key: string): void {
    const t = terminals.get(key);
    if (!t) return;
    terminals.delete(key);
    try {
      t.proc.kill();
    } catch {}
  }
  const closeAllTerminals = () => {
    for (const k of [...terminals.keys()]) closeTerminal(k);
  };
  process.on("exit", closeAllTerminals);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      closeAllTerminals();
      process.exit(0);
    });
  }

  // the state of the open topics' MRs, read from the forge in the background: rendering never waits for it
  const deliveries = deliveryTracker(() => boardChanged());
  /** The last tick of `listen` (tick.json, every 5 min): the sign that the Slack listener is alive. */
  function lastTickIso(): string | null {
    const t = readJson<{ lastTick?: number }>(F.tick, {}).lastTick;
    return t ? new Date(t * 1000).toISOString() : null;
  }
  async function renderBoard(sujets: Sujet[]): Promise<string> {
    const { sessions, others, running, remote, since, lastAgent, trail, agents } = await boardSessions(sujets);
    const model = buildBoard({ sujets, events: boardEvents(), live: liveStates(sujets), running, remote, since, lastAgent, trail, agents, teammates: cfg.teammates, sessions, otherSessions: others, now: new Date(), timeOf: dayTime, lastTick: lastTickIso(), socket: readJson<{ socket?: Partial<SocketHealth> }>(F.tick, {}).socket, slackAppId: cfg.appId, snoozed: new Map(Object.entries(readJson<Record<string, Snooze>>(F.snooze, {}))), revue: readJson<MasterRequest[]>(F.master, []).filter((r) => r.kind === "revue").at(-1) ?? null, demandes: readJson<MasterRequest[]>(F.master, []).filter((r) => r.kind === "demande"), users: readJson<Record<string, string>>(F.users, {}), deliveries: deliveries.of(sujets), heartbeat: readJson<{ beat?: number }>(F.tick, {}).beat, undo: undoByTopic(sujets) });
    return boardView(model, { timeOf: dayTime, readAt: dayTime(new Date().toISOString()) });
  }
  /** Board messages being delivered, "key\0text": a duplicate during delivery is refused. */
  const inFlight = new Set<string>();
  /** A message from the person served, from the board, to a topic's session (app/deliver.ts). */
  async function sendFromBoard(key: string, text: string): Promise<{ ok: true; note: string } | { ok: false; error: string; status: number }> {
    // a pasted image arrives as "[image : <path>]" (marker written by the board's script): the session reads it with the Read tool
    const images = text.includes("[image : ") ? `\n\nThe [image : …] entries are screenshots pasted by ${settings().owner.name}: read each file with the Read tool before answering.` : "";
    return deliverToSujet(key, `[${settings().owner.name}, from the board] ${text}${images}`, "board");
  }

  /**
   * "Send" on a task's draft: the gate (app/act.ts) posts the text through the provider, on behalf of the person served,
   * without going through the session. The click is the Go on the exact content shown: the page sends back the hash
   * of the plan it showed (`data-sha`), or, from a page older than the hash, the draft and the destination it showed,
   * which give the same hash when nothing changed. The task becomes done at once (note: the permalink); the rest of the
   * topic does not move, unless no open task is left: the topic then waits for the rest of the thread. The session is
   * told only once the undo window has passed, so that an "Undo" does not send it off on a message that no longer exists.
   */
  const UNDO_MS = 30_000;
  /** For the board: per topic, the latest write still undoable and its task, read from the tasks' sent records on disk. */
  function undoByTopic(sujets: Sujet[]): Map<string, { until: number; taskId: string | null }> {
    const out = new Map<string, { until: number; taskId: string | null }>();
    const now = Date.now();
    for (const s of sujets)
      for (const x of tasksOf(s)) {
        const until = x.sent?.undo?.until;
        if (until && until > now && (out.get(s.key)?.until ?? 0) < until) out.set(s.key, { until, taskId: x.id });
      }
    return out;
  }
  /** The note to the session, one part per posted task: a second post within the window adds its part, an Undo removes it. */
  type Notify = NonNullable<Sujet["notify"]>;
  const notifyText = (byTask: Record<string, string>) => Object.values(byTask).join("\n\n");
  function withNotice(n: Notify | undefined, taskId: string, at: string, text: string): Notify {
    const byTask = { ...(n?.byTask ?? (n ? { _: n.text } : {})), [taskId]: text };
    return { at, text: notifyText(byTask), byTask };
  }
  /**
   * Delivers the topic's pending note (`notify`) to the session, once the last undo window has passed. It is removed
   * from the topic under the lock before sending: delivered at most once, even if two timers fire together.
   */
  async function deliverNotice(key: string): Promise<void> {
    let text: string | null = null;
    let early: string | null = null;
    await updateSujet(key, (x) => {
      if (!x.notify) return null;
      // a later post of the same topic is still undoable: its own timer delivers both parts
      if (Date.parse(x.notify.at) > Date.now() + 500) {
        early = x.notify.at;
        return null;
      }
      text = x.notify.text;
      const { notify: _, ...rest } = x;
      return rest;
    });
    if (early) return;
    if (text === null) return;
    const r = await sendFromBoard(key, text).catch((e: Error) => ({ ok: false as const, error: e.message }));
    if (!r.ok) logEvent({ type: "board-post-notify-failed", key, error: r.error });
  }
  const scheduleNotice = (key: string, at: string) => setTimeout(() => void deliverNotice(key).catch(() => {}), Math.max(0, Date.parse(at) - Date.now()));
  // the note of a post made just before a restart of serve is not lost: it is in the topic, and so is the undo window
  try {
    for (const x of loadSujets()) if (x.notify) scheduleNotice(x.key, x.notify.at);
  } catch (e) {
    out(`[strato] pending notes not reloaded: ${(e as Error).message}`);
  }
  /**
   * Who the person is on each account, read once through the provider's `connect`: a deep link needs it (Slack's
   * slack:// links need the team id). Null when the tool does not answer: the link then opens over https.
   */
  const identities = new Map<string, Identity>();
  async function identityOf(owner: { provider: string; account: string }): Promise<Identity | null> {
    const id = `${owner.provider}@${owner.account}`;
    const hit = identities.get(id);
    if (hit) return hit;
    const entry = accountOf(owner.provider, owner.account);
    if (!entry?.provider) return null;
    try {
      const identity = await entry.provider.connect(accountContext(entry));
      identities.set(id, identity);
      return identity;
    } catch {
      return null;
    }
  }
  /** The app link of an https link, through the provider that owns its host; Slack's only when `ui.slackApp` asks for it. */
  async function appLinkOf(url: URL): Promise<string | null> {
    const owner = hostOwner(url.hostname);
    if (!owner || !pureOf(owner.provider)?.deepLink) return null;
    if (owner.provider === "slack" && !settings().ui.slackApp) return null;
    const identity = await identityOf(owner);
    return identity ? deepLinkOf(url.href, owner, identity) : null;
  }
  /** A refusal of the gate, or a provider's failure, as the board's answer. */
  function actFailure(r: Exclude<ActOutcome, { ok: true }>): { ok: false; error: string; status: number; code?: string } {
    if ("refused" in r) {
      const code = r.refused.code;
      const status = code === "missing" ? 404 : code === "tooLong" ? 413 : 409;
      return { ok: false, error: r.refused.message, status, ...(code === "shadow" ? { code: "shadow" } : code === "sha" ? { code: "draft-changed" } : code === "unknown" ? { code: "unknown" } : {}) };
    }
    if (r.failed.outcome === "unknown") return { ok: false, error: t("gate.unknownOutcome", { tool: r.tool, link: r.link ?? "-" }), status: 502, code: "unknown" };
    if (r.failed.fatal) return { ok: false, error: r.failed.message, status: 503 };
    return { ok: false, error: t("gate.refused", { tool: r.tool, error: r.failed.message }), status: 502 };
  }
  async function postDraft(s: Sujet, taskId: string, edited: string | null, sha: string, retry: boolean): Promise<{ ok: true; at: string; permalink: string; undoMs: number } | { ok: false; error: string; status: number; code?: string }> {
    const at = nowIso();
    let notifyAt = at;
    const r = await actOnTask({
      key: s.key,
      taskId,
      sha,
      by: "board",
      edited,
      retry,
      after: (x, sent) => {
        const permalink = sent.link;
        const text = sent.plan.actions[0] && "text" in sent.plan.actions[0] ? sent.plan.actions[0].text : "";
        const note = `I posted the draft of task ${taskId} myself from the board${edited !== null ? ", with my edits" : ""}: ${permalink}\nPosted text:\n${text}\nDo not post it again. Task ${taskId} is marked done: update the rest of the card and continue the plan.`;
        // the note goes after the undo window; written in the topic, it survives a restart of serve
        notifyAt = new Date(sent.undo?.until ?? Date.now() + UNDO_MS).toISOString();
        const posted = `${at} ${permalink}`;
        const next = applyAssignments(x, openTasks(x).length ? { posted } : { status: "waiting", waiting: t("task.waiting.restOfThread"), posted }, at);
        return { ...next, notify: withNotice(x.notify, taskId, notifyAt, note) };
      },
    });
    if (!r.ok) return actFailure(r);
    logEvent({ type: "board-post", key: s.key, task: taskId, permalink: r.sent.link, edited: edited !== null });
    scheduleNotice(s.key, notifyAt);
    return { ok: true, at: dayTime(at).slice(6), permalink: r.sent.link, undoMs: r.sent.undo ? Math.max(0, r.sent.undo.until - Date.now()) : 0 };
  }
  /** "Undo" within the window: the message is removed from the thread, the task reopens, and the topic comes back as before. */
  async function unpost(s: Sujet, taskId: string): Promise<{ ok: true } | { ok: false; error: string; status: number; code?: string }> {
    const at = nowIso();
    const r = await undoTask({
      key: s.key,
      taskId,
      by: "board",
      after: (x) => {
        // only the fields the post changed come back (app/act.ts), on the current state: a write of the session meanwhile stays
        const { notify, ...rest } = x;
        const byTask = { ...(notify?.byTask ?? {}) };
        delete byTask[taskId];
        const left = Object.keys(byTask).length ? { notify: { at: notify?.at ?? at, text: notifyText(byTask), byTask } } : {};
        return { ...rest, ...left, updatedAt: at, history: [...rest.history, { at, what: t("task.note.unposted", { id: taskId }) }] };
      },
    });
    if (!r.ok) {
      if ("refused" in r && r.refused.code === "nothingToUndo") return { ok: false, error: r.refused.message, status: 409 };
      // the message stays in the thread: the session must still learn about it
      if ("failed" in r) {
        void deliverNotice(s.key).catch(() => {});
        return { ok: false, error: t("gate.refusedUndo", { tool: r.tool, error: r.failed.message }), status: 502 };
      }
      return actFailure(r);
    }
    logEvent({ type: "board-unpost", key: s.key, task: taskId });
    return { ok: true };
  }
  /** The message a go on a task carries to the session: the task, its exact action, and how to close it. */
  function taskGoMessage(s: Sujet, x: Task, text: string): string {
    const what = x.action?.trim() || (taskDraftText(x) ? `post the draft of task ${x.id} in ${x.draftTo || "its destination"}` : x.ask);
    return `${text} on task ${x.id}: ${what.replace(/\\n/g, " ")}\nCarry it out, then mark it done: ${selfCommand()} task ${s.key} done ${x.id}`;
  }
  /**
   * Done or Drop on a task, from the board: the task closes under the lock, then the session is told, so it does not
   * carry it out nor propose it again as is. Drop never sends anything to Slack.
   */
  async function taskOp(s: Sujet, taskId: string, op: "done" | "drop"): Promise<{ ok: true; note: string } | { ok: false; error: string; status: number }> {
    const x = findTask(s, taskId);
    if (!x) return { ok: false, error: t("board.api.taskMissing", { id: taskId }), status: 404 };
    if (x.status !== "open") return { ok: false, error: t("board.api.taskClosed", { id: taskId }), status: 409 };
    let closed = false;
    await updateSujet(s.key, (y) => {
      if (findTask(y, taskId)?.status !== "open") return null;
      closed = true;
      return closeTask(y, taskId, op === "done" ? "done" : "dropped", nowIso(), t(op === "done" ? "task.note.doneOnBoard" : "task.note.droppedOnBoard"));
    });
    if (!closed) return { ok: false, error: t("board.api.taskClosed", { id: taskId }), status: 409 };
    logEvent({ type: op === "done" ? "board-task-done" : "board-task-drop", key: s.key, task: taskId });
    boardChanged();
    const draft = taskDraftText(x);
    const quote = (v: string) => `« ${v.length > 300 ? `${v.slice(0, 299)}…` : v} »`;
    const note =
      op === "done"
        ? `I marked task ${taskId} done from the board: ${quote(x.ask)}. Do not carry it out again. Update the card (steps, other tasks) and continue the plan; if nothing is left to do, close the topic.`
        : `I dropped task ${taskId} from the board, it does not go out: ${quote(x.ask)}${draft ? `, draft ${quote(draft)}` : x.action ? `, action ${quote(x.action)}` : ""}. Do not propose it again as is. Update the card (steps, other tasks) and continue the plan; if nothing is left to do, close the topic.`;
    const r = await sendFromBoard(s.key, note).catch((e: Error) => ({ ok: false as const, error: e.message, status: 500 }));
    return { ok: true, note: r.ok ? t(op === "done" ? "board.api.taskDone" : "board.api.taskDropped", { id: taskId }) : t("board.api.taskNotified", { id: taskId, error: r.error }) };
  }

  async function render(url: URL): Promise<string> {
    const sujets = loadSujets();
    const asked = url.searchParams.get("sujet");
    const refresh = url.searchParams.get("refresh") === "1";
    if (url.searchParams.has("liste")) return sujetListView(sujets, { timeOf: dayTime });
    const ref = asked ?? focus.key;
    const s = ref ? findSujet(sujets, ref) : undefined;
    if (s) {
      const t = await threadsFor(sujetKeys(s), refresh);
      return sujetView(s, t.dumps, reportOf(s), { timeOf: dayTime, slackError: t.error, threadsReadAt: dayTime(new Date(t.at).toISOString()) });
    }
    const session = cleanSessionName(focus.sessionName);
    if (!asked && focus.panel) {
      const context = transcriptContext(focus.panel.transcript);
      if (context) {
        const readableKeys = context.slackThreads.filter((c) => c.workspace === cfg.workspace).map((c) => c.key);
        const threads = await threadsFor(readableKeys, refresh);
        const name = session || context.title || focus.panel.name || t("panel.session.unnamed");
        const cwd = context.cwd ?? focus.panel.cwd;
        const branch = (cwd ? await branchOf(cwd) : null) ?? context.branch;
        return sessionView(
          { name, context: { ...context, cwd, branch }, threads: threads.dumps, sujets },
          { timeOf: dayTime, slackError: threads.error, threadsReadAt: dayTime(new Date(threads.at).toISOString()) },
        );
      }
    }
    const why = focus.reason ?? t("panel.focus.transcriptUnreadable");
    const note = asked ? t("panel.note.topicMissing", { ref: asked }) : session ? t("panel.note.noConversation", { session, reason: why }) : t("panel.note.noFocus");
    return sujetListView(sujets, { timeOf: dayTime, note });
  }

  const encoder = new TextEncoder();
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const send = (c: ReadableStreamDefaultController<Uint8Array>, chunk: string) => {
    try {
      c.enqueue(encoder.encode(chunk));
    } catch {
      clients.delete(c);
    }
  };
  const broadcast = (event: string, data: unknown) => {
    for (const c of clients) send(c, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // a beat every 15 s keeps the SSE connection open, and it is a real event (not a comment, invisible to the page):
  // without it for 40 s, the page knows its connection is dead (machine asleep) and reopens it
  setInterval(() => {
    for (const c of clients) send(c, "event: ping\ndata: {}\n\n");
  }, 15_000);
  // work sessions rewrite sujets.json: the page is redrawn when the file changes
  // the conversation shown moves too: the page is redrawn when its transcript changes, at most every 10 s
  let sujetsMtime = mtimeOf(F.sujets);
  let watched = { path: "", mtime: 0, at: 0 };
  // the board also depends on events, on the sessions' declarations and on live Claude Code sessions: a separate
  // "board" event, throttled, so the panel is not redrawn on every Slack message.
  // A folder's date does not change when a file in it is rewritten in place, and that is exactly what Claude Code
  // (status in ~/.claude/sessions/<pid>.json) and the hooks (live/<sessionId>.json) do: the signature therefore
  // sums the dates of the files themselves.
  const dirFilesMtime = (dir: string) => {
    let sum = 0;
    try {
      for (const f of readdirSync(dir)) if (f.endsWith(".json")) sum += mtimeOf(join(dir, f));
    } catch {}
    return sum;
  };
  // A working session writes neither to live/ nor to ~/.claude/sessions during its turn: only its transcript moves.
  // The signature therefore adds the transcript date of `busy` topic sessions, rounded to 5 s, so that the "what the
  // session is doing" trail moves on the board.
  let knownIds = { mtime: -1, ids: new Set<string>() };
  const busyTranscripts = () => {
    const m = mtimeOf(F.sujets);
    if (m !== knownIds.mtime) knownIds = { mtime: m, ids: new Set(loadSujets().filter((x) => x.sessionId && x.status !== "closed").map((x) => x.sessionId as string)) };
    let sum = 0;
    try {
      for (const f of readdirSync(join(CLAUDE_DIR, "sessions"))) {
        if (!f.endsWith(".json")) continue;
        const r = readJson<{ sessionId?: string; status?: string }>(join(CLAUDE_DIR, "sessions", f), {});
        if (!r.sessionId || !knownIds.ids.has(r.sessionId)) continue;
        const tr = transcriptOf(r.sessionId);
        if (!tr) continue;
        if (r.status === "busy") sum += Math.floor(mtimeOf(tr) / 5_000);
        // sub-agents write to their own files, including while the session waits for its background agents
        const sub = join(tr.replace(/\.jsonl$/, ""), "subagents");
        try {
          for (const a of readdirSync(sub)) if (a.endsWith(".jsonl")) sum += Math.floor(mtimeOf(join(sub, a)) / 5_000);
        } catch {}
      }
    } catch {}
    return sum;
  };
  const boardSignature = () => `${deliveries.version()}|${mtimeOf(F.snooze)}|${mtimeOf(F.master)}|${mtimeOf(F.events)}|${dirFilesMtime(join(STATE, "live"))}|${dirFilesMtime(join(CLAUDE_DIR, "sessions"))}|${busyTranscripts()}`;
  let board = { signature: boardSignature(), at: Date.now() };
  let boardTimer: ReturnType<typeof setTimeout> | null = null;
  const boardChanged = () => {
    const sig = boardSignature();
    if (sig === board.signature) return;
    // at most one redraw every BOARD_REDRAW_MS, but never a lost change: postpone, never forget
    const wait = Math.max(0, board.at + BOARD_REDRAW_MS - Date.now());
    if (boardTimer) return;
    boardTimer = setTimeout(() => {
      boardTimer = null;
      board = { signature: boardSignature(), at: Date.now() };
      broadcast("board", { version: version() });
    }, wait);
  };
  // the MR state, read from GitLab in the background once boardChanged is defined
  setInterval(() => void deliveries.refresh(), 60_000);
  void deliveries.refresh();
  // fs.watch reports within a second; the 2 s tick stays as a safety net if the watch cannot open
  for (const dir of [join(STATE, "live"), join(CLAUDE_DIR, "sessions")]) {
    try {
      mkdirSync(dir, { recursive: true });
      fsWatch(dir, boardChanged);
    } catch {}
  }
  setInterval(() => {
    boardChanged();
    const m = mtimeOf(F.sujets);
    if (m !== sujetsMtime) {
      sujetsMtime = m;
      broadcast("update", { version: version() });
      return;
    }
    const path = focus.panel?.transcript ?? "";
    if (path !== watched.path) {
      watched = { path, mtime: mtimeOf(path), at: Date.now() };
      return;
    }
    if (!path) return;
    const tm = mtimeOf(path);
    if (tm === watched.mtime || Date.now() - watched.at < TRANSCRIPT_REDRAW_MS) return;
    watched = { path, mtime: tm, at: Date.now() };
    broadcast("update", { version: version() });
  }, 2_000);

  const html = (body: string) => new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

  // ---- version and update from the board (app/update.ts). STRATO_UPDATE_CHECK=off: no fetch (tests).
  const updates: VersionState = { local: await localVersion(), check: null, running: false, failure: null };
  const checksOn = process.env.STRATO_UPDATE_CHECK !== "off";
  const recheck = async () => {
    if (!checksOn || updates.running) return;
    const check = await checkUpdates();
    if (updates.running) return;
    updates.local = await localVersion();
    updates.check = check;
    broadcast("board", { version: version() });
  };
  void recheck();
  setInterval(() => void recheck(), UPDATE_CHECK_MS).unref();
  const label = (v: string | null, sha: string) => `${v ?? "?"} (${sha.slice(0, 7)})`;
  /**
   * The update itself, in the background: the request answers at once (pull, install and the whole test suite take
   * longer than the connection's idle timeout). On success: a request to the master in master.json (same path as
   * "Recheck everything"), then a new detached `serve` on the same port, which waits for this one to free it, and exit.
   * The page reloads by itself when the hello of the new server carries another boot (see onHello in board.ts).
   * Nothing restarts after a failure: the failure shows in the top bar.
   */
  async function runUpdate() {
    updates.running = true;
    updates.failure = null;
    broadcast("board", { version: version() });
    const r = await applyUpdate().catch((e) => ({ ok: false as const, reason: "pullFailed" as const, from: updates.local.sha, output: (e as Error).message }));
    if (!r.ok || r.from === r.to) {
      updates.running = false;
      updates.failure = r.ok ? null : r;
      logEvent({ type: "board-update", ok: r.ok, reason: r.ok ? "upToDate" : r.reason });
      updates.local = await localVersion();
      await recheck();
      broadcast("board", { version: version() });
      return;
    }
    const req: MasterRequest = { id: `u${Date.now().toString(36)}`, kind: "update", from: label(r.fromVersion, r.from), to: label(r.toVersion, r.to), at: nowIso() };
    await withLock(() => writeJson(F.master, [...readJson<MasterRequest[]>(F.master, []), req].slice(-30))).catch(() => {});
    logEvent({ type: "board-update", ok: true, from: req.from, to: req.to });
    const log = openSync(join(STATE, "serve.log"), "a");
    const [selfBin, ...selfArgs] = selfArgv();
    const child = spawn(selfBin, [...selfArgs, "serve", "--port", String(port), "--wait-port"], { detached: true, stdio: ["ignore", log, log], env: process.env });
    child.unref();
    out(`[strato] updated ${req.from} -> ${req.to}, the board restarts on the new code`);
    setTimeout(() => process.exit(0), 300);
  }
  // a page from another site must not be able to trigger anything: every POST carries the origin of the board or the panel (see guard.ts)
  const localOrigin = (req: Request) => {
    const route = `${req.method} ${new URL(req.url).pathname}`;
    return originAllowed(req.headers.get("origin"), port, ORIGINLESS_ROUTES.has(route));
  };

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;
    const shadow = shadowNow();
    if (route === "GET /board") return html(boardPage(await renderBoard(loadSujets()), versionControl(updates)));
    if (route === "GET /board/fragment") return html(await renderBoard(loadSujets()));
    if (route === "GET /" && url.searchParams.has("board")) return Response.redirect(`http://127.0.0.1:${port}/board`, 302);
    if (route === "GET /") return html(panelPage(await render(url), version()));
    if (route === "GET /fragment") return html(await render(url));
    if (route === "GET /board/version") return html(versionControl(updates));
    if (route === "GET /api/version") return Response.json(updates);
    if (route === "POST /api/update") {
      if (!localOrigin(req)) return Response.json({ error: t("board.api.originRefused") }, { status: 403 });
      if (updates.running) return Response.json({ error: t("board.update.running") }, { status: 409 });
      void runUpdate();
      return Response.json({ ok: true, started: true }, { status: 202 });
    }
    if (route === "GET /api/terminals") {
      return Response.json({ terminals: [...terminals.values()].map((t) => ({ key: t.key, letter: t.letter, title: t.title, url: t.url })) });
    }
    if (route === "POST /api/terminal" || route === "POST /api/terminal/close" || route === "POST /api/dive" || route === "POST /api/stop" || route === "POST /api/close") {
      if (!localOrigin(req)) return Response.json({ error: t("board.api.originRefused") }, { status: 403 });
      let body: { key?: unknown };
      try {
        body = (await req.json()) as { key?: unknown };
      } catch {
        return Response.json({ error: t("board.api.jsonExpected") }, { status: 400 });
      }
      if (typeof body.key !== "string") return Response.json({ error: t("board.api.keyExpected") }, { status: 400 });
      const s = findSujet(loadSujets(), body.key);
      if (!s) return Response.json({ error: t("board.api.topicMissing") }, { status: 404 });
      if (route === "POST /api/terminal/close") {
        closeTerminal(s.key);
        return Response.json({ ok: true });
      }
      if (route === "POST /api/stop" || route === "POST /api/close") {
        // stop = the session stops, the topic stays and a message resumes it; close = `close`, topic closed, conversation kept
        const rows = await agentsBySessionAsync();
        const live = s.sessionId ? rows?.get(s.sessionId) : undefined;
        if (live?.id) await run([CLAUDE_BIN, "stop", live.id], 15_000);
        closeTerminal(s.key);
        if (route === "POST /api/close") {
          await updateSujet(s.key, (x) => applyAssignments(x, { status: "closed", gate: "none", waiting: "-" }, nowIso()));
          logEvent({ type: "board-close", key: s.key });
          return Response.json({ ok: true, note: t("board.api.topicClosedNote", { letter: s.letter }) });
        }
        logEvent({ type: "board-stop", key: s.key, stopped: !!live });
        return Response.json({ ok: true, note: live ? t("board.api.sessionStopped", { letter: s.letter }) : t("board.api.sessionNotRunning", { letter: s.letter }) });
      }
      if (!s.sessionId) return Response.json({ error: t("board.api.noSession", { letter: s.letter }) }, { status: 409 });
      if (route === "POST /api/dive") {
        // the iTerm2 tab opens beside: the dive command does everything, it is not awaited
        Bun.spawn([...selfArgv(), "dive", s.key], { cwd: WORKSPACE, stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { ...process.env, PATH: pathWithClaude() } });
        return Response.json({ ok: true, note: t("board.api.diveOpened", { letter: s.letter }) });
      }
      try {
        const t = await openTerminal(s);
        return Response.json({ ok: true, url: t.url, letter: t.letter, title: t.title, key: t.key });
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 500 });
      }
    }
    if (route === "POST /api/post-draft" || route === "POST /api/unpost" || route === "POST /api/snooze" || route === "POST /api/drop-draft" || route === "POST /api/task") {
      if (!localOrigin(req)) return Response.json({ error: t("board.api.originRefused") }, { status: 403 });
      let body: { key?: unknown; taskId?: unknown; op?: unknown; text?: unknown; draft?: unknown; draftTo?: unknown; until?: unknown; sha?: unknown; retry?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: t("board.api.jsonExpected") }, { status: 400 });
      }
      if (typeof body.key !== "string") return Response.json({ error: t("board.api.keyExpected") }, { status: 400 });
      const s = findSujet(loadSujets(), body.key);
      if (!s) return Response.json({ error: t("board.api.topicMissing") }, { status: 404 });
      if (route === "POST /api/snooze") {
        const reason = typeof (body as { reason?: unknown }).reason === "string" ? String((body as { reason?: unknown }).reason).trim().slice(0, 200) : "";
        const until = typeof body.until === "string" && Date.parse(body.until) > Date.now() ? new Date(body.until).toISOString() : null;
        // under the lock: `listen` also writes this file when it sends a reminder
        await withLock(() => {
          const all = readJson<Record<string, Snooze>>(F.snooze, {});
          const now = Date.now();
          // an expired snooze stays until its reminder, then one day: that is what guarantees the reminder after sleep
          for (const [k, z] of Object.entries(all)) if (z.notifiedAt && now - Date.parse(z.notifiedAt) > 86_400_000) delete all[k];
          if (until) all[s.key] = { until, since: nowIso(), ...(reason ? { reason } : {}) };
          else delete all[s.key];
          writeJson(F.snooze, all);
        });
        logEvent({ type: "board-snooze", key: s.key, until, reason: reason || undefined });
        boardChanged();
        return Response.json({ ok: true });
      }
      // every other route acts on one task of the topic
      if (typeof body.taskId !== "string" || !/^t\d+$/.test(body.taskId)) return Response.json({ error: t("board.api.taskIdExpected") }, { status: 400 });
      const taskId = body.taskId;
      if (route === "POST /api/task" || route === "POST /api/drop-draft") {
        // drop-draft is the Drop of a draft task, kept for a page loaded before /api/task
        const op = route === "POST /api/drop-draft" ? "drop" : body.op;
        if (op !== "done" && op !== "drop") return Response.json({ error: t("board.api.opExpected") }, { status: 400 });
        const r = await taskOp(s, taskId, op);
        return r.ok ? Response.json(r) : Response.json({ error: r.error }, { status: r.status });
      }
      if (route === "POST /api/post-draft") {
        // the server posts the text shown (or edited) on the board, and only if the task still carries the draft and the
        // destination that were read: otherwise 409, and the board asks to reread (see draftConflict)
        const conflict = draftConflict(s, body);
        if (conflict) return Response.json({ error: conflict, code: "draft-changed" }, { status: 409 });
        const task = findTask(s, taskId) as Task;
        const text = typeof body.text === "string" ? body.text : "";
        // the hash of the plan the page showed; a page older than the hash showed the draft and destination it sent back
        const shown = planOfTask(s, { ...task, draft: typeof body.draft === "string" ? body.draft : "", draftTo: typeof body.draftTo === "string" ? body.draftTo : "" });
        const sha = typeof body.sha === "string" && body.sha ? body.sha : "plan" in shown ? planSha(shown.plan) : "";
        const r = await postDraft(s, taskId, text.replace(/\r\n/g, "\n").trim() === taskDraftText(task) ? null : text, sha, body.retry === true);
        boardChanged();
        return r.ok ? Response.json(r) : Response.json({ error: r.error, ...(r.code ? { code: r.code } : {}) }, { status: r.status });
      }
      const r = await unpost(s, taskId);
      boardChanged();
      return r.ok ? Response.json(r) : Response.json({ error: r.error, ...(r.code ? { code: r.code } : {}) }, { status: r.status });
    }
    if (route === "POST /api/revue") {
      if (!localOrigin(req)) return Response.json({ error: t("board.api.originRefused") }, { status: 403 });
      let body: { since?: unknown };
      try {
        body = (await req.json()) as { since?: unknown };
      } catch {
        return Response.json({ error: t("board.api.jsonExpected") }, { status: 400 });
      }
      const since = typeof body.since === "string" && body.since in REVUE_WINDOWS ? body.since : null;
      if (!since) return Response.json({ error: t("board.api.windowExpected", { windows: Object.keys(REVUE_WINDOWS).join(", ") }) }, { status: 400 });
      const tick = lastTickIso();
      if (!tick || Date.now() - Date.parse(tick) > 12 * 60_000) return Response.json({ error: t("board.header.revue.noListener") }, { status: 503 });
      const r = await withLock(() => {
        const list = readJson<MasterRequest[]>(F.master, []);
        const pending = pendingRevue(list, Date.now());
        if (pending) return { error: t("board.api.revueBusy", { time: dayTime(pending.at) }) };
        const req: MasterRequest = { id: `r${Date.now().toString(36)}`, kind: "revue", since, at: nowIso() };
        writeJson(F.master, [...list, req].slice(-20));
        return { req };
      });
      if ("error" in r) return Response.json({ error: r.error }, { status: 409 });
      logEvent({ type: "board-revue", since });
      boardChanged();
      return Response.json({ ok: true, id: r.req.id });
    }
    if (route === "POST /api/send") {
      if (!localOrigin(req)) return Response.json({ error: t("board.api.originRefused") }, { status: 403 });
      let body: { key?: unknown; text?: unknown; taskId?: unknown };
      try {
        body = (await req.json()) as { key?: unknown; text?: unknown; taskId?: unknown };
      } catch {
        return Response.json({ error: t("board.api.jsonExpected") }, { status: 400 });
      }
      if (typeof body.key !== "string" || typeof body.text !== "string" || !body.text.trim()) return Response.json({ error: t("board.api.keyTextExpected") }, { status: 400 });
      if (body.text.length > 4000) return Response.json({ error: t("board.api.messageTooLong") }, { status: 400 });
      // a go on a task names it: the session knows which of its tasks to carry out (and to mark done)
      let message = body.text.trim();
      if (typeof body.taskId === "string") {
        const s = findSujet(loadSujets(), body.key);
        const x = s ? findTask(s, body.taskId) : undefined;
        if (!s || !x) return Response.json({ error: t("board.api.taskMissing", { id: body.taskId }) }, { status: 404 });
        if (x.status !== "open") return Response.json({ error: t("board.api.taskClosed", { id: x.id }) }, { status: 409 });
        if (shadow) return Response.json({ error: SHADOW_REFUSAL, code: "shadow" }, { status: 409 });
        // a go would publish words never shown: refused here too, whatever the page shows
        if (sendsUnseenMessage(x)) return Response.json({ error: t("board.api.textsMissing", { id: x.id }) }, { status: 409 });
        message = taskGoMessage(s, x, message);
      }
      // Server-side safety net: the same message to the same topic does not go twice in parallel (double click on Go,
      // two open tabs). A delivery takes 10 to 15 s, the window in which a second click would otherwise go out.
      const flight = `${body.key}\u0000${message}`;
      if (inFlight.has(flight)) return Response.json({ error: t("board.api.alreadySending") }, { status: 409 });
      inFlight.add(flight);
      try {
        const r = await sendFromBoard(body.key, message);
        return r.ok ? Response.json({ ok: true, note: r.note }) : Response.json({ error: r.error }, { status: r.status });
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 500 });
      } finally {
        inFlight.delete(flight);
      }
    }
    if (route === "POST /api/check") {
      // ✅ on the original message of a settled topic's thread, on behalf of the person served: on their click only
      let body: { key?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: t("board.api.jsonExpected") }, { status: 400 });
      }
      const s = typeof body.key === "string" ? findSujet(loadSujets(), body.key) : undefined;
      if (!s) return Response.json({ error: t("board.api.topicMissing") }, { status: 404 });
      if (!checkable(s)) return Response.json({ error: t("board.api.notCheckable", { letter: s.letter }) }, { status: 409 });
      // the click is the Go on the tool's marker of a settled thread (Slack: ✅), through the gate
      const at = nowIso();
      const r = await actDone({ key: s.key, by: "board", after: (x) => ({ ...x, checked: at }) });
      if (!r.ok) {
        if ("refused" in r && (r.refused.code === "capability" || r.refused.code === "target")) return Response.json({ error: t("board.api.notCheckable", { letter: s.letter }) }, { status: 409 });
        const f = actFailure(r);
        return Response.json({ error: f.error, ...(f.code ? { code: f.code } : {}) }, { status: f.status });
      }
      logEvent({ type: "board-check", key: s.key });
      return Response.json({ ok: true });
    }
    if (route === "POST /api/paste-image") {
      // an image pasted in the message field: kept for the topic, the client inserts its path in the text
      let body: { key?: unknown; type?: unknown; data?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: t("board.api.jsonExpected") }, { status: 400 });
      }
      if (typeof body.key !== "string" || typeof body.type !== "string" || typeof body.data !== "string") return Response.json({ error: t("board.api.pasteExpected") }, { status: 400 });
      const s = findSujet(loadSujets(), body.key);
      if (!s) return Response.json({ error: t("board.api.topicMissing") }, { status: 404 });
      try {
        const path = saveUpload(s.key, body.type, Buffer.from(body.data, "base64"));
        logEvent({ type: "board-image", key: s.key, path });
        return Response.json({ ok: true, path });
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 400 });
      }
    }
    if (route === "GET /api/find") {
      return Response.json(searchSujets(loadSujets(), url.searchParams.get("q") ?? "", Date.now()));
    }
    if (route === "POST /api/refresh") {
      if (!localOrigin(req)) return Response.json({ error: t("board.api.originRefused") }, { status: 403 });
      let body: { key?: unknown; all?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: t("board.api.jsonExpected") }, { status: 400 });
      }
      const refs = typeof body.key === "string" ? [body.key] : undefined;
      if (!refs && body.all !== true) return Response.json({ error: t("board.api.refreshExpected") }, { status: 400 });
      const picks = await pickCards({ refs });
      if (!picks.length) return Response.json({ ok: true, note: t("board.api.refreshNone") });
      // a relaunch takes 15 s to a minute per session: answer at once, the board is redrawn on each rewritten card
      void refreshCards(picks, "board", true).catch((e: Error) => logEvent({ type: "refresh-failed", error: e.message }));
      const n = picks.length;
      return Response.json({ ok: true, note: n === 1 ? t("board.api.refreshOne", { letter: picks[0].sujet.letter }) : t("board.api.refreshMany", { n, parallel: settings().refresh.maxParallel }) });
    }
    if (route === "POST /api/master/dismiss") {
      if (!localOrigin(req)) return Response.json({ error: t("board.api.originRefused") }, { status: 403 });
      let body: { id?: unknown };
      try {
        body = (await req.json()) as { id?: unknown };
      } catch {
        return Response.json({ error: t("board.api.jsonExpected") }, { status: 400 });
      }
      const id = typeof body.id === "string" ? body.id : "";
      const found = await withLock(() => {
        const list = readJson<MasterRequest[]>(F.master, []);
        const r = list.find((x) => x.id === id);
        if (!r) return false;
        r.dismissedAt = nowIso();
        writeJson(F.master, list);
        return true;
      });
      if (!found) return Response.json({ error: t("board.api.requestMissing") }, { status: 404 });
      boardChanged();
      return Response.json({ ok: true });
    }
    if (route === "POST /api/master") {
      if (!localOrigin(req)) return Response.json({ error: t("board.api.originRefused") }, { status: 403 });
      let body: { text?: unknown };
      try {
        body = (await req.json()) as { text?: unknown };
      } catch {
        return Response.json({ error: t("board.api.jsonExpected") }, { status: 400 });
      }
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return Response.json({ error: t("board.api.textExpected") }, { status: 400 });
      if (text.length > 2000) return Response.json({ error: t("board.api.requestTooLong") }, { status: 400 });
      const tick = lastTickIso();
      if (!tick || Date.now() - Date.parse(tick) > 12 * 60_000) return Response.json({ error: t("board.header.revue.noListener") }, { status: 503 });
      const id = `d${Date.now().toString(36)}`;
      await withLock(() => {
        const list = readJson<MasterRequest[]>(F.master, []);
        writeJson(F.master, [...list, { id, kind: "demande", text, at: nowIso() } satisfies MasterRequest].slice(-30));
      });
      logEvent({ type: "board-master", id });
      boardChanged();
      return Response.json({ ok: true, id });
    }
    if (route === "GET /api/state") {
      const sujets = loadSujets();
      return Response.json({
        current: focus.key ? (findSujet(sujets, focus.key) ?? null) : null,
        session: focus.sessionName ? { name: focus.sessionName, id: focus.sessionId } : null,
        conversation: focus.panel ? { sessionId: focus.panel.sessionId, name: focus.panel.name, cwd: focus.panel.cwd, transcript: focus.panel.transcript } : null,
        reason: focus.reason,
        sujets,
      });
    }
    if (route === "GET /events") {
      let self: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          self = c;
          clients.add(c);
          send(c, `retry: 2000\nevent: hello\ndata: ${JSON.stringify({ current: focus.key, version: version() })}\n\n`);
        },
        cancel() {
          if (self) clients.delete(self);
        },
      });
      req.signal.addEventListener("abort", () => {
        if (self) clients.delete(self);
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" } });
    }
    if (route === "POST /api/focus" || route === "POST /api/open") {
      if (!localOrigin(req)) return Response.json({ error: t("board.api.originRefused") }, { status: 403 });
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return Response.json({ error: t("board.api.jsonExpected") }, { status: 400 });
      }
      if (route === "POST /api/open") {
        let target: URL | null = null;
        try {
          target = typeof body.url === "string" ? new URL(body.url) : null;
        } catch {}
        if (!target || target.protocol !== "https:" || !openable(target.hostname))
          return Response.json({ error: t("board.api.linkRefused") }, { status: 400 });
        // a link opens in its tool's app when the provider builds one (Slack: on the message, without a redirecting tab);
        // https otherwise, and when the tool does not say who the person is
        const app = await appLinkOf(target);
        Bun.spawn(["open", app ?? target.href], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        return Response.json({ ok: true });
      }
      if (typeof body.sessionName !== "string") return Response.json({ error: "sessionName expected" }, { status: 400 });
      const sessionName = body.sessionName;
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
      const seq = ++focusSeq;
      const sujets = loadSujets();
      let s = sujetForFocus(sessionName, sessionId ?? undefined, sujets, readJson<Record<string, string>>(F.tabs, {}));
      let panel: PanelSession | null = null;
      let reason: string | null = null;
      if (!s) {
        const r = sessionId ? await resolvePanel(sessionId) : { reason: t("panel.focus.noPaneId") };
        if ("session" in r) {
          // a topic session that Claude Code renamed, or joined through `claude attach`: its conversation tells its topic
          s = findSujet(sujets, r.session.sessionId) ?? null;
          if (!s) panel = r.session;
        } else reason = r.reason;
      }
      // two focus calls cross (pane change and beat): only the latest counts
      if (seq !== focusSeq) return Response.json({ ignored: "a more recent focus is in progress" });
      const key = s?.key ?? null;
      const cleaned = cleanSessionName(sessionName);
      const identity = key ? `topic:${key}` : panel ? `claude:${panel.sessionId}:${cleaned}` : `none:${cleaned}:${reason ?? ""}`;
      const changed = identity !== focus.identity;
      focus = { key, sessionName, sessionId, panel, reason, identity };
      if (changed) {
        focusVersion++;
        broadcast("focus", { current: key, version: version() });
      }
      return Response.json({
        current: s ? { key: s.key, letter: s.letter, title: s.title, status: s.status } : null,
        conversation: panel ? { sessionId: panel.sessionId, name: panel.name, cwd: panel.cwd } : null,
        reason,
        changed,
      });
    }
    return new Response("not found\n", { status: 404 });
  }

  const bind = () =>
    Bun.serve({
      hostname: "127.0.0.1",
      port,
      idleTimeout: 60,
      async fetch(req) {
        // DNS rebinding: a foreign domain resolving to 127.0.0.1 would read the state and the Slack threads
        if (!hostAllowed(req.headers.get("host"), port)) return new Response("host refused\n", { status: 421 });
        if (req.method !== "GET" && !localOrigin(req)) return Response.json({ error: t("board.api.originRefused") }, { status: 403 });
        try {
          return await handle(req);
        } catch (e) {
          return new Response(`server error: ${(e as Error).message}\n`, { status: 500 });
        }
      },
    });
  // `--wait-port`: started by an update, the old server still holds the port for a moment
  const bindUntil = Date.now() + (opts["wait-port"] ? 10_000 : 0);
  for (;;) {
    try {
      bind();
      break;
    } catch (e) {
      if (Date.now() >= bindUntil) fail(t("cli.serve.cannotListen", { port, error: (e as Error).message }));
      await Bun.sleep(250);
    }
  }
  out(`[strato] served on http://127.0.0.1:${port}/`);
}
