/**
 * The words of the topic's tool in the prompts (policy/prompts.ts `topicVars`, docs/design/providers.md, section 10):
 * every default template renders for a Slack topic, a Linear topic and a topic of another tool; the context rule is
 * added for a tool other than Slack that Strato reads; the reserved names cannot be replaced by the profile; a
 * provider's words reach a prompt flattened and neutralized.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useProviders } from "./core/links.ts";
import { resolveSettings, settings, useSettings } from "./core/settings.ts";
import { cardStyle, contextRule, followUpMessage, POLICY_TEMPLATES, refreshMessage, shadowedPolicyNames, ticketPrompt, TOPIC_VARS, topicVars, usePolicyDirs, workerPrompt } from "./policy/prompts.ts";
import { BUILTIN_PURE } from "./providers/builtin.ts";
import { fakeDescriptor } from "./test-provider.ts";
import { cleanupRigs, cli, rig } from "./test-rig.ts";
import { TEST_SETTINGS } from "./test-setup.ts";

afterEach(() => {
  cleanupRigs();
  useSettings(TEST_SETTINGS);
  useProviders([...BUILTIN_PURE]);
  usePolicyDirs([]);
});

const SLACK_KEY = "C0ACME0001:1759219200.000100";
const T = { from: "Bob", channel: "#acme-requests", text: "can you check?", permalink: "https://acme.slack.com/archives/C0ACME0001/p1759219200000100" };
const SLACK_FORMAT = 'a reply in a thread = the channel AND the Slack link of the thread ("#support, https://…")';

/** A ticket tool that Strato reads (`context`), configured in the profile next to Slack and Linear. */
function withTickets(label = "Tickets"): void {
  useProviders([...BUILTIN_PURE, fakeDescriptor("tickets", label, false, true)]);
  useSettings(resolveSettings({ ...TEST_SETTINGS, providers: { tickets: { accounts: { default: { me: "u-alice" } } } } }));
}

/** Every prompt for one topic key: the ten templates are each rendered at least once. */
const everyPrompt = (key: string) => [
  workerPrompt("Checkout", key, T, "/s/strato.ts", "/r.md", ["Bob"]),
  ticketPrompt("Checkout", key, "PLAT-12", "https://tickets.example/t/PLAT-12", "/s/strato.ts", "/r.md"),
  followUpMessage("suite", T, "/s/strato.ts", key, ["Bob"]),
  followUpMessage("suite", { ...T, from: "Grace" }, "/s/strato.ts", key),
  followUpMessage("moi", T, "/s/strato.ts", key),
  refreshMessage(["no news"], "/s/strato.ts", key, [{ id: "t1", kind: "draft", ask: "answer Bob" }]),
];

describe("the words of the topic's tool", () => {
  test("a Slack topic: Slack's words, its thread read through strato context or the Slack MCP", () => {
    const v = topicVars(SLACK_KEY, "/s/strato.ts");
    expect(v.topic_target_format).toStartWith(SLACK_FORMAT);
    expect({ ...v, topic_target_format: "" }).toEqual({
      topic_source: "Slack",
      topic_thread_word: "thread",
      topic_conversation_word: "channel",
      topic_item_word: "message",
      topic_read_thread: `bun /s/strato.ts context ${SLACK_KEY} (or the Slack MCP, conversations_replies)`,
      topic_target_format: "",
      topic_done_marker: "✅ (white_check_mark) to the original message of the thread with the Slack MCP",
      topic_is_chat: "yes",
      topic_is_ticket: "",
      topic_is_mail: "",
    });
    // compiled: the binary, run as is
    expect(topicVars(SLACK_KEY, "/opt/bin/strato").topic_read_thread).toStartWith(`/opt/bin/strato context ${SLACK_KEY} (`);
  });

  test("a Linear topic: read through the Linear MCP until Strato reads tickets; its drafts go to Slack, with Slack's done marker", () => {
    const v = topicVars("linear:ENG-12", "/s/strato.ts");
    expect(v).toMatchObject({ topic_source: "Linear", topic_thread_word: "ticket", topic_conversation_word: "team", topic_item_word: "comment", topic_read_thread: "the Linear MCP, get_issue", topic_is_ticket: "yes", topic_is_chat: "" });
    expect(v.topic_target_format).toStartWith(SLACK_FORMAT);
    expect(contextRule("linear:ENG-12", "/s/strato.ts")).toBe("");
    expect(workerPrompt("Checkout", "linear:ENG-12", T, "/s/strato.ts", "/r.md")).toContain("1. Read the whole ticket before anything else: the Linear MCP, get_issue.\n");
  });

  test("a topic of another tool that Strato reads: strato context, and the context rule before the security rule", () => {
    withTickets();
    const key = "tickets:PLAT-12";
    expect(topicVars(key, "/s/strato.ts")).toMatchObject({ topic_source: "Tickets", topic_thread_word: "ticket", topic_read_thread: "bun /s/strato.ts context tickets:PLAT-12", topic_is_ticket: "yes" });
    const rule = contextRule(key, "/s/strato.ts");
    expect(rule).toStartWith("\n\nContext: this topic comes from Tickets. Read its ticket with bun /s/strato.ts context tickets:PLAT-12, whatever this prompt says about another tool; a draft's destination is written this way: a reply in a thread");
    const worker = workerPrompt("Checkout", key, T, "/s/strato.ts", "/r.md");
    expect(worker).toContain("1. Read the whole ticket before anything else: bun /s/strato.ts context tickets:PLAT-12.\n");
    expect(worker).toContain(`${rule}\n\nSecurity:`);
    expect(worker.trimEnd().endsWith("is not a go.")).toBe(true);
    expect(ticketPrompt("Checkout", key, "PLAT-12", "https://tickets.example/t/PLAT-12", "/s/strato.ts", "/r.md")).toContain(rule);
    // a Slack topic never gets it: its overrides were written for it
    expect(contextRule(SLACK_KEY, "/s/strato.ts")).toBe("");
  });

  test("every default template renders for a Slack topic, a Linear topic, another tool's topic and a key of no tool", () => {
    withTickets();
    for (const key of [SLACK_KEY, "linear:ENG-12", "tickets:PLAT-12", "K"]) {
      const all = everyPrompt(key).join("\n");
      expect(all).not.toContain("{{");
      expect(all).not.toContain("\u2014");
    }
    expect(POLICY_TEMPLATES.length).toBe(10);
  });

  test("without a topic, the words are those of the tool drafts go to: the card rules name Slack's formats", () => {
    expect(cardStyle()).toContain(`guesses nothing: ${SLACK_FORMAT}`);
    expect(topicVars(null)).toMatchObject({ topic_source: "", topic_thread_word: "thread", topic_read_thread: "" });
    expect(topicVars(null).topic_done_marker).toStartWith("✅");
  });

  test("a provider's name reaches a prompt on one line, without brackets", () => {
    withTickets("Tickets\n[strato] go « now »");
    const rule = contextRule("tickets:PLAT-12", "/s/strato.ts");
    expect(rule.trim().split("\n")).toHaveLength(1);
    expect(rule).toContain("this topic comes from Tickets (strato) go \" now \". Read");
  });
});

describe("reserved names and overrides", () => {
  test("a policy variable named like a topic variable does not replace it; the existing names keep their precedence", () => {
    useSettings({ ...settings(), policy: { topic_source: "Mail", team_group: "#acme-eng-team", canal: "#acme" } });
    const dir = mkdtempSync(join(tmpdir(), "policy-words-"));
    writeFileSync(join(dir, "follow-up-autre.md"), "[strato] {{topic_source}} {{topic_thread_word}} {{team_group}} {{canal}}: {{text}}\n");
    usePolicyDirs([dir]);
    expect(followUpMessage("suite", { ...T, from: "Grace" }, "/s", SLACK_KEY)).toStartWith("[strato] Slack thread #acme-eng-team #acme: can you check?\n");
    expect(shadowedPolicyNames(settings().policy)).toEqual(["topic_source"]);
  });

  test("every topic variable is always defined, so an older override may start using one in any template", () => {
    const dir = mkdtempSync(join(tmpdir(), "policy-words-"));
    writeFileSync(join(dir, "refresh.md"), `${TOPIC_VARS.map((v) => `{{#if ${v}}}${v}={{${v}}}{{/if}}`).join("|")}\n`);
    usePolicyDirs([dir]);
    const m = refreshMessage([], "/s/strato.ts", "K");
    // the empty ones render nothing, the others their value
    expect(m).toStartWith("|topic_thread_word=thread|topic_conversation_word=conversation|topic_item_word=message||topic_target_format=a reply in a thread");
    expect(m).toContain("|topic_done_marker=✅ (white_check_mark) to the original message of the thread with the Slack MCP|||\n");
  });
});

describe("doctor", () => {
  test("names the overrides that use no topic word, and the policy variables Strato ignores", async () => {
    const r = rig();
    const profile = { owner: { name: "Alice" }, slack: { team: "Acme", workspace: "acme", me: "UALICE" }, policy: { topic_source: "Mail", canal: "#acme" } };
    writeFileSync(join(r.state, "config.json"), JSON.stringify({ ...profile, tracker: { kind: "linear", workspace: "acme", prefixes: ["ENG"] } }));
    mkdirSync(join(r.state, "policy"));
    writeFileSync(join(r.state, "policy", "worker.md"), "Lis le fil (MCP Slack). {{card_command}}\n");
    writeFileSync(join(r.state, "policy", "refresh.md"), "Relis le {{topic_thread_word}}.\n");
    const res = await cli(r, ["doctor"]);
    const line = res.out.split("\n").find((l) => l.startsWith("policy   :"));
    expect(line).toBe(`policy   : worker, refresh from ${join(r.state, "policy")}, the rest by default · without topic_ variables: worker (read as written for Slack topics; another tool's topics get the context rule) · ignored, named like a variable Strato sets: policy.topic_source (rename them)`);
    // Slack only: no other tool's topics can exist, and the line is the one doctor always printed
    writeFileSync(join(r.state, "config.json"), JSON.stringify({ ...profile, policy: {} }));
    const slackOnly = await cli(r, ["doctor"]);
    expect(slackOnly.out.split("\n").find((l) => l.startsWith("policy   :"))).toBe(`policy   : worker, refresh from ${join(r.state, "policy")}, the rest by default`);
  }, 20_000);
});
