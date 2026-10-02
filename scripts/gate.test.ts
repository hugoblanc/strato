/**
 * The gate, pure side (core/gate.ts): the plan a Go approves, its canonical content and hash, and the refusals taken
 * before any provider is called (shadow mode, an unknown tool, content changed since the Go, a write already on its
 * way or that may have gone out, a tool that cannot do it).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type ActionPlan, canonicalContent, donePlan, type GateAccount, IN_FLIGHT_STALE_MS, planOfTask, planRefusal, planSha, type Refusal, resolveSettings, shaMatches, type Sujet, type Task, taskRefusal, unknownOf, useProviders, useSettings } from "./lib.ts";
import { BUILTIN_PURE } from "./providers/builtin.ts";
import { SLACK_DESCRIPTOR } from "./providers/slack/model.ts";
import { TEST_SETTINGS } from "./test-setup.ts";

afterEach(() => {
  useSettings(TEST_SETTINGS);
  useProviders([...BUILTIN_PURE]);
});

const KEY = "C0ACMEREQ01:1790000000.000100";
const LINK = "https://acme.slack.com/archives/C0ACMEREQ01/p1790000000000100";
const T = "2026-09-30T08:00:00Z";
const task = (o: Partial<Task> = {}): Task => ({ id: "t1", kind: "draft", ask: "Bob asks", proposal: "", action: "post the draft", draft: "Tomorrow 10:00.", draftTo: `#acme-requests, ${LINK}`, createdAt: T, updatedAt: T, status: "open", origin: "task", ...o });
const topic = (o: Partial<Sujet> = {}): Sujet => ({ key: KEY, threads: [KEY], letter: "A", title: "Deploy", channel: "#acme-requests", permalink: LINK, asker: "Bob", sessionId: null, shortId: null, name: "A", status: "gate", gate: "draft", waiting: "", next: "", summary: "", createdAt: T, updatedAt: T, history: [], tasks: [task()], ...o });
const SLACK: GateAccount = { usable: true, actions: SLACK_DESCRIPTOR.capabilities.actions, descriptor: SLACK_DESCRIPTOR };
const planOf = (s: Sujet, x: Task, edited: string | null = null) => {
  const p = planOfTask(s, x, edited);
  if (!("plan" in p)) throw new Error(p.message);
  return p.plan;
};
const refusal = (o: Partial<Parameters<typeof taskRefusal>[0]> = {}): Refusal | null => {
  const s = topic();
  const x = task();
  const plan = planOfTask(s, x);
  return taskRefusal({ shadow: false, topic: s, task: x, taskId: "t1", shown: plan, plan, account: SLACK, sha: "plan" in plan ? planSha(plan.plan) : "", retry: false, now: Date.parse(T), ...o });
};

describe("the plan of a draft task", () => {
  test("a reply in the thread the destination names, with the draft's text", () => {
    expect(planOf(topic(), task())).toEqual({ provider: "slack", account: "default", actions: [{ kind: "reply", target: { scope: "thread", native: KEY, label: "#acme-requests" }, text: "Tomorrow 10:00." }] });
    expect(planOf(topic(), task({ draftTo: "#acme-announcements (C0ACMEANN01), new message" })).actions[0]).toMatchObject({ kind: "post", target: { scope: "conversation", native: "C0ACMEANN01" } });
    expect(planOf(topic(), task({ to: "slack:C0ACMEANN01" })).actions[0]).toMatchObject({ kind: "post", target: { native: "C0ACMEANN01" } });
    expect(planOf(topic(), task(), "My own words.").actions[0]).toMatchObject({ text: "My own words." });
  });

  test("an empty draft, a destination that cannot be posted to, or a tool not connected: why", () => {
    expect(planOfTask(topic(), task({ draft: "  ", action: "" }))).toMatchObject({ code: "empty" });
    expect(planOfTask(topic(), task({ draftTo: "#acme-support" }))).toMatchObject({ code: "target" });
    expect(planOfTask(topic(), task({ to: "tickets:PLAT-12" }))).toMatchObject({ code: "tool" });
    expect(planOfTask(topic({ key: "jira:X-1" }), task({ draftTo: "" }))).toMatchObject({ code: "target" });
  });

  test("the check mark: the tool's marker of a settled thread, on the topic's first item", () => {
    expect(donePlan(topic())).toEqual({ plan: { provider: "slack", account: "default", actions: [{ kind: "react", target: { scope: "item", native: KEY, label: "#acme-requests" }, emoji: "white_check_mark" }] } });
    expect(donePlan(topic({ key: "linear:ENG-12" }))).toMatchObject({ code: "capability" });
  });
});

describe("canonical content and hash", () => {
  const plan = (): ActionPlan => ({ provider: "slack", account: "default", actions: [{ kind: "reply", target: { scope: "thread", native: KEY, label: "#acme-requests" }, text: "Hi\r\nthere  " }] });

  test("one content, one text: key order, labels and line endings do not count; account, target and text do", () => {
    const a = plan();
    const reordered = { actions: [{ text: "Hi\nthere", target: { native: KEY, scope: "thread" as const, label: "another label", link: "https://x" }, kind: "reply" as const }], account: "default", provider: "slack" };
    expect(canonicalContent(reordered)).toBe(canonicalContent(a));
    expect(canonicalContent(a)).toBe(`{"account":"slack","actions":[{"kind":"reply","target":{"native":"${KEY}","scope":"thread"},"text":"Hi\\nthere"}]}`);
    expect(planSha(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(planSha({ ...a, account: "partners" })).not.toBe(planSha(a));
    expect(planSha({ ...a, actions: [{ ...a.actions[0], target: { scope: "thread", native: "C0ACMEREQ01:1790000099.000100", label: "#acme-requests" } }] })).not.toBe(planSha(a));
    expect(planSha({ ...a, actions: [{ kind: "reply", target: a.actions[0].target, text: "Hi there" }] })).not.toBe(planSha(a));
  });

  test("a hash given with a Go: 12 hex characters at least, a prefix of the content's", () => {
    const sha = planSha(plan());
    expect(shaMatches(sha, sha)).toBe(true);
    expect(shaMatches(sha.slice(0, 12), sha)).toBe(true);
    expect(shaMatches(sha.slice(0, 11), sha)).toBe(false);
    expect(shaMatches("", sha)).toBe(false);
    expect(shaMatches(`${sha.slice(0, 63)}0`.replace(/.$/, sha.endsWith("0") ? "1" : "0"), sha)).toBe(false);
  });
});

describe("refusals before any provider call", () => {
  test("a Go on the content shown passes", () => {
    expect(refusal()).toBeNull();
  });

  test("shadow mode refuses everything, first", () => {
    expect(refusal({ shadow: true })).toMatchObject({ code: "shadow" });
    expect(refusal({ shadow: true, topic: undefined, sha: "" })).toMatchObject({ code: "shadow" });
  });

  test("an unknown tool, or one that cannot do it, is refused", () => {
    const plan = planOfTask(topic(), task({ to: "tickets:PLAT-12" }));
    expect(refusal({ plan, shown: plan })).toMatchObject({ code: "tool" });
    expect(refusal({ account: { ...SLACK, usable: false } })).toMatchObject({ code: "tool" });
    expect(refusal({ account: { ...SLACK, actions: ["react"] } })).toMatchObject({ code: "capability" });
  });

  test("content changed since the Go: the hash of what was shown no longer matches", () => {
    const before = planOf(topic(), task());
    const after = planOfTask(topic(), task({ draft: "Tomorrow 11:00." }));
    expect(refusal({ shown: after, plan: after, sha: planSha(before) })).toMatchObject({ code: "sha" });
    const moved = planOfTask(topic(), task({ to: "C0ACMEREQ01:1790000099.000100" }));
    expect(refusal({ shown: moved, plan: moved, sha: planSha(before) })).toMatchObject({ code: "sha" });
    // the person's own edit of the text is theirs: the Go covers the destination and the draft shown
    expect(refusal({ plan: planOfTask(topic(), task(), "My own words."), sha: planSha(before) })).toBeNull();
    expect(refusal({ sha: "" })).toMatchObject({ code: "sha" });
  });

  test("a closed topic or task, a task already sent, more than a post, words never shown", () => {
    expect(refusal({ topic: undefined })).toMatchObject({ code: "missing" });
    expect(refusal({ topic: topic({ status: "closed" }) })).toMatchObject({ code: "topic" });
    expect(refusal({ task: undefined })).toMatchObject({ code: "missing" });
    expect(refusal({ task: task({ status: "done" }) })).toMatchObject({ code: "task" });
    expect(refusal({ task: task({ sent: { plan: planOf(topic(), task()), sha: "x", at: T, by: "board", ref: "r", link: LINK } }) })).toMatchObject({ code: "sent" });
    expect(refusal({ task: task({ action: "merge api!12 then post the draft" }) })).toMatchObject({ code: "notPostOnly" });
  });

  test("too long for the tool, an audience the tool requires and the plan does not carry", () => {
    const long = planOfTask(topic(), task(), "x".repeat(4000));
    expect(refusal({ plan: long })).toMatchObject({ code: "tooLong" });
    const plan = planOf(topic(), task());
    expect(planRefusal(plan, { ...SLACK, descriptor: { ...SLACK_DESCRIPTOR, audience: { reply: { visibility: { default: "internal" } } } } })).toMatchObject({ code: "target" });
  });

  test("a plan of more than one action, or of none, is refused: only what goes out is hashed and logged", () => {
    const plan = planOf(topic(), task());
    expect(planRefusal({ ...plan, actions: [...plan.actions, plan.actions[0]] }, SLACK)).toMatchObject({ code: "plan" });
    expect(planRefusal({ ...plan, actions: [] }, SLACK)).toMatchObject({ code: "plan" });
    expect(planRefusal(plan, SLACK)).toBeNull();
  });

  test("a write on its way refuses a second Go; past the stale limit it may have gone out, and only a retry sends again", () => {
    const at = Date.parse(T);
    const inFlight = { at: T, by: "board" as const, sha: "x", attempt: 1 };
    expect(refusal({ task: task({ inFlight }), now: at + 1000 })).toMatchObject({ code: "busy" });
    expect(unknownOf({ inFlight }, at + 1000)).toBeNull();
    expect(unknownOf({ inFlight }, at + IN_FLIGHT_STALE_MS + 1)).toEqual({ at: T, sha: "x", attempt: 1 });
    expect(refusal({ task: task({ inFlight }), now: at + IN_FLIGHT_STALE_MS + 1 })).toMatchObject({ code: "unknown" });
    expect(refusal({ task: task({ inFlight }), now: at + IN_FLIGHT_STALE_MS + 1, retry: true })).toBeNull();
    expect(refusal({ task: task({ unknown: { at: T, sha: "x", attempt: 1, link: LINK } }) })).toMatchObject({ code: "unknown" });
    expect((refusal({ task: task({ unknown: { at: T, sha: "x", attempt: 1, link: LINK } }) }) as Refusal).message).toContain(LINK);
  });

  test("a named account's plan names its account", () => {
    useSettings(resolveSettings({ ...TEST_SETTINGS, providers: { slack: { accounts: { partners: { auth: "user-token", team: "Acme Partners", workspace: "acme-partners", me: "U0ALICE0P01" } } } } }));
    const plan = planOf(topic(), task({ to: "slack@partners:C0PART0001:1790000100.000200" }));
    expect(plan.account).toBe("partners");
    expect(canonicalContent(plan)).toContain('"account":"slack@partners"');
  });
});
