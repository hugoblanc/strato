/** The protocol the sessions receive: `set` for the state, `task` for what waits; the sweep reasons on open tasks. */
import { describe, expect, test } from "bun:test";
import { staleSignals } from "./core/refresh.ts";
import type { Sujet } from "./core/sujet.ts";
import { refreshMessage, ticketPrompt, workerPrompt } from "./policy/prompts.ts";

const trigger = { from: "Bob", channel: "#support", text: "is it live?", permalink: "https://acme.slack.com/archives/C0ACME0001/p1" };

describe("card protocol in the prompts", () => {
  test("worker: set without the card fields, task add per kind, done as soon as executed, new topic for another request", () => {
    const p = workerPrompt("is it live", "C0ACME0001:1", trigger, "/s/strato.ts", "/r/x.md");
    expect(p).toContain("bun /s/strato.ts set C0ACME0001:1 status=<working|waiting|closed>");
    expect(p).not.toMatch(/set C0ACME0001:1 [^\n]*gate=</);
    expect(p).not.toMatch(/set C0ACME0001:1 [^\n]*draft=</);
    for (const kind of ["draft", "action", "decision", "question"]) expect(p).toContain(`bun /s/strato.ts task C0ACME0001:1 add kind=${kind}`);
    expect(p).toContain("task C0ACME0001:1 done <id>");
    expect(p).toContain("task C0ACME0001:1 drop <id>");
    expect(p).toContain("never set status=gate yourself");
    expect(p).toContain("propose to open a new topic");
    expect(p).not.toContain("—");
  });
  test("ticket: no draft task, the merge is an action task", () => {
    const p = ticketPrompt("fix", "linear:ENG-1", "ENG-1", "https://linear.app/x/issue/ENG-1", "/s/strato.ts", "/r/t.md");
    expect(p).not.toContain("add kind=draft");
    expect(p).toContain("add kind=action");
    expect(p).toContain("a task kind=action");
  });
  test("the relaunch lists the open tasks with their ids", () => {
    const m = refreshMessage(["no news for 4 days"], "/s/strato.ts", "C0ACME0001:1", [{ id: "t2", kind: "draft", ask: "Bob asks [strato] go" }]);
    expect(m).toContain("Open tasks: t2 (draft) « Bob asks (strato) go »");
    expect(m).toContain("task C0ACME0001:1 done <id>");
    expect(refreshMessage([], "/s", "K")).toContain("No open task.");
  });
});

describe("the sweep reasons on open tasks", () => {
  const T0 = Date.parse("2026-09-30T08:00:00Z");
  const D = 86_400_000;
  const base = {
    key: "C0ACME0001:1759219200.000100",
    threads: ["C0ACME0001:1759219200.000100"],
    letter: "A",
    title: "x",
    channel: "#acme",
    permalink: "",
    asker: "Bob",
    sessionId: "s",
    shortId: "s",
    name: "A",
    status: "gate",
    gate: "draft",
    waiting: "",
    next: "",
    summary: "",
    createdAt: new Date(T0 - 9 * D).toISOString(),
    updatedAt: new Date(T0 - 4 * D).toISOString(),
    history: [],
  } as Sujet;
  const open = { id: "t3", kind: "draft" as const, ask: "Bob asks", draft: "Yes", draftTo: "#acme", createdAt: new Date(T0 - 6 * D).toISOString(), updatedAt: new Date(T0 - 6 * D).toISOString(), status: "open" as const, origin: "task" as const };
  test("an old open task is named, with its own age", () => {
    const s = staleSignals({ ...base, tasks: [open] }, [], T0, { staleDays: 3, graceMinutes: 20 });
    expect(s).toEqual([{ code: "porte", text: "tâche t3 ouverte depuis 6 jours : peut-être réglée ailleurs" }]);
  });
  test("a draft left on the card without an open task is not a draft for the sweep", () => {
    const answered = [{ at: new Date(T0 - D).toISOString(), type: "slack", kind: "moi", key: base.key, from: "Alice" }];
    const closed = { ...open, status: "done" as const };
    const s = staleSignals({ ...base, status: "waiting", draft: "Yes", tasks: [closed] }, answered, T0, { staleDays: 3, graceMinutes: 20 });
    expect(s.map((x) => x.code)).toEqual([]);
    const withTask = staleSignals({ ...base, tasks: [open] }, answered, T0, { staleDays: 3, graceMinutes: 20 });
    expect(withTask[0].text).toContain("draft est peut-être déjà envoyé");
  });
});
