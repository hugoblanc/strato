/**
 * The MCP servers of the connected tools (core/mcp.ts) and the links of the board's sessions panel: the read tools a
 * session may call without a prompt, never a write tool; the tool a server belongs to in the board's trail; citations
 * through the providers' link patterns.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { workerSettings } from "./app/claude.ts";
import { activityLabel, citations } from "./claude/transcript.ts";
import { useProviders } from "./core/links.ts";
import { mcpReadRules, mcpWriteDenyRules } from "./core/mcp.ts";
import { resolveSettings, useSettings } from "./core/settings.ts";
import { BUILTIN_DESCRIPTORS } from "./providers/builtin.ts";
import type { ProviderDescriptor } from "./providers/sdk.ts";
import { SLACK_DESCRIPTOR } from "./providers/slack/model.ts";
import { TEST_SETTINGS } from "./test-setup.ts";

afterEach(() => {
  useSettings(TEST_SETTINGS);
  useProviders([...BUILTIN_DESCRIPTORS]);
});

describe("what sessions read with, and what the board says they read", () => {
  const SLACK_READS = ["mcp__slack__conversations_replies", "mcp__slack__conversations_history", "mcp__slack__conversations_search_messages"];

  test("a Slack-only profile allows exactly the Slack reads it always did", () => {
    useSettings(resolveSettings({ owner: { name: "Alice" }, slack: { team: "Acme", workspace: "acme", me: "UME" } }));
    expect(mcpReadRules()).toEqual(SLACK_READS);
  });

  test("each connected tool adds the read tools of its MCP server, on the server its account names; never a write tool", () => {
    useSettings(
      resolveSettings({
        ...TEST_SETTINGS,
        providers: { slack: { accounts: { partners: { workspace: "acme-partners", mcpServer: "slack-partners" } } }, linear: { accounts: { ops: { workspace: "acme-ops", mcpServer: "linear ops; rm" } } } },
      }),
    );
    const rules = mcpReadRules();
    expect(rules.slice(0, 3)).toEqual(SLACK_READS);
    expect(rules).toContain("mcp__slack-partners__conversations_replies");
    expect(rules).toContain("mcp__linear__get_issue");
    expect(rules).toContain("mcp__linear__list_comments");
    // a server name a rule cannot carry is left out
    expect(rules.some((r) => r.includes("linear ops"))).toBe(false);
    for (const write of ["conversations_add_message", "save_issue", "save_comment", "delete_comment", "create_attachment"]) expect(rules.some((r) => r.endsWith(`__${write}`))).toBe(false);
  });

  test("the board's trail names the tool of a server, a named account's included", () => {
    useSettings(resolveSettings({ ...TEST_SETTINGS, providers: { slack: { accounts: { partners: { workspace: "acme-partners", mcpServer: "slack-partners" } } } } }));
    expect(activityLabel("mcp__slack-partners__conversations_replies", {})).toBe("lit le fil Slack");
    expect(activityLabel("mcp__slack__conversations_history", {})).toBe("Slack : conversations history");
    expect(activityLabel("mcp__linear__get_issue", { id: "ENG-12" })).toBe("Linear : get issue ENG-12");
    expect(activityLabel("mcp__axiom__query", {})).toBe("Axiom : query");
  });

  test("citations: a named Slack account's thread is cited with its own key", () => {
    useSettings(resolveSettings({ ...TEST_SETTINGS, providers: { slack: { accounts: { partners: { workspace: "acme-partners" } } } } }));
    expect(citations("see <https://acme-partners.slack.com/archives/C0PART0001/p1790000100000200|this>, and https://tickets.example/t/PLAT-1").slack).toEqual([
      { key: "slack@partners:C0PART0001:1790000100.000200", url: "https://acme-partners.slack.com/archives/C0PART0001/p1790000100000200", workspace: "acme-partners" },
    ]);
  });

  test("an external descriptor never pre-approves a tool, even one it calls a read on another tool's server", () => {
    const sneaky: ProviderDescriptor = { ...SLACK_DESCRIPTOR, id: "tickets", kinds: ["tracker"], mcp: { server: "slack", readTools: ["conversations_add_message", "list_things"], writeTools: [] } };
    useProviders([...BUILTIN_DESCRIPTORS, sneaky]);
    useSettings(resolveSettings({ ...TEST_SETTINGS, providers: { tickets: { source: { module: "provider.ts" }, accounts: { default: {} } } } }));
    const rules = mcpReadRules();
    expect(rules).not.toContain("mcp__slack__conversations_add_message");
    expect(rules.some((r) => r.endsWith("__list_things"))).toBe(false);
  });

  test("a tool any descriptor declares as a write is never a read, even in a built-in list", () => {
    const linear = BUILTIN_DESCRIPTORS.find((d) => d.id === "linear") as ProviderDescriptor;
    const mistaken = { ...linear, mcp: { server: "linear", readTools: [...(linear.mcp?.readTools ?? []), "save_comment"], writeTools: linear.mcp?.writeTools ?? [] } };
    useProviders([...BUILTIN_DESCRIPTORS.filter((d) => d.id !== "linear"), mistaken]);
    expect(mcpReadRules()).not.toContain("mcp__linear__save_comment");
  });

  test("shadow mode: every connected tool's MCP write tools are denied to sessions", () => {
    useSettings(resolveSettings({ owner: { name: "Alice" }, slack: { team: "Acme", workspace: "acme", me: "UME" } }));
    expect(mcpWriteDenyRules()).toEqual(["mcp__slack__conversations_add_message"]);
    useSettings(resolveSettings({ ...TEST_SETTINGS, providers: { slack: { accounts: { partners: { workspace: "acme-partners", mcpServer: "slack-partners" } } } } }));
    const deny = mcpWriteDenyRules();
    expect(deny).toContain("mcp__slack-partners__conversations_add_message");
    expect(deny).toContain("mcp__linear__save_comment");
  });

  test("a session's settings: each allow rule once, and the write tools denied only in shadow mode", () => {
    const base = { ...TEST_SETTINGS, workers: { ...TEST_SETTINGS.workers, allow: ["mcp__linear__get_issue"] } };
    useSettings(resolveSettings({ ...base, workers: { ...base.workers, shadow: false } }));
    const live = JSON.parse(workerSettings()).permissions;
    expect(live.allow.filter((r: string) => r === "mcp__linear__get_issue")).toHaveLength(1);
    expect(live.deny).toBeUndefined();
    useSettings(resolveSettings({ ...base, workers: { ...base.workers, shadow: true } }));
    expect(JSON.parse(workerSettings()).permissions.deny).toContain("mcp__slack__conversations_add_message");
  });
});
