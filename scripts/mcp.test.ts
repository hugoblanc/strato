/**
 * The MCP servers of the connected tools (core/mcp.ts) and the links of the board's sessions panel: the read tools a
 * session may call without a prompt, never a write tool; the tool a server belongs to in the board's trail; citations
 * through the providers' link patterns.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { activityLabel, citations } from "./claude/transcript.ts";
import { mcpReadRules } from "./core/mcp.ts";
import { resolveSettings, useSettings } from "./core/settings.ts";
import { TEST_SETTINGS } from "./test-setup.ts";

afterEach(() => useSettings(TEST_SETTINGS));

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
});
