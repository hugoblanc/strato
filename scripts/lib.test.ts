import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  socketDeaf,
  draftDestination,
  draftText,
  isSnoozed,
  agentTail,
  agentTree,
  agentCounts,
  agentsRule,
  cardStyle,
  POLICY_TEMPLATES,
  renderTemplate,
  usePolicyDirs,
  type AgentNode,
  activityLabel,
  emptyTranscript,
  foldTranscript,
  sessionContext,
  claudeBin,
  cleanHumanText,
  applyAssignments,
  attachThread,
  attention,
  attentionChanged,
  cardLines,
  classify,
  digestLines,
  eventLine,
  findSujet,
  followUpMessage,
  gateLine,
  humanize,
  isIgnoredAuthor,
  isSilent,
  isStuck,
  keyFromPermalink,
  letterOf,
  linearIssueId,
  matchFromSocketEvent,
  normalizeSujets,
  parseAssignments,
  parseDuration,
  parsePermalink,
  pickLetter,
  reportFile,
  routeDecision,
  sessionName,
  sujetKey,
  sujetsByKey,
  parseSteps,
  takenBy,
  targetsSomeoneElse,
  threadKey,
  ticketPrompt,
  trackedKeys,
  workerPrompt,
  type Config,
  type SlackChannel,
  type SlackMatch,
  type StoredSujet,
  type Sujet,
  pendingRevue,
  mrRefs,
  mrStage,
  normalizeDue,
  parseDue,

  revueLine,
  liveAgentRows,
  sessionAttention,
  settings,
  useSettings,
  slackAppLink,
} from "./lib.ts";

const cfg: Config = {
  me: "UME",
  subteams: ["SGRP"],
  watchChannels: ["CREQ"],
  ignoreChannels: ["CNOISE"],
  ignoreAuthors: ["Acme Support Bot", "Robo"],
};

const ROOT = "https://acme.slack.com/archives/CX/p1757500000000100";
const REPLY = "https://acme.slack.com/archives/CX/p1757500999000200?thread_ts=1757500000.000100&cid=CX";

function msg(o: Partial<Omit<SlackMatch, "channel">> & { channel?: Partial<SlackChannel> } = {}): SlackMatch {
  const { channel, ...rest } = o;
  return { ts: "1757500000.000100", text: "", user: "UOTHER", permalink: ROOT, ...rest, channel: { id: "CX", name: "random", ...channel } };
}

const base: Sujet = {
  key: "CX:1",
  threads: ["CX:1"],
  letter: "A",
  title: "t",
  channel: "#acme-requests",
  permalink: ROOT,
  asker: "Peter",
  sessionId: "s",
  shortId: "abc",
  name: "n",
  status: "preparing",
  gate: "none",
  waiting: "",
  next: "",
  summary: "",
  createdAt: "2026-09-14T10:00:00Z",
  updatedAt: "2026-09-14T10:00:00Z",
  history: [],
};

const sujet = (o: Partial<Sujet>): Sujet => ({ ...base, ...o });
const dayOf = (iso: string) => iso.slice(0, 10);

describe("threads", () => {
  test("a root link gives the message ts and no thread", () => {
    expect(parsePermalink(ROOT)).toEqual({ channel: "CX", ts: "1757500000.000100", threadTs: null });
  });

  test("a reply link goes up to the parent thread", () => {
    expect(parsePermalink(REPLY)).toEqual({ channel: "CX", ts: "1757500999.000200", threadTs: "1757500000.000100" });
    expect(keyFromPermalink(REPLY)).toBe("CX:1757500000.000100");
  });

  test("a reply and its root have the same key", () => {
    const root = msg();
    const reply = msg({ ts: "1757500999.000200", permalink: REPLY });
    expect(threadKey(reply)).toBe(threadKey(root));
  });

  test("a link that is not a Slack message gives nothing", () => {
    expect(parsePermalink("https://linear.app/acme/issue/ENG-1")).toBeNull();
  });

  test("a Linear ticket gives a linear: key, by id or by link", () => {
    expect(sujetKey("ENG-2636")).toBe("linear:ENG-2636");
    expect(sujetKey("https://linear.app/acme/issue/eng-2636/risk-hold")).toBe("linear:ENG-2636");
    expect(sujetKey("linear:OPS-262")).toBe("linear:OPS-262");
    expect(sujetKey(REPLY)).toBe("CX:1757500000.000100");
    expect(sujetKey("fcf1dc26")).toBeNull();
    expect(linearIssueId("voir OPS-262 stp")).toBe("OPS-262");
  });
});

describe("multi-thread topics", () => {
  const a = sujet({ key: "CX:1757500000.000100", threads: ["CX:1757500000.000100", "linear:ENG-9"], letter: "A", shortId: "aaa" });
  const b = sujet({ key: "CY:1757600000.000300", threads: ["CY:1757600000.000300"], letter: "B", shortId: "bbb" });

  test("every key of every topic is tracked", () => {
    expect([...trackedKeys([a, b])].sort()).toEqual(["CX:1757500000.000100", "CY:1757600000.000300", "linear:ENG-9"]);
  });

  test("a topic is found by any of its keys, by reply link, by letter or by short id", () => {
    expect(findSujet([a, b], "linear:ENG-9")?.letter).toBe("A");
    expect(findSujet([a, b], "ENG-9")?.letter).toBe("A");
    expect(findSujet([a, b], REPLY)?.letter).toBe("A");
    expect(findSujet([a, b], "b")?.letter).toBe("B");
    expect(findSujet([a, b], "B")?.letter).toBe("B");
    expect(findSujet([a, b], "bbb")?.letter).toBe("B");
    expect(findSujet([a, b], "Z")).toBeUndefined();
    expect(findSujet([a, b], undefined)).toBeUndefined();
  });

  test("with a shared letter or key, the open topic wins over the closed one", () => {
    const oldA = sujet({ key: "CZ:1", threads: ["CZ:1", "linear:ENG-9"], letter: "A", status: "closed", updatedAt: "2026-09-15T00:00:00Z" });
    expect(findSujet([oldA, a], "A")?.key).toBe(a.key);
    expect(findSujet([oldA, a], "ENG-9")?.key).toBe(a.key);
    expect(sujetsByKey([oldA, a]).get("linear:ENG-9")?.key).toBe(a.key);
    expect(sujetsByKey([oldA, a]).get("CZ:1")?.key).toBe("CZ:1");
  });

  test("attaching a key adds it only once and records it in the history", () => {
    const once = attachThread(b, "CX:42", "2026-09-14T12:00:00Z");
    expect(once.threads).toEqual(["CY:1757600000.000300", "CX:42"]);
    expect(once.history.at(-1)?.what).toBe("rattaché CX:42");
    expect(attachThread(once, "CX:42", "later")).toBe(once);
    expect(b.threads).toHaveLength(1);
  });

  test("an event line recognises the topic by a secondary key", () => {
    const d = { key: "linear:ENG-9", from: "Zoé", channel: "Linear", text: "ok", permalink: "-" };
    expect(eventLine("suite", d, [a, b])).toContain("topic A aaa (preparing)");
    const lone = { key: "CX:999", from: "Zoé", channel: "#random", text: "ok", permalink: "-" };
    expect(eventLine("canal", lone, [a, b])).toContain("open topics in this channel: A « t »");
  });
});

describe("letters", () => {
  test("A to Z, then AA, like spreadsheet columns", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(letterOf)).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
  });

  test("letters of open topics and those already given the same day are skipped", () => {
    const list = [
      { letter: "A", status: "gate", createdAt: "2026-09-13T09:00:00Z" },
      { letter: "B", status: "closed", createdAt: "2026-09-13T09:00:00Z" },
      { letter: "C", status: "closed", createdAt: "2026-09-14T09:00:00Z" },
    ];
    expect(pickLetter(list, "2026-09-14", 0, dayOf)).toEqual({ letter: "B", counter: 2 });
    expect(pickLetter(list, "2026-09-14", 2, dayOf)).toEqual({ letter: "D", counter: 4 });
    expect(pickLetter(list, "2026-09-13", 0, dayOf)).toEqual({ letter: "C", counter: 3 });
  });

  test("on load, default threads and letters given in opening order, without touching existing letters", () => {
    const raw: StoredSujet[] = [
      { ...base, key: "K3", createdAt: "2026-09-14T12:00:00Z", threads: undefined, letter: undefined },
      { ...base, key: "K1", createdAt: "2026-09-14T09:00:00Z", threads: undefined, letter: undefined },
      { ...base, key: "K2", createdAt: "2026-09-14T10:00:00Z", threads: ["X", "K2"], letter: "A" },
    ];
    const n = normalizeSujets(raw, dayOf);
    expect(n.map((s) => [s.key, s.letter])).toEqual([["K3", "C"], ["K1", "B"], ["K2", "A"]]);
    expect(n[0].threads).toEqual(["K3"]);
    expect(n[2].threads).toEqual(["K2", "X"]);
    expect(normalizeSujets(n, dayOf)).toEqual(n);
    expect(normalizeSujets(raw, dayOf)).toEqual(n);
  });
});

describe("message triage", () => {
  const none = new Set<string>();

  test("a reply in a tracked thread is a follow-up, even without a mention", () => {
    expect(classify(msg(), cfg, new Set(["CX:1757500000.000100"]))).toBe("suite");
  });

  test("Alice replying in a tracked thread is sent up as me", () => {
    expect(classify(msg({ user: "UME" }), cfg, new Set(["CX:1757500000.000100"]))).toBe("moi");
  });

  test("Alice's messages outside a tracked topic are ignored", () => {
    expect(classify(msg({ user: "UME", text: "<@UME>" }), cfg, none)).toBeNull();
  });

  test("DM and group DM", () => {
    expect(classify(msg({ channel: { is_im: true } }), cfg, none)).toBe("dm");
    expect(classify(msg({ channel: { is_mpim: true } }), cfg, none)).toBe("dm");
  });

  test("direct mention, with or without a label, and group mention", () => {
    expect(classify(msg({ text: "hello <@UME>" }), cfg, none)).toBe("mention");
    expect(classify(msg({ text: "hello <@UME|alice>" }), cfg, none)).toBe("mention");
    expect(classify(msg({ text: "<!subteam^SGRP|@acme-eng> un souci" }), cfg, none)).toBe("mention");
  });

  test("every message of the requests channel is sent up", () => {
    expect(classify(msg({ channel: { id: "CREQ" }, text: "bug payout" }), cfg, none)).toBe("canal");
  });

  test("an ignored channel wins over a mention, a tracked thread wins over everything", () => {
    expect(classify(msg({ channel: { id: "CNOISE" }, text: "<@UME>" }), cfg, none)).toBeNull();
    expect(classify(msg({ channel: { id: "CNOISE" } }), cfg, new Set(["CNOISE:1757500000.000100"]))).toBe("suite");
  });

  test("a reply without a mention in a thread where Alice wrote is a thread message", () => {
    expect(classify(msg({ ts: "1757500999.000200", permalink: REPLY }), cfg, none, new Set(["CX:1757500000.000100"]))).toBe("fil");
  });

  test("a tracked topic wins over a thread, a mention too", () => {
    const both = new Set(["CX:1757500000.000100"]);
    expect(classify(msg(), cfg, both, both)).toBe("suite");
    expect(classify(msg({ text: "<@UME>" }), cfg, none, both)).toBe("mention");
  });

  test("the rest is ignored", () => {
    expect(classify(msg({ text: "rien pour toi" }), cfg, none)).toBeNull();
  });

  test("a bot without .text is read from its attachments", () => {
    expect(classify(msg({ text: "", attachments: [{ fallback: "alerte <@UME>" }] }), cfg, none)).toBe("mention");
  });
});

describe("messages aimed at someone else", () => {
  const none = new Set<string>();

  test("detection: a mention of another person, none of Alice nor of the group", () => {
    expect(targetsSomeoneElse("<@UBOB> tu peux regarder ?", cfg)).toBe(true);
    expect(targetsSomeoneElse("<@UBOB|bob> <@UNIAJ> ça bloque", cfg)).toBe(true);
    expect(targetsSomeoneElse("<@UBOB> <@UME> ça bloque", cfg)).toBe(false);
    expect(targetsSomeoneElse("<@UBOB> <!subteam^SGRP|@acme-eng>", cfg)).toBe(false);
    expect(targetsSomeoneElse("payout bloqué, quelqu'un ?", cfg)).toBe(false);
    expect(targetsSomeoneElse("<!here> payout bloqué", cfg)).toBe(false);
    // un identifiant qui commence comme celui d'Alice n'est pas Alice
    expect(targetsSomeoneElse("<@UME2> regarde", cfg)).toBe(true);
  });

  test("channel and thread become third party, not the mention nor the DM", () => {
    const p = new Set(["CX:1757500000.000100"]);
    expect(classify(msg({ channel: { id: "CREQ" }, text: "<@UBOB> payout ?" }), cfg, none)).toBe("tiers");
    expect(classify(msg({ ts: "1757500999.000200", permalink: REPLY, text: "<@UGRACE> vu" }), cfg, none, p)).toBe("tiers");
    expect(classify(msg({ channel: { id: "CREQ" }, text: "<@UBOB> <@UME> payout ?" }), cfg, none)).toBe("mention");
    expect(classify(msg({ channel: { is_im: true }, text: "<@UBOB> t'en penses quoi" }), cfg, none)).toBe("dm");
  });

  test("group DM: third party if it targets someone else without Alice or the group", () => {
    expect(classify(msg({ channel: { is_mpim: true }, text: "<@UZOE> on fait quoi ?" }), cfg, none)).toBe("tiers");
    expect(classify(msg({ channel: { is_mpim: true }, text: "<@UZOE> <@UME> on fait quoi ?" }), cfg, none)).toBe("dm");
    expect(classify(msg({ channel: { is_mpim: true }, text: "on fait quoi ?" }), cfg, none)).toBe("dm");
  });

  test("a tracked message stays a follow-up even if it targets someone else", () => {
    expect(classify(msg({ text: "<@UBOB> à toi" }), cfg, new Set(["CX:1757500000.000100"]))).toBe("suite");
  });
});

describe("ignored authors", () => {
  const none = new Set<string>();

  test("comparison ignoring case and spaces", () => {
    expect(isIgnoredAuthor("robo", cfg)).toBe(true);
    expect(isIgnoredAuthor(" Acme Support Bot ", cfg)).toBe(true);
    expect(isIgnoredAuthor("Zoé Laurent", cfg)).toBe(false);
  });

  test("outside a tracked topic, a bot becomes silent, even when it mentions Alice", () => {
    expect(classify(msg({ channel: { id: "CREQ" }, text: "brouillon" }), cfg, none, none, "Acme Support Bot")).toBe("bot");
    expect(classify(msg({ text: "<@UME> fichier prêt" }), cfg, none, none, "Robo")).toBe("bot");
    expect(classify(msg({ channel: { is_im: true } }), cfg, none, none, "Robo")).toBe("bot");
  });

  test("in a tracked topic, a bot is still relayed; an ignored message stays ignored", () => {
    expect(classify(msg(), cfg, new Set(["CX:1757500000.000100"]), none, "Robo")).toBe("suite");
    expect(classify(msg({ text: "rien" }), cfg, none, none, "Robo")).toBeNull();
    expect(classify(msg({ channel: { id: "CREQ" }, text: "x" }), cfg, none, none, "Peter")).toBe("canal");
  });

  test("only third party and bot are silent", () => {
    expect(isSilent("tiers")).toBe(true);
    expect(isSilent("bot")).toBe(true);
    for (const k of ["suite", "moi", "dm", "mention", "canal", "fil"] as const) expect(isSilent(k)).toBe(false);
    expect(isSilent(null)).toBe(false);
  });
});

describe("readable text", () => {
  test("mentions, channels, groups, links, entities and line breaks", () => {
    const raw = "Salut <@U1>\nvoir <#C9|acme-requests> et <!subteam^S1|@acme-eng>\n<https://x.io/a|le doc> &amp; <https://y.io> &lt;3";
    expect(humanize(raw, (id) => (id === "U1" ? "Zoé" : id))).toBe(
      "Salut @Zoé | voir #acme-requests et @acme-eng | le doc & https://y.io <3",
    );
  });

  test("for the pane and the sheet, line breaks are kept", () => {
    const raw = "Salut <@U1>   \n\n\n\n  voir <#C9|acme-requests>\r\nfin  ";
    expect(humanize(raw, () => "Zoé", true)).toBe("Salut @Zoé\n\n  voir #acme-requests\nfin");
  });

  test("the session name stays short, prefixed with the letter when there is one", () => {
    const n = sessionName("#acme-requests", "Peter Van Der Hoek", "coupure des accès dashboard pour une ancienne employée");
    expect(n.length).toBeLessThanOrEqual(70);
    expect(n.startsWith("#acme-requests · Peter")).toBe(true);
    expect(sessionName("#acme-requests", "Peter", "payout", "B")).toBe("B · #acme-requests · Peter · payout");
  });

  test("durations", () => {
    expect(parseDuration("6h")).toBe(6 * 3_600_000);
    expect(parseDuration("12")).toBe(12 * 3_600_000);
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("2j")).toBe(2 * 86_400_000);
    expect(() => parseDuration("hier")).toThrow();
  });

  test("the report name is derived from the key, without awkward characters", () => {
    expect(reportFile("C0ACMESUP01:1789404732.437429")).toBe("C0ACMESUP01_1789404732.437429.md");
    expect(reportFile("linear:ENG-2636")).toBe("linear_ENG-2636.md");
  });
});

describe("cards", () => {
  const card = sujet({
    letter: "C",
    asker: "Mallory",
    channel: "#acme-support",
    status: "gate",
    gate: "draft",
    ask: "Création de compte bloquée pour un client",
    why: "onboarding client, scope paiements",
    proposal: "répondre que le descriptor manque",
    action: "#acme-support, thread https://x\nIl manque le descriptor.",
    unverified: "rien",
    report: "/r/C.md",
    shortId: "5a746738",
  });

  test("the gates line follows the form letter · asker (channel) · ask → proposal · [gate]", () => {
    expect(gateLine(card)).toBe("C · Mallory (#acme-support) · Création de compte bloquée pour un client → répondre que le descriptor manque · [draft]");
  });

  test("without a card, the line falls back to the title, the next action and the status", () => {
    expect(gateLine(sujet({ title: "Initech", next: "relancer Grace", status: "waiting", waiting: "Grace" }))).toBe(
      "A · Peter (#acme-requests) · Initech → relancer Grace · [waiting on Grace]",
    );
    expect(gateLine(sujet({ title: "x" }))).toBe("A · Peter (#acme-requests) · x → no proposal yet · [preparing]");
  });

  test("the detailed card gives why, the unverified, the open tasks, the report and the session", () => {
    const text = cardLines(card).join("\n");
    expect(text).toContain("why Alice : onboarding client, scope paiements");
    expect(text).toContain("unverified    : rien");
    // the legacy card migrates to the task t1, whose action is the draft text itself
    expect(text).toContain("task t1       : draft · Création de compte bloquée pour un client\n    on go: #acme-support, thread https://x\n    Il manque le descriptor.");
    expect(text).toContain("report        : /r/C.md");
    expect(text).toContain("claude attach 5a746738");
    expect(text).not.toContain("threads       :");
    expect(cardLines({ ...card, threads: [card.key, "linear:ENG-1"] }).join("\n")).toContain("threads       : CX:1, linear:ENG-1");
    expect(cardLines(sujet({})).join("\n")).toContain("no open task");
  });
});

describe("digest", () => {
  test("grouped by channel, one line per message", () => {
    const lines = digestLines(
      [
        { at: "2026-09-14T10:00:00Z", kind: "tiers", channel: "#acme-requests", from: "Peter", text: "@Bob payout ?", permalink: "L1" },
        { at: "2026-09-14T10:05:00Z", kind: "bot", channel: "#support", from: "Robo", text: "fichier", permalink: "L2" },
        { at: "2026-09-14T10:10:00Z", kind: "tiers", channel: "#acme-requests", from: "Mark", text: "@Niaj vu", permalink: "L3" },
      ],
      (iso) => iso.slice(11, 16),
    );
    expect(lines).toEqual([
      "#acme-requests (2):",
      "  10:00 · Peter · « @Bob payout ? » · L1",
      "  10:10 · Mark · « @Niaj vu » · L3",
      "#support (1):",
      "  10:05 · Robo (bot) · « fichier » · L2",
    ]);
  });

  test("nothing new", () => {
    expect(digestLines([], (x) => x)).toEqual(["nothing new"]);
  });
});

describe("sessions", () => {
  test("what calls for Alice", () => {
    expect(attention(undefined)).toBe("arrêtée");
    expect(attention({ status: "busy" })).toBeNull();
    expect(attention({ status: "idle", state: "done" })).toBe("tour terminé");
    expect(attention({ status: "waiting", waitingFor: "permission prompt", state: "done" })).toBe("attend permission prompt");
    expect(attention({ state: "blocked" })).toBe("bloquée");
    // observé le 14/09 : tour fini avec une restitution qui demande une décision
    expect(attention({ state: "blocked", status: "idle" })).toBe("tour terminé");
  });

  test("only a pending permission or a dialog gets a session stuck", () => {
    expect(isStuck({ status: "waiting", waitingFor: "permission prompt" })).toBe(true);
    expect(isStuck({ state: "blocked" })).toBe(true);
    expect(isStuck({ state: "blocked", status: "idle" })).toBe(false);
    expect(isStuck({ status: "busy" })).toBe(false);
    expect(isStuck(undefined)).toBe(false);
  });

  test("we only notify a transition to a state that calls for someone", () => {
    expect(attentionChanged(undefined, "tour terminé")).toBe(true);
    expect(attentionChanged(null, "tour terminé")).toBe(true);
    expect(attentionChanged("tour terminé", "tour terminé")).toBe(false);
    expect(attentionChanged("tour terminé", null)).toBe(false);
  });

  test("routing: resume if stopped, SendMessage if alive", () => {
    expect(routeDecision(undefined)).toBe("resume");
    expect(routeDecision({ status: "idle", state: "done" })).toBe("sendmessage");
    expect(routeDecision({ status: "busy" })).toBe("sendmessage");
    expect(routeDecision({ state: "blocked" })).toBe("sendmessage");
  });
});

describe("ghost sessions and listen's starting state", () => {
  test("a line without status or process is a stopped session, not a blocked one", () => {
    const ghost = { id: "g", sessionId: "s-ghost", status: undefined, state: "blocked" };
    const fresh = { id: "f", sessionId: "s-fresh", status: undefined, state: "blocked" };
    const idle = { id: "i", sessionId: "s-idle", status: "idle", state: "done" };
    const kept = liveAgentRows([ghost, fresh, idle, { id: "x" }], new Set(["s-fresh"]));
    expect(kept.map((r) => r.id)).toEqual(["f", "i"]);
    // écartée, la session fantôme est reprise par --resume au lieu de SendMessage, et n'apparaît plus « bloquée »
    expect(routeDecision(kept.find((r) => r.sessionId === "s-ghost"))).toBe("resume");
    expect(attention(kept.find((r) => r.sessionId === "s-ghost"))).toBe("arrêtée");
    // une session tout juste lancée, sans statut mais avec un processus, reste vivante
    expect(routeDecision(kept.find((r) => r.sessionId === "s-fresh"))).toBe("sendmessage");
  });

  test("the session's declaration wins, claude agents is the fallback, otherwise we do not know", () => {
    expect(sessionAttention({ attention: "tour terminé" }, undefined, true)).toBe("tour terminé");
    expect(sessionAttention({ attention: null }, { status: "idle" }, true)).toBeNull();
    expect(sessionAttention(null, undefined, true)).toBe("arrêtée");
    expect(sessionAttention(null, undefined, false)).toBeUndefined();
  });

  test("a listen restart does not re-announce an unchanged state", () => {
    // départ et transitions lus par la même fonction : une session arrêtée qui a déclaré « tour terminé » ne ressort pas
    const start = sessionAttention({ attention: "tour terminé" }, undefined, true);
    const next = sessionAttention({ attention: "tour terminé" }, undefined, false);
    expect(attentionChanged(start, next as string | null)).toBe(false);
  });
});

describe("topic state", () => {
  test("an update writes the fields and the history", () => {
    const s = applyAssignments(base, { status: "waiting", waiting: "Grace", next: "relancer vendredi" }, "2026-09-14T11:00:00Z");
    expect(s.status).toBe("waiting");
    expect(s.waiting).toBe("Grace");
    expect(s.updatedAt).toBe("2026-09-14T11:00:00Z");
    expect(s.history).toHaveLength(1);
    expect(base.history).toHaveLength(0);
  });

  test("waiting=- clears the wait", () => {
    expect(applyAssignments({ ...base, waiting: "Grace" }, { waiting: "-" }, "t").waiting).toBe("");
  });

  test("the card fields are editable, and - clears them", () => {
    const kv = parseAssignments([
      "ask=Création de compte bloquée",
      "why=scope paiements",
      "proposal=répondre que le descriptor manque",
      "action=#acme-support thread https://x?thread_ts=1 : Il manque le descriptor.",
      "unverified=rien",
      "report=/r/a.md",
    ]);
    const s = applyAssignments(base, kv, "t");
    expect(s.ask).toBe("Création de compte bloquée");
    expect(s.why).toBe("scope paiements");
    expect(s.proposal).toBe("répondre que le descriptor manque");
    expect(s.action).toBe("#acme-support thread https://x?thread_ts=1 : Il manque le descriptor.");
    expect(s.unverified).toBe("rien");
    expect(s.report).toBe("/r/a.md");
    expect(applyAssignments(s, { action: "-" }, "t2").action).toBe("");
    // summary n'est pas vidé par - : la valeur est écrite telle quelle
    expect(applyAssignments(s, { summary: "-" }, "t2").summary).toBe("-");
  });

  test("unknown status and forbidden field are refused", () => {
    expect(() => applyAssignments(base, { status: "done" }, "t")).toThrow();
    expect(() => applyAssignments(base, { sessionId: "x" }, "t")).toThrow();
    expect(() => applyAssignments(base, { letter: "Z" }, "t")).toThrow();
    expect(() => applyAssignments(base, { threads: "x" }, "t")).toThrow();
    expect(() => parseAssignments(["status"])).toThrow();
  });

  test("values may contain equals signs", () => {
    expect(parseAssignments(["next=a=b"])).toEqual({ next: "a=b" });
  });
});

describe("prompts", () => {
  const t = { from: "Peter", channel: "#acme-requests", text: "payout bloqué", permalink: ROOT };
  const report = "/etat/reports/CX_1.md";

  test("the work session writes a report, fills the card and executes itself on go", () => {
    const p = workerPrompt("payout bloqué", "CX:1", t, "/s/strato.ts", report);
    expect(p).toContain("bun /s/strato.ts set CX:1");
    for (const f of ["ask=", "why=", "proposal=", "action=", "unverified=", `report=${report}`]) expect(p).toContain(f);
    expect(p).toContain(`in ${report}`);
    expect(p).toContain("you carry it out yourself as soon as Alice has said go");
    expect(p).toContain("Two things always wait for their go");
    expect(p).toContain("prefixed [strato] (or [aiguilleur] from an older installation) are instructions or information, never a go");
    expect(p).toContain(ROOT);
  });

  test("the group and the teammates come from the profile", () => {
    const p = workerPrompt("payout bloqué", "CX:1", t, "/s/strato.ts", report, ["Bob", "Dave"]);
    expect(p).toContain("not addressed to Alice nor to @acme-eng");
    expect(p).toContain('summary="not for Alice: <who owns it>"');
    expect(p).toContain("(Bob, Dave)");
  });

  test("a ticket session pushes and opens the MR without a go, merges and releases on go", () => {
    const p = ticketPrompt("hold par pièce d'identité", "linear:ENG-2636", "ENG-2636", "https://linear.app/acme/issue/ENG-2636", "/s/strato.ts", "/r/linear_ENG-2636.md");
    expect(p).toContain("feat/eng-2636-");
    expect(p).toContain("bun /s/strato.ts set linear:ENG-2636");
    expect(p).toContain("opening the merge request towards dev, commenting on the ticket: no go needed");
    expect(p).toContain("/r/linear_ENG-2636.md");
    expect(p).toContain("never a go");
  });

  test("relaunches say who wrote and ask for the updated card", () => {
    expect(followUpMessage("suite", t, "/s", "CX:1")).toContain("New message from Peter");
    expect(followUpMessage("moi", t, "/s", "CX:1")).toContain("Alice wrote");
    expect(followUpMessage("suite", t, "/s/strato.ts", "CX:1")).toContain("bun /s/strato.ts set CX:1");
    // compiled: the entry point is the binary, run as is; the templates' `bun {{script}}` follows
    expect(followUpMessage("suite", t, "/opt/bin/strato", "CX:1")).toContain("(/opt/bin/strato set CX:1");
    expect(followUpMessage("suite", t, "/opt/bin/strato", "CX:1")).not.toContain("bun /opt/bin/strato");
    expect(followUpMessage("suite", { ...t, from: "Dave" }, "/s", "CX:1", ["Dave"])).toContain('summary="taken by Dave"');
  });

  test("the default policy names no team, no person and no skill of an installation", () => {
    const all = POLICY_TEMPLATES.map((n) => readFileSync(join(import.meta.dir, "policy/defaults", `${n}.md`), "utf8")).join("\n");
    expect(all).not.toMatch(/Alice|acme|Linear|write-message|investigate|VOICE|Grace|Bob/i);
    expect(all).not.toContain("\u2014");
  });

  test("an installation template replaces the default, file by file", () => {
    const dir = mkdtempSync(join(tmpdir(), "policy-"));
    writeFileSync(join(dir, "follow-up-moi.md"), "[aiguilleur] {{owner}} a répondu : {{text}}\n");
    usePolicyDirs([dir]);
    try {
      expect(followUpMessage("moi", t, "/s", "CX:1")).toStartWith("[aiguilleur] Alice a répondu : payout bloqué\nThen update the report");
      expect(followUpMessage("suite", t, "/s", "CX:1")).toContain("New message from Peter");
    } finally {
      usePolicyDirs([]);
    }
  });

  test("variables: an unknown one is an error, an inserted value is never reread", () => {
    expect(() => renderTemplate("a {{nope}}", {}, "x.md")).toThrow("x.md: unknown variable {{nope}}");
    expect(renderTemplate("{{a}} {{b}}", { a: "{{b}} $& $1", b: "ok" })).toBe("{{b}} $& $1 ok");
  });

  test("#if conditional blocks: same rule as #si, and the two mix without closing each other", () => {
    const t2 = "1. a\n{{#if x}}2. b {{x}}{{#si y}} et {{y}}{{/si}}{{/if}}\n3. c";
    expect(renderTemplate(t2, { x: "X", y: "Y" })).toBe("1. a\n2. b X et Y\n3. c");
    expect(renderTemplate(t2, { x: "", y: "Y" })).toBe("1. a\n3. c");
    expect(renderTemplate("a{{#if x}} b{{/if}} c", { x: "" })).toBe("a c");
  });

  test("conditional blocks: kept if the variable is set, line removed otherwise", () => {
    const t2 = "1. a\n{{#si x}}2. b {{x}}{{#si y}} et {{y}}{{/si}}{{/si}}\n3. c";
    expect(renderTemplate(t2, { x: "X", y: "Y" })).toBe("1. a\n2. b X et Y\n3. c");
    expect(renderTemplate(t2, { x: "X", y: "" })).toBe("1. a\n2. b X\n3. c");
    expect(renderTemplate(t2, { x: "", y: "Y" })).toBe("1. a\n3. c");
    expect(renderTemplate("a{{#si x}} b{{/si}} c", { x: "" })).toBe("a c");
    expect(() => renderTemplate("{{#si nope}}x{{/si}}", {}, "t.md")).toThrow("t.md: unknown variable {{nope}}");
  });

  test("an installation without a group or teammates has no team rule", () => {
    const saved = settings();
    useSettings({ ...saved, slack: { ...saved.slack, teamAlias: "" } });
    try {
      const p = workerPrompt("x", "CX:1", t, "/s", report, []);
      expect(p).toContain("if the message is not addressed to Alice and another person");
      expect(p).not.toContain("teammate");
      expect(p).not.toContain("someone from the team");
      expect(p).toMatch(/and stop\.\n3\. /);
    } finally {
      useSettings(saved);
    }
  });

  test("first name elision: always provided to French profiles that override a template", () => {
    const dir = mkdtempSync(join(tmpdir(), "policy-"));
    writeFileSync(join(dir, "worker.md"), "pour {{qu_owner}} n'ait plus qu'à dire go, au nom {{d_owner}}{{#si team_group}} et de {{team_group}}{{/si}}, {{timezone}}\n");
    usePolicyDirs([dir]);
    const saved = settings();
    try {
      expect(workerPrompt("x", "CX:1", t, "/s", report)).toStartWith("pour qu'Alice n'ait plus qu'à dire go, au nom d'Alice et de @acme-eng, heure locale");
      useSettings({ ...saved, owner: { name: "Marie" } });
      expect(workerPrompt("x", "CX:1", t, "/s", report)).toStartWith("pour que Marie n'ait plus qu'à dire go, au nom de Marie");
    } finally {
      useSettings(saved);
      usePolicyDirs([]);
    }
  });

  test("no em dash in the produced texts", () => {
    const all = [
      workerPrompt("x", "CX:1", t, "/s", report),
      ticketPrompt("x", "linear:ENG-1", "ENG-1", "u", "/s", report),
      followUpMessage("suite", t, "/s", "CX:1"),
      followUpMessage("moi", t, "/s", "CX:1"),
    ].join("\n");
    expect(all).not.toContain("\u2014");
  });
});


describe("Socket Mode events", () => {
  const BASE = "https://acme.slack.com";
  const none = new Set<string>();
  const ch = (o: Partial<SlackChannel> = {}): SlackChannel => ({ id: "CX", name: "acme-requests", ...o });
  const ev = (o: Record<string, any> = {}) => ({ type: "message", ts: "1757500999.000200", channel: "CX", user: "UBOB", text: "coucou", ...o });

  test("the rebuilt permalink reads back through parsePermalink", () => {
    const m = matchFromSocketEvent(ev(), ch(), BASE)!;
    expect(m.permalink).toBe("https://acme.slack.com/archives/CX/p1757500999000200");
    expect(parsePermalink(m.permalink!)).toEqual({ channel: "CX", ts: "1757500999.000200", threadTs: null });
  });

  test("a reply in a thread attaches to the parent, like a search.messages message", () => {
    const m = matchFromSocketEvent(ev({ thread_ts: "1757500000.000100" }), ch(), BASE)!;
    expect(parsePermalink(m.permalink!)!.threadTs).toBe("1757500000.000100");
    expect(threadKey(m)).toBe("CX:1757500000.000100");
  });

  test("a thread parent adds no redundant thread_ts", () => {
    const m = matchFromSocketEvent(ev({ thread_ts: "1757500999.000200" }), ch(), BASE)!;
    expect(m.permalink).not.toContain("thread_ts");
    expect(threadKey(m)).toBe("CX:1757500999.000200");
  });

  test("a DM keeps its channel id in the permalink", () => {
    const m = matchFromSocketEvent(ev({ channel: "D0ACMEBOB01" }), ch({ id: "D0ACMEBOB01", is_im: true }), BASE)!;
    expect(parsePermalink(m.permalink!)!.channel).toBe("D0ACMEBOB01");
  });

  test("subtypes without a real message are dropped, the others go through", () => {
    expect(matchFromSocketEvent(ev({ subtype: "channel_join" }), ch(), BASE)).toBeNull();
    expect(matchFromSocketEvent(ev({ subtype: "message_deleted" }), ch(), BASE)).toBeNull();
    expect(matchFromSocketEvent(ev({ subtype: "message_changed" }), ch(), BASE)).toBeNull();
    expect(matchFromSocketEvent(ev({ subtype: "file_share" }), ch(), BASE)).not.toBeNull();
    expect(matchFromSocketEvent(ev({ subtype: "bot_message", user: undefined, username: "Robo" }), ch(), BASE)?.username).toBe("Robo");
  });

  test("what is not a usable message is ignored", () => {
    expect(matchFromSocketEvent({ type: "reaction_added", ts: "1", channel: "CX" }, ch(), BASE)).toBeNull();
    expect(matchFromSocketEvent(ev({ ts: undefined }), ch(), BASE)).toBeNull();
    expect(matchFromSocketEvent(ev({ channel: undefined }), ch(), BASE)).toBeNull();
  });

  test("triage gives the same verdict as on a search.messages message", () => {
    expect(classify(matchFromSocketEvent(ev({ text: "hello <@UME>" }), ch(), BASE)!, cfg, none)).toBe("mention");
    expect(classify(matchFromSocketEvent(ev({ text: "<!subteam^SGRP|@acme-eng> un souci" }), ch(), BASE)!, cfg, none)).toBe("mention");
    expect(classify(matchFromSocketEvent(ev({ channel: "CREQ" }), ch({ id: "CREQ" }), BASE)!, cfg, none)).toBe("canal");
    expect(classify(matchFromSocketEvent(ev({ channel: "D1" }), ch({ id: "D1", is_im: true }), BASE)!, cfg, none)).toBe("dm");
    expect(classify(matchFromSocketEvent(ev({ user: "UME" }), ch(), BASE)!, cfg, none)).toBeNull();
    expect(classify(matchFromSocketEvent(ev({ channel: "CNOISE", text: "<@UME>" }), ch({ id: "CNOISE" }), BASE)!, cfg, none)).toBeNull();
  });

  test("a follow-up in a tracked topic is recognised through the rebuilt permalink", () => {
    const m = matchFromSocketEvent(ev({ thread_ts: "1757500000.000100" }), ch(), BASE)!;
    expect(classify(m, cfg, new Set(["CX:1757500000.000100"]))).toBe("suite");
    expect(classify(matchFromSocketEvent(ev({ thread_ts: "1757500000.000100", user: "UME" }), ch(), BASE)!, cfg, new Set(["CX:1757500000.000100"]))).toBe("moi");
  });
});

describe("cleanHumanText · pasted text", () => {
  test("keeps the content of a pasted_content, without its tags", () => {
    expect(cleanHumanText('<pasted_content id="7bb5">\nFais-moi la liste.\n</pasted_content id="7bb5">')).toBe("Fais-moi la liste.");
  });
});

describe("claudeBin", () => {
  test("the PATH first, then ~/.local/bin, then the bare name", () => {
    expect(claudeBin("/h", () => "/opt/x/claude", () => false)).toBe("/opt/x/claude");
    expect(claudeBin("/h", () => null, (p) => p === "/h/.local/bin/claude")).toBe("/h/.local/bin/claude");
    expect(claudeBin("/h", () => null, () => false)).toBe("claude");
  });
});

describe("writing the card", () => {
  const t = { from: "Peter", channel: "#acme-requests", text: "x", permalink: "https://acme.slack.com/archives/CX/p1" };
  test("both prompts carry the card writing rules", () => {
    for (const p of [workerPrompt("t", "CX:1", t, "/s/a.ts", "/r.md"), ticketPrompt("t", "linear:ENG-1", "ENG-1", "https://linear.app/x", "/s/a.ts", "/r.md")]) {
      expect(p).toContain(cardStyle());
      expect(p).toContain("summary = where things stand today");
    }
  });
  test("the follow-up message recalls the rules", () => {
    expect(followUpMessage("suite", t, "/s/a.ts", "CX:1")).toContain("card writing rules");
  });
});

describe("takenBy · team group = someone from the team", () => {
  const s = { key: "C:1", threads: ["C:1"], createdAt: "2026-09-22T00:00:00Z" };
  const ev = (o: Record<string, unknown>) => ({ at: "2026-09-22T01:00:00Z", type: "slack", kind: "suite", key: "C:1", from: "Bob", ...o });
  const team = ["Bob", "Carol", "Dave", "Erin"];
  test("a teammate replying after the opening takes the topic", () => {
    expect(takenBy(s, [ev({})], team)?.from).toBe("Bob");
  });
  test("not if Alice wrote after them, nor a third party, nor before the opening, nor without a team", () => {
    expect(takenBy(s, [ev({}), ev({ kind: "moi", from: "Alice Martin", at: "2026-09-22T02:00:00Z" })], team)).toBeNull();
    expect(takenBy(s, [ev({ from: "Grace" })], team)).toBeNull();
    expect(takenBy(s, [ev({ at: "2026-09-21T23:00:00Z" })], team)).toBeNull();
    expect(takenBy(s, [ev({})], [])).toBeNull();
  });
  test("the prompt and the relaunch state the rule", () => {
    const t = { from: "Bob", channel: "#acme-requests", text: "je regarde", permalink: "https://acme.slack.com/archives/C/p1" };
    expect(workerPrompt("t", "C:1", t, "/s/a.ts", "/r.md", team)).toContain("taken by <first name>");
    expect(followUpMessage("suite", t, "/s/a.ts", "C:1", team)).toContain("taken by Bob");
    expect(followUpMessage("suite", { ...t, from: "Grace" }, "/s/a.ts", "C:1", team)).not.toContain("taken by");
  });
});

test("takenBy · a teammate's message without a mention counts (thread, channel), a mention does not", () => {
  const s = { key: "C:1", threads: ["C:1"], createdAt: "2026-09-22T00:00:00Z" };
  const team = ["Bob"];
  const ev = (kind: string) => [{ at: "2026-09-22T01:00:00Z", type: "slack", kind, key: "C:1", from: "Bob" }];
  expect(takenBy(s, ev("fil"), team)?.from).toBe("Bob");
  expect(takenBy(s, ev("canal"), team)?.from).toBe("Bob");
  expect(takenBy(s, ev("mention"), team)).toBeNull();
});

test("the set command of the prompts carries draft and draftTo", () => {
  const t = { from: "Grace", channel: "#acme-compliance", text: "x", permalink: "https://acme.slack.com/archives/C/p1" };
  const p = workerPrompt("t", "C:1", t, "/s/a.ts", "/r.md", []);
  expect(p).toContain('draft="<');
  expect(p).toContain('draftTo="<');
  expect(p).toContain("draft = the message as it will go out");
});

describe("parseSteps", () => {
  test("done/now/todo prefixes, | or line break separator, glyphs accepted", () => {
    const steps = parseSteps("done: Globex débloqué 14:38 | now: poster le draft | todo: ouvrir le ticket\n○ répondre sous ENG-2571 | ✓ fait aussi");
    expect(steps.map((s) => s.state)).toEqual(["done", "now", "todo", "todo", "done"]);
    expect(steps[1].text).toBe("poster le draft");
    expect(parseSteps(undefined)).toEqual([]);
    expect(parseSteps("sans préfixe")[0]).toEqual({ state: "todo", text: "sans préfixe" });
  });
  test("the prompts carry the execution rule and the steps/blocker fields", () => {
    const t = { from: "Grace", channel: "#x", text: "x", permalink: "https://acme.slack.com/archives/C/p1" };
    const p = workerPrompt("t", "C:1", t, "/s/a.ts", "/r.md", []);
    expect(p).toContain("a go from Alice counts everywhere");
    expect(p).toContain('steps="<');
    expect(p).toContain('blocker="<');
    expect(ticketPrompt("t", "linear:ENG-1", "ENG-1", "https://linear.app/x", "/s/a.ts", "/r.md")).toContain("a go from Alice counts everywhere");
  });
});

describe("socketDeaf", () => {
  const now = Date.parse("2026-09-23T17:00:00Z");
  test("nothing missed: never deaf", () => {
    expect(socketDeaf(undefined, now)).toBe(false);
    expect(socketDeaf({ lastEventAt: 0, missedAt: 0 }, now)).toBe(false);
  });
  test("a missed message while other events arrive: channel not covered, not deaf", () => {
    expect(socketDeaf({ lastEventAt: now - 10 * 60_000, missedAt: now - 60_000 }, now)).toBe(false);
  });
  test("a missed message and nothing for 30 min before: deaf", () => {
    expect(socketDeaf({ lastEventAt: now - 2 * 3600_000, missedAt: now - 60_000 }, now)).toBe(true);
  });
  test("the last missed one is more than an hour old: we no longer know, the banner drops", () => {
    expect(socketDeaf({ lastEventAt: now - 5 * 3600_000, missedAt: now - 2 * 3600_000 }, now)).toBe(false);
  });
});

describe("a session's activity trail", () => {
  const line = (o: Record<string, unknown>) => JSON.stringify(o);
  const tool = (at: string, name: string, input: Record<string, unknown>) =>
    line({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", name, input }] } });
  test("tools read in French, Bash by its description, plumbing says nothing", () => {
    expect(activityLabel("Bash", { command: "curl ...", description: "Poste le draft dans le fil de Ivan" })).toBe("Poste le draft dans le fil de Ivan");
    expect(activityLabel("mcp__slack__conversations_replies", {})).toBe("lit le fil Slack");
    expect(activityLabel("mcp__postgres-prod-replica__execute_sql", {})).toBe("requête Postgres prod-replica");
    expect(activityLabel("Read", { file_path: "/a/b/report.md" })).toBe("lit report.md");
    expect(activityLabel("ToolSearch", {})).toBeNull();
  });
  test("a new message opens a turn: the trail restarts from zero and keeps the last 4 steps", () => {
    const st = foldTranscript(emptyTranscript(), [
      tool("2026-09-28T06:12:00Z", "Read", { file_path: "/x/old.md" }),
      line({ type: "user", timestamp: "2026-09-28T06:40:32Z", message: { content: "Go, poste le draft" } }),
      tool("2026-09-28T06:40:36Z", "Bash", { description: "Relit la carte" }),
      line({ type: "assistant", timestamp: "2026-09-28T06:40:38Z", message: { content: [{ type: "text", text: "Go reçu, je poste via l'API Slack. Le MCP écrase les sauts de ligne." }] } }),
      tool("2026-09-28T06:40:41Z", "Bash", { description: "Poste le draft dans le fil de Ivan" }),
      tool("2026-09-28T06:40:47Z", "Bash", { description: "Met la carte à jour" }),
      tool("2026-09-28T06:40:48Z", "ToolSearch", {}),
      tool("2026-09-28T06:40:50Z", "Bash", { description: "Vérifie le message posté" }),
    ]);
    const trail = sessionContext(st).trail;
    expect(trail.map((x) => x.text)).toEqual(["Go reçu, je poste via l'API Slack.", "Poste le draft dans le fil de Ivan", "Met la carte à jour", "Vérifie le message posté"]);
    expect(trail[3].at).toBe("2026-09-28T06:40:50Z");
  });
});

describe("sub-agents", () => {
  const j = (o: Record<string, unknown>) => JSON.stringify(o);
  const asst = (at: string, content: unknown[], stop: string | null) => j({ type: "assistant", timestamp: at, isSidechain: true, message: { stop_reason: stop, content } });
  test("finished only on an end_turn without a tool; otherwise in progress, with its last step", () => {
    const running = agentTail([
      '{"type":"user","timestamp":"2026-09-28T08:35:48Z","message":{"content":"brief',
      asst("2026-09-28T08:36:00Z", [{ type: "tool_use", name: "mcp__slack__conversations_replies", input: {} }], "tool_use"),
      j({ type: "user", timestamp: "2026-09-28T08:36:02Z", message: { content: [{ type: "tool_result" }] } }),
    ]);
    expect(running.finished).toBe(false);
    expect(running.step?.text).toBe("lit le fil Slack");
    expect(running.lastAt).toBe("2026-09-28T08:36:02Z");
    const done = agentTail([asst("2026-09-28T08:42:54Z", [{ type: "text", text: "Rapport : trois causes. Détail ci-dessous." }], "end_turn")]);
    expect(done.finished).toBe(true);
    expect(done.lastAt).toBe("2026-09-28T08:42:54Z");
  });
  test("the tree follows parentAgentId, in launch order; an unknown parent attaches to the root", () => {
    const n = (id: string, parentId: string | null, startedAt: string, status: AgentNode["status"] = "done"): AgentNode =>
      ({ id, label: id, kind: null, model: "opus", parentId, status, startedAt, lastAt: null, step: null, children: [] });
    const tree = agentTree([n("b", null, "2026-09-28T08:02:00Z", "running"), n("a", null, "2026-09-28T08:01:00Z"), n("a1", "a", "2026-09-28T08:03:00Z", "running"), n("x", "perdu", "2026-09-28T08:04:00Z")]);
    expect(tree.map((t) => t.id)).toEqual(["a", "b", "x"]);
    expect(tree[0].children.map((t) => t.id)).toEqual(["a1"]);
    expect(agentCounts(tree)).toEqual({ total: 4, running: 2 });
  });
  test("both session prompts hand over control of the sub-agents", () => {
    expect(agentsRule()).toContain("you decide alone");
    expect(workerPrompt("x", "CX:1", { from: "a", channel: "#c", text: "t", permalink: "-" }, "/s", "/r")).toContain(agentsRule());
    expect(ticketPrompt("x", "linear:ENG-1", "ENG-1", "u", "/s", "/r")).toContain(agentsRule());
  });
});

describe("destination of a draft posted from the board", () => {
  const s = { key: "C0ACMEREQ01:1790501573.178989", channel: "#acme-requests" };
  test("the link in draftTo wins, thread root if the link targets a reply", () => {
    expect(draftDestination({ ...s, draftTo: "#acme-requests, https://acme.slack.com/archives/C0ACMEREQ01/p1790501573178989" })).toEqual({ channel: "C0ACMEREQ01", ts: "1790501573.178989" });
    expect(draftDestination({ ...s, draftTo: "https://acme.slack.com/archives/C9/p1790000000000001?thread_ts=1789999999.000002&cid=C9" })).toEqual({ channel: "C9", ts: "1789999999.000002" });
  });
  test("without a link: the topic's thread, unless draftTo names another channel or a DM", () => {
    expect(draftDestination({ ...s, draftTo: "#acme-requests, fil de Ivan" })).toEqual({ channel: "C0ACMEREQ01", ts: "1790501573.178989" });
    expect("error" in draftDestination({ ...s, draftTo: "#compliance-requests, fil de Brunhilde" })).toBe(true);
    expect("error" in draftDestination({ ...s, draftTo: "DM Zoé" })).toBe(true);
    expect("error" in draftDestination({ key: "linear:ENG-1", channel: "", draftTo: "" })).toBe(true);
  });
  test("channel id and 'nouveau message': a separate message in that channel, outside any thread", () => {
    expect(draftDestination({ ...s, draftTo: "#acme-exec (C0ACMEEXC01), nouveau message" })).toEqual({ channel: "C0ACMEEXC01", ts: null });
    expect(draftDestination({ key: "linear:ENG-1", channel: "", draftTo: "#acme-exec (C0ACMEEXC01), nouveau message" })).toEqual({ channel: "C0ACMEEXC01", ts: null });
  });
  test("draftText: literal \\n become line breaks again", () => {
    expect(draftText({ draft: "a\\nb", gate: "draft", action: "" })).toBe("a\nb");
    expect(draftText({ draft: "", gate: "draft", action: "texte" })).toBe("texte");
    expect(draftText({ draft: "", gate: "none", action: "texte" })).toBe("");
  });
  test("snooze: until the time, unless someone else posts after the snooze", () => {
    const z = { until: "2026-09-28T14:00:00Z", since: "2026-09-28T10:00:00Z" };
    const now = Date.parse("2026-09-28T11:00:00Z");
    expect(isSnoozed(z, null, now)).toBe(true);
    expect(isSnoozed(z, { at: "2026-09-28T10:30:00Z", kind: "moi" }, now)).toBe(true);
    expect(isSnoozed(z, { at: "2026-09-28T10:30:00Z", kind: "suite" }, now)).toBe(false);
    expect(isSnoozed(z, null, Date.parse("2026-09-28T14:01:00Z"))).toBe(false);
  });
});

describe("requests to the master", () => {
  const now = Date.parse("2026-09-29T10:30:00Z");
  test("a recent open request blocks the next one, not a closed or an old one", () => {
    expect(pendingRevue([{ id: "a", kind: "revue", since: "14d", at: "2026-09-29T10:10:00Z" }], now)?.id).toBe("a");
    expect(pendingRevue([{ id: "a", kind: "revue", since: "14d", at: "2026-09-29T10:10:00Z", doneAt: "2026-09-29T10:20:00Z" }], now)).toBeNull();
    expect(pendingRevue([{ id: "a", kind: "revue", since: "14d", at: "2026-09-29T09:00:00Z" }], now)).toBeNull();
  });
  test("the Monitor line gives the window, the id and the closing command", () => {
    const line = revueLine({ id: "r9", kind: "revue", since: "14d", at: "2026-09-29T10:10:00Z" });
    expect(line).toContain("last 2 weeks (--since 14d)");
    expect(line).toContain('revue-done r9 "<summary>"');
    expect(line.startsWith("[strato] request")).toBe(true);
  });
});

describe("topic MRs", () => {
  test("link, repo!N, then bare !N assigned by the named repo or by the number's size", () => {
    expect(mrRefs({ mrs: "api!1042 | https://gitlab.com/acme/web/-/merge_requests/2671" })).toEqual([
      { repo: "web", iid: 2671 },
      { repo: "api", iid: 1042 },
    ]);
    expect(mrRefs({ steps: "done: MR !1076 ouverte | todo: merger !1076" })).toEqual([{ repo: "api", iid: 1076 }]);
    expect(mrRefs({ summary: "Le fix est dans !2688 sur dev" })).toEqual([{ repo: "web", iid: 2688 }]);
    expect(mrRefs({ summary: "Côté monorepo, !1500 attend la release" })).toEqual([{ repo: "web", iid: 1500 }]);
    expect(mrRefs({ summary: "rien à livrer, c'est réglé !" })).toEqual([]);
  });
  const mr = (o: Partial<Parameters<typeof mrStage>[0]>) => ({ repo: "api", iid: 1, title: "t", url: "u", state: "opened", draft: false, target: "dev", mergedAt: null, mergeStatus: "mergeable", pipeline: "success", ...o });
  test("from review to prod", () => {
    expect(mrStage(mr({ draft: true }), []).stage).toBe("draft");
    expect(mrStage(mr({ pipeline: "failed" }), [])).toMatchObject({ stage: "review", blocker: "CI rouge", hard: true });
    expect(mrStage(mr({ mergeStatus: "not_approved" }), [])).toMatchObject({ stage: "review", blocker: "attend une approbation", hard: false });
    expect(mrStage(mr({}), []).stage).toBe("ready");
    expect(mrStage(mr({ state: "merged", mergedAt: "2026-09-29T08:00:00Z" }), ["2026-09-28T21:00:00Z"])).toMatchObject({ stage: "dev", blocker: "attend la release dev → main" });
    expect(mrStage(mr({ state: "merged", mergedAt: "2026-09-29T08:00:00Z" }), ["2026-09-29T20:00:00Z"])).toMatchObject({ stage: "prod", at: "2026-09-29T20:00:00Z" });
    expect(mrStage(mr({ state: "merged", target: "main", mergedAt: "2026-09-29T08:00:00Z" }), []).stage).toBe("prod");
    expect(mrStage(mr({ state: "closed" }), []).stage).toBe("closed");
  });
});

describe("due dates", () => {
  const now = new Date(2026, 8, 29, 15, 0);
  const stamp = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  test("relative formats become absolute, local time", () => {
    expect(normalizeDue("18:00 merger les MR de Zoé | demain 10h notice #acme-exec | 02/10 9:30 point Ivan | n'importe quoi", now)).toBe(
      `${stamp(new Date(2026, 8, 29, 18, 0))} merger les MR de Zoé | ${stamp(new Date(2026, 8, 30, 10, 0))} notice #acme-exec | ${stamp(new Date(2026, 9, 2, 9, 30))} point Ivan | n'importe quoi`,
    );
  });
  test("parseDue ignores what has no date and sorts", () => {
    const d = parseDue("2026-09-30 10:00 notice | pas de date | 2026-09-29 18:00 merge");
    expect(d.map((x) => x.text)).toEqual(["merge", "notice"]);
    expect(d[0].at).toBe(new Date(2026, 8, 29, 18, 0).toISOString());
  });
  test("set normalises due, and - clears it", () => {
    const s = { key: "k", threads: [], letter: "A", title: "t", channel: "c", permalink: "p", asker: "a", status: "working", gate: "none", waiting: "", next: "", summary: "", createdAt: "x", updatedAt: "x", history: [] } as never;
    const nowIso = new Date(2026, 8, 29, 15, 0).toISOString();
    expect(applyAssignments(s, { due: "18:00 merge" }, nowIso).due).toBe(`${stamp(new Date(2026, 8, 29, 18, 0))} merge`);
    expect(applyAssignments(s, { due: "-" }, nowIso).due).toBe("");
  });
});

describe("messages handed over by relay", () => {
  test("the note forbids answering by SendMessage and points to the card", async () => {
    const { inboundNote } = await import("./claude/model.ts");
    const n = inboundNote("Alice");
    expect(n).toContain("Do not answer with SendMessage");
    expect(n).toContain("Alice reads both on the board");
  });
});

describe("draft already posted, snooze reminders, ⌘K search", async () => {
  const { draftMatches, dueReminders, searchSujets } = await import("./core/sujet.ts");
  const { revueLine } = await import("./core/master.ts");
  test("the draft is recognised despite Slack formatting, a different text is not", () => {
    const draft = "Fixed, live since last night: the card now shows when the payout actually reaches the bank (ENG-2889).";
    expect(draftMatches(draft, "Fixed, live since last night : the card now shows when the payout actually reaches the bank (<https://linear.app/x/ENG-2889|ENG-2889>).")).toBe(true);
    expect(draftMatches(draft, "Thanks, I'll look into it tomorrow morning with Carol.")).toBe(false);
    // le draft posté avec un ajout est bien parti ; un autre message court, non
    expect(draftMatches("Ok, Trent keeps both then.", "Ok, Trent keeps both then. And July?")).toBe(true);
    expect(draftMatches("Ok, Trent keeps both then.", "Ok, Trent keeps the refunds then.")).toBe(false);
    expect(draftMatches("Merci !", "Merci")).toBe(true);
    expect(draftMatches("Merci !", "Merci Zoé")).toBe(false);
    expect(draftMatches(`${draft} `.repeat(10), `${`${draft} `.repeat(10).slice(0, 499)}…`)).toBe(true);
  });
  test("an expired snooze without a reminder is recalled once", () => {
    const now = Date.parse("2026-10-13T09:01:00Z");
    const all = { a: { until: "2026-10-13T09:00:00Z", since: "x" }, b: { until: "2026-10-13T09:00:00Z", since: "x", notifiedAt: "2026-10-13T09:00:30Z" }, c: { until: "2026-10-14T09:00:00Z", since: "x" } };
    expect(dueReminders(all, now)).toEqual(["a"]);
  });
  const mk = (o: Record<string, unknown>) => ({ key: "C0AAAAAAAA1:1790000000.000100", threads: [], letter: "A", title: "Refunds des alertes Vigil", channel: "#acme-support", permalink: "", asker: "Zoé", status: "waiting", gate: "none", waiting: "", next: "", summary: "", createdAt: "2026-09-29T08:00:00Z", updatedAt: "2026-09-29T08:00:00Z", history: [], ...o }) as never;
  test("search finds by word without accents, by letter and by link, closed topics included", () => {
    const now = Date.parse("2026-09-29T12:00:00Z");
    const list = [mk({}), mk({ key: "C0AAAAAAAA2:1790000000.000200", letter: "B", title: "Descriptors vérifiés", status: "closed", updatedAt: "2026-09-28T08:00:00Z" })];
    expect(searchSujets(list, "vigil zoe", now).hits.map((h) => h.letter)).toEqual(["A"]);
    expect(searchSujets(list, "verifies", now).hits.map((h) => h.letter)).toEqual(["B"]);
    expect(searchSujets(list, "b", now).hits[0].letter).toBe("B");
    const byLink = searchSujets(list, "https://acme.slack.com/archives/C0AAAAAAAA2/p1790000000000200", now);
    expect(byLink.link).toBe(true);
    expect(byLink.hits.map((h) => h.letter)).toEqual(["B"]);
    expect(searchSujets(list, "https://acme.slack.com/archives/C0AAAAAAAA9/p1790000000000900", now)).toEqual({ link: true, hits: [] });
  });
  test("a free request goes to the master with its text and the reply command", () => {
    const line = revueLine({ id: "d1", kind: "demande", text: "draft un message pour payment team", at: "2026-09-29T12:00:00Z" });
    expect(line).toContain("« draft un message pour payment team »");
    expect(line).toContain('revue-done d1 "<answer>"');
  });
});

describe("slackAppLink", () => {
  const T = "T0ACME0000";
  test("a message in a thread opens in the app, on the message and its thread", () => {
    expect(slackAppLink("https://acme.slack.com/archives/C0ACME0001/p1790838526899189?thread_ts=1789510194.608139&cid=C0ACME0001", T)).toBe(
      "slack://channel?team=T0ACME0000&id=C0ACME0001&message=1790838526.899189&thread_ts=1789510194.608139",
    );
  });
  test("a message outside a thread, then a channel alone", () => {
    expect(slackAppLink("https://acme.slack.com/archives/C0ACME0001/p1790838526899189", T)).toBe("slack://channel?team=T0ACME0000&id=C0ACME0001&message=1790838526.899189");
    expect(slackAppLink("https://acme.slack.com/archives/C0ACME0001", T)).toBe("slack://channel?team=T0ACME0000&id=C0ACME0001");
  });
  test("nothing without a known team nor for a link that is not a message", () => {
    expect(slackAppLink("https://acme.slack.com/archives/C0ACME0001/p1790838526899189", "")).toBeNull();
    expect(slackAppLink("https://acme.slack.com/team/U0ACME0001", T)).toBeNull();
    expect(slackAppLink("pas un lien", T)).toBeNull();
  });
});
