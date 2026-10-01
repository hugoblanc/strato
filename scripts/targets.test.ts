/**
 * Targets through the providers (core/targets.ts): a legacy free-text `draftTo` keeps its meaning, a typed `to` key
 * names its account, a link of another account goes to that account, and what cannot be posted to says why. Also the
 * words the board and the panel read from a thread id, through its tool.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { addTask, deepLinkOf, isResolved, renderHtml, resolveSettings, resolveTarget, type Sujet, targetLink, threadInfoOfKey, useProviders, useSettings } from "./lib.ts";
import { BUILTIN_DESCRIPTORS, BUILTIN_PURE } from "./providers/builtin.ts";
import { fakeDescriptor } from "./test-provider.ts";
import { TEST_SETTINGS } from "./test-setup.ts";

afterEach(() => {
  useSettings(TEST_SETTINGS);
  useProviders([...BUILTIN_PURE]);
});

const KEY = "C0ACMEREQ01:1790000000.000100";
const LINK = "https://acme.slack.com/archives/C0ACMEREQ01/p1790000000000100";
const topic = (o: Partial<Sujet> = {}) => ({ key: KEY, channel: "#acme-requests", ...o });

/** A second Slack workspace, "acme-partners", next to the default one. */
const withPartners = () => useSettings(resolveSettings({ ...TEST_SETTINGS, providers: { slack: { accounts: { partners: { auth: "user-token", team: "Acme Partners", workspace: "acme-partners", me: "U0ALICE0P01" } } } } }));

describe("legacy free-text destinations", () => {
  test("a thread link, a channel id and new message, nothing: today's three meanings", () => {
    expect(resolveTarget(topic(), { draftTo: `#acme-requests, ${LINK}` })).toEqual({ provider: "slack", account: "default", target: { scope: "thread", native: KEY, label: "#acme-requests" } });
    expect(resolveTarget(topic(), { draftTo: "#acme-announcements (C0ACMEANN01), new message" })).toEqual({ provider: "slack", account: "default", target: { scope: "conversation", native: "C0ACMEANN01", label: "#acme-announcements, new message" } });
    expect(resolveTarget(topic(), { draftTo: "" })).toEqual({ provider: "slack", account: "default", target: { scope: "thread", native: KEY, label: "#acme-requests" } });
  });

  test("a destination that cannot be posted to says why, with the words the board shows", () => {
    const r = resolveTarget(topic(), { draftTo: "#acme-support" });
    expect(isResolved(r)).toBe(false);
    expect(r).toMatchObject({ label: "#acme-support", provider: "slack" });
    expect((r as { error: string }).error).toContain("#acme-support");
  });

  test("a ticket topic's draft goes to the Slack thread linked in it, as it always did", () => {
    const r = resolveTarget(topic({ key: "linear:ENG-12", channel: "ENG-12" }), { draftTo: `#acme-requests, ${LINK}` });
    expect(r).toMatchObject({ provider: "slack", account: "default", target: { scope: "thread", native: KEY } });
    expect(resolveTarget(topic({ key: "linear:ENG-12", channel: "ENG-12" }), { draftTo: "#acme-announcements (C0ACMEANN01), new message" })).toMatchObject({ provider: "slack", target: { scope: "conversation", native: "C0ACMEANN01" } });
    expect(isResolved(resolveTarget(topic({ key: "linear:ENG-12", channel: "ENG-12" }), { draftTo: "#acme-requests" }))).toBe(false);
  });

  test("a link of another Slack account goes to that account", () => {
    withPartners();
    const r = resolveTarget(topic(), { draftTo: "#partners, https://acme-partners.slack.com/archives/C0PART0001/p1790000100000200" });
    expect(r).toMatchObject({ provider: "slack", account: "partners", target: { scope: "thread", native: "C0PART0001:1790000100.000200" } });
    expect(targetLink(r as never)).toBe("https://acme-partners.slack.com/archives/C0PART0001/p1790000100000200");
  });
});

describe("typed targets", () => {
  test("a thread key is a reply, a conversation key a separate message, on the key's account", () => {
    withPartners();
    expect(resolveTarget(topic(), { to: "C0ACMEREQ01:1790000050.000100" })).toEqual({ provider: "slack", account: "default", target: { scope: "thread", native: "C0ACMEREQ01:1790000050.000100", label: "#acme-requests" } });
    expect(resolveTarget(topic(), { to: "slack:C0ACMEANN01" })).toEqual({ provider: "slack", account: "default", target: { scope: "conversation", native: "C0ACMEANN01", label: "C0ACMEANN01" } });
    expect(resolveTarget(topic(), { to: "slack@partners:C0PART0001:1790000100.000200", draftTo: "ignored" })).toMatchObject({ account: "partners", target: { scope: "thread", label: "C0PART0001" } });
  });

  test("a key of a tool that is not connected, or not a key at all, cannot be posted to", () => {
    expect(isResolved(resolveTarget(topic(), { to: "tickets:PLAT-12" }))).toBe(false);
    expect((resolveTarget(topic(), { to: "slack@nope:C0ACMEANN01" }) as { error: string }).error).toContain("Slack (nope)");
    expect(isResolved(resolveTarget(topic(), { to: "not a key" }))).toBe(false);
  });

  test("a tracker's key is a ticket", () => {
    useProviders([...BUILTIN_DESCRIPTORS, fakeDescriptor("tickets", "Tickets")]);
    useSettings(resolveSettings({ ...TEST_SETTINGS, providers: { tickets: { source: { module: "x.ts" }, accounts: { default: { auth: "api-key" } } } } }));
    expect(resolveTarget(topic(), { to: "tickets:PLAT-12" })).toEqual({ provider: "tickets", account: "default", target: { scope: "ticket", native: "PLAT-12", label: "PLAT-12" } });
  });

  test("a task carries a typed target; to must be a key", () => {
    const card = { status: "working" as const, gate: "none", updatedAt: "2026-09-30T08:00:00Z", history: [], title: "x" };
    const { task } = addTask(card, { kind: "draft", ask: "Answer", draft: "Done.", to: "C0ACMEREQ01:1790000050.000100" }, "2026-09-30T08:01:00Z");
    expect(task.to).toBe("C0ACMEREQ01:1790000050.000100");
    expect(task.draftTo).toBe("");
    expect(() => addTask(card, { kind: "draft", ask: "Answer", draft: "Done.", to: "#acme-requests" }, "2026-09-30T08:01:00Z")).toThrow("not a key");
    expect(() => addTask(card, { kind: "draft", ask: "Answer", draft: "Done." }, "2026-09-30T08:01:00Z")).toThrow("draftTo");
  });
});

describe("what a thread id says, through its tool", () => {
  test("a Slack key gives its channel and time; another account names itself; a ticket says nothing", () => {
    withPartners();
    expect(threadInfoOfKey(KEY)).toEqual({ provider: "slack", account: "default", tool: "Slack", conversation: "C0ACMEREQ01", at: 1790000000000 });
    expect(threadInfoOfKey("slack@partners:C0PART0001:1790000100.000200")).toMatchObject({ tool: "Slack (partners)", conversation: "C0PART0001" });
    expect(threadInfoOfKey("linear:ENG-12")).toBeNull();
  });

  test("a tool without rendering shows its text escaped", () => {
    useProviders([...BUILTIN_DESCRIPTORS, fakeDescriptor("tickets", "Tickets")]);
    expect(renderHtml("tickets", "<b>x</b> <@U1>")).toBe("&lt;b&gt;x&lt;/b&gt; &lt;@U1&gt;");
    expect(renderHtml("slack", "<@U1>", { people: { U1: "Bob" } })).toContain("@Bob");
  });

  test("a deep link comes from the provider that owns the link's host, with the person's identity on that account", () => {
    const identity = { me: "UME", name: "Alice", workspace: "Acme", tenant: "T0ACME0000" };
    expect(deepLinkOf(LINK, { provider: "slack", account: "default" }, identity)).toBe("slack://channel?team=T0ACME0000&id=C0ACMEREQ01&message=1790000000.000100");
    expect(deepLinkOf("https://linear.app/acme/issue/ENG-12", { provider: "linear", account: "default" }, identity)).toBeNull();
    expect(deepLinkOf(LINK, { provider: "slack", account: "nope" }, identity)).toBeNull();
  });
});
