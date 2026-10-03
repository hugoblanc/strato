import { existsSync as fsExists } from "node:fs";

/** What `claude agents --json` returns for a session. */
export interface AgentRow {
  id?: string;
  sessionId?: string;
  cwd?: string;
  name?: string;
  kind?: string;
  status?: string;
  waitingFor?: string;
  state?: string;
}

export interface TtyProcess {
  pid: number;
  /** STAT column of ps: "+" = foreground process group of the terminal. */
  stat: string;
  command: string;
}

/** Output of `ps -o pid=,stat=,command= -t ttysNNN` -> processes. Unreadable lines are ignored. */
export function parsePs(out: string): TtyProcess[] {
  const procs: TtyProcess[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.+)$/);
    if (m) procs.push({ pid: Number(m[1]), stat: m[2], command: m[3].trim() });
  }
  return procs;
}

/**
 * Does the process run Claude Code: `claude` binary, versioned binary (~/.local/share/claude/versions/x.y.z), npm
 * package, or shell wrapper (`/bin/sh /usr/bin/command claude …`). `.claude/dbhub.toml` and the like do not count.
 */
export function looksLikeClaude(command: string): boolean {
  return /(^|[\s/])claude(\s|$)/.test(command) || /\/claude\/versions\/\S+/.test(command) || command.includes("@anthropic-ai/claude-code");
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** A lead to the conversation of a terminal pane: a pid to look up in ~/.claude/sessions, a short id from `claude attach`, a sessionId. */
export type ClaudeRef = { pid: number } | { shortId: string } | { sessionId: string };

/**
 * The leads of a pane, in the order to try them: foreground process first, then the most recent.
 * For each Claude process: its pid (the file ~/.claude/sessions/<pid>.json is authoritative), then the id of
 * `claude attach <id>`, then the sessionId of `--resume` or `--session-id` (a transcript path given to --resume counts).
 */
export function claudeRefs(procs: TtyProcess[]): ClaudeRef[] {
  const ordered = procs
    .filter((p) => looksLikeClaude(p.command))
    .sort((a, b) => Number(b.stat.includes("+")) - Number(a.stat.includes("+")) || b.pid - a.pid);
  const refs: ClaudeRef[] = [];
  const seen = new Set<string>();
  const push = (ref: ClaudeRef, id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    refs.push(ref);
  };
  for (const p of ordered) {
    push({ pid: p.pid }, `pid:${p.pid}`);
    const attach = p.command.match(/\sattach\s+([A-Za-z0-9_-]+)/);
    if (attach) push({ shortId: attach[1] }, `short:${attach[1]}`);
    const resume = p.command.match(/\s(?:--resume|-r|--session-id)(?:\s+|=)(\S+)/)?.[1].match(UUID)?.[0].toLowerCase();
    if (resume) push({ sessionId: resume }, `session:${resume}`);
  }
  return refs;
}

// ------------------------------------------------------------------ sessions

/**
 * What a work session asks of the person served, seen from `claude agents --json`. null = it is working, nothing to
 * report. The values ("arrêtée" stopped, "attend …" waiting for, "bloquée" stuck, "tour terminé" turn done) are
 * French on purpose: they are written to live/*.json by the hooks and compared by the board and `listen`. Renaming
 * them requires reading the old values too.
 */
export function attention(row: AgentRow | undefined): string | null {
  if (!row) return "arrêtée";
  if (row.status === "waiting") return `attend ${row.waitingFor ?? "une réponse"}`;
  if (isStuck(row)) return "bloquée";
  if (row.status === "busy") return null;
  if (row.status === "idle" || row.state === "done" || row.state === "blocked") return "tour terminé";
  return null;
}

/**
 * Really stuck: pending permission, or a dialog at startup (state blocked without status).
 * A session that finished its turn and waits for the person served also shows state blocked, but with status idle.
 */
export function isStuck(row: AgentRow | undefined): boolean {
  if (!row) return false;
  return row.status === "waiting" || (row.state === "blocked" && !row.status);
}

/** A change of attention deserves a notification only if it calls for someone. */
export function attentionChanged(prev: string | null | undefined, cur: string | null): boolean {
  return cur !== null && cur !== prev;
}

/**
 * `claude agents --json` keeps ghosts: stopped sessions, listed with `status: null` and `state: "blocked"`. In
 * practice, rows without a status have no process and rows with one do. Taking ghosts for live sessions sends
 * `relay` through SendMessage ("No agent named … is reachable"), files dead sessions under "Stuck" and tries
 * `claude attach` on a stopped session.
 * A row therefore counts if it has a status, or if its process runs (a session just started may not have a status
 * yet); `running` = sessionIds whose process is alive, read from ~/.claude/sessions.
 */
export function liveAgentRows(rows: AgentRow[], running: Set<string>): AgentRow[] {
  return rows.filter((x) => x.sessionId && (x.status || running.has(x.sessionId)));
}

/**
 * The attention of a topic session: what it declared through its hooks wins (fresher, and the only one to see a
 * permission block), else what `claude agents` says, else `undefined`: unknown, nothing is concluded.
 * `listen` uses it at startup as on every transition: with two different sources, every restart would print a
 * "turn done" line per open topic.
 */
export function sessionAttention(declared: { attention: string | null } | null, row: AgentRow | undefined, rowsKnown: boolean): string | null | undefined {
  if (declared) return declared.attention;
  return rowsKnown ? attention(row) : undefined;
}

export type RouteDecision = "resume" | "sendmessage";

/**
 * Suffix of the messages delivered through SendMessage (the board's throwaway relay, or the master). Without it, the
 * session answers the sender: the relay is already gone ("Failed to send to uds:/tmp/cc-socks/…sock: ENOENT"), and
 * the answer goes nowhere or into the master's chat.
 */
export function inboundNote(owner: string): string {
  return `(Message delivered by a relay. Do not answer with SendMessage: the sender does not read the answer. Answer in your end-of-turn message and update the card, ${owner} reads both on the board.)`;
}

/**
 * How to get a message into a topic's session.
 * - absent from `claude agents` (stopped): `claude --bg --resume <sessionId>` without any option, which continues the
 *   same session; with options, Claude Code creates a copy;
 * - alive, whatever its state: SendMessage from the master. Work sessions are started with
 *   `crossSessionInbound: accept`, the message is delivered even if it is idle. Resuming a live session would create
 *   a copy.
 */
export function routeDecision(row: AgentRow | undefined): RouteDecision {
  return row ? "sendmessage" : "resume";
}

/**
 * Path of the `claude` binary. The panel's server is started by the iTerm2 script with a minimal PATH, without
 * `~/.local/bin`: look in the PATH first, then in the installer's known locations.
 */
export function claudeBin(home = process.env.HOME ?? "", which: (name: string) => string | null = (n) => Bun.which(n), exists: (p: string) => boolean = (p) => Bun.file(p).size > 0 || fsExists(p)): string {
  const found = which("claude");
  if (found) return found;
  for (const p of [`${home}/.local/bin/claude`, `${home}/.claude/local/claude`, `${home}/.bun/bin/claude`, "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]) {
    if (exists(p)) return p;
  }
  return "claude";
}
