/** The board renders tasks: one block per open task with its own age and box, closed tasks only in the details. */
import { sendsUnseenMessage, taskReady } from "./core/tasks.ts";
import { describe, expect, test } from "bun:test";
import { type BoardInput, blocOrder, boardView, buildBoard, classify, isQuickGo, lineView, pinLine } from "./board.ts";
import type { Sujet, Task } from "./lib.ts";

const base: Sujet = {
  key: "C0ACMECMP01:1788788755.025729",
  threads: ["C0ACMECMP01:1788788755.025729"],
  letter: "F",
  title: "Demande de changement de banque",
  channel: "#acme-compliance",
  permalink: "https://acme.slack.com/archives/C0ACMECMP01/p1788788755025729",
  asker: "Grace",
  sessionId: "sess-f",
  shortId: "053023ad",
  name: "F",
  status: "gate",
  gate: "draft",
  waiting: "",
  next: "",
  summary: "",
  createdAt: "2026-09-21T07:08:49Z",
  updatedAt: "2026-09-21T11:16:29Z",
  history: [],
};
const sujet = (o: Partial<Sujet>): Sujet => ({ ...base, ...o });
const timeOf = (iso: string) => iso.slice(11, 16);
const ctx = { timeOf, now: Date.parse("2026-09-21T12:00:00Z") };
const input = (o: Partial<BoardInput>): BoardInput => ({ sujets: [], events: [], live: new Map(), running: new Map(), sessions: [], otherSessions: 0, now: new Date("2026-09-21T12:00:00Z"), timeOf, ...o });
const task = (o: Partial<Task>): Task => ({
  id: "t1",
  kind: "draft",
  ask: "Grace demande la date",
  proposal: "",
  action: "poster le draft",
  draft: "",
  draftTo: "#acme-compliance, https://acme.slack.com/archives/C0ACMECMP01/p1788788755025729",
  createdAt: "2026-09-21T09:00:00Z",
  updatedAt: "2026-09-21T09:00:00Z",
  status: "open",
  origin: "task",
  ...o,
});
const two = sujet({
  tasks: [
    task({ id: "t1", draft: "Date : lundi.", createdAt: "2026-09-20T09:00:00Z" }),
    task({ id: "t2", kind: "action", ask: "Merger le fix ?", action: "merger api!1042", draft: "", draftTo: "", createdAt: "2026-09-21T11:00:00Z" }),
    task({ id: "t3", kind: "action", ask: "Rejouer le script SQL ?", action: "rejouer le script SQL en prod", draft: "", draftTo: "", status: "dropped", closedAt: "2026-09-21T10:00:00Z", note: "remplacée par une nouvelle demande" }),
  ],
});

describe("tasks on the board", () => {
  test("two open tasks: two blocks, two ages, a single g g; the dropped task has neither box nor Go", () => {
    const html = lineView(classify(two, [], null, "idle", timeOf), ctx);
    expect(html.match(/data-task-item/g)?.length).toBe(2);
    expect(html).toContain('data-task-item data-task="t1"');
    expect(html).toContain('data-task-item data-task="t2"');
    expect(html).not.toContain('data-task-item data-task="t3"');
    expect(html).not.toContain('data-task="t3" class');
    expect(html).not.toContain(">rejouer le script SQL en prod<");
    // each task its own age: a day for t1, an hour for t2
    expect(html).toContain("<span data-age> · 1 j</span>");
    expect(html).toContain("<span data-age> · 1 h</span>");
    expect(html.match(/>g g<\/span>/g)?.length).toBe(1);
    expect(html.indexOf('data-task-item data-task="t1"')).toBeLessThan(html.indexOf(">g g</span>"));
    expect(html.indexOf(">g g</span>")).toBeLessThan(html.indexOf('data-task-item data-task="t2"'));
    // one filled button per task: Send for t1, Go for t2
    expect(html.match(/bg-accent px-3/g)?.length).toBe(2);
    expect(html.match(/data-task-op="done"/g)?.length).toBe(2);
    expect(html).toContain('data-go="C0ACMECMP01:1788788755.025729" data-task="t2"');
  });

  test("the badge counts the tasks; the edge and the sort follow the oldest", () => {
    const l = classify(two, [], null, "idle", timeOf);
    expect(l.verdict).toBe("2 tâches");
    expect(l.waitingSince).toBe("2026-09-20T09:00:00Z");
    const recent = sujet({ key: "C9:9.9", letter: "Q", sessionId: "sess-q", tasks: [task({ id: "t1", draft: "x", createdAt: "2026-09-21T11:30:00Z" })] });
    const m = buildBoard(input({ sujets: [recent, two], running: new Map([["sess-f", "idle"], ["sess-q", "idle"]]) }));
    expect(m.attend.map((x) => x.sujet.letter)).toEqual(["F", "Q"]);
  });

  test("finished tasks are in Details, and the card's request is no longer there", () => {
    const html = lineView(classify({ ...two, ask: "Ancienne demande de la carte" }, [], null, "idle", timeOf), ctx);
    expect(html).toContain("Tâches terminées");
    expect(html).toContain('data-closed-task="t3"');
    expect(html).toContain("remplacée par une nouvelle demande");
    expect(html).not.toContain("Ancienne demande de la carte");
  });

  test("just a go only if every open task is ready", () => {
    expect(isQuickGo(classify(two, [], null, "idle", timeOf))).toBe(true);
    const mixed = sujet({ tasks: [task({ id: "t1", draft: "x" }), task({ id: "t2", kind: "decision", ask: "5 % ou 0 % ?", action: "", draft: "", draftTo: "" })] });
    const l = classify(mixed, [], null, "idle", timeOf);
    expect(isQuickGo(l)).toBe(false);
    // the decision has its Done and Drop buttons, without a box nor a Go
    expect(lineView(l, ctx)).toContain('data-task-ops><span class="flex shrink-0');
  });

  test("a migrated card whose action comes from another request shows no Go", () => {
    const e = sujet({
      gate: "decision",
      ask: "Tu veux envoyer le DM à Judy ?",
      action: "rejouer le script SQL en prod",
      draft: "",
      history: [
        { at: "2026-09-21T08:00:00Z", what: "status=gate gate=decision ask=Rejouer le script ? action=rejouer le script SQL en prod" },
        { at: "2026-09-21T09:00:00Z", what: "status=gate gate=decision ask=Tu veux envoyer le DM à Judy ?" },
      ],
    });
    const html = lineView(classify(e, [], null, "idle", timeOf), ctx);
    expect(html).toContain("Tu veux envoyer le DM à Judy ?");
    expect(html).not.toContain("data-go=");
    expect(html).not.toContain("rejouer le script SQL en prod");
  });
});

describe("a task that would post unseen messages", () => {
  const unseen = { id: "t1", kind: "action" as const, ask: "Avancer", action: "poster la notice #acme-exec, puis le DM à Oscar", createdAt: "2026-10-01T09:00:00Z", updatedAt: "2026-10-01T09:00:00Z", status: "open" as const, origin: "set" as const };
  test("is detected in French and English, and is never ready for a go", () => {
    expect(sendsUnseenMessage(unseen)).toBe(true);
    expect(sendsUnseenMessage({ ...unseen, action: "post the notice in #acme-exec, then DM Oscar" })).toBe(true);
    expect(sendsUnseenMessage({ ...unseen, action: "merger api!1143 vers dev" })).toBe(false);
    expect(sendsUnseenMessage({ ...unseen, kind: "draft" as never, draft: "Hello" })).toBe(false);
    expect(taskReady(unseen)).toBe(false);
  });
});

describe("pin in the go queue", () => {
  const ready = (letter: string, at: string) => sujet({ key: `C${letter}:1`, threads: [`C${letter}:1`], letter, sessionId: `s-${letter}`, tasks: [task({ id: "t1", draft: "ok", createdAt: at })] });
  const decision = sujet({ key: "CD:1", threads: ["CD:1"], letter: "D", sessionId: "s-D", tasks: [task({ id: "t1", kind: "decision", ask: "5 % ou 0 % ?", action: "", draft: "", draftTo: "", createdAt: "2026-09-21T08:00:00Z" })] });
  const sujets = [ready("P", "2026-09-21T09:00:00Z"), ready("Q", "2026-09-21T10:00:00Z"), decision];
  const rowsOf = (html: string) => [...html.matchAll(/<li[^>]*data-letter="(\w)"/g)].map((x) => x[1]);
  const quickOf = (html: string) => rowsOf(html.slice(html.indexOf("data-quick"), html.indexOf("</ul>", html.indexOf("data-quick"))));

  test("a draft sent from the queue stays in the queue, at its place, while its session works", () => {
    const before = buildBoard(input({ sujets }));
    expect(blocOrder("attend", before.attend).map((l) => l.sujet.letter)).toEqual(["P", "Q", "D"]);
    // Q was second in "just a go"; its draft is sent and its session wakes up
    const after = buildBoard(input({ sujets, running: new Map([["s-Q", "busy"]]) }));
    expect(after.travail.map((l) => l.sujet.letter)).toEqual(["Q"]);
    const html = boardView(pinLine(after, { key: "CQ:1", bloc: "attend", index: 1, quick: true }), ctx);
    expect(rowsOf(html).slice(0, 3)).toEqual(["P", "Q", "D"]);
    expect(quickOf(html)).toEqual(["P", "Q"]);
    expect(html).toContain("data-held");
  });
  test("a decision acted on stays first of its sub-list", () => {
    const after = buildBoard(input({ sujets, running: new Map([["s-D", "busy"]]) }));
    const html = boardView(pinLine(after, { key: "CD:1", bloc: "attend", index: 2 }), ctx);
    expect(rowsOf(html).slice(0, 3)).toEqual(["P", "Q", "D"]);
    expect(quickOf(html)).toEqual(["P", "Q"]);
  });
});
