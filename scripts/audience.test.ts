/**
 * Recipients on a draft, for a mail tool (core/tasks.ts, core/gate.ts, core/targets.ts): a typed key of a mail tool is
 * an email thread, so its text is a reply; a task carries `audience.to`, `audience.cc`, `visibility` and `subject`;
 * the plan keeps the fields the tool declares, the hash covers them, the gate requires the recipients, the board shows
 * them before the Go, and the prompts name the fields only for a tool that has them. A Slack draft is unchanged.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { actionCard, classify } from "./board.ts";
import { addTask, editTask, type GateAccount, planOfTask, planRefusal, planSha, resolveSettings, resolveTarget, settingHost, type Sujet, type Task, typedScope, useProviders, useSettings } from "./lib.ts";
import { audienceFields } from "./policy/prompts.ts";
import { BUILTIN_DESCRIPTORS, BUILTIN_PURE } from "./providers/builtin.ts";
import type { ProviderDescriptor } from "./providers/sdk.ts";
import { fakeDescriptor } from "./test-provider.ts";
import { TEST_SETTINGS } from "./test-setup.ts";

afterEach(() => {
  useSettings(TEST_SETTINGS);
  useProviders([...BUILTIN_PURE]);
});

const T = "2026-09-30T08:00:00Z";
const THREAD = "ca41.root@mail.acme.example";

/** A mail tool whose replies name their recipients, and a support desk whose replies are public or internal. */
const MAIL: ProviderDescriptor = { ...fakeDescriptor("mail", "Mail"), kinds: ["mail"], capabilities: { ...fakeDescriptor("mail", "Mail").capabilities, actions: ["reply"] }, audience: { reply: { to: true, cc: true, subject: true } } };
const DESK: ProviderDescriptor = { ...fakeDescriptor("desk", "Desk"), capabilities: { ...fakeDescriptor("desk", "Desk").capabilities, actions: ["comment"] }, audience: { comment: { visibility: { default: "internal" } } } };

function withTools(): void {
  useProviders([...BUILTIN_DESCRIPTORS, MAIL, DESK, fakeDescriptor("chat", "Chat")]);
  const account = { source: { module: "x.ts" }, accounts: { default: { auth: "api-key" } } };
  useSettings(resolveSettings({ ...TEST_SETTINGS, providers: { mail: account, desk: account, chat: account } }));
}

const card = { status: "working" as const, gate: "none", updatedAt: T, history: [], title: "x" };
const topic = (tasks: Task[], key = `mail:${THREAD}`): Sujet => ({ key, threads: [key], letter: "A", title: "Invoice", channel: "INBOX", permalink: "", asker: "Carol", sessionId: null, shortId: null, name: "A", status: "gate", gate: "draft", waiting: "", next: "", summary: "", createdAt: T, updatedAt: T, history: [], tasks });
const draft = (fields: Record<string, string>) => addTask(card, { kind: "draft", ask: "Carol asks for the date", draft: "The 12th.", to: `mail:${THREAD}`, ...fields }, T).task;
const planOf = (s: Sujet, x: Task) => {
  const p = planOfTask(s, x);
  if (!("plan" in p)) throw new Error(p.message);
  return p.plan;
};

describe("a typed key's scope, and the rule that decided it", () => {
  test("a mail tool's key is an email thread, so its text is a reply; a tracker's a ticket; otherwise a conversation", () => {
    withTools();
    expect(typedScope("mail", THREAD)).toMatchObject({ scope: "thread", rule: "mail" });
    expect(typedScope("desk", "OPS-7")).toMatchObject({ scope: "ticket", rule: "tracker" });
    useProviders([...BUILTIN_DESCRIPTORS, { ...fakeDescriptor("chat", "Chat"), kinds: ["chat"] }]);
    expect(typedScope("chat", "C1")).toMatchObject({ scope: "conversation", rule: "conversation" });
    useProviders([...BUILTIN_PURE]);
    expect(typedScope("slack", "C0ACMEREQ01:1790000000.000100")).toMatchObject({ scope: "thread", rule: "threadInfo" });
  });

  test("a draft to a mail thread is a reply on that thread, labelled by its id", () => {
    withTools();
    expect(resolveTarget(topic([]), { to: `mail:${THREAD}` })).toEqual({ provider: "mail", account: "default", target: { scope: "thread", native: THREAD, label: THREAD } });
  });
});

describe("audience fields on a task", () => {
  test("written as lists of addresses, removed with -, refused without a draft or when they are not addresses", () => {
    const x = draft({ "audience.to": "carol@acme.example, dan@acme.example", "audience.cc": "", subject: "Re: Invoice", visibility: "internal" });
    expect(x.audience).toEqual({ to: ["carol@acme.example", "dan@acme.example"], visibility: "internal" });
    expect(x.subject).toBe("Re: Invoice");
    expect(Object.keys(x)).not.toContain("audience.to");
    const s = topic([x]);
    const edited = editTask(s, "t1", { "audience.cc": "erin@acme.example", visibility: "-", subject: "-" }, T).tasks?.[0] as Task;
    expect(edited.audience).toEqual({ to: ["carol@acme.example", "dan@acme.example"], cc: ["erin@acme.example"] });
    expect(Object.keys(edited)).not.toContain("subject");
    expect(() => addTask(card, { kind: "decision", ask: "Which date?", "audience.to": "carol@acme.example" }, T)).toThrow("go with a draft");
    expect(() => draft({ "audience.to": "Carol <carol@acme.example>" })).toThrow("is not one address");
    expect(() => draft({ "audience.to": "carol" })).toThrow("is not one address");
    expect(() => draft({ visibility: "secret" })).toThrow("unknown visibility");
    expect(() => draft({ subject: "two\nlines" })).toThrow("one line");
  });
});

describe("the plan of a draft with an audience", () => {
  test("it carries the fields its tool declares, and the hash covers them", () => {
    withTools();
    const x = draft({ "audience.to": "carol@acme.example", "audience.cc": "dan@acme.example", subject: "Re: Invoice", visibility: "public" });
    const plan = planOf(topic([x]), x);
    // visibility is not a field of this mail tool: it is left out, not shown, not sent
    expect(plan.actions).toEqual([{ kind: "reply", target: { scope: "thread", native: THREAD, label: THREAD }, text: "The 12th.", subject: "Re: Invoice", audience: { to: ["carol@acme.example"], cc: ["dan@acme.example"] } }]);
    const other = draft({ "audience.to": "dan@acme.example", "audience.cc": "dan@acme.example", subject: "Re: Invoice" });
    expect(planSha(planOf(topic([other]), other))).not.toBe(planSha(plan));
  });

  test("a declared default visibility applies when the task names none; a Slack draft carries none of it", () => {
    withTools();
    const x = addTask(card, { kind: "draft", ask: "Reply", draft: "Fixed.", to: "desk:OPS-7", "audience.to": "carol@acme.example" }, T).task;
    expect(planOf(topic([x], "desk:OPS-7"), x).actions[0]).toEqual({ kind: "comment", target: { scope: "ticket", native: "OPS-7", label: "OPS-7" }, text: "Fixed.", audience: { visibility: "internal" } });
    const slack = addTask(card, { kind: "draft", ask: "Reply", draft: "Fixed.", to: "C0ACMEREQ01:1790000000.000100", "audience.to": "carol@acme.example", subject: "x" }, T).task;
    expect(planOf(topic([slack], "C0ACMEREQ01:1790000000.000100"), slack).actions[0]).toEqual({ kind: "reply", target: { scope: "thread", native: "C0ACMEREQ01:1790000000.000100", label: "INBOX" }, text: "Fixed." });
  });

  test("the gate refuses a mail reply without recipients", () => {
    withTools();
    const account: GateAccount = { usable: true, actions: ["reply"], descriptor: MAIL };
    const bare = draft({});
    expect(planRefusal(planOf(topic([bare]), bare), account)?.code).toBe("target");
    const named = draft({ "audience.to": "carol@acme.example" });
    expect(planRefusal(planOf(topic([named]), named), account)).toBeNull();
  });

  test("the board shows who receives it before the Go, escaped; nothing more on a Slack draft", () => {
    withTools();
    const x = draft({ "audience.to": "carol@acme.example", "audience.cc": "dan@acme.example", subject: "Re: <Invoice>" });
    const html = actionCard(classify(topic([x]), [], null, "idle", (i: string) => i));
    // the test profile speaks French
    expect(html).toContain("data-draft-audience>À : carol@acme.example · Cc : dan@acme.example · Objet : Re: &lt;Invoice&gt;</p>");
    const key = "C0ACMEREQ01:1790000000.000100";
    const slack = addTask(card, { kind: "draft", ask: "Reply", draft: "Fixed.", to: key }, T).task;
    expect(actionCard(classify(topic([slack], key), [], null, "idle", (i: string) => i))).not.toContain("data-draft-audience");
  });

  test("a mail reply that names no subject says, before the Go, that it keeps the thread's", () => {
    withTools();
    const html = actionCard(classify(topic([draft({ "audience.to": "carol@acme.example" })]), [], null, "idle", (i: string) => i));
    expect(html).toContain("data-draft-audience>À : carol@acme.example · Objet : celui du fil (Re: …)</p>");
  });

  test("the prompts name the fields of a tool that has them, and nothing for Slack", () => {
    withTools();
    expect(audienceFields("mail")).toBe(' audience.to="<the recipients, addresses separated by commas>" audience.cc="<the copies, or ->" subject="<the subject line, or - for the thread\'s own>"');
    expect(audienceFields("desk")).toBe(" visibility=<public|internal>");
    expect(audienceFields("slack")).toBe("");
    expect(audienceFields(null)).toBe("");
  });
});

describe("a setting that names an API host", () => {
  test("a URL of any scheme or a bare host, with or without a port; anything else names none", () => {
    expect(settingHost("https://Tickets.example/api")).toBe("tickets.example");
    expect(settingHost("imaps://imap.acme.example:993")).toBe("imap.acme.example");
    expect(settingHost("imap.acme.example")).toBe("imap.acme.example");
    expect(settingHost(" smtp.acme.example:587 ")).toBe("smtp.acme.example");
    for (const v of ["", "not a host", "acme.example/path", "user@acme.example", 42, null]) expect(settingHost(v)).toBeNull();
  });
});
