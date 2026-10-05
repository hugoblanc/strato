/**
 * Golden render of every prompt a Slack-only installation sends its sessions: the worker and ticket prompts, the three
 * follow-ups, the relaunch, in shadow mode, compiled, without a team, in French, and with policy overrides written in
 * the older styles (French, `{{#si}}`, `bun {{script}}`, Slack named literally). Every one of the ten templates is
 * rendered at least once. The expected values were recorded on the code before the prompts read their words from the
 * providers (docs/design/providers.md, section 15, prompts); `INTENDED` lists, and explains, every difference since.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSettings, settings, useSettings } from "./core/settings.ts";
import { followUpMessage, refreshMessage, ticketPrompt, usePolicyDirs, workerPrompt } from "./policy/prompts.ts";

const GOLDEN_FILE = join(import.meta.dir, "prompts-golden.json");
/** `STRATO_GOLDEN_RECORD=1 bun test prompts-golden` rewrites the expected values: only for an intended change of the prompts. */
const RECORD = process.env.STRATO_GOLDEN_RECORD === "1";
const GOLDEN: Record<string, string> = RECORD ? {} : JSON.parse(readFileSync(GOLDEN_FILE, "utf8"));
afterAll(() => {
  if (RECORD) writeFileSync(GOLDEN_FILE, `${JSON.stringify(GOLDEN, null, 2)}\n`);
});

/**
 * The differences a later stage makes on purpose, applied to the recorded text before the comparison: each one says
 * which renders it touches, the text before and the text after, and why.
 */
const INTENDED: { why: string; names: RegExp; from: string; to: string }[] = [
  ...[
    { names: /^(?!compiled\/|overrides\/)[^/]*\/?worker/, command: "bun /s/strato.ts" },
    { names: /^compiled\/worker/, command: "/opt/bin/strato" },
  ].map(({ names, command }) => ({
    why: "the worker reads its thread with `strato context` first, which needs no MCP server; the Slack MCP stays named as the other way",
    names,
    from: "1. Read the whole thread before anything else (Slack MCP, conversations_replies).",
    to: `1. Read the whole thread before anything else: ${command} context C0ACME0001:1759219200.000100 (or the Slack MCP, conversations_replies).`,
  })),
  {
    why: "the destination formats come from the tool that reads them (its vocabulary): the shared sentence no longer counts them, Slack still lists its two",
    names: /^(?!overrides\/)/,
    from: "- draftTo = where it goes, in one of these two formats, because",
    to: "- draftTo = where it goes, in one of these formats, because",
  },
  {
    why: "the ticket prompt names how the ticket is read: the Linear MCP for a tracker that only recognizes links, `strato context` once Linear is connected",
    names: /(^|\/)ticket$/,
    from: "1. Read the ticket and its comments (tracker MCP), then",
    to: "1. Read the ticket and its comments (the Linear MCP, get_issue), then",
  },
  {
    why: "the board reads the blocker beside the open task: it names who or what blocks, never the task again, and stays empty when the person served blocks or nothing does (docs/design/board-modes.md, section 6.3)",
    names: /^(?!overrides\/)/,
    from: `- blocker = what blocks the now step, and who: "your go to post", "the vendor's answer", "nothing, I keep going". One sentence.`,
    to: `- blocker = who or what blocks the now step: "the vendor's answer", "Zoé's review", "the CI on api!1042". Never the task again. Empty when Alice is the one blocking: the open task already says it. Empty when nothing blocks.`,
  },
  {
    why: "the board uses the first open task's ask as the card's headline: a verb first, 80 characters at most (docs/design/board-modes.md, section 6.3)",
    names: /^(?!overrides\/)/,
    from: "- ask = the request of the task, proposal = what you propose for it: one sentence each. One task, one request.\n",
    to: "- ask = the request of the task, proposal = what you propose for it: one sentence each. One task, one request.\n- The first open task's ask starts with a verb and fits 80 characters: the board uses it as the card's headline. The details go in proposal.\n",
  },
];

function check(name: string, text: string): void {
  if (RECORD) {
    GOLDEN[name] = text;
    return;
  }
  let expected = GOLDEN[name];
  expect(expected).toBeDefined();
  for (const d of INTENDED) if (d.names.test(name)) expected = expected.split(d.from).join(d.to);
  expect(text).toBe(expected);
}

/** A Slack-only profile: no tracker, no forge. */
const SLACK_ONLY = resolveSettings({
  owner: { name: "Alice" },
  workspace: "/Users/alice/dev/acme",
  slack: { team: "Acme", workspace: "acme", me: "UME", subteams: ["SGRP"], teamAlias: "@acme-eng", teammates: ["Bob", "Carol Smith", "Dave", "Erin"] },
  ui: { locale: "en" },
});

const saved = settings();
afterEach(() => {
  useSettings(saved);
  usePolicyDirs([]);
});

const KEY = "C0ACME0001:1759219200.000100";
const LINK = "https://acme.slack.com/archives/C0ACME0001/p1759219200000100";
const TRIGGER = { from: "Bob", channel: "#acme-requests", text: "can you check the payout of Initech?", permalink: LINK };
const TICKET = { key: "linear:ENG-12", id: "ENG-12", url: "https://linear.app/acme/issue/ENG-12" };
const REPORT = "/state/reports/C0ACME0001_1759219200.000100.md";
const TASKS = [
  { id: "t1", kind: "draft" as const, ask: "Bob asks when the payout goes out" },
  { id: "t2", kind: "action" as const, ask: "merge api!12" },
];

/** Every prompt for one profile and one entry point. */
function renderAll(prefix: string, script: string): void {
  check(`${prefix}worker`, workerPrompt("Initech payout", KEY, TRIGGER, script, REPORT));
  check(`${prefix}worker-team`, workerPrompt("Initech payout", KEY, TRIGGER, script, REPORT, ["Bob", "Dave"]));
  check(`${prefix}ticket`, ticketPrompt("Initech payout hold", TICKET.key, TICKET.id, TICKET.url, script, "/state/reports/linear_ENG-12.md"));
  check(`${prefix}follow-up-other`, followUpMessage("suite", { ...TRIGGER, from: "Grace" }, script, KEY, ["Bob", "Dave"]));
  check(`${prefix}follow-up-teammate`, followUpMessage("suite", TRIGGER, script, KEY, ["Bob", "Dave"]));
  check(`${prefix}follow-up-me`, followUpMessage("moi", { ...TRIGGER, from: "Alice" }, script, KEY));
  check(`${prefix}refresh`, refreshMessage(["no news for 4 days"], script, KEY, TASKS));
  check(`${prefix}refresh-empty`, refreshMessage([], script, KEY));
}

describe("prompts of a Slack-only installation", () => {
  test("every default template, from a development clone", () => {
    useSettings(SLACK_ONLY);
    renderAll("", "/s/strato.ts");
  });

  test("every default template, from a binary", () => {
    useSettings(SLACK_ONLY);
    renderAll("compiled/", "/opt/bin/strato");
  });

  test("shadow mode", () => {
    useSettings({ ...SLACK_ONLY, workers: { ...SLACK_ONLY.workers, shadow: true } });
    renderAll("shadow/", "/s/strato.ts");
  });

  test("without a team group", () => {
    useSettings({ ...SLACK_ONLY, slack: { ...SLACK_ONLY.slack, teamAlias: "" } });
    renderAll("no-team/", "/s/strato.ts");
  });

  test("a French profile", () => {
    useSettings({ ...SLACK_ONLY, ui: { ...SLACK_ONLY.ui, locale: "fr" } });
    renderAll("fr/", "/s/strato.ts");
  });

  test("overrides in the older styles render as they did", () => {
    useSettings({ ...SLACK_ONLY, ui: { ...SLACK_ONLY.ui, locale: "fr" }, policy: { canal_equipe: "#acme-eng" } });
    const dir = mkdtempSync(join(tmpdir(), "policy-golden-"));
    // a French worker of an older installation: {{#si}}, the elided forms, `bun {{script}}`, the Slack MCP named literally
    writeFileSync(
      join(dir, "worker.md"),
      "Tu es une session ouverte par l'aiguilleur {{d_owner}}. Sujet : {{title}} ({{key}})\nMessage de {{from}} dans {{channel}} : « {{text}} » {{permalink}}\n1. Lis tout le fil (MCP Slack, conversations_replies).\n{{#si team_group}}2. Une mention de {{team_group}} vise l'équipe ({{canal_equipe}}).{{/si}}\n3. Rapport dans {{report}}, {{timezone}}.\n{{execution_rule}}\n{{agents_rule}}\nAvant de t'arrêter : bun {{script}} set {{key}} status=…\n{{card_command}}\n",
    );
    // an older English execution rule that posts through the Slack MCP itself
    writeFileSync(join(dir, "execution-rule.md"), "Execution rule: on a go from {{owner}}, post the draft yourself with the Slack MCP (conversations_add_message), then add ✅.\n");
    writeFileSync(join(dir, "card-style.md"), "Card: short. draftTo = the channel and the Slack link of the thread.\n");
    writeFileSync(join(dir, "follow-up-moi.md"), "[aiguilleur] {{owner}} a répondu : {{text}}\n");
    writeFileSync(join(dir, "refresh.md"), "[aiguilleur] Revalide ta carte ({{reasons}}) : relis le fil Slack, puis bun {{script}} set {{key}} …\n");
    usePolicyDirs([dir]);
    renderAll("overrides/", "/s/strato.ts");
  });
});
