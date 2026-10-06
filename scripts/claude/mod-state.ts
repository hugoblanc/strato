/**
 * What a topic session declares about itself through Strato's mod (scripts/mod/strato-state), in
 * `<state>/live/<sessionId>.mod.json`, and how the board reads it. Pure: parsing, freshness, and the translation into
 * the inputs the board already takes from Claude Code's files (status, since, last word, steps, sub-agents).
 */
import { type ActivityStep, activityLabel, type AgentNode, type AgentStatus, agentTree } from "./transcript.ts";

/** A declaration is trusted while its beat is younger than this; the mod beats every 15 s. */
export const MOD_FRESH_MS = 60_000;

export type ModStatus = "working" | "idle" | "waiting" | "ended";

/** A tool call as the mod saw it: the tool and the input fields a label needs. */
export interface ModStep {
  tool: string;
  input: Record<string, string>;
  at: number;
}

export interface ModAgent {
  id: string;
  type: string | null;
  description: string | null;
  model: string | null;
  parentId: string | null;
  status: AgentStatus;
  since: number;
  lastAt: number;
  step: ModStep | null;
}

export interface ModState {
  source: "mod";
  v: 1;
  sessionId: string;
  status: ModStatus;
  /** Since when the session is in this status, ms. */
  since: number;
  step: ModStep | null;
  stepAt: number;
  trail: ModStep[];
  lastText: string;
  lastTextAt: number;
  agents: ModAgent[];
  waiting: { tool: string; input: Record<string, string>; since: number; toolUseId: string | null } | null;
  /** Last write, ms: every write is a proof of life, and a timer writes at least every 15 s. */
  beat: number;
  turnId: string | null;
  /** The last main turn ended on an API error. */
  error: boolean;
}

const STATUSES: readonly ModStatus[] = ["working", "idle", "waiting", "ended"];

/** The file's text -> a declaration, or null: not JSON (a write caught halfway), another version, no status. */
export function parseModState(raw: string): ModState | null {
  let x: unknown;
  try {
    x = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!x || typeof x !== "object") return null;
  const m = x as Partial<ModState>;
  if (m.source !== "mod" || m.v !== 1 || !STATUSES.includes(m.status as ModStatus) || typeof m.beat !== "number") return null;
  return {
    source: "mod",
    v: 1,
    sessionId: String(m.sessionId ?? ""),
    status: m.status as ModStatus,
    since: Number(m.since) || m.beat,
    step: m.step ?? null,
    stepAt: Number(m.stepAt) || 0,
    trail: Array.isArray(m.trail) ? m.trail : [],
    lastText: typeof m.lastText === "string" ? m.lastText : "",
    lastTextAt: Number(m.lastTextAt) || 0,
    agents: Array.isArray(m.agents) ? m.agents : [],
    waiting: m.waiting ?? null,
    beat: m.beat,
    turnId: m.turnId ?? null,
    error: m.error === true,
  };
}

/** A declaration the board may use: its beat is fresh, or it says the session ended. */
export function modUsable(m: ModState | null, now: number): m is ModState {
  return !!m && (m.status === "ended" || now - m.beat < MOD_FRESH_MS);
}

/** Where the board's view of a session comes from: its own declaration, or Claude Code's files. */
export type StateSource = "mod" | "reconstructed";

/** A declaration in the board's terms: what `claude agents`, the hooks and the transcript otherwise give. */
export interface DeclaredView {
  /** Claude Code's status words (busy, idle, waiting), or null for a session that ended. */
  running: string | null;
  since: string;
  /** The hooks' attention labels (claude/model.ts `attention`), compared as is by the board. */
  attention: string | null;
  lastAgent: { text: string; at: string | null } | null;
  trail: ActivityStep[];
  agents: AgentNode[];
}

const iso = (ms: number) => new Date(ms).toISOString();
const stepView = (s: ModStep): ActivityStep => ({ text: activityLabel(s.tool, s.input) ?? s.tool, at: s.at ? iso(s.at) : null });

const RUNNING: Record<ModStatus, string | null> = { working: "busy", idle: "idle", waiting: "waiting", ended: null };

export function declaredView(m: ModState): DeclaredView {
  const attention = m.status === "working" ? null : m.status === "waiting" ? "attend une autorisation" : m.status === "ended" ? "arrêtée" : m.error ? "tour terminé en erreur" : "tour terminé";
  // plumbing tools have no label: they do not make a step of the trail
  const trail = m.trail.filter((s) => activityLabel(s.tool, s.input) !== null).map(stepView);
  const flat: AgentNode[] = m.agents.map((a) => ({
    id: a.id,
    label: a.description || a.type || a.id,
    kind: a.type,
    model: a.model,
    parentId: a.parentId,
    // the session ended: what it declared running did not survive it
    status: m.status === "ended" && a.status === "running" ? "stopped" : a.status,
    startedAt: a.since ? iso(a.since) : null,
    lastAt: a.lastAt ? iso(a.lastAt) : null,
    step: a.status === "running" && a.step ? stepView(a.step) : null,
    children: [],
  }));
  return {
    running: RUNNING[m.status],
    since: iso(m.since),
    attention,
    lastAgent: m.lastText ? { text: m.lastText, at: m.lastTextAt ? iso(m.lastTextAt) : null } : null,
    trail,
    agents: agentTree(flat),
  };
}
