import { describe, expect, test } from "bun:test";
import { applyAssignments, normalizeSujets, type StoredSujet, type Sujet } from "./core/sujet.ts";
import { addTask, closeTask, editTask, legacyTasks, openTasks, reopenTask, rollbackHazards, staleCardAction, taskDraftText, tasksOf } from "./core/tasks.ts";

const T0 = "2026-10-01T08:00:00Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const dayOf = (iso: string) => iso.slice(0, 10);

function card(over: Partial<Sujet> = {}): Sujet {
  return {
    key: "C1:1.1",
    threads: ["C1:1.1"],
    letter: "E",
    title: "MCP staff",
    channel: "#tp",
    permalink: "https://acme.slack.com/archives/C1/p1",
    asker: "Judy",
    sessionId: "sess-e",
    shortId: "s1",
    name: "E",
    status: "working",
    gate: "none",
    waiting: "",
    next: "",
    summary: "",
    createdAt: T0,
    updatedAt: T0,
    history: [],
    tasks: [],
    ...over,
  };
}

const DRAFT = { kind: "draft", ask: "Bob asks if it is live", proposal: "Answer yes", draft: "Yes, live since 10:00.", draftTo: "#tp, https://acme.slack.com/archives/C1/p1", action: "post the draft in #tp" };

describe("migration of a stored card", () => {
  test("an open gate with a draft becomes t1, origin set, aged from the start of the gate", () => {
    const raw = card({ status: "gate", gate: "draft", ask: "Bob asks", draft: "Hello", draftTo: "#tp", action: "post", updatedAt: at(30), history: [{ at: at(10), what: "status=gate gate=draft ask=Bob asks draft=Hello" }] });
    const { tasks: _, ...stored } = raw;
    const [s] = normalizeSujets([stored as StoredSujet], dayOf);
    expect(s.tasks).toHaveLength(1);
    expect(s.tasks?.[0]).toMatchObject({ id: "t1", kind: "draft", ask: "Bob asks", draft: "Hello", status: "open", origin: "set", createdAt: at(10) });
  });
  test("the gate decides the kind; a gate without draft nor action, or a topic not at a gate, has no task", () => {
    expect(legacyTasks(card({ status: "gate", gate: "merge", action: "merge !12", tasks: undefined }))[0].kind).toBe("action");
    expect(legacyTasks(card({ status: "gate", gate: "decision", action: "x", tasks: undefined }))[0].kind).toBe("decision");
    expect(legacyTasks(card({ status: "gate", gate: "question", draft: "y", draftTo: "#x", tasks: undefined }))[0].kind).toBe("question");
    expect(legacyTasks(card({ status: "gate", gate: "decision", action: "", draft: "-", tasks: undefined }))).toEqual([]);
    expect(legacyTasks(card({ status: "waiting", gate: "none", action: "x", tasks: undefined }))).toEqual([]);
  });
  test("an action written before the current request is not carried over: no Go on a stale action", () => {
    const history = [
      { at: at(0), what: "status=gate gate=decision ask=Replay the script? action=replay the SQL script in prod" },
      { at: at(60), what: "status=gate gate=decision ask=Send the DM to Judy? proposal=Short DM" },
    ];
    expect(staleCardAction({ history }, at(0))).toBe(true);
    const [x] = legacyTasks(card({ status: "gate", gate: "decision", ask: "Send the DM to Judy?", action: "replay the SQL script in prod", history, tasks: undefined }));
    expect(x.action).toBe("");
    expect(x.kind).toBe("decision");
    expect(x.ask).toBe("Send the DM to Judy?");
  });
  test("an action written with the current request is kept", () => {
    const history = [
      { at: at(0), what: "status=gate gate=decision ask=Old request" },
      { at: at(60), what: "status=gate gate=go ask=Send the DM? action=send the DM to Judy" },
    ];
    const [x] = legacyTasks(card({ status: "gate", gate: "go", ask: "Send the DM?", action: "send the DM to Judy", history, tasks: undefined }));
    expect(x.action).toBe("send the DM to Judy");
    expect(x.kind).toBe("action");
  });
  test("an already migrated topic keeps its tasks", () => {
    const s = card({ status: "gate", gate: "draft", draft: "x", tasks: [] });
    expect(normalizeSujets([s], dayOf)[0].tasks).toEqual([]);
  });
});

describe("rolling back to a binary without typed targets", () => {
  test("open tasks with a typed target, a tool action or an audience are named; free-text drafts are not", () => {
    let s = card({ letter: "A" });
    s = addTask(s, DRAFT, at(1)).sujet;
    s = addTask(s, { kind: "draft", ask: "Comment?", draft: "Internal note", to: "linear:ENG-12" }, at(2)).sujet;
    s = addTask(s, { kind: "action", ask: "Close?", act: "setStatus", value: "Done", to: "linear:ENG-12" }, at(3)).sujet;
    expect(rollbackHazards([s])).toEqual(["A t2: to=linear:ENG-12", "A t3: to=linear:ENG-12 act=setStatus"]);
    expect(rollbackHazards([closeTask(closeTask(s, "t2", "dropped", at(4)), "t3", "done", at(5))])).toEqual([]);
    expect(rollbackHazards([{ ...s, status: "closed" }])).toEqual([]);
  });
});

describe("task operations", () => {
  test("add: ids t1, t2, the topic becomes a gate; done and drop close them", () => {
    let s = card();
    const a = addTask(s, DRAFT, at(1));
    expect(a.task.id).toBe("t1");
    expect(a.sujet.status).toBe("gate");
    const b = addTask(a.sujet, { kind: "action", ask: "Merge?", action: "merge api!12" }, at(2));
    expect(b.task.id).toBe("t2");
    s = closeTask(b.sujet, "t1", "done", at(3), "posted");
    expect(openTasks(s).map((x) => x.id)).toEqual(["t2"]);
    expect(s.status).toBe("gate");
    s = closeTask(s, "t2", "dropped", at(4));
    expect(openTasks(s)).toEqual([]);
    expect(s.status).toBe("working");
    expect(s.gate).toBe("none");
    expect(tasksOf(s).find((x) => x.id === "t1")).toMatchObject({ status: "done", note: "posted", closedAt: at(3) });
    // an id is never reused
    expect(addTask(s, { kind: "question", ask: "Which one?" }, at(5)).task.id).toBe("t3");
  });
  test("validation: kind known, draft requires draftTo, unknown fields refused, closed topic refused", () => {
    expect(() => addTask(card(), { kind: "nope", ask: "x" }, at(1))).toThrow("unknown kind");
    expect(() => addTask(card(), { ask: "x" }, at(1))).toThrow("kind is required");
    expect(() => addTask(card(), { kind: "draft", ask: "x", draft: "hello" }, at(1))).toThrow("draftTo");
    expect(() => addTask(card(), { kind: "action", ask: "x" }, at(1))).toThrow("action");
    expect(() => addTask(card(), { kind: "decision", ask: "x", why: "y" }, at(1))).toThrow("unknown task field: why");
    expect(() => addTask(card({ status: "closed" }), { kind: "decision", ask: "x" }, at(1))).toThrow("closed");
    expect(() => closeTask(card(), "t9", "done", at(1))).toThrow("no task t9");
  });
  test("edit changes only the given fields of an open task; reopen undoes a close", () => {
    const { sujet } = addTask(card(), DRAFT, at(1));
    const e = editTask(sujet, "t1", { draft: "Yes, live." }, at(2));
    expect(taskDraftText(tasksOf(e)[0])).toBe("Yes, live.");
    expect(tasksOf(e)[0].createdAt).toBe(at(1));
    expect(() => editTask(e, "t1", { draftTo: "-" }, at(3))).toThrow("draftTo");
    const closed = closeTask(e, "t1", "done", at(4));
    expect(() => editTask(closed, "t1", { ask: "x" }, at(5))).toThrow("done");
    const back = reopenTask(closed, "t1", at(5));
    expect(openTasks(back)).toHaveLength(1);
    expect(back.status).toBe("gate");
  });
  test("closing the topic drops every open task, task origin included", () => {
    const { sujet } = addTask(card(), { kind: "decision", ask: "Pick one" }, at(1));
    const closed = applyAssignments(sujet, { status: "closed", gate: "none", waiting: "-" }, at(2));
    expect(openTasks(closed)).toEqual([]);
    expect(tasksOf(closed)[0]).toMatchObject({ status: "dropped", note: "sujet fermé" });
  });
});

describe("compatibility of set", () => {
  const legacy = (s: Sujet, kv: Record<string, string>, min: number) => applyAssignments(s, kv, at(min));

  test("a set with a gate and a draft creates a task of origin set; the same request updates it in place", () => {
    let s = legacy(card(), { status: "gate", gate: "draft", ask: "Bob asks", draft: "v1", draftTo: "#tp", action: "post" }, 1);
    expect(openTasks(s)).toHaveLength(1);
    expect(openTasks(s)[0]).toMatchObject({ id: "t1", origin: "set", draft: "v1", createdAt: at(1) });
    s = legacy(s, { status: "gate", gate: "draft", ask: "Bob asks", draft: "v2" }, 5);
    expect(openTasks(s)).toHaveLength(1);
    expect(openTasks(s)[0]).toMatchObject({ id: "t1", draft: "v2", createdAt: at(1), updatedAt: at(5) });
  });
  test("a new request replaces the open set task: the old one is dropped, its action no longer shows", () => {
    let s = legacy(card(), { status: "gate", gate: "decision", ask: "Replay the script?", action: "replay the SQL script in prod" }, 1);
    s = legacy(s, { status: "gate", gate: "decision", ask: "Send the DM to Judy?", proposal: "Short DM" }, 60);
    const open = openTasks(s);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id: "t2", ask: "Send the DM to Judy?", createdAt: at(60) });
    // the legacy session never cleared action: the stale action stays on the card, never on the new task
    expect(s.action).toBe("replay the SQL script in prod");
    expect(open[0].action).toBe("");
    expect(tasksOf(s).find((x) => x.id === "t1")).toMatchObject({ status: "dropped", note: "remplacée par une nouvelle demande" });
  });
  test("gate=none or status waiting: the open set task is done; status working leaves it", () => {
    const s = legacy(card(), { status: "gate", gate: "draft", ask: "Bob", draft: "x", draftTo: "#tp" }, 1);
    expect(openTasks(legacy(s, { status: "working" }, 2))).toHaveLength(1);
    const none = legacy(s, { gate: "none", status: "waiting", waiting: "Bob" }, 3);
    expect(openTasks(none)).toEqual([]);
    expect(none.status).toBe("waiting");
    expect(tasksOf(none)[0].status).toBe("done");
  });
  test("set never touches a task of origin task; status waiting with an open task stays a gate", () => {
    const { sujet } = addTask(card(), { kind: "action", ask: "Merge?", action: "merge api!12" }, at(1));
    const s = legacy(sujet, { status: "waiting", gate: "none", waiting: "CI" }, 2);
    expect(openTasks(s).map((x) => x.id)).toEqual(["t1"]);
    expect(s.status).toBe("gate");
    const c = legacy(s, { status: "closed" }, 3);
    expect(tasksOf(c)[0].status).toBe("dropped");
  });
  test("a draft already posted is not resurrected by a set that rewrites it", () => {
    let s = legacy(card(), { status: "gate", gate: "draft", ask: "Bob", draft: "Yes", draftTo: "#tp" }, 1);
    s = closeTask(s, "t1", "done", at(2), "posted");
    s = legacy(s, { status: "gate", gate: "draft", ask: "Bob", draft: "Yes", draftTo: "#tp" }, 3);
    expect(openTasks(s)).toEqual([]);
    expect(s.status).toBe("working");
  });
  test("a set that does not touch the card fields leaves the tasks alone", () => {
    const s = legacy(card(), { status: "gate", gate: "draft", ask: "Bob", draft: "x", draftTo: "#tp" }, 1);
    const after = legacy(s, { summary: "news" }, 2);
    expect(after.tasks).toEqual(s.tasks);
  });
});
