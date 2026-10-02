/**
 * The gate, pure side (docs/design/providers.md, section 8): the plan a Go approves, its canonical content and hash,
 * and every decision taken before a provider is called. Nothing reaches the outside world unless the person gave a Go
 * on the exact content that goes out, and nothing at all in shadow mode; app/act.ts is the only caller of a provider's
 * `act` and `undo`, and it asks this module first.
 *
 * Pure: no I/O. The hash is computed here, the state is read and written by app/act.ts.
 */
import { createHash } from "node:crypto";
import type { Action, ActionKind, ProviderDescriptor, Target } from "../providers/sdk.ts";
import { t } from "./i18n.ts";
import { parseKey } from "./keys.ts";
import { descriptorOf, providerLabel } from "./links.ts";
import { postOnlyAction, type Sujet } from "./sujet.ts";
import { isResolved, resolveTarget, toolLabel } from "./targets.ts";
import { sendsUnseenMessage, type Task, taskDraftText } from "./tasks.ts";

/**
 * What one Go approves: actions through one account. The type allows several, carried out in order, but until ordered
 * execution exists the gate refuses a plan of more than one action (`planRefusal`): what is hashed, logged and recorded
 * is always exactly what went out.
 */
export interface ActionPlan {
  provider: string;
  account: string;
  actions: Action[];
}

/** Who gave the Go: a click on the board, or the master (a later stage). */
export type ActOrigin = "board" | "master";

/** A write on its way out, written on the task before the provider is called: a second Go meanwhile is refused. */
export interface InFlight {
  at: string;
  by: ActOrigin;
  sha: string;
  attempt: number;
}

/** A write whose outcome is unknown (a timeout, a process that died mid-act): never retried without the person. */
export interface UnknownOutcome {
  at: string;
  sha: string;
  attempt: number;
  /** Where to check whether it went out. */
  link?: string;
}

/** What went out, frozen on the task: the hash in the event log can always be checked against the content it names. */
export interface SentRecord {
  plan: ActionPlan;
  sha: string;
  at: string;
  by: ActOrigin;
  ref: string;
  link: string;
  /** How to take it back, until when (ms), and which action it takes back. */
  undo?: { token: string; until: number; kind: ActionKind };
  /**
   * The topic's fields before the act, put back by an Undo. Not its status: reopening the task settles it from the
   * tasks (`reopenTask`). A record written by an earlier version may still carry a `status`, ignored.
   */
  restore?: { waiting: string; posted?: string };
}

/** Why the gate refuses; the board maps the code to an HTTP status. */
export type RefusalCode = "shadow" | "plan" | "missing" | "topic" | "task" | "sent" | "empty" | "target" | "tool" | "capability" | "tooLong" | "notPostOnly" | "unseen" | "sha" | "busy" | "unknown" | "nothingToUndo";

export interface Refusal {
  code: RefusalCode;
  message: string;
}

const refuse = (code: RefusalCode, message: string): Refusal => ({ code, message });

/** A provider call that has not answered within this time is read as an unknown outcome. */
export const ACT_TIMEOUT_MS = 30_000;
/** An in-flight marker older than this (the act timeout plus two minutes) was left by a process that died: unknown. */
export const IN_FLIGHT_STALE_MS = ACT_TIMEOUT_MS + 120_000;

// ------------------------------------------------------------------ plans

/** The text action a target takes: a reply in a thread, a separate message in a conversation, a comment elsewhere. */
export function textKind(target: Target): "reply" | "post" | "comment" {
  return target.scope === "thread" ? "reply" : target.scope === "conversation" ? "post" : "comment";
}

const normalizeText = (text: string) => text.replace(/\r\n/g, "\n").trim();

/**
 * The plan a draft task carries out: its text (the person's own edit when given), to its target as the provider
 * resolved it. The same resolution the board shows (core/targets.ts).
 */
export function planOfTask(s: Pick<Sujet, "key" | "channel" | "conversation">, x: Pick<Task, "kind" | "draft" | "action" | "draftTo" | "to">, edited: string | null = null): { plan: ActionPlan } | Refusal {
  const text = normalizeText(edited ?? taskDraftText(x));
  if (!text) return refuse("empty", t("board.api.draftEmpty"));
  const dest = resolveTarget(s, x);
  if (!isResolved(dest)) return refuse(dest.noTool ? "tool" : "target", dest.error);
  const target = { scope: dest.target.scope, native: dest.target.native, label: dest.target.label };
  return { plan: { provider: dest.provider, account: dest.account, actions: [{ kind: textKind(target), target, text }] } };
}

/**
 * The plan of the board's check mark: the tool's marker of a settled thread on the topic's first item. The click is
 * the Go on this plan.
 */
export function donePlan(s: Pick<Sujet, "key" | "channel">): { plan: ActionPlan } | Refusal {
  const p = parseKey(s.key);
  if (!p || p.long) return refuse("target", t("target.notAKey", { to: s.key }));
  const done = descriptorOf(p.provider)?.done;
  if (!done) return refuse("capability", t("gate.notDone", { tool: toolLabel(p.provider, p.account) }));
  return { plan: { provider: p.provider, account: p.account, actions: [{ kind: done.kind, target: { scope: "item", native: p.native, label: s.channel }, emoji: done.emoji }] } };
}

// ------------------------------------------------------------------ canonical content and hash

/** JSON with sorted keys, without undefined fields: one text for one content, whatever the order it was built in. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * The content a Go covers: the account, then each action with its kind, its target (scope and native id), its audience,
 * subject and fields, and every payload field, texts normalized. A target's label and link are words for the person,
 * derived from the same native id: they are not part of what goes out.
 */
export function canonicalContent(plan: ActionPlan): string {
  const actions = plan.actions.map((a) => {
    const { target, ...rest } = a;
    const payload = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, typeof v === "string" && (k === "text" || k === "title") ? normalizeText(v) : v]));
    return { ...payload, target: { scope: target.scope, native: target.native } };
  });
  return canonicalJson({ account: `${plan.provider}${plan.account === "default" ? "" : `@${plan.account}`}`, actions });
}

/** The SHA-256 of the canonical content, 64 hex characters: what the board sends back, 12 of them in the event log. */
export const planSha = (plan: ActionPlan): string => createHash("sha256").update(canonicalContent(plan)).digest("hex");

/** A hash given with a Go: at least 12 hex characters, a prefix of the content's hash. */
export const shaMatches = (given: string, actual: string): boolean => /^[0-9a-f]{12,64}$/.test(given) && actual.startsWith(given);

/** The key a provider that honors idempotency uses: a replay of the same Go cannot write twice. */
export const idempotencyKey = (topic: string, task: string, sha: string, attempt: number) => `${topic}#${task}#${sha.slice(0, 12)}#${attempt}`;

// ------------------------------------------------------------------ decisions

/** The task's write is on its way out now: a marker younger than the stale limit. */
export const inFlightLive = (x: Pick<Task, "inFlight">, now: number): boolean => !!x.inFlight && now - Date.parse(x.inFlight.at) < IN_FLIGHT_STALE_MS;

/** The task's last write may have gone out: an unknown outcome, or an in-flight marker left by a process that died. */
export function unknownOf(x: Pick<Task, "inFlight" | "unknown">, now: number): UnknownOutcome | null {
  if (x.unknown) return x.unknown;
  if (x.inFlight && !inFlightLive(x, now)) return { at: x.inFlight.at, sha: x.inFlight.sha, attempt: x.inFlight.attempt };
  return null;
}

/** What the gate knows of the account a plan goes through. */
export interface GateAccount {
  /** Configured in the profile and served by a provider Strato runs. */
  usable: boolean;
  /** The action kinds this account can carry out (the descriptor's, minus what its auth method cannot do). */
  actions: ActionKind[];
  descriptor: Pick<ProviderDescriptor, "maxText" | "audience"> | null;
}

/**
 * Steps 1 to 7 of the act path (section 8.2), in this order: shadow mode; the topic and the task; a plan never carries
 * a message the person has not read, nor more than a post; the plan, the account and what it can do; the exact content
 * the Go was given on (`sha`, the hash of `shown`, the task's plan as the board showed it; `plan` differs from it only
 * by the person's own edit of the text); no write of this task already on its way, nor one that may have gone out
 * unless the person asks to send again.
 */
export function taskRefusal(input: {
  shadow: boolean;
  topic: Sujet | undefined;
  task: Task | undefined;
  taskId: string;
  shown: { plan: ActionPlan } | Refusal;
  plan: { plan: ActionPlan } | Refusal;
  account: GateAccount;
  sha: string;
  retry: boolean;
  now: number;
}): Refusal | null {
  const { topic, task, plan, account } = input;
  if (input.shadow) return refuse("shadow", t("gate.shadow"));
  if (!topic) return refuse("missing", t("board.api.topicMissing"));
  if (topic.status === "closed") return refuse("topic", t("board.api.topicClosed", { letter: topic.letter }));
  if (!task) return refuse("missing", t("board.api.taskMissing", { id: input.taskId }));
  if (task.sent) return refuse("sent", t("gate.sent", { id: task.id }));
  if (task.status !== "open") return refuse("task", t("board.api.taskClosed", { id: task.id }));
  if ("code" in plan && plan.code === "empty") return plan;
  // the action does more than post (merge then post…): the session carries it out, in order
  if (!postOnlyAction(task)) return refuse("notPostOnly", t("board.api.notPostOnly"));
  if (sendsUnseenMessage(task)) return refuse("unseen", t("board.api.textsMissing", { id: task.id }));
  if ("code" in plan) return plan;
  const accountRefusal = planRefusal(plan.plan, account);
  if (accountRefusal) return accountRefusal;
  if (!("plan" in input.shown) || !shaMatches(input.sha, planSha(input.shown.plan))) return refuse("sha", t("board.api.draftChanged"));
  if (inFlightLive(task, input.now)) return refuse("busy", t("gate.sending", { id: task.id }));
  const unknown = unknownOf(task, input.now);
  if (unknown && !input.retry) return refuse("unknown", t("gate.mayHaveGone", { id: task.id, link: unknown.link ?? topic.permalink }));
  return null;
}

/** The plan is one action, and the account can carry it out, with the audience its tool requires and within its length. */
export function planRefusal(plan: ActionPlan, account: GateAccount): Refusal | null {
  const tool = toolLabel(plan.provider, plan.account);
  if (!account.usable || !account.descriptor) return refuse("tool", t("gate.noTool", { tool }));
  if (plan.actions.length !== 1) return refuse("plan", t("gate.oneAction", { n: plan.actions.length }));
  const missing = plan.actions.map((a) => a.kind).filter((k) => !account.actions.includes(k));
  if (missing.length) return refuse("capability", t("gate.cannot", { tool, kinds: missing.join(", ") }));
  for (const a of plan.actions) {
    if (a.kind === "post" || a.kind === "reply" || a.kind === "comment") {
      if (!a.text.trim()) return refuse("empty", t("gate.textMissing", { kind: a.kind }));
      const max = account.descriptor.maxText;
      if (max !== undefined && a.text.length > max) return refuse("tooLong", t("board.api.draftTooLong", { tool: providerLabel(plan.provider), n: a.text.length }));
      // every audience field the tool declares for this kind is part of what the person sees, and required
      const spec = account.descriptor.audience?.[a.kind];
      const audience = a.audience ?? {};
      if (spec && ((spec.to && !audience.to?.length) || (spec.visibility && !audience.visibility))) return refuse("target", t("gate.noAudience", { tool, kind: a.kind }));
    }
  }
  return null;
}
