/**
 * The single act path (docs/design/providers.md, section 8.2): the only module that calls a provider's `act` and
 * `undo`. Each write runs the gate (core/gate.ts) on the state read under the lock, marks the task in flight, calls the
 * provider outside the lock, then writes the result on the topic reread under the lock, and logs every attempt in
 * events.ndjson (`act`, `act-refused`, `act-undo`), with the hash of the content, never the text.
 */
import { ACT_TIMEOUT_MS, type ActionPlan, type ActOrigin, donePlan, type GateAccount, idempotencyKey, type InFlight, planOfTask, planRefusal, planSha, type Refusal, type SentRecord, taskRefusal, unknownOf } from "../core/gate.ts";
import { t } from "../core/i18n.ts";
import { checkedLink, descriptorOf, linkOfNative } from "../core/links.ts";
import { findSujet, type Sujet } from "../core/sujet.ts";
import { toolLabel } from "../core/targets.ts";
import { closeTask, findTask, reopenTask, type Task, tasksOf } from "../core/tasks.ts";
import { authUsable, effectiveCapabilities, providerError } from "../providers/api.ts";
import { accountContext, accountOf, actorOf, type AccountEntry } from "../providers/registry.ts";
import type { ActResult, ProviderError } from "../providers/sdk.ts";
import { nowIso, shadowNow } from "./env.ts";
import { loadSujets, logEvent, updateSujet } from "./store.ts";

/** What an act came to: done, refused by the gate, or failed at the provider. */
export type ActOutcome =
  | { ok: true; sent: SentRecord; topic: Sujet | null }
  | { ok: false; refused: Refusal }
  | { ok: false; failed: ProviderError; tool: string; link: string | null };

/** What the gate knows of the account a plan goes through, from the registry. */
function gateAccount(plan: ActionPlan | null): { entry: AccountEntry | null; account: GateAccount } {
  const entry = plan ? accountOf(plan.provider, plan.account) : null;
  // a provider that declares actions without implementing them acts on nothing, nor does a links-only account
  const usable = !!entry?.provider && !entry.problem && authUsable(entry.provider.descriptor, entry.account.auth) && !!(entry && actorOf(entry)?.act);
  return {
    entry,
    account: {
      usable,
      actions: usable && entry?.provider ? effectiveCapabilities(entry.provider.descriptor, entry.account.auth).actions : [],
      descriptor: entry?.provider?.descriptor ?? null,
    },
  };
}

const short = (sha: string) => sha.slice(0, 12);
const kindsOf = (plan: ActionPlan) => plan.actions.map((a) => a.kind);
const accountName = (plan: ActionPlan) => `${plan.provider}${plan.account === "default" ? "" : `@${plan.account}`}`;

function logRefusal(by: ActOrigin, key: string, task: string | null, r: Refusal, sha?: string): void {
  logEvent({ type: "act-refused", by, key, task, reason: r.code, ...(sha ? { sha: short(sha) } : {}) });
}

/**
 * A Go the caller refuses before the gate runs (the board: the page that sent it no longer shows what is on disk):
 * logged like the gate's own refusals, so that every refused Go is in the event log.
 */
export function refuseAct(req: { key: string; taskId: string | null; by: ActOrigin; sha?: string }, r: Refusal): ActOutcome {
  logRefusal(req.by, req.key, req.taskId, r, req.sha);
  return { ok: false, refused: r };
}

/** Rewrites one task of a topic. */
function patchTask(s: Sujet, id: string, fn: (x: Task) => Task): Sujet {
  return { ...s, tasks: tasksOf(s).map((x) => (x.id === id ? fn(x) : x)) };
}

/** The task without the gate's markers of a write on its way. */
function settled(x: Task): Task {
  const { inFlight: _f, unknown: _u, ...rest } = x;
  return rest;
}

/**
 * The provider call, bounded: past `ACT_TIMEOUT_MS` the write may still happen, so the outcome is unknown. Anything the
 * provider throws is read as an error that may have written.
 */
async function call(run: () => Promise<ActResult>): Promise<ActResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ActResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: { code: "timeout", message: `no answer after ${ACT_TIMEOUT_MS / 1000} s`, retryable: true, fatal: false, outcome: "unknown" } }), ACT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([run().catch((e) => ({ ok: false as const, error: providerError(e, "write") })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The longest undo token Strato keeps: it is stored on the topic and sent back to the provider as is. */
const UNDO_TOKEN_MAX = 1024;

/**
 * A provider's answer read defensively: a provider that breaks its contract never counts as a success. A success is
 * then cleaned for what Strato does with it: its link must be an https link on the tool's hosts (else the plan's own
 * thread link, else none), since it reaches the topic, the task's note and the session; an undo is kept only with a
 * string token of at most 1 KiB and a finite deadline, cut to the tool's declared window.
 */
export function checkedResult(r: unknown, plan: ActionPlan): ActResult {
  const x = r as Partial<ActResult> | null;
  if (x && x.ok === true && typeof (x as { ref?: unknown }).ref === "string" && typeof (x as { link?: unknown }).link === "string") {
    const ok = x as Extract<ActResult, { ok: true }>;
    const link = checkedLink(ok.link, plan.provider) ?? planLink(plan) ?? "";
    const undoMs = descriptorOf(plan.provider)?.undoMs;
    const u = ok.undo as { token?: unknown; until?: unknown } | undefined;
    const undo =
      u && typeof u.token === "string" && u.token.length <= UNDO_TOKEN_MAX && typeof u.until === "number" && Number.isFinite(u.until) && typeof undoMs === "number"
        ? { token: u.token, until: Math.min(u.until, Date.now() + undoMs) }
        : null;
    const { undo: _u, ...rest } = ok;
    return { ...rest, ref: ok.ref.slice(0, UNDO_TOKEN_MAX), link, ...(undo ? { undo } : {}) };
  }
  if (x && x.ok === false && x.error && typeof x.error.code === "string") return { ok: false, error: providerError(x.error, "write") };
  return { ok: false, error: { code: "internal", message: "the provider answered something that is not a result", retryable: false, fatal: false, outcome: "unknown" } };
}

/**
 * Carries out a draft task on a Go: the plan built from the task on disk (with the person's own edit of the text, when
 * there is one) must hash to `sha`, the hash of the content the person was shown. `retry`: the person was told the
 * last attempt may have gone out, checked, and sends again. `after` adds what the caller writes with the result, in
 * the same locked write (the board: the note to the session, the topic's `posted`).
 */
export async function actOnTask(req: { key: string; taskId: string; sha: string; by: ActOrigin; edited?: string | null; retry?: boolean; after?: (s: Sujet, sent: SentRecord) => Sujet }): Promise<ActOutcome> {
  const shadow = shadowNow();
  const now = Date.now();
  let prepared: { plan: ActionPlan; sha: string; attempt: number; entry: AccountEntry } | null = null;
  let refused: Refusal | null = null;
  // shadow mode refuses before anything is read or written
  if (shadow) refused = { code: "shadow", message: t("gate.shadow") };
  else
    await updateSujet(req.key, (s) => {
      const task = findTask(s, req.taskId);
      // the Go covers the content shown: the task as it is on disk; what goes out differs only by the person's own edit
      const missing: Refusal = { code: "missing", message: t("board.api.taskMissing", { id: req.taskId }) };
      const shown = task ? planOfTask(s, task) : missing;
      const plan = task ? planOfTask(s, task, req.edited ?? null) : missing;
      const { entry, account } = gateAccount("plan" in plan ? plan.plan : null);
      refused = taskRefusal({ shadow, topic: s, task, taskId: req.taskId, shown, plan, account, sha: req.sha, retry: !!req.retry, now });
      if (refused || !task || !("plan" in plan) || !entry) return null;
      const attempt = task.attempt ?? 1;
      const sha = planSha(plan.plan);
      prepared = { plan: plan.plan, sha, attempt, entry };
      const inFlight: InFlight = { at: nowIso(), by: req.by, sha, attempt };
      return patchTask(s, task.id, (x) => ({ ...settled(x), inFlight }));
    });
  const p = prepared as { plan: ActionPlan; sha: string; attempt: number; entry: AccountEntry } | null;
  if (!p) {
    const r = (refused ?? { code: "missing", message: t("board.api.topicMissing") }) as Refusal;
    logRefusal(req.by, req.key, req.taskId, r, req.sha);
    return { ok: false, refused: r };
  }
  const actor = actorOf(p.entry);
  const ctx = accountContext(p.entry);
  const action = p.plan.actions[0];
  const result = actor?.act ? checkedResult(await call(() => (actor.act as NonNullable<typeof actor.act>)(ctx, { action, idempotencyKey: idempotencyKey(req.key, req.taskId, p.sha, p.attempt), dryRun: false })), p.plan) : { ok: false as const, error: { code: "unsupported", message: "no act", retryable: false, fatal: true, outcome: "none" as const } };
  const tool = toolLabel(p.plan.provider, p.plan.account);
  const at = nowIso();
  const base = { type: "act", by: req.by, key: req.key, task: req.taskId, account: accountName(p.plan), kinds: kindsOf(p.plan), sha: short(p.sha), attempt: p.attempt };
  if (result.ok) {
    const sent: SentRecord = { plan: p.plan, sha: p.sha, at, by: req.by, ref: result.ref, link: result.link, ...(result.undo ? { undo: { ...result.undo, kind: action.kind } } : {}) };
    const topic = await updateSujet(req.key, (s) => {
      const restore = { waiting: s.waiting, ...(s.posted !== undefined ? { posted: s.posted } : {}) };
      let next = patchTask(s, req.taskId, (x) => ({ ...settled(x), sent: { ...sent, restore } }));
      // the task may have been closed meanwhile (the session, another tab): the message is out, the record stays
      if (findTask(next, req.taskId)?.status === "open") next = closeTask(next, req.taskId, "done", at, t("task.note.posted", { permalink: result.link }));
      return req.after ? req.after(next, sent) : next;
    });
    logEvent({ ...base, ok: true, link: result.link });
    return { ok: true, sent, topic };
  }
  const error = result.error;
  const unknown = error.outcome === "unknown";
  const link = unknown ? (planLink(p.plan) ?? null) : null;
  await updateSujet(req.key, (s) =>
    patchTask(s, req.taskId, (x) => (unknown ? { ...settled(x), unknown: { at, sha: p.sha, attempt: p.attempt, ...(link ? { link } : {}) } } : { ...settled(x), attempt: p.attempt + 1 })),
  );
  logEvent({ ...base, ok: false, error: error.code, outcome: error.outcome ?? "none" });
  return { ok: false, failed: error, tool, link };
}

/**
 * A dry run of a draft or action task through the same gate, for the conformance harness: every check of a real Go
 * (shadow mode first), then the provider's `act` with `dryRun: true`, which validates and describes without writing.
 * Nothing on the topic changes; the attempt is logged as `act-dry`.
 */
export async function dryRunTask(req: { key: string; taskId: string; sha: string; by: ActOrigin }): Promise<{ ok: true; result: Extract<ActResult, { ok: true }> } | { ok: false; refused: Refusal } | { ok: false; failed: ProviderError }> {
  const shadow = shadowNow();
  const s = findSujet(loadSujets(), req.key);
  const task = s ? findTask(s, req.taskId) : undefined;
  const missing: Refusal = { code: "missing", message: t("board.api.taskMissing", { id: req.taskId }) };
  const plan = s && task ? planOfTask(s, task) : missing;
  const { entry, account } = gateAccount("plan" in plan ? plan.plan : null);
  const refused = taskRefusal({ shadow, topic: s, task, taskId: req.taskId, shown: plan, plan, account, sha: req.sha, retry: false, now: Date.now() });
  if (refused || !("plan" in plan) || !entry) {
    const r = refused ?? missing;
    logRefusal(req.by, req.key, req.taskId, r, req.sha);
    return { ok: false, refused: r };
  }
  const sha = planSha(plan.plan);
  const actor = actorOf(entry);
  const result = actor?.act ? checkedResult(await call(() => (actor.act as NonNullable<typeof actor.act>)(accountContext(entry), { action: plan.plan.actions[0], idempotencyKey: idempotencyKey(req.key, req.taskId, sha, task?.attempt ?? 1), dryRun: true })), plan.plan) : { ok: false as const, error: { code: "unsupported", message: "no act", retryable: false, fatal: true, outcome: "none" as const } };
  logEvent({ type: "act-dry", by: req.by, key: req.key, task: req.taskId, account: accountName(plan.plan), kinds: kindsOf(plan.plan), sha: short(sha), ok: result.ok, ...(result.ok ? {} : { error: result.error.code }) });
  return result.ok ? { ok: true, result } : { ok: false, failed: result.error };
}

/** Where to check a plan's first action: the thread or conversation it targets. */
function planLink(plan: ActionPlan): string | null {
  const a = plan.actions[0];
  return a ? (a.target.link ?? linkOfNative(plan.provider, plan.account, a.target.native)) : null;
}

/**
 * The board's check mark: the tool's marker of a settled thread (Slack: ✅ on the first message), on the click that is
 * the Go on it. `after` writes the topic's mark in the same locked write.
 */
export async function actDone(req: { key: string; by: ActOrigin; after?: (s: Sujet) => Sujet }): Promise<ActOutcome> {
  const s = findSujet(loadSujets(), req.key);
  const shadow = shadowNow();
  const plan = s ? donePlan(s) : ({ code: "missing", message: t("board.api.topicMissing") } as Refusal);
  const { entry, account } = gateAccount("plan" in plan ? plan.plan : null);
  const refused: Refusal | null = shadow ? { code: "shadow", message: t("gate.shadow") } : "code" in plan ? plan : planRefusal(plan.plan, account);
  if (refused || !("plan" in plan) || !entry) {
    const r = refused ?? { code: "tool", message: t("gate.noTool", { tool: req.key }) };
    logRefusal(req.by, req.key, null, r);
    return { ok: false, refused: r };
  }
  const sha = planSha(plan.plan);
  const actor = actorOf(entry);
  const action = plan.plan.actions[0];
  const result = actor?.act ? checkedResult(await call(() => (actor.act as NonNullable<typeof actor.act>)(accountContext(entry), { action, idempotencyKey: idempotencyKey(req.key, "done", sha, 1), dryRun: false })), plan.plan) : { ok: false as const, error: { code: "unsupported", message: "no act", retryable: false, fatal: true, outcome: "none" as const } };
  const base = { type: "act", by: req.by, key: req.key, task: null, account: accountName(plan.plan), kinds: kindsOf(plan.plan), sha: short(sha), attempt: 1 };
  if (!result.ok) {
    logEvent({ ...base, ok: false, error: result.error.code, outcome: result.error.outcome ?? "none" });
    return { ok: false, failed: result.error, tool: toolLabel(plan.plan.provider, plan.plan.account), link: null };
  }
  const sent: SentRecord = { plan: plan.plan, sha, at: nowIso(), by: req.by, ref: result.ref, link: result.link };
  const topic = req.after ? await updateSujet(req.key, (x) => (req.after as (s: Sujet) => Sujet)(x)) : null;
  logEvent({ ...base, ok: true, link: result.link });
  return { ok: true, sent, topic };
}

/**
 * Undo of a task's write within the provider's window: the click is the person's Go on taking it back. On success the
 * task reopens without its sent record, its attempt grows (a resend gets a new idempotency key), the topic's `waiting`
 * and `posted` come back as they were before the act, and its status is settled again from its tasks (`reopenTask`);
 * `after` adds the caller's own changes in the same write.
 */
export async function undoTask(req: { key: string; taskId: string; by: ActOrigin; after?: (s: Sujet) => Sujet }): Promise<ActOutcome> {
  const shadow = shadowNow();
  let claimed: { sent: SentRecord & { undo: NonNullable<SentRecord["undo"]> }; entry: AccountEntry } | null = null;
  let refused: Refusal | null = shadow ? { code: "shadow", message: t("gate.shadow") } : null;
  if (!refused)
    await updateSujet(req.key, (s) => {
      const x = findTask(s, req.taskId);
      const sent = x?.sent;
      if (!x || !sent?.undo || sent.undo.until <= Date.now()) {
        refused = { code: "nothingToUndo", message: t("board.api.nothingToUndo") };
        return null;
      }
      const entry = accountOf(sent.plan.provider, sent.plan.account);
      const caps = entry?.provider && !entry.problem ? effectiveCapabilities(entry.provider.descriptor, entry.account.auth) : null;
      if (!entry || !caps?.undo.includes(sent.undo.kind)) {
        refused = { code: "capability", message: t("gate.noUndo", { tool: toolLabel(sent.plan.provider, sent.plan.account) }) };
        return null;
      }
      claimed = { sent: sent as SentRecord & { undo: NonNullable<SentRecord["undo"]> }, entry };
      // claimed under the lock: a second click meanwhile finds nothing left to undo
      const { undo: _u, ...rest } = sent;
      return patchTask(s, x.id, (y) => ({ ...y, sent: rest }));
    });
  const c = claimed as { sent: SentRecord & { undo: NonNullable<SentRecord["undo"]> }; entry: AccountEntry } | null;
  if (!c) {
    const r = (refused ?? { code: "missing", message: t("board.api.topicMissing") }) as Refusal;
    logRefusal(req.by, req.key, req.taskId, r);
    return { ok: false, refused: r };
  }
  const actor = actorOf(c.entry);
  const result = actor?.undo ? checkedResult(await call(() => (actor.undo as NonNullable<typeof actor.undo>)(accountContext(c.entry), c.sent.undo.token)), c.sent.plan) : { ok: false as const, error: { code: "unsupported", message: "no undo", retryable: false, fatal: true, outcome: "none" as const } };
  const base = { type: "act-undo", by: req.by, key: req.key, task: req.taskId, account: accountName(c.sent.plan), sha: short(c.sent.sha) };
  if (!result.ok) {
    logEvent({ ...base, ok: false, error: result.error.code });
    return { ok: false, failed: result.error, tool: toolLabel(c.sent.plan.provider, c.sent.plan.account), link: c.sent.link };
  }
  const at = nowIso();
  const topic = await updateSujet(req.key, (s) => {
    const x = findTask(s, req.taskId);
    if (!x) return null;
    const restore = c.sent.restore;
    let next: Sujet = restore ? { ...s, waiting: restore.waiting, posted: restore.posted } : s;
    next = patchTask(next, x.id, (y) => {
      const { sent: _s, ...rest } = settled(y);
      return { ...rest, attempt: (y.attempt ?? 1) + 1 };
    });
    next = findTask(next, x.id)?.status === "open" ? next : reopenTask(next, x.id, at);
    return req.after ? req.after(next) : next;
  });
  logEvent({ ...base, ok: true });
  return { ok: true, sent: c.sent, topic };
}

/** The task's last write may have gone out (for the board: Send then says "Send again"). */
export const mayHaveGone = (x: Task): boolean => unknownOf(x, Date.now()) !== null;
