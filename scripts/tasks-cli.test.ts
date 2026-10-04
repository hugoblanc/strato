/**
 * The `task` command and the legacy `set` on a throwaway state (test-rig.ts): real `strato.ts` processes, a fake
 * `claude`, nothing touches Slack nor the real state.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanupRigs, cli, readSujets, rig, sujet, writeSujets } from "./test-rig.ts";

afterEach(cleanupRigs);

const open = (s: Record<string, any>) => (s.tasks ?? []).filter((x: { status: string }) => x.status === "open");

describe("task command", () => {
  test("add prints the id, done and drop close, edit patches; the topic follows its open tasks", async () => {
    const r = rig();
    writeSujets(r, [sujet({ status: "working" })]);
    const a = await cli(r, ["task", "A", "add", "kind=draft", "ask=Bob asks if it is live", "proposal=Answer yes", "draft=Yes, live.", "draftTo=#acme, https://acme.slack.com/archives/C0ACME0001/p1759219200000100", "action=post the draft in #acme"]);
    expect(a.code).toBe(0);
    expect(a.out.split("\n")[0]).toBe("t1");
    const b = await cli(r, ["task", "A", "add", "kind=action", "ask=Merge?", "action=merge api!12"]);
    expect(b.out.split("\n")[0]).toBe("t2");
    let [s] = readSujets(r);
    expect(s.status).toBe("gate");
    expect(open(s).map((x: { id: string }) => x.id)).toEqual(["t1", "t2"]);

    expect((await cli(r, ["task", "A", "edit", "t2", "action=merge api!13"])).code).toBe(0);
    expect((await cli(r, ["task", "A", "done", "t1", "note=posted by hand"])).code).toBe(0);
    [s] = readSujets(r);
    expect(s.tasks.find((x: { id: string }) => x.id === "t1")).toMatchObject({ status: "done", note: "posted by hand", origin: "task" });
    expect(s.tasks.find((x: { id: string }) => x.id === "t2").action).toBe("merge api!13");
    expect(s.status).toBe("gate");

    const d = await cli(r, ["task", "A", "drop", "t2"]);
    expect(d.out).toContain("no open task");
    [s] = readSujets(r);
    expect(open(s)).toEqual([]);
    expect(s.status).toBe("working");
  }, 20_000);

  test("validation errors stop the command and write nothing", async () => {
    const r = rig();
    writeSujets(r, [sujet({ status: "working" })]);
    const cases = [
      ["task", "A", "add", "kind=memo", "ask=x"],
      ["task", "A", "add", "kind=draft", "ask=x", "draft=hello"],
      ["task", "A", "add", "kind=decision", "ask=x", "colour=blue"],
      ["task", "A", "done", "t7"],
      ["task", "A", "done", "t7", "colour=blue"],
      ["task", "A", "frobnicate", "t1"],
    ];
    for (const c of cases) {
      const res = await cli(r, c);
      expect(res.code, c.join(" ")).toBe(1);
    }
    expect((await cli(r, ["task", "A", "add", "kind=draft", "ask=x", "draft=hello"])).err).toContain("draftTo");
    const [s] = readSujets(r);
    expect(s.tasks ?? []).toEqual([]);
    expect(s.status).toBe("working");
  }, 20_000);
});

describe("legacy set", () => {
  test("a new ask replaces the open task; close drops what is left", async () => {
    const r = rig();
    writeSujets(r, [sujet({ status: "working" })]);
    await cli(r, ["set", "A", "status=gate", "gate=decision", "ask=Replay the script?", "action=replay the SQL script in prod"]);
    await cli(r, ["task", "A", "add", "kind=question", "ask=Which channel?"]);
    await cli(r, ["set", "A", "status=gate", "gate=go", "ask=Send the DM to Judy?", "action=send the DM to Judy"]);
    let [s] = readSujets(r);
    expect(open(s).map((x: { id: string; ask: string }) => `${x.id} ${x.ask}`)).toEqual(["t2 Which channel?", "t3 Send the DM to Judy?"]);
    expect(s.tasks[0]).toMatchObject({ id: "t1", status: "dropped" });
    expect((await cli(r, ["close", "A"])).code).toBe(0);
    [s] = readSujets(r);
    expect(open(s)).toEqual([]);
    expect(s.tasks.every((x: { status: string }) => x.status !== "open")).toBe(true);
  }, 20_000);
});
