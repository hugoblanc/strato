/** The card's presentation model (views/card.ts): each rule that keeps a thing said once, in its own test. */
import { describe, expect, test } from "bun:test";
import { type BoardEvent, type BoardLine, classify } from "./board.ts";
import type { Sujet, Task } from "./lib.ts";
import { cardOf, namesPersonServed, planOf, repeatsNeed, saysNothingBlocks, threadRefs } from "./views/card.ts";

const NOW = Date.parse("2026-09-21T12:00:00Z");
const timeOf = (iso: string) => iso.slice(11, 16);
const KEY = "C0ACMEREQ01:1790000000.000100";
const base: Sujet = {
  key: KEY,
  threads: [KEY],
  letter: "A",
  title: "Deploy date",
  channel: "#acme-requests",
  permalink: "https://acme.slack.com/archives/C0ACMEREQ01/p1790000000000100",
  asker: "Ann",
  sessionId: "sess-a",
  shortId: "0a1b2c3d",
  name: "A",
  status: "gate",
  gate: "decision",
  waiting: "",
  next: "",
  summary: "",
  createdAt: "2026-09-21T08:00:00Z",
  updatedAt: "2026-09-21T10:00:00Z",
  history: [],
};
const sujet = (o: Partial<Sujet>): Sujet => ({ ...base, ...o });
const task = (o: Partial<Task>): Task => ({ id: "t1", kind: "decision", ask: "Pick the release day", proposal: "", action: "", draft: "", draftTo: "", createdAt: "2026-09-21T09:00:00Z", updatedAt: "2026-09-21T09:00:00Z", status: "open", origin: "task", ...o });
const msg = (o: Partial<BoardEvent>): BoardEvent => ({ at: "2026-09-21T11:00:00Z", type: "slack", kind: "suite", key: KEY, from: "Zoé", channel: "#acme-requests", permalink: "https://acme.slack.com/archives/C0ACMEREQ01/p1790000900000100", ...o });
const line = (s: Sujet, o: { events?: BoardEvent[]; running?: string | null; lastAgent?: { text: string; at: string | null } | null; trail?: { text: string; at: string | null }[] } = {}): BoardLine =>
  classify(s, o.events ?? [], null, o.running === undefined ? "idle" : o.running, timeOf, null, null, o.lastAgent ?? null, [], (o.trail ?? []) as never);
const card = (l: BoardLine) => cardOf(l, { now: NOW });

describe("the blocker", () => {
  test("is dropped when it repeats the first open task's need", () => {
    const s = sujet({ blocker: "Rename the two descriptors in the dashboard", tasks: [task({ ask: "Rename two descriptors in the dashboard" })] });
    expect(card(line(s)).blocker).toBeNull();
    expect(repeatsNeed("Rename the two descriptors in the dashboard", "Rename two descriptors in the dashboard")).toBe(true);
    expect(repeatsNeed("Zoé confirms the release window", "Pick the release day")).toBe(false);
  });
  test("is dropped when it points at the person served, shown when it names someone else", () => {
    const tasks = [task({})];
    expect(card(line(sujet({ blocker: "your go to merge", tasks }))).blocker).toBeNull();
    expect(card(line(sujet({ blocker: "Alice picks the date", tasks }))).blocker).toBeNull();
    expect(card(line(sujet({ blocker: "ton go pour poster", tasks }))).blocker).toBeNull();
    expect(card(line(sujet({ blocker: "Zoé confirms the release window", tasks }))).blocker).toBe("Zoé confirms the release window");
    expect(namesPersonServed("Zoé confirms", "Alice Martin")).toBe(false);
    expect(namesPersonServed("t'attend sur le choix", "Alice Martin")).toBe(true);
  });
  test("is dropped when it says nothing blocks, in English and in French", () => {
    const tasks = [task({})];
    for (const text of ["Rien, les corrections tournent", "rien, je vérifie à 17:32", "Nothing: the CI runs", "Aucun blocage", "aucune", "Personne ne bloque", "nobody", "None"]) {
      expect(saysNothingBlocks(text)).toBe(true);
      expect(card(line(sujet({ blocker: text, tasks }))).blocker).toBeNull();
    }
    expect(saysNothingBlocks("Zoé confirms the window")).toBe(false);
    expect(saysNothingBlocks("Rientz signs the contract")).toBe(false);
  });
  test("is not shown on a topic that waits on someone else: the status names them", () => {
    expect(card(line(sujet({ status: "waiting", gate: "none", waiting: "Zoé", blocker: "Zoé confirms" }))).blocker).toBeNull();
  });
});

describe("the status, said once", () => {
  test("the gate's verdict as a sentence, with the wait's age", () => {
    const c = card(line(sujet({ tasks: [task({})] })));
    expect(c.status.kind).toBe("go");
    expect(c.status.text).toBe("Décider");
    expect(c.status.age).toBe("3 h");
  });
  test("a working session says its current step, its dot pulses", () => {
    const c = card(line(sujet({ status: "working", gate: "none" }), { running: "busy", trail: [{ text: "reads the thread", at: null }] }));
    expect(c.status.kind).toBe("work");
    expect(c.status.text).toBe("Au travail : reads the thread");
    expect(c.status.pulse).toBe(true);
  });
  test("waiting on someone else reads as such", () => {
    const c = card(line(sujet({ status: "waiting", gate: "none", waiting: "Zoé" })));
    expect(c.status.kind).toBe("wait");
    expect(c.status.text).toBe("Attend Zoé");
  });
});

describe("one age per instant", () => {
  test("the last message keeps no age the status already says", () => {
    // Zoé wrote after the card: the status ("Zoé a écrit · 1 h") and the message share their instant
    const c = card(line(sujet({ tasks: [task({})] }), { events: [msg({ text: "any news?" })] }));
    expect(c.status.age).toBe("1 h");
    expect(c.said?.age).toBeNull();
    expect(c.said?.text).toBe("any news?");
  });
  test("a different instant keeps its own age", () => {
    const c = card(line(sujet({ tasks: [task({})], updatedAt: "2026-09-21T11:30:00Z" }), { events: [msg({ at: "2026-09-21T07:00:00Z", text: "hello" })] }));
    expect(c.status.age).toBe("3 h");
    expect(c.said?.age).toBe("5 h");
  });
  test("the session's last word drops an age already said", () => {
    const c = card(line(sujet({ tasks: [task({ createdAt: "2026-09-21T11:00:00Z" })] }), { lastAgent: { text: "I checked the logs.", at: "2026-09-21T11:00:00Z" } }));
    expect(c.status.age).toBe("1 h");
    expect(c.word?.text).toBe("I checked the logs.");
    expect(c.word?.age).toBeNull();
  });
  test("a message to review without its words says nothing the status does not", () => {
    const c = card(line(sujet({ tasks: [task({})] }), { events: [msg({})] }));
    expect(c.status.text).toBe("Zoé a écrit");
    expect(c.said).toBeNull();
  });
});

describe("the session's last word", () => {
  test("only when newer than the card", () => {
    expect(card(line(sujet({ tasks: [task({})] }), { lastAgent: { text: "older", at: "2026-09-21T09:00:00Z" } })).word).toBeNull();
    expect(card(line(sujet({ tasks: [task({})] }), { lastAgent: { text: "no date", at: null } })).word).toBeNull();
    expect(card(line(sujet({ tasks: [task({})] }), { lastAgent: { text: "newer", at: "2026-09-21T11:30:00Z" } })).word?.text).toBe("newer");
  });
  test("not when the status already quotes it as the current step", () => {
    const l = line(sujet({ status: "working", gate: "none" }), { running: "busy", trail: [{ text: "I opened the MR", at: null }], lastAgent: { text: "I opened the MR and wait for the CI.", at: "2026-09-21T11:30:00Z" } });
    expect(card(l).word).toBeNull();
  });
});

describe("tasks", () => {
  test("the first open task is expanded, the others on one line, finished ones left out", () => {
    const c = card(line(sujet({ tasks: [task({ id: "t1" }), task({ id: "t2", kind: "draft", ask: "Answer Ann", draft: "Tuesday." }), task({ id: "t3", status: "done", closedAt: "2026-09-21T09:30:00Z" })] })));
    expect(c.tasks.map((x) => [x.id, x.kind, x.open])).toEqual([
      ["t1", "decide", true],
      ["t2", "draft", false],
    ]);
  });
  test("kinds map to Decide, Answer, Draft, Go", () => {
    const c = card(line(sujet({ tasks: [task({ id: "t1" }), task({ id: "t2", kind: "question" }), task({ id: "t3", kind: "draft", draft: "x" }), task({ id: "t4", kind: "action", action: "merge api!1" })] })));
    expect(c.tasks.map((x) => x.kind)).toEqual(["decide", "answer", "draft", "go"]);
  });
  test("finished tasks: the last two in the context, the rest counted", () => {
    const done = (id: string, at: string) => task({ id, status: "done", closedAt: at });
    const c = card(line(sujet({ tasks: [done("t1", "2026-09-21T08:00:00Z"), done("t2", "2026-09-21T09:00:00Z"), done("t3", "2026-09-21T10:00:00Z"), task({ id: "t4" })] })));
    expect(c.context.finished.map((x) => x.id)).toEqual(["t3", "t2"]);
    expect(c.context.finishedCount).toBe(3);
  });
});

describe("levels", () => {
  test("without open task the summary is read on the card; with tasks it goes to the context", () => {
    const none = card(line(sujet({ status: "waiting", gate: "none", waiting: "Zoé", summary: "Waiting for the window." })));
    expect(none.need?.summary).toBe("Waiting for the window.");
    expect(none.context.summary).toBeNull();
    const some = card(line(sujet({ summary: "Waiting for the window.", tasks: [task({})] })));
    expect(some.need).toBeNull();
    expect(some.context.summary).toBe("Waiting for the window.");
  });
  test("a due date within 24 h is named on the folded line", () => {
    const l = line(sujet({ tasks: [task({})] }));
    l.dues = [{ at: "2026-09-22T09:00:00Z", text: "release", state: "later", day: "" }];
    expect(card(l).context.dueSoon?.text).toBe("release");
    l.dues = [{ at: "2026-09-24T09:00:00Z", text: "later", state: "later", day: "" }];
    expect(card(l).context.dueSoon).toBeNull();
  });
  test("the plan strip keeps the last done step, the now step and three next ones", () => {
    const p = planOf(sujet({ steps: "done: a | done: b | done: c | now: d | todo: e | todo: f | todo: g | todo: h" }));
    expect(p?.steps.map((x) => x.text)).toEqual(["c", "d", "e", "f", "g"]);
    expect(p?.doneHidden).toBe(2);
    expect(p?.todoHidden).toBe(1);
    expect(planOf(sujet({ steps: "" }))).toBeNull();
  });
});

describe("threads", () => {
  test("to the minute, with the seconds only when two threads of one conversation share it", () => {
    const s = sujet({ threads: [KEY, "C0ACMEREQ01:1790000010.000200", "C0ACMEREQ01:1790000020.000300", "C0ACMEREQ01:1790090000.000400"] });
    const labels = threadRefs(s, new Map([["C0ACMEREQ01", "#acme-requests"]])).map((r) => r.label);
    expect(labels[0]).toBe("#acme-requests");
    expect(labels[1]).toMatch(/^#acme-requests \d\d\/\d\d \d\d:\d\d:\d\d$/);
    expect(labels[2]).toMatch(/^#acme-requests \d\d\/\d\d \d\d:\d\d:\d\d$/);
    expect(labels[3]).toMatch(/^#acme-requests \d\d\/\d\d \d\d:\d\d$/);
  });
  test("older threads fold behind a count, the origin and tickets stay", () => {
    const s = sujet({ threads: [KEY, "linear:ENG-1", "C0ACMEREQ01:1790001000.000100", "C0ACMEREQ01:1790002000.000100", "C0ACMEREQ01:1790003000.000100", "C0ACMEREQ01:1790004000.000100"] });
    const c = card(line(s));
    expect(c.context.threadCount).toBe(6);
    expect(c.context.threads.map((r) => r.key)).toEqual(["linear:ENG-1", "C0ACMEREQ01:1790004000.000100", "C0ACMEREQ01:1790003000.000100"]);
    expect(c.context.older.length).toBe(2);
  });
});
