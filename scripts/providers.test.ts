/**
 * The provider seam: the shared rules of providers/api.ts, the built-in descriptors, the types-only SDK file, and the
 * Slack provider's pure adapters of chat/slack-model.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { effectiveCapabilities, PROVIDER_API, providerError } from "./providers/api.ts";
import { BUILTIN_DESCRIPTORS } from "./providers/builtin.ts";
import type { ProviderDescriptor } from "./providers/sdk.ts";
import { SLACK_DESCRIPTOR, slackDeepLink, slackParseTarget, slackRender, slackThreadInfo } from "./providers/slack/model.ts";

describe("the shared rules of providers", () => {
  test("an account's capabilities are the descriptor's minus its auth method's limits, push requiring poll", () => {
    const d: ProviderDescriptor = { ...SLACK_DESCRIPTOR, auth: [{ ...SLACK_DESCRIPTOR.auth[0], id: "narrow", limits: { ingest: { poll: false }, actions: ["delete"], context: false } }, SLACK_DESCRIPTOR.auth[0]] };
    expect(effectiveCapabilities(d, "user-token")).toEqual(SLACK_DESCRIPTOR.capabilities);
    expect(effectiveCapabilities(d, "narrow")).toMatchObject({ ingest: { push: false, poll: false }, context: false, actions: ["reply", "post", "react"] });
  });

  test("anything a provider throws is read as a provider error; a crash while writing may have written", () => {
    expect(providerError({ code: "rate_limited", message: "slow down", retryable: true, retryAfterMs: 2000 })).toEqual({ code: "rate_limited", message: "slow down", retryable: true, fatal: false, retryAfterMs: 2000 });
    expect(providerError({ code: "invalid_auth" })).toEqual({ code: "invalid_auth", message: "invalid_auth", retryable: false, fatal: false });
    expect(providerError(new Error("boom"))).toEqual({ code: "internal", message: "boom", retryable: true, fatal: false });
    expect(providerError(new Error("boom"), "write")).toEqual({ code: "internal", message: "boom", retryable: true, fatal: false, outcome: "unknown" });
  });

  test("the built-in descriptors are valid: ids, API version, push only with poll, triage settings asked", () => {
    for (const d of BUILTIN_DESCRIPTORS) {
      expect(d.id).toMatch(/^[a-z][a-z0-9-]{1,30}$/);
      expect(d.api.min <= PROVIDER_API && PROVIDER_API <= d.api.max).toBe(true);
      if (d.capabilities.ingest.push) expect(d.capabilities.ingest.poll).toBe(true);
      for (const s of d.settings) if (s.triage) expect(s.ask).toBeDefined();
      for (const p of d.links.parse) expect(() => new RegExp(p.pattern.replace(/\{settings\.\w+\}/g, "x"))).not.toThrow();
    }
  });

  test("sdk.ts holds types only, so it is a declaration file as printed", () => {
    const src = readFileSync(join(import.meta.dir, "providers/sdk.ts"), "utf8");
    expect(src).not.toMatch(/^import /m);
    expect(new Bun.Transpiler({ loader: "ts" }).transformSync(src).replace(/export\s*\{\s*\};?/g, "").trim()).toBe("");
  });
});

describe("the Slack provider's pure adapters", () => {
  const topic = { thread: "C0ACME0001:1759219200.000100", conversation: { id: "C0ACME0001", label: "#acme-support" } };

  test("a free-text destination becomes a target with today's rules, labelled with the board's words", () => {
    expect(slackParseTarget("#acme-support, https://acme.slack.com/archives/C0ACME0001/p1759219260000200?thread_ts=1759219200.000100", topic)).toEqual({ scope: "thread", native: "C0ACME0001:1759219200.000100", label: "#acme-support" });
    expect(slackParseTarget("#announcements (C0ACMEANN01), new message", topic)).toEqual({ scope: "conversation", native: "C0ACMEANN01", label: "#announcements, new message" });
    expect(slackParseTarget("", topic)).toEqual({ scope: "thread", native: "C0ACME0001:1759219200.000100", label: "#acme-support" });
    expect(slackParseTarget("", { ...topic, thread: "linear:ENG-12" })).toHaveProperty("error");
    // a destination that cannot be posted to keeps its words, for the board
    expect(slackParseTarget("#acme-sales", topic)).toMatchObject({ label: "#acme-sales" });
    expect(slackParseTarget("#acme-sales", topic)).toHaveProperty("error");
  });

  test("mrkdwn to plain text, and drafts to safe HTML as the board showed them", () => {
    expect(slackRender.plain("hi <@U0BOB0001>\n<https://x.example|the doc>")).toBe("hi @U0BOB0001 | the doc");
    // a draft is shown as it will go out: an entity typed in it stays visible as typed
    expect(slackRender.html("<script>&lt;b&gt;")).toBe("&lt;script&gt;&amp;lt;b&amp;gt;");
    const html = slackRender.html("<@U0BOB0001> in <#C0ACMEOPS01> <!here>", { people: { U0BOB0001: "Bob" }, conversations: { C0ACMEOPS01: "#acme-ops" } });
    expect(html).toContain("@Bob");
    expect(html).toContain("#acme-ops");
    expect(html).toContain("@here");
  });

  test("a thread id says its channel and its time", () => {
    expect(slackThreadInfo("C0ACME0001:1759219200.000100")).toEqual({ conversation: "C0ACME0001", at: 1759219200000 });
    expect(slackThreadInfo("CX:x")).toEqual({ conversation: "CX" });
    expect(slackThreadInfo("C0ACME0001")).toBeNull();
  });

  test("the slack:// link needs the team id", () => {
    const account = { provider: "slack", id: "default", label: "Acme", auth: "user-token", ingest: "push" as const, settings: {} };
    const url = "https://acme.slack.com/archives/C0ACME0001/p1759219200000100";
    expect(slackDeepLink(url, account, { me: "UME", name: "Alice", workspace: "Acme", tenant: "T0ACME0000" })).toBe("slack://channel?team=T0ACME0000&id=C0ACME0001&message=1759219200.000100");
    expect(slackDeepLink(url, account, { me: "UME", name: "Alice", workspace: "Acme" })).toBeNull();
  });
});
