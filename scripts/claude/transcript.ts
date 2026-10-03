import { keyFromPermalink } from "../chat/slack-model.ts";
import { t } from "../core/i18n.ts";
import { ticketPattern } from "../core/keys.ts";
import { clip } from "../core/text.ts";

/** An entry of a Claude Code transcript (~/.claude/projects/<folder>/<sessionId>.jsonl), reduced to what the panel reads. */
export interface TranscriptEntry {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  isApiErrorMessage?: boolean;
  toolUseResult?: unknown;
  origin?: { kind?: string } | null;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  timestamp?: string;
  aiTitle?: string;
  message?: { content?: string | { type?: string; text?: string; name?: string; input?: unknown }[] };
}

/**
 * Text typed by a human, without what Claude Code injects into it: `<system-reminder>`, `<task-notification>`,
 * outputs of local commands and of `!`, interruption and pasted image marks. A slash command keeps its name followed
 * by its arguments; without arguments, it says nothing about the request and disappears.
 */
export function cleanHumanText(raw: string): string {
  const name = raw.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1].trim() ?? "";
  const args = raw.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1].trim() ?? "";
  const body = raw
    .replace(/<(system-reminder|task-notification|local-command-[a-z-]+|bash-(?:input|stdout|stderr))>[\s\S]*?<\/\1>/g, "")
    .replace(/<(command-[a-z-]+)>[\s\S]*?<\/\1>/g, "")
    // a pasted text keeps its content, not its tags
    .replace(/<\/?pasted_content(?:\s[^>]*)?>/g, "")
    .replace(/^\[(?:Request interrupted by user[^\]\n]*|Image: source: [^\]\n]*)\]$/gm, "")
    .trim();
  return (args ? `${name} ${args}\n${body}` : body).trim();
}

/** The human request of an entry, or null: not a tool result, a system message, a notification nor a compaction summary. */
export function humanRequestText(e: TranscriptEntry): string | null {
  if (e.type !== "user" || e.isMeta || e.isSidechain || e.isCompactSummary || e.toolUseResult !== undefined) return null;
  if (e.origin?.kind && e.origin.kind !== "human") return null;
  const c = e.message?.content;
  let raw: string;
  if (typeof c === "string") raw = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b.type === "tool_result")) return null;
    raw = c
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
  } else return null;
  return cleanHumanText(raw) || null;
}

/** The visible text of an agent answer (neither thinking nor tool call), or null. */
export function agentText(e: TranscriptEntry): string | null {
  if (e.type !== "assistant" || e.isSidechain || e.isApiErrorMessage) return null;
  const c = e.message?.content;
  if (!Array.isArray(c)) return null;
  const text = c
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n\n")
    .trim();
  return text && text !== "No response requested." ? text : null;
}

export interface SlackCitation {
  /** `channel:ts` key of the thread (the root for a link to a reply). */
  key: string;
  /** The link as quoted, without trailing punctuation. */
  url: string;
  /** Slack subdomain of the link: only the one of `settings().slack.workspace` is readable by Strato. */
  workspace: string;
}


const SLACK_LINK = /https:\/\/([a-z0-9-]+)\.slack\.com\/archives\/[A-Z0-9]+\/p\d{16}(?:\?[^\s<>"'`)\]|]*)?/g;

/** Slack threads and Linear tickets quoted in a text, in order of appearance. */
export function citations(text: string): { slack: SlackCitation[]; linear: string[] } {
  const slack: SlackCitation[] = [];
  for (const m of text.matchAll(SLACK_LINK)) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    const key = keyFromPermalink(url);
    if (key) slack.push({ key, url, workspace: m[1] });
  }
  const tickets = ticketPattern("g");
  return { slack, linear: tickets ? [...text.matchAll(tickets)].map((m) => m[0]) : [] };
}

/** Lengths shown in the panel for a session outside any topic. */
export const FIRST_REQUEST_MAX = 700;
export const AGENT_TEXT_MAX = 1200;
/** Slack threads and Linear tickets kept, the most recently quoted. */
export const CITED_MAX = 5;

/** What a transcript read accumulates. Filled line by line by `foldTranscript`, to read a file that grows at the end. */
export interface TranscriptState {
  sessionId: string | null;
  cwd: string | null;
  branch: string | null;
  title: string | null;
  firstRequest: { text: string; at: string | null } | null;
  /** The first request is only a slash command, not confirmed yet: a built-in command withdraws it. */
  firstRequestProvisional: boolean;
  lastAgent: { text: string; at: string | null } | null;
  /** The last steps of the current turn (tools called, agent sentences), most recent last. */
  trail: ActivityStep[];
  /** Start of the current turn (last message received), ISO: sub-agents started since belong to the turn. */
  turnAt: string | null;
  /** Citation counter: the higher, the more recent the citation. */
  seq: number;
  slack: Map<string, SlackCitation & { seq: number }>;
  linear: Map<string, number>;
  master: boolean;
}

export function emptyTranscript(): TranscriptState {
  return {
    sessionId: null,
    cwd: null,
    branch: null,
    title: null,
    firstRequest: null,
    firstRequestProvisional: false,
    lastAgent: null,
    trail: [],
    turnAt: null,
    seq: 0,
    slack: new Map(),
    linear: new Map(),
    master: false,
  };
}

/** Temporary folders (scratchpads): a cwd there says nothing about the working repository. */
const TEMP_DIR = /^\/(?:private\/)?(?:tmp|var\/folders)\//;
/** The master's slash command, current or pre-rename name. */
const MASTER_COMMAND = /<command-name>\/(?:strato|aiguilleur)<\/command-name>/;
/** The master's listener armed in Monitor, through the entry point or its legacy alias. */
const MASTER_MONITOR = /(?:strato|aiguilleur)\.ts watch/;

/** The message is only a slash command (name, message, arguments), with no text around it. */
function isCommandOnly(raw: string): boolean {
  return raw.includes("<command-name>") && !raw.replace(/<(command-[a-z-]+)>[\s\S]*?<\/\1>/g, "").trim();
}

function cite(st: TranscriptState, text: string) {
  const found = citations(text);
  for (const c of found.slack) st.slack.set(c.key, { ...c, seq: ++st.seq });
  for (const id of found.linear) st.linear.set(id, ++st.seq);
}

/**
 * Adds JSONL lines to the state, in place, and returns it. Unreadable or cut lines are ignored.
 * Tool results (the heaviest lines) are skipped before parsing: they carry neither request nor agent text.
 * The session is the master if a human ran /strato (or the legacy /aiguilleur) in it, or if the agent armed
 * `strato.ts watch` (or `aiguilleur.ts watch`) in Monitor.
 * A lone slash command is the first request only if the agent answers it: a built-in command (/model, /mcp…) gets a
 * `<local-command-stdout>` instead, and the first request becomes the next human message.
 * `gitBranch` is "HEAD" when Claude Code read no branch (umbrella folder, detached HEAD): ignored, like a temporary cwd.
 */
export function foldTranscript(st: TranscriptState, lines: string[]): TranscriptState {
  for (const line of lines) {
    if (!line || line.includes('"toolUseResult":')) continue;
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"') && !line.includes('"type":"ai-title"')) continue;
    let e: TranscriptEntry;
    try {
      e = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }
    if (e.type === "ai-title") {
      if (e.aiTitle?.trim()) st.title = e.aiTitle.trim();
      continue;
    }
    if (e.isSidechain) continue;
    if (e.sessionId) st.sessionId = e.sessionId;
    if (e.cwd && !TEMP_DIR.test(e.cwd)) st.cwd = e.cwd;
    if (e.gitBranch && e.gitBranch !== "HEAD") st.branch = e.gitBranch;
    const at = e.timestamp ?? null;
    const raw = typeof e.message?.content === "string" ? e.message.content : "";
    const human = humanRequestText(e);
    if (st.firstRequestProvisional) {
      // the output of a built-in command withdraws it; an agent answer or a new human message confirms it
      const builtin = raw.includes("<local-command-stdout>");
      if (builtin) st.firstRequest = null;
      if (builtin || human || e.type === "assistant") st.firstRequestProvisional = false;
    }
    if (human) {
      if (!st.firstRequest) {
        st.firstRequest = { text: clip(human, FIRST_REQUEST_MAX), at };
        st.firstRequestProvisional = isCommandOnly(raw);
      }
      cite(st, human);
    }
    if (e.type === "user" && !e.isMeta && MASTER_COMMAND.test(raw)) st.master = true;
    // a new message (human, master, board) opens a turn: the trail starts over
    if (e.type === "user" && !e.isMeta && raw.trim()) {
      st.trail = [];
      st.turnAt = at;
    }
    const agent = agentText(e);
    if (agent) {
      st.lastAgent = { text: clip(agent, AGENT_TEXT_MAX), at };
      cite(st, agent);
      pushStep(st, firstSentence(agent), at);
    }
    if (e.type === "assistant" && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b.type === "tool_use") {
          const label = activityLabel(String(b.name ?? ""), (b.input ?? {}) as Record<string, unknown>);
          if (label) pushStep(st, label, at);
        }
        const command = (b.input as { command?: unknown } | undefined)?.command;
        if (b.type === "tool_use" && b.name === "Monitor" && typeof command === "string" && MASTER_MONITOR.test(command)) st.master = true;
      }
    }
  }
  return st;
}

/** The context of a session as the panel shows it. */
export interface SessionContext {
  sessionId: string | null;
  cwd: string | null;
  branch: string | null;
  /** Title Claude Code gave the conversation (ai-title entry), the most recent. */
  title: string | null;
  firstRequest: { text: string; at: string | null } | null;
  lastAgent: { text: string; at: string | null } | null;
  /** The last steps of the current turn, most recent last. */
  trail: ActivityStep[];
  /** Start of the current turn, ISO. */
  turnAt: string | null;
  /** From the most recently quoted to the oldest, CITED_MAX at most. */
  slackThreads: SlackCitation[];
  linearIssues: string[];
  master: boolean;
}

export function sessionContext(st: TranscriptState): SessionContext {
  const slackThreads = [...st.slack.values()]
    .sort((a, b) => b.seq - a.seq)
    .slice(0, CITED_MAX)
    .map(({ key, url, workspace }) => ({ key, url, workspace }));
  const linearIssues = [...st.linear.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, CITED_MAX)
    .map(([id]) => id);
  return { sessionId: st.sessionId, cwd: st.cwd, branch: st.branch, title: st.title, firstRequest: st.firstRequest, lastAgent: st.lastAgent, trail: st.trail.slice(), turnAt: st.turnAt, slackThreads, linearIssues, master: st.master };
}

/** A visible step of a working session: what it does, and when it started. */
export interface ActivityStep {
  text: string;
  at: string | null;
}

/** Number of steps kept for the board: the current one and a few before it. */
export const TRAIL_MAX = 4;

function pushStep(st: TranscriptState, text: string, at: string | null) {
  const t = text.trim();
  if (!t) return;
  if (st.trail.length && st.trail[st.trail.length - 1].text === t) return;
  st.trail.push({ text: clip(t, 140), at });
  if (st.trail.length > TRAIL_MAX) st.trail.splice(0, st.trail.length - TRAIL_MAX);
}

function firstSentence(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  const m = one.match(/^.{12,}?[.!?:](?=\s|$)/);
  return m ? m[0] : one;
}

const base = (p: unknown) => String(p ?? "").split("/").filter(Boolean).pop() ?? "";

/**
 * A tool call as a readable label, for the board's trail. Bash carries its own description, written by the agent for
 * the human: the best label there is. Plumbing tools (ToolSearch, TodoWrite) say nothing.
 */
export function activityLabel(name: string, input: Record<string, unknown>): string | null {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string).trim() : "");
  if (name === "ToolSearch" || name === "TodoWrite" || name === "TaskOutput" || name === "ReadNotifications") return null;
  if (name === "Bash") return str("description") || t("activity.command", { cmd: clip(str("command").split("\n")[0], 70) });
  if (name === "Read") return t("activity.read", { file: base(input.file_path) });
  if (name === "Grep") return t("activity.grep", { pattern: clip(str("pattern"), 40) });
  if (name === "Glob") return t("activity.glob", { pattern: clip(str("pattern"), 40) });
  if (name === "Edit" || name === "Write" || name === "NotebookEdit") return t("activity.edit", { file: base(input.file_path ?? input.notebook_path) });
  if (name === "Agent" || name === "Task") return t("activity.agent", { what: str("description") || t("activity.agentDefault") });
  if (name === "Skill") return t("activity.skill", { name: str("skill") });
  if (name === "SendMessage") return t("activity.sendMessage", { to: str("to") || t("activity.sendMessageDefault") });
  if (name === "WebFetch" || name === "WebSearch") return t("activity.web", { target: clip(str("url") || str("query"), 60) });
  if (name === "Monitor") return str("description") || t("activity.monitor");
  const mcp = name.match(/^mcp__([^_]+(?:[-_][^_]+)*?)__(.+)$/);
  if (mcp) {
    const [, server, tool] = mcp;
    if (/postgres/.test(server)) return t("activity.query", { db: server.replace(/^postgres-?/, "Postgres ").trim() || "Postgres" });
    if (server === "slack") {
      if (tool === "conversations_replies") return t("activity.slackThread");
      if (tool === "conversations_add_message") return t("activity.slackPost");
      if (tool.startsWith("conversations_search")) return t("activity.slackSearch", { query: str("search_query") ? ` « ${clip(str("search_query"), 40)} »` : "" });
      return `Slack : ${tool.replace(/_/g, " ")}`;
    }
    if (server === "linear") return `Linear : ${tool.replace(/_/g, " ")}${str("id") ? ` ${str("id")}` : ""}`;
    if (server === "clickhouse") return t("activity.query", { db: "ClickHouse" });
    if (server === "axiom") return `Axiom : ${tool}`;
    return `${server} : ${tool.replace(/_/g, " ")}`;
  }
  return name;
}

/** Metadata of a sub-agent, as Claude Code writes it in `<session>/subagents/agent-<id>.meta.json`. */
export interface AgentMeta {
  agentType?: string;
  description?: string;
  name?: string;
  /** The agent that started it; absent when it is the session itself (or a workflow agent). */
  parentAgentId?: string;
  spawnDepth?: number;
  model?: string;
}

export type AgentStatus = "running" | "done" | "error" | "stopped";

/** A sub-agent on the board: what it does, where it stands, and the agents it started. */
export interface AgentNode {
  id: string;
  label: string;
  kind: string | null;
  model: string | null;
  parentId: string | null;
  status: AgentStatus;
  startedAt: string | null;
  /** Last write of the agent, ISO: its end when it is finished. */
  lastAt: string | null;
  /** Its last step (tool or sentence), while it still works. */
  step: ActivityStep | null;
  children: AgentNode[];
}

/**
 * The end of a sub-agent's conversation -> its state and its last step.
 * Finished = its last message says `end_turn` without asking for a tool; everything else is running (or stopped if
 * the session that carries it is dead, which the caller knows and we do not).
 * `lines` may start in the middle of the file: a cut line is ignored.
 */
export function agentTail(lines: string[]): { finished: boolean; error: boolean; step: ActivityStep | null; lastAt: string | null } {
  let finished = false;
  let error = false;
  let step: ActivityStep | null = null;
  let lastAt: string | null = null;
  for (const line of lines) {
    if (!line || !line.includes('"type":"assistant"')) {
      const ts = line.match(/"timestamp":"([^"]+)"/);
      if (ts && line.includes('"type":"user"')) {
        lastAt = ts[1];
        finished = false;
      }
      continue;
    }
    let e: TranscriptEntry & { message?: { stop_reason?: string | null; content?: unknown } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== "assistant") continue;
    lastAt = e.timestamp ?? lastAt;
    const content = Array.isArray(e.message?.content) ? (e.message?.content as { type?: string; text?: string; name?: string; input?: unknown }[]) : [];
    const tool = content.filter((b) => b.type === "tool_use").pop();
    const text = content.filter((b) => b.type === "text" && b.text).map((b) => b.text as string).join(" ").trim();
    if (tool) {
      const label = activityLabel(String(tool.name ?? ""), (tool.input ?? {}) as Record<string, unknown>);
      if (label) step = { text: clip(label, 140), at: e.timestamp ?? null };
    } else if (text) step = { text: clip(firstSentence(text), 140), at: e.timestamp ?? null };
    finished = !tool && e.message?.stop_reason === "end_turn";
    error = !!e.isApiErrorMessage;
  }
  return { finished, error, step, lastAt };
}

/** Flat agents -> a tree by `parentId`, in start order; an unknown parent attaches the agent to the root. */
export function agentTree(flat: AgentNode[]): AgentNode[] {
  const byId = new Map(flat.map((a) => [a.id, { ...a, children: [] as AgentNode[] }]));
  const roots: AgentNode[] = [];
  const order = (a: AgentNode, b: AgentNode) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "");
  for (const a of [...byId.values()].sort(order)) {
    const parent = a.parentId ? byId.get(a.parentId) : undefined;
    (parent ? parent.children : roots).push(a);
  }
  return roots;
}

/** Number of agents in a tree, and how many still work. */
export function agentCounts(tree: AgentNode[]): { total: number; running: number } {
  let total = 0;
  let running = 0;
  const walk = (list: AgentNode[]) => {
    for (const a of list) {
      total++;
      if (a.status === "running") running++;
      walk(a.children);
    }
  };
  walk(tree);
  return { total, running };
}
