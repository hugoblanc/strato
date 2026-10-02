/**
 * Triage on provider items (core/triage.ts): the rules every provider shares, the rules derived from an account's
 * settings, and the Slack message as an item.
 */
import { describe, expect, test } from "bun:test";
import { lastMessageOf } from "./board.ts";
import { staleSignals } from "./core/refresh.ts";
import { type Sujet, takenBy } from "./core/sujet.ts";
import { classify, type Config, slackItem } from "./chat/slack-model.ts";
import { classifyItem, editAlreadyRaised, isItemEvent, itemEventType, NO_RULES, triageRules, withoutAuthors } from "./core/triage.ts";
import type { Item } from "./providers/sdk.ts";
import { SLACK_DESCRIPTOR } from "./providers/slack/model.ts";

const item = (o: Partial<Item> = {}): Item => ({
  thread: "PLAT-12",
  id: "PLAT-12/comment/1",
  event: "comment",
  author: { id: "u-bob", name: "Bob", isMe: false, isBot: false },
  conversation: { id: "PLAT", label: "Tickets PLAT", kind: "ticket" },
  text: "looks good",
  time: 1_790_000_000_000,
  link: "https://tickets.example/PLAT-12",
  mentionsMe: false,
  targetsOther: false,
  ...o,
});
const KEY = "tickets:PLAT-12";
const none = new Set<string>();
const rules = { ...NO_RULES, watch: ["PLAT"], ignore: ["NOISE"], ignoreAuthors: ["Deploy Bot"] };

describe("classifyItem", () => {
  test("a tracked thread gives suite, or moi for the person's own item", () => {
    expect(classifyItem(item(), KEY, rules, new Set([KEY]), none)).toBe("suite");
    expect(classifyItem(item({ author: { id: "u-alice", name: "Alice", isMe: true, isBot: false } }), KEY, rules, new Set([KEY]), none)).toBe("moi");
  });

  test("a status event outside a tracked thread is ignored, inside one it follows the topic", () => {
    const status = item({ event: "status", mentionsMe: true });
    expect(classifyItem(status, KEY, rules, none, none)).toBeNull();
    expect(classifyItem(status, KEY, rules, new Set([KEY]), none)).toBe("suite");
  });

  test("an assignment to the person is a mention, in any conversation", () => {
    expect(classifyItem(item({ event: "assigned", mentionsMe: true, conversation: { id: "OPS", label: "Tickets OPS", kind: "ticket" } }), KEY, rules, none, none)).toBe("mention");
  });

  test("watched conversation, participated thread, someone else targeted, ignored conversation", () => {
    expect(classifyItem(item({ event: "created" }), KEY, rules, none, none)).toBe("canal");
    expect(classifyItem(item({ event: "created", targetsOther: true }), KEY, rules, none, none)).toBe("tiers");
    const elsewhere = item({ conversation: { id: "OPS", label: "Tickets OPS", kind: "ticket" } });
    expect(classifyItem(elsewhere, KEY, rules, none, none)).toBeNull();
    expect(classifyItem(elsewhere, KEY, rules, none, new Set([KEY]))).toBe("fil");
    expect(classifyItem(item({ mentionsMe: true, conversation: { id: "NOISE", label: "Noise", kind: "channel" } }), KEY, rules, none, none)).toBeNull();
  });

  test("an author of ignoreAuthors turns a kept item into bot, only once the authors are read", () => {
    // in a chat channel: a bot there is not set aside by itself, only by its name
    const bot = item({ author: { id: "u-deploy", name: " deploy bot ", isMe: false, isBot: true }, conversation: { id: "PLAT", label: "#plat", kind: "channel" } });
    expect(classifyItem(bot, KEY, rules, none, none)).toBe("bot");
    expect(classifyItem(bot, KEY, withoutAuthors(rules), none, none)).toBe("canal");
  });

  test("on a ticket, a bot or an automation goes to the digest unless it targets the person; a tracked ticket still follows", () => {
    const sync = item({ author: { id: "", name: "GitHub", isMe: false, isBot: true } });
    expect(classifyItem(sync, KEY, NO_RULES, none, new Set([KEY]))).toBe("bot");
    expect(classifyItem(item({ event: "created", author: sync.author }), KEY, rules, none, none)).toBe("bot");
    expect(classifyItem(item({ event: "assigned", mentionsMe: true, author: sync.author }), KEY, NO_RULES, none, none)).toBe("mention");
    expect(classifyItem(sync, KEY, NO_RULES, new Set([KEY]), none)).toBe("suite");
    // a bot in a chat conversation keeps today's rules
    expect(classifyItem(item({ author: sync.author, conversation: { id: "C1", label: "#ops", kind: "channel" } }), KEY, NO_RULES, none, new Set([KEY]))).toBe("fil");
  });

  test("a comment on a ticket the tool says the person follows is a thread they take part in", () => {
    expect(classifyItem(item({ reason: "subscribed" }), KEY, NO_RULES, none, none)).toBe("fil");
    expect(classifyItem(item({ reason: "subscribed", targetsOther: true }), KEY, NO_RULES, none, none)).toBe("tiers");
    expect(classifyItem(item({ reason: "watched" }), KEY, NO_RULES, none, none)).toBeNull();
  });

  test("an edit is raised only when its previous version was not", () => {
    const edit = item({ conversation: { id: "OPS", label: "Tickets OPS", kind: "ticket" }, mentionsMe: true, edited: { before: { mentionsMe: false, targetsOther: false } } });
    expect(editAlreadyRaised(edit, KEY, rules, none, none)).toBe(false);
    expect(editAlreadyRaised({ ...edit, conversation: { id: "PLAT", label: "Tickets PLAT", kind: "ticket" } }, KEY, rules, none, none)).toBe(true);
    expect(editAlreadyRaised(item(), KEY, rules, none, none)).toBe(false);
  });
});

describe("the rules of an account", () => {
  test("Slack's settings give today's rules", () => {
    const r = triageRules({ watchChannels: ["C0ACMEREQ01"], ignoreChannels: ["C0ACMENOISE"], ignoreAuthors: ["Acme Bot"], teammates: ["Bob"], subteams: ["SACME"] }, SLACK_DESCRIPTOR.settings);
    expect(r).toEqual({ watch: ["C0ACMEREQ01"], ignore: ["C0ACMENOISE"], ignoreAuthors: ["Acme Bot"], teammates: ["Bob"] });
  });
  test("a setting that is not a list of strings counts as empty", () => {
    expect(triageRules({ watchTeams: "PLAT", ignore: [1, "X"] }, [{ key: "watchTeams", triage: "watch" }, { key: "ignore", triage: "ignore" }])).toEqual({ ...NO_RULES, ignore: ["X"] });
  });
});

describe("a Slack message as an item", () => {
  const cfg: Config = { me: "UALICE", subteams: ["SACME"], watchChannels: ["C0ACMEREQ01"], ignoreChannels: [], ignoreAuthors: ["Acme Bot"] };
  test("its facts, and the costly part left for later", () => {
    const m = { ts: "1790000140.000100", user: "UBOB", text: "<@UALICE> any news?", channel: { id: "C0ACME0001", name: "acme-support" }, permalink: "https://acme.slack.com/archives/C0ACME0001/p1790000140000100?thread_ts=1790000000.000100&cid=C0ACME0001" };
    const it = slackItem(m, cfg);
    expect(it).toMatchObject({ thread: "C0ACME0001:1790000000.000100", id: "C0ACME0001:1790000140.000100", event: "message", text: "<@UALICE> any news?", time: 1_790_000_140_000, mentionsMe: true, targetsOther: false });
    expect(it.author).toEqual({ id: "UBOB", name: "UBOB", isMe: false, isBot: false });
    expect(it.conversation).toEqual({ id: "C0ACME0001", label: "#acme-support", kind: "channel" });
    expect(slackItem({ ts: "1.2", username: "Acme Bot", channel: { id: "D0ACME0001", is_im: true } }, cfg).author).toEqual({ id: "", name: "Acme Bot", isMe: false, isBot: true });
  });
  test("classify and classifyItem agree on every kind", () => {
    const cases = [
      { ts: "1.1", user: "UBOB", text: "hi", channel: { id: "D0ACME0001", is_im: true } },
      { ts: "1.2", user: "UBOB", text: "<@UDAVE> hi", channel: { id: "G0ACME0001", is_mpim: true } },
      { ts: "1.3", user: "UBOB", text: "<!subteam^SACME> hi", channel: { id: "C0ACME0007" } },
      { ts: "1.4", user: "UBOB", text: "hi", channel: { id: "C0ACMEREQ01" } },
      { ts: "1.5", username: "Acme Bot", text: "hi", channel: { id: "C0ACMEREQ01" } },
      { ts: "1.6", user: "UALICE", text: "hi", channel: { id: "C0ACME0007" } },
    ];
    const r = { ...NO_RULES, watch: cfg.watchChannels, ignore: cfg.ignoreChannels, ignoreAuthors: cfg.ignoreAuthors };
    for (const m of cases) {
      const it = slackItem(m, cfg);
      const named = { ...it, author: { ...it.author, name: m.username ?? "Bob" } };
      expect(classifyItem(named, it.thread, r, none, none)).toBe(classify(m, cfg, none, none, m.username ?? "Bob"));
    }
  });
});

describe("message events in events.ndjson", () => {
  test("Slack keeps its type, other providers log items; readers accept both", () => {
    expect(itemEventType("slack")).toBe("slack");
    expect(itemEventType("tickets")).toBe("item");
    expect(isItemEvent({ type: "slack" })).toBe(true);
    expect(isItemEvent({ type: "item" })).toBe(true);
    expect(isItemEvent({ type: "info" })).toBe(false);
    expect(isItemEvent({})).toBe(false);
  });
});

describe("readers of message events", () => {
  const sujet = (o: Partial<Sujet> = {}): Sujet => ({
    key: "tickets:PLAT-12",
    threads: ["tickets:PLAT-12", "C0ACME0001:1790000000.000100"],
    letter: "A",
    title: "Checkout fails",
    channel: "Tickets PLAT",
    permalink: "-",
    asker: "Peter",
    sessionId: "s",
    shortId: "s1",
    name: "n",
    status: "waiting",
    gate: "none",
    waiting: "Bob",
    next: "",
    summary: "",
    createdAt: "2026-09-21T08:00:00Z",
    updatedAt: "2026-09-21T08:00:00Z",
    history: [],
    ...o,
  });
  const item = { at: "2026-09-21T10:00:00Z", type: "item", kind: "suite", key: "tickets:PLAT-12", from: "Bob", channel: "Tickets PLAT", permalink: "https://tickets.example/PLAT-12" };
  const slack = { at: "2026-09-21T09:00:00Z", type: "slack", kind: "suite", key: "C0ACME0001:1790000000.000100", from: "Carol Smith", channel: "#acme-support", permalink: "-" };
  const other = { at: "2026-09-21T11:00:00Z", type: "open", kind: "suite", key: "tickets:PLAT-12", from: "Mallory" };

  test("the board's last message, the takeover and the card sweep read items and legacy Slack events alike", () => {
    expect(lastMessageOf(sujet(), [slack, item, other])?.from).toBe("Bob");
    expect(lastMessageOf(sujet(), [slack, other])?.from).toBe("Carol Smith");
    expect(takenBy(sujet(), [slack], ["Carol Smith"])?.from).toBe("Carol Smith");
    expect(takenBy(sujet(), [item, other], ["Bob", "Mallory"])?.from).toBe("Bob");
    const now = Date.parse("2026-09-21T12:00:00Z");
    expect(staleSignals(sujet(), [item], now, { staleDays: 3, graceMinutes: 20 }).map((x) => x.code)).toEqual(["fil"]);
    expect(staleSignals(sujet(), [other], now, { staleDays: 3, graceMinutes: 20 })).toEqual([]);
  });
});
