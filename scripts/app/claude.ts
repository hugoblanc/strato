/**
 * What Strato does with Claude Code: start and resume topic sessions, talk to them, read their declarations
 * (hooks), their transcripts and their sub-agents. Everything that depends on Claude Code's internal formats
 * (`~/.claude/sessions`, `~/.claude/projects`, `claude agents --json`) goes through here or through claude/.
 */
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, type Stats, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentRow, liveAgentRows } from "../claude/model.ts";
import { type AgentMeta, type AgentNode, agentTail, emptyTranscript, foldTranscript, sessionContext, type SessionContext, type TranscriptState } from "../claude/transcript.ts";
import { settings } from "../core/settings.ts";
import { CLAUDE_BIN, F, fail, HOME, LEGACY_SCRIPT, mtimeOf, readJson, SCRIPT, STATE, WORKSPACE } from "./env.ts";
import { loadSujets, logEvent } from "./store.ts";

/**
 * Settings passed to every work session: project MCP servers without a dialog, messages from the master accepted,
 * and common reads pre-approved. grep, cat and head are already allowed by default; sed -n and git log are not,
 * and a session can sit blocked on a permission prompt for a `grep … ; sed -n …` while nobody watches it.
 * A compound command passes when every sub-command is covered. Nothing that writes is in the list, except the
 * topic's report in <state>/reports/.
 */
export function workerSettings(): string {
  return JSON.stringify({
    enableAllProjectMcpServers: true,
    crossSessionInbound: "accept",
    // The session declares its own transitions: Strato does not have to poll it.
    // Only these events matter; a hook on PreToolUse would cost one process per tool call.
    hooks: Object.fromEntries(
      ["Stop", "StopFailure", "PermissionRequest", "Notification", "SessionEnd", "UserPromptSubmit"].map((e) => [
        e,
        [{ matcher: "*", hooks: [{ type: "command", command: `bun ${SCRIPT} hook` }] }],
      ]),
    ),
    permissions: {
      allow: [
        "Bash(sed -n *)",
        "Bash(rg *)",
        "Bash(jq *)",
        "Bash(git log *)",
        "Bash(git show *)",
        "Bash(git diff *)",
        "Bash(git status *)",
        "Bash(git fetch *)",
        "Bash(git branch *)",
        `Bash(bun ${SCRIPT} *)`,
        // a session resumed after the rename may still follow a prompt that names the legacy alias
        `Bash(bun ${LEGACY_SCRIPT} *)`,
        // Edit covers Write; an absolute path is written with // (a single / anchors on the settings file's folder)
        `Edit(/${F.reports}/**)`,
        // the session reads its threads itself: Slack reads always allowed
        "mcp__slack__conversations_replies",
        "mcp__slack__conversations_history",
        "mcp__slack__conversations_search_messages",
        // what the installation adds (database reads, tracker…), from `workers.allow`
        ...settings().workers.allow,
      ],
    },
  });
}

// ------------------------------------------------------------------ claude

/** The process still exists. */
export const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** sessionId of the Claude Code sessions whose process runs, from ~/.claude/sessions/<pid>.json. */
export function runningSessionIds(): Set<string> {
  const ids = new Set<string>();
  try {
    for (const f of readdirSync(join(CLAUDE_DIR, "sessions"))) {
      if (!f.endsWith(".json")) continue;
      const r = readJson<{ pid?: number; sessionId?: string }>(join(CLAUDE_DIR, "sessions", f), {});
      if (r.sessionId && r.pid && pidAlive(r.pid)) ids.add(r.sessionId);
    }
  } catch {}
  return ids;
}

/** Cap on `claude agents --json`: past it we do not know, and the listener is not blocked to find out. */
export const AGENTS_TIMEOUT_MS = 10_000;
/** Cap on `claude --bg`: it returns as soon as the session is started, within a few seconds. */
export const BG_TIMEOUT_MS = 30_000;

/** Options of the calls to claude, for tests: another binary, another cap. */
export interface ClaudeCallOptions {
  bin?: string;
  timeoutMs?: number;
}

/** What a stream has written so far, read as it comes: a grandchild that keeps the pipe open must not make us wait. */
function drain(stream: ReadableStream<Uint8Array>): { text: () => string; done: Promise<void> } {
  let text = "";
  const dec = new TextDecoder();
  const done = (async () => {
    try {
      for await (const chunk of stream) text += dec.decode(chunk, { stream: true });
    } catch {}
  })();
  return { text: () => text, done };
}

/**
 * Runs claude without blocking the event loop, killed after `timeoutMs`. Returns the exit code (null if killed)
 * and everything written to stdout then stderr. A synchronous `claude agents` in `listen` would stop the socket from
 * acknowledging anything meanwhile, and Slack then redelivers or cuts the delivery.
 */
async function runClaude(args: string[], timeoutMs: number, bin = CLAUDE_BIN, cwd?: string): Promise<{ code: number | null; text: string }> {
  const proc = Bun.spawn([bin, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const out = drain(proc.stdout);
  const err = drain(proc.stderr);
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  const code = await proc.exited;
  clearTimeout(timer);
  // the output may still sit in the pipe: a short delay to read it, no more
  await Promise.race([Promise.all([out.done, err.done]), Bun.sleep(500)]);
  return { code: killed ? null : code, text: `${out.text()}${err.text()}` };
}

/** The rows of `claude agents --json` -> active sessions by sessionId, ghosts dropped (`liveAgentRows`). */
function agentMap(json: string): Map<string, AgentRow> | null {
  try {
    const rows = liveAgentRows(JSON.parse(json) as AgentRow[], runningSessionIds());
    return new Map(rows.map((x) => [x.sessionId as string, x]));
  } catch {
    return null;
  }
}

/**
 * Active sessions by sessionId, or null when `claude agents` did not answer: do not conclude they are stopped.
 * Synchronous, for one-shot commands and the board server; `listen` goes through `agentsBySessionAsync`.
 */
export function agentsBySession(): Map<string, AgentRow> | null {
  const r = Bun.spawnSync([CLAUDE_BIN, "agents", "--json"], { stdout: "pipe", stderr: "pipe", timeout: AGENTS_TIMEOUT_MS });
  if (r.exitCode !== 0) return null;
  return agentMap(r.stdout.toString());
}

/** The same without blocking the event loop, killed after 10 s: null in that case too. */
export async function agentsBySessionAsync(opts: ClaudeCallOptions = {}): Promise<Map<string, AgentRow> | null> {
  const r = await runClaude(["agents", "--json"], opts.timeoutMs ?? AGENTS_TIMEOUT_MS, opts.bin);
  if (r.code !== 0) return null;
  return agentMap(r.text);
}

export async function sessionIdOf(shortId: string): Promise<string | null> {
  for (let i = 0; i < 20; i++) {
    const rows = await agentsBySessionAsync();
    for (const row of rows?.values() ?? []) if (row.id === shortId && row.sessionId) return row.sessionId;
    await Bun.sleep(500);
  }
  return null;
}

/** The short id printed by `claude --bg`, or an error that quotes the output. */
function backgroundId(text: string): string {
  const m = text.match(/backgrounded · (\S+)/);
  if (!m) throw new Error(`claude --bg did not start a session:\n${text}`);
  return m[1];
}

/**
 * Runs `claude --bg …` and returns the session's short id; throws when no session started (the server must not die).
 * Synchronous and capped at 30 s, for callers that wait that way; `spawnBackgroundAsync` does not block the loop.
 */
export function spawnBackgroundOrThrow(args: string[]): string {
  const r = Bun.spawnSync([CLAUDE_BIN, "--bg", ...args], { cwd: WORKSPACE, stdout: "pipe", stderr: "pipe", timeout: BG_TIMEOUT_MS });
  return backgroundId(`${r.stdout.toString()}${r.stderr.toString()}`);
}

/** `claude --bg …` without blocking the event loop, killed after 30 s. Same contract as `spawnBackgroundOrThrow`. */
export async function spawnBackgroundAsync(args: string[], opts: ClaudeCallOptions = {}): Promise<string> {
  const r = await runClaude(["--bg", ...args], opts.timeoutMs ?? BG_TIMEOUT_MS, opts.bin, WORKSPACE);
  if (r.code === null) throw new Error(`claude --bg did not return within ${Math.round((opts.timeoutMs ?? BG_TIMEOUT_MS) / 1000)} s:\n${r.text}`);
  return backgroundId(r.text);
}

export function spawnBackground(args: string[]): string {
  try {
    return spawnBackgroundOrThrow(args);
  } catch (e) {
    return fail((e as Error).message);
  }
}

/**
 * Hands a message to a live session. No script can talk to it directly: only a Claude can, through the SendMessage
 * tool. So a throwaway `claude -p` runs, without MCP, allowed on that tool only, sends the text as is to the named
 * session and answers "ok". It takes about 15 s, and the message lands in the session as a message from another
 * session (crossSessionInbound: accept in workerSettings).
 */
export async function deliverToLiveSession(sessionName: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const prompt = [
    `Use the SendMessage tool to send to the session named exactly "${sessionName}" the message between the <message> tags, as is, without adding or removing anything.`,
    'Then answer only "ok", or the exact error returned by the tool.',
    "<message>",
    text,
    "</message>",
  ].join("\n");
  // --no-session-persistence: without it, every message from the board leaves a throwaway conversation in the
  // history (dozens a day), which clutters /resume and session search.
  const proc = Bun.spawn([CLAUDE_BIN, "-p", "--no-session-persistence", "--strict-mcp-config", "--allowedTools", "SendMessage", "--settings", '{"enableAllProjectMcpServers":false}', prompt], {
    cwd: WORKSPACE,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), 90_000);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  const answer = out.trim().split("\n").filter(Boolean).pop() ?? "";
  if (code === 0 && /^ok\b/i.test(answer)) return { ok: true };
  return { ok: false, error: answer || err.trim().split("\n").pop() || `claude -p exited with code ${code}` };
}

/**
 * What a session declares about itself. The labels are those of `attention()` (claude/model.ts), so the two sources
 * are interchangeable. They are written to live/<sessionId>.json and compared as is by their readers: protocol
 * values, not display text, kept unchanged until every reader accepts a new spelling.
 * `null` means "working, nothing to report", and resets the counter for the next transition.
 */
const HOOK_ATTENTION: Record<string, string | null> = {
  Stop: "tour terminé",
  StopFailure: "tour terminé en erreur",
  PermissionRequest: "attend une autorisation",
  Notification: "attend une réponse",
  SessionEnd: "arrêtée",
  UserPromptSubmit: null,
};

/**
 * Called by Claude Code inside a topic session, on every state transition.
 * Writes one file per session, so never two concurrent writes to the same file.
 * Never blocks the session and never makes it fail: exit 0 whatever happens.
 */
export async function hookSession(): Promise<void> {
  try {
    const p = JSON.parse(await Bun.stdin.text()) as { session_id?: string; hook_event_name?: string; notification_type?: string };
    const id = p.session_id;
    const ev = p.hook_event_name ?? "";
    if (!id || !(ev in HOOK_ATTENTION)) return;
    const attention = ev === "Notification" ? notificationAttention(p.notification_type) : HOOK_ATTENTION[ev];
    if (attention === undefined) return;
    mkdirSync(join(STATE, "live"), { recursive: true });
    writeFileSync(join(STATE, "live", `${id}.json`), JSON.stringify({ attention, event: ev, at: Date.now(), kind: p.notification_type }));
    if (ev === "Stop") noteSelfClose(id);
  } catch {}
}

/**
 * A session that closed its topic during its turn (`set status=closed`) logs it at the end of that turn.
 * It does not stop itself from here: a process started by the hook can be killed along with it. The listener,
 * which runs continuously, stops the sessions of closed topics every 5 minutes (commands/gc.ts).
 */
function noteSelfClose(sessionId: string): void {
  const s = loadSujets().find((x) => x.sessionId === sessionId);
  if (!s || s.status !== "closed") return;
  logEvent({ type: "self-close", key: s.key, summary: s.summary });
}

/**
 * The Notification hook does not mean a session is stuck: Claude Code also sends it when the session has simply been
 * waiting for input for 60 s (`idle_prompt`), the normal state of a topic session between two turns.
 * Only a permission request blocks. `undefined` = nothing to write.
 */
function notificationAttention(kind: string | undefined): string | null | undefined {
  switch (kind) {
    case "permission_prompt":
      return "attend une autorisation";
    case "idle_prompt":
      return "tour terminé";
    case "auth_success":
      return undefined;
    default:
      return "attend une réponse";
  }
}

/** The state a session declared, or null if it never spoke. */
export function declaredAttention(sessionId: string): { attention: string | null } | null {
  try {
    return JSON.parse(readFileSync(join(STATE, "live", `${sessionId}.json`), "utf8"));
  } catch {
    return null;
  }
}

/** `claude stop <id>`: the session stops, its conversation is kept. True if Claude Code accepted, capped at 15 s. */
export async function stopSession(id: string): Promise<boolean> {
  const r = await runClaude(["stop", id], 15_000);
  return r.code === 0;
}

/** Deletes the declarations of sessions whose topic is closed or gone. */
export function purgeLive(): void {
  try {
    const alive = new Set(loadSujets().filter((s) => s.status !== "closed" && s.sessionId).map((s) => s.sessionId as string));
    for (const f of readdirSync(join(STATE, "live"))) {
      if (!alive.has(f.replace(/\.json$/, ""))) unlinkSync(join(STATE, "live", f));
    }
  } catch {}
}

/** The process PATH, plus claude's and bun's folders: ttyd and the panel server start with a minimal PATH. */
export function pathWithClaude(): string {
  const dirs = [CLAUDE_BIN, process.execPath].map((p) => p.slice(0, p.lastIndexOf("/"))).filter(Boolean);
  const current = (process.env.PATH ?? "").split(":").filter(Boolean);
  return [...new Set([...dirs, ...current, "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
}

/** ~/.claude, read and never written: live sessions and transcripts. */
export const CLAUDE_DIR = join(HOME, ".claude");

/** Transcripts kept in memory by the panel. */
const TRANSCRIPT_CACHE_MAX = 20;

/** A Claude Code conversation found behind an iTerm2 pane. */
export interface PanelSession {
  sessionId: string;
  cwd: string | null;
  /** Session name in ~/.claude/sessions or in `claude agents`. */
  name: string | null;
  transcript: string;
}

/** ~/.claude/projects/*\/<sessionId>.jsonl, the most recently modified if there are several. */
export function findTranscript(sessionId: string): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  const root = join(CLAUDE_DIR, "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  let best: string | null = null;
  let bestMtime = 0;
  for (const dir of dirs) {
    const path = join(root, dir, `${sessionId}.jsonl`);
    const m = mtimeOf(path);
    if (m > bestMtime) {
      best = path;
      bestMtime = m;
    }
  }
  return best;
}

interface TranscriptCache {
  ino: number;
  mtime: number;
  size: number;
  /** Bytes already read, up to the last complete newline. */
  offset: number;
  state: TranscriptState;
}
const transcriptCache = new Map<string, TranscriptCache>();

/**
 * A session's sub-agents (folder `<transcript>/subagents/`, one .jsonl and one .meta.json per agent), flat.
 * Kept: those started during the current turn, and those still working (a background agent outlives its turn).
 * Agent conversations weigh several MB: only the start (for the launch time, once) and the last 96 KB (for the
 * state) are read, cached as long as the size does not move.
 */
const agentCache = new Map<string, { size: number; startedAt: string | null; tail: ReturnType<typeof agentTail> }>();
function readSlice(path: string, start: number, length: number): string {
  const buf = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
export function sessionAgents(transcript: string, turnAt: string | null, alive: boolean): AgentNode[] {
  const dir = join(transcript.replace(/\.jsonl$/, ""), "subagents");
  let metas: string[] = [];
  try {
    metas = readdirSync(dir).filter((f) => f.endsWith(".meta.json"));
  } catch {
    return [];
  }
  const out: AgentNode[] = [];
  for (const m of metas) {
    const id = m.replace(/^agent-/, "").replace(/\.meta\.json$/, "");
    const path = join(dir, `agent-${id}.jsonl`);
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      continue;
    }
    let c = agentCache.get(path);
    if (!c || c.size !== size) {
      const startedAt = c?.startedAt ?? readSlice(path, 0, Math.min(size, 262_144)).match(/"timestamp":"([^"]+)"/)?.[1] ?? null;
      const from = Math.max(0, size - 98_304);
      const lines = readSlice(path, from, size - from).split("\n");
      if (from > 0) lines.shift();
      c = { size, startedAt, tail: agentTail(lines) };
      agentCache.set(path, c);
    }
    const inTurn = !!turnAt && !!c.startedAt && c.startedAt >= turnAt;
    const stillRunning = alive && !c.tail.finished;
    if (!inTurn && !stillRunning) continue;
    const meta = readJson<AgentMeta>(join(dir, m), {});
    out.push({
      id,
      label: meta.description || meta.name || meta.agentType || id,
      kind: meta.agentType ?? null,
      model: meta.model ?? null,
      parentId: meta.parentAgentId ?? null,
      status: c.tail.error ? "error" : c.tail.finished ? "done" : alive ? "running" : "stopped",
      startedAt: c.startedAt,
      lastAt: c.tail.lastAt,
      step: c.tail.finished ? null : c.tail.step,
      children: [],
    });
  }
  return out;
}

/**
 * A transcript's context, cached by path and mtime.
 * A transcript only grows: only the bytes appended since the previous read are read, up to the last newline,
 * which keeps a 50 MB transcript readable every 3 s. A replaced (other inode) or truncated file is reread in full.
 */
export function transcriptContext(path: string): SessionContext | null {
  let st: Stats;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  let entry = transcriptCache.get(path);
  if (entry && entry.ino === st.ino && entry.mtime === st.mtimeMs && entry.size === st.size) return sessionContext(entry.state);
  if (!entry || entry.ino !== st.ino || st.size < entry.offset) entry = { ino: st.ino, mtime: 0, size: 0, offset: 0, state: emptyTranscript() };
  const length = st.size - entry.offset;
  if (length > 0) {
    const buf = Buffer.alloc(length);
    const fd = openSync(path, "r");
    let read = 0;
    try {
      while (read < length) {
        const n = readSync(fd, buf, read, length - read, entry.offset + read);
        if (n <= 0) break;
        read += n;
      }
    } finally {
      closeSync(fd);
    }
    const end = buf.subarray(0, read).lastIndexOf(0x0a) + 1;
    if (end > 0) {
      foldTranscript(entry.state, buf.subarray(0, end).toString("utf8").split("\n"));
      entry.offset += end;
    }
  }
  entry.mtime = st.mtimeMs;
  entry.size = st.size;
  transcriptCache.delete(path);
  transcriptCache.set(path, entry);
  for (const old of transcriptCache.keys()) {
    if (transcriptCache.size <= TRANSCRIPT_CACHE_MAX) break;
    transcriptCache.delete(old);
  }
  return sessionContext(entry.state);
}
