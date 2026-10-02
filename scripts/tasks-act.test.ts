/**
 * Structured actions on a ticket as tasks (`act=setStatus|assign value=…`, docs/design/providers.md, section 4.6): what
 * a session may write, and the plan the board's Go approves.
 */
import { describe, expect, test } from "bun:test";
import { planOfTask } from "./core/gate.ts";
import { addTask } from "./core/tasks.ts";

describe("a status or an assignee as a task", () => {
  test("act=setStatus|assign goes with kind=action and a value; its plan targets the ticket, the topic's own by default", () => {
    const topic = { key: "linear:ENG-12", channel: "ENG-12", status: "working" as const, gate: "none", updatedAt: "2026-09-30T08:00:00Z", history: [], title: "Checkout" };
    const now = "2026-09-30T08:10:00Z";
    const { task } = addTask(topic, { kind: "action", ask: "Move it?", act: "setStatus", value: "In Progress" }, now);
    expect(task).toMatchObject({ kind: "action", act: "setStatus", value: "In Progress", action: "" });
    expect(planOfTask(topic, task)).toEqual({ plan: { provider: "linear", account: "default", actions: [{ kind: "setStatus", target: { scope: "ticket", native: "ENG-12", label: "ENG-12" }, status: "In Progress" }] } });
    const assign = addTask(topic, { kind: "action", ask: "Take it?", act: "assign", value: "me", to: "linear:OPS-40" }, now).task;
    expect(planOfTask(topic, assign)).toMatchObject({ plan: { actions: [{ kind: "assign", assignee: "me", target: { native: "OPS-40" } }] } });
    expect(() => addTask(topic, { kind: "action", ask: "x", act: "close", value: "y" }, now)).toThrow("unknown act: close (setStatus, assign)");
    expect(() => addTask(topic, { kind: "action", ask: "x", act: "setStatus" }, now)).toThrow("act=setStatus requires value");
    expect(() => addTask(topic, { kind: "draft", ask: "x", act: "assign", value: "me", draft: "hi", to: "linear:ENG-12" }, now)).toThrow("act=assign goes with kind=action");
    expect(() => addTask(topic, { kind: "action", ask: "x" }, now)).toThrow("kind=action requires action");
  });
});
