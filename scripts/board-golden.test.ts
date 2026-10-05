/**
 * Golden render of a Slack-only board and panel: drafts with Slack mentions and every kind of destination (a thread, a
 * separate message, a destination that cannot be posted to), attached threads of the same channel, a ticket topic, a
 * settled topic, a session citing Slack threads, the listener's deaf banner. The HTML must stay what it was before the
 * board rendered targets, links and deep links through the providers (docs/design/providers.md, section 15, act).
 * The expected values were recorded on the code before that change.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BoardInput, boardView, buildBoard, focusView } from "./board.ts";
import type { Sujet } from "./lib.ts";
import { sessionView, sujetView } from "./panel.ts";

const GOLDEN_FILE = join(import.meta.dir, "board-golden.json");
/** `STRATO_GOLDEN_RECORD=1 bun test board-golden` rewrites the expected values: only for an intended change of the page. */
const RECORD = process.env.STRATO_GOLDEN_RECORD === "1";
const GOLDEN: Record<string, string> = RECORD ? {} : JSON.parse(readFileSync(GOLDEN_FILE, "utf8"));
afterAll(() => {
  if (RECORD) writeFileSync(GOLDEN_FILE, `${JSON.stringify(GOLDEN, null, 2)}\n`);
});

/**
 * What a later stage adds on purpose, removed before the comparison: the hash of the plan a Send approves
 * (`data-sha`), which the page sends back so the server acts on exactly what was shown.
 */
const normalize = (html: string) => html.replace(/ data-sha="[0-9a-f]*"/g, "");

function check(name: string, html: string): void {
  if (RECORD) GOLDEN[name] = normalize(html);
  else expect(normalize(html)).toBe(GOLDEN[name]);
}

// the dates of attached threads read the local time: pinned, so the golden does not depend on the machine
let tz: string | undefined;
beforeAll(() => {
  tz = process.env.TZ;
  process.env.TZ = "Europe/Paris";
});
afterAll(() => {
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
});

const LINK = "https://acme.slack.com/archives/C0ACMEREQ01/p1790000000000100";
const T = "2026-09-21T08:00:00Z";
const task = (o: Record<string, unknown>) => ({ kind: "draft", ask: "Bob asks for the deploy date", proposal: "answer with the date", action: "post the draft", draft: "", draftTo: "", createdAt: T, updatedAt: T, status: "open", origin: "task", ...o });
const topic = (o: Partial<Sujet> & { key: string }): Sujet => ({
  threads: [o.key],
  letter: "A",
  title: "Deploy date",
  channel: "#acme-requests",
  permalink: LINK,
  asker: "Bob",
  sessionId: null,
  shortId: null,
  name: "A · #acme-requests · Bob",
  status: "gate",
  gate: "draft",
  waiting: "",
  next: "",
  summary: "",
  createdAt: T,
  updatedAt: T,
  history: [],
  ...o,
});

const SUJETS: Sujet[] = [
  topic({
    key: "C0ACMEREQ01:1790000000.000100",
    // a second thread of the same channel in the same minute, and one the next day: the board tells them apart
    threads: ["C0ACMEREQ01:1790000000.000100", "C0ACMEREQ01:1790000030.000200", "C0ACMEREQ01:1790090000.000300", "linear:ENG-12", "D0ACME0001:1790000500.000400"],
    tasks: [
      task({ id: "t1", draft: "Hi <@U0BOB00001>, tomorrow 10:00 in <#C0ACMEOPS01|acme-ops>, see <https://acme.example/runbook|the runbook> and <https://acme.example/x?a=1&b=2>. cc <!subteam^SGRP|@acme-eng> <!here>", draftTo: `#acme-requests, ${LINK}` }),
      task({ id: "t2", kind: "action", ask: "Merge?", action: "merge api!12", draft: "", draftTo: "" }),
    ] as never,
  }),
  topic({ key: "C0ACMEREQ01:1790001000.000100", letter: "B", title: "Announcement", tasks: [task({ id: "t1", draft: "We ship on Monday.", draftTo: "#acme-announcements (C0ACMEANN01), new message" })] as never }),
  topic({ key: "C0ACMEREQ01:1790002000.000100", letter: "C", title: "Wrong channel", tasks: [task({ id: "t1", draft: "Looking into it.", draftTo: "#acme-support" })] as never }),
  topic({ key: "C0ACMEREQ01:1790003000.000100", letter: "D", title: "Merge then answer", tasks: [task({ id: "t1", draft: "Merged, it is live.", action: "merge api!14 then post the draft", draftTo: LINK })] as never }),
  topic({ key: "D0ACME0001:1790004000.000100", letter: "E", title: "A DM", channel: "DM", permalink: "https://acme.slack.com/archives/D0ACME0001/p1790004000000100", tasks: [task({ id: "t1", draft: "Sure.", draftTo: "DM" })] as never }),
  topic({ key: "linear:ENG-12", letter: "F", title: "Checkout fails", channel: "ENG-12", permalink: "https://linear.app/acme/issue/ENG-12", tasks: [task({ id: "t1", draft: "Fixed in api!15.", draftTo: `#acme-requests, ${LINK}` })] as never }),
  topic({ key: "C0ACMEREQ01:1790005000.000100", letter: "G", title: "Settled", status: "closed", gate: "none", summary: "closed: Bob confirmed", updatedAt: "2026-09-21T11:00:00Z" }),
  topic({ key: "C0ACMEREQ01:1790006000.000100", letter: "H", title: "Settled and checked", status: "closed", gate: "none", summary: "closed: done", checked: "2026-09-21T11:30:00Z", updatedAt: "2026-09-21T11:30:00Z" }),
  topic({ key: "C0ACMEREQ01:1790007000.000100", letter: "I", title: "Posted", status: "waiting", gate: "none", waiting: "the rest of the thread", posted: `2026-09-21T11:59:50Z ${LINK}?thread_ts=1790007000.000100`, updatedAt: "2026-09-21T11:59:50Z" }),
];

const input = (): BoardInput => ({
  sujets: SUJETS,
  events: [{ at: "2026-09-21T07:00:00Z", type: "slack", kind: "mention", key: "C0ACMEREQ01:1790000000.000100", from: "Bob", channel: "#acme-requests", permalink: LINK }],
  live: new Map(),
  running: new Map(),
  sessions: [
    {
      sessionId: "sess-x",
      name: "acme-api",
      status: "idle",
      kind: "interactive",
      cwd: "/Users/alice/dev/acme",
      branch: "main",
      startedAt: "2026-09-21T09:00:00Z",
      context: {
        sessionId: "sess-x",
        cwd: "/Users/alice/dev/acme",
        branch: "main",
        title: "Look at the checkout",
        firstRequest: { text: "look at this", at: "2026-09-21T09:00:00Z" },
        lastAgent: null,
        trail: [],
        turnAt: null,
        slackThreads: [{ key: "C0ACMEOPS01:1790000700.000100", url: "https://acme.slack.com/archives/C0ACMEOPS01/p1790000700000100", workspace: "acme" }],
        linearIssues: ["ENG-12"],
        master: false,
      },
    },
  ],
  otherSessions: 0,
  now: new Date("2026-09-21T12:00:00Z"),
  timeOf: (iso: string) => iso.slice(11, 16),
  lastTick: "2026-09-21T11:58:00Z",
  socket: { missedAt: Date.parse("2026-09-21T11:59:00Z"), lastEventAt: Date.parse("2026-09-20T08:00:00Z") },
  slackAppId: "A0ACME00001",
  users: { U0BOB00001: "Bob" },
  undo: new Map([["C0ACMEREQ01:1790007000.000100", { until: Date.parse("2026-09-21T12:00:20Z"), taskId: "t1" }]]),
});

describe("golden render of a Slack-only board", () => {
  test("the board", () => {
    check("board", boardView(buildBoard(input()), { timeOf: (iso: string) => iso.slice(11, 16), now: Date.parse("2026-09-21T12:00:00Z"), readAt: "12:00" }));
  });

  test("the board, focus mode: the same cards as a list and the detail of the first one", () => {
    check("board-focus", focusView(buildBoard(input()), { timeOf: (iso: string) => iso.slice(11, 16), now: Date.parse("2026-09-21T12:00:00Z"), readAt: "12:00" }));
  });

  test("the panel of a topic, with its threads", () => {
    const s = SUJETS[0];
    const dumps = [
      { key: s.key, permalink: LINK, channel: "#acme-requests", messages: [{ at: "09:00", from: "Bob", text: "when do we deploy?" }] },
      { key: "C0ACMEREQ01:1790000030.000200", permalink: "https://acme.slack.com/archives/C0ACMEREQ01/p1790000030000200", messages: [{ at: "09:01", from: "Carol Smith", text: "same question" }] },
    ];
    check("panel-topic", sujetView(s, dumps, null, { timeOf: (iso: string) => iso.slice(5, 16) }));
  });

  test("the panel of a session citing Slack threads", () => {
    const c = input().sessions[0].context;
    if (!c) throw new Error("fixture");
    const dumps = [{ key: "C0ACMEOPS01:1790000700.000100", permalink: "https://acme.slack.com/archives/C0ACMEOPS01/p1790000700000100", channel: "#acme-ops", messages: [{ at: "09:02", from: "Dave", text: "it fails" }] }];
    check("panel-session", sessionView({ name: "acme-api", context: { ...c, slackThreads: [...c.slackThreads, { key: "C0OTHER0001:1790000800.000100", url: "https://other.slack.com/archives/C0OTHER0001/p1790000800000100", workspace: "other" }] }, threads: dumps, sujets: SUJETS }, { timeOf: (iso: string) => iso.slice(5, 16) }));
  });
});
