/**
 * The board's task routes on a throwaway state: a real `serve`, a fake Slack (preload, no network) and a fake
 * `claude`. Send closes the task it posted, Undo reopens it, Done and Drop close a task and tell the session, a Go
 * names its task.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupRigs, KEY, LINK, lines, postBoard, readSujets, type Rig, rig, startServe, sujet, writeSujets } from "./test-rig.ts";

afterEach(cleanupRigs);

const FAKE_SLACK = `import { appendFileSync } from "node:fs";
const real = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith("https://slack.com/api/")) return real(input, init);
  const method = url.slice("https://slack.com/api/".length).split("?")[0];
  appendFileSync(process.env.FAKE_SLACK_LOG as string, method + "\\n");
  const body =
    method === "auth.test" ? { ok: true, team: "Acme", user_id: "UALICE", url: "https://acme.slack.com/" }
    : method === "chat.postMessage" ? { ok: true, ts: "1759219400.000300" }
    : method === "conversations.replies" ? { ok: true, messages: [{ ts: "1759219200.000100" }] }
    : { ok: true };
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}) as typeof fetch;
`;

const T = "2026-09-30T08:00:00Z";
const task = (o: Record<string, unknown>) => ({ kind: "draft", ask: "Bob asks", proposal: "", action: "post the draft", draft: "", draftTo: LINK, createdAt: T, updatedAt: T, status: "open", origin: "task", ...o });
const twoTasks = () =>
  sujet({
    status: "gate",
    gate: "draft",
    tasks: [task({ id: "t1", draft: "First answer." }), task({ id: "t2", kind: "action", ask: "Merge?", action: "merge api!12", draft: "", draftTo: "" })],
  });

async function serveWithSlack(r: Rig) {
  writeFileSync(join(r.dir, "fake-slack.ts"), FAKE_SLACK);
  return startServe(r, { preload: join(r.dir, "fake-slack.ts"), env: { STRATO_SLACK_TOKEN: "xoxp-acme-factice", FAKE_SLACK_LOG: join(r.dir, "slack.log") } });
}
const taskOf = (r: Rig, id: string) => readSujets(r)[0].tasks.find((x: { id: string }) => x.id === id);

describe("board task routes", () => {
  test("Send posts the draft of one task: that task is done, the other stays, the topic stays a gate; Undo reopens it", async () => {
    const r = rig();
    writeSujets(r, [twoTasks()]);
    const serve = await serveWithSlack(r);
    try {
      const res = await postBoard(serve.port, "/api/post-draft", { key: KEY, taskId: "t1", text: "First answer.", draft: "First answer.", draftTo: LINK });
      expect(res.status).toBe(200);
      expect(lines(join(r.dir, "slack.log")).filter((m) => m === "chat.postMessage").length).toBe(1);
      expect(taskOf(r, "t1")).toMatchObject({ status: "done" });
      expect(taskOf(r, "t1").note).toContain("https://acme.slack.com/archives/C0ACME0001/p1759219400000300");
      expect(taskOf(r, "t2").status).toBe("open");
      expect(readSujets(r)[0].status).toBe("gate");
      expect(readSujets(r)[0].notify.byTask.t1).toContain("task t1");

      const undo = await postBoard(serve.port, "/api/unpost", { key: KEY, taskId: "t1" });
      expect(undo.status).toBe(200);
      expect(lines(join(r.dir, "slack.log"))).toContain("chat.delete");
      expect(taskOf(r, "t1").status).toBe("open");
      expect(taskOf(r, "t1").note).toBeUndefined();
      expect(readSujets(r)[0].notify).toBeUndefined();
    } finally {
      await serve.stop();
    }
  }, 30_000);

  test("Send on the last open task: the topic waits for the thread; a task already closed or a wrong draft: 409", async () => {
    const r = rig();
    writeSujets(r, [sujet({ status: "gate", gate: "draft", tasks: [task({ id: "t1", draft: "Only answer." })] })]);
    const serve = await serveWithSlack(r);
    try {
      const changed = await postBoard(serve.port, "/api/post-draft", { key: KEY, taskId: "t1", text: "x", draft: "Old text.", draftTo: LINK });
      expect(changed.status).toBe(409);
      expect(((await changed.json()) as { code: string }).code).toBe("draft-changed");
      expect((await postBoard(serve.port, "/api/post-draft", { key: KEY, taskId: "t1", text: "Only answer.", draft: "Only answer.", draftTo: LINK })).status).toBe(200);
      const s = readSujets(r)[0];
      expect(s.status).toBe("waiting");
      expect(s.waiting).toBe("the rest of the thread");
      expect((await postBoard(serve.port, "/api/post-draft", { key: KEY, taskId: "t1", text: "Only answer.", draft: "Only answer.", draftTo: LINK })).status).toBe(409);
      expect((await postBoard(serve.port, "/api/post-draft", { key: KEY, text: "Only answer.", draft: "Only answer.", draftTo: LINK })).status).toBe(400);
    } finally {
      await serve.stop();
    }
  }, 30_000);

  test("/api/task done and drop close the task and tell the session; a closed task answers 409; no origin, 403", async () => {
    const r = rig();
    writeSujets(r, [twoTasks()]);
    const serve = await serveWithSlack(r);
    try {
      const done = await postBoard(serve.port, "/api/task", { key: KEY, taskId: "t2", op: "done" });
      expect(done.status).toBe(200);
      expect(taskOf(r, "t2")).toMatchObject({ status: "done", note: "marked done from the board" });
      expect(readFileSync(join(r.dir, "spawns.log"), "utf8")).toContain("I marked task t2 done from the board");
      expect((await postBoard(serve.port, "/api/task", { key: KEY, taskId: "t2", op: "drop" })).status).toBe(409);
      expect((await postBoard(serve.port, "/api/task", { key: KEY, taskId: "t1", op: "nope" })).status).toBe(400);
      const foreign = await fetch(`http://127.0.0.1:${serve.port}/api/task`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ key: KEY, taskId: "t1", op: "drop" }) });
      expect(foreign.status).toBe(403);
      expect((await postBoard(serve.port, "/api/drop-draft", { key: KEY, taskId: "t1" })).status).toBe(200);
      expect(taskOf(r, "t1").status).toBe("dropped");
      // the session is alive since the first message (fake claude): the drop is delivered through SendMessage, which the
      // fake does not answer; the attempt is logged right after the drop
      const types = lines(join(r.state, "events.ndjson")).map((l) => (JSON.parse(l) as { type: string }).type);
      expect(types).toEqual(["board-task-done", "resume", "board-task-drop", "board-send-failed"]);
      expect(readSujets(r)[0].status).toBe("working");
      expect(lines(join(r.dir, "slack.log")).filter((m) => m === "chat.postMessage")).toEqual([]);
    } finally {
      await serve.stop();
    }
  }, 30_000);

  test("a go on a task names the task and its action; a go on a closed task is refused", async () => {
    const r = rig();
    writeSujets(r, [twoTasks()]);
    const serve = await serveWithSlack(r);
    try {
      const go = await postBoard(serve.port, "/api/send", { key: KEY, text: "go", taskId: "t2" });
      expect(go.status).toBe(200);
      const spawned = readFileSync(join(r.dir, "spawns.log"), "utf8");
      expect(spawned).toContain("go on task t2: merge api!12");
      expect(spawned).toContain(`task ${KEY} done t2`);
      writeSujets(r, [{ ...readSujets(r)[0], tasks: readSujets(r)[0].tasks.map((x: { id: string }) => (x.id === "t2" ? { ...x, status: "dropped" } : x)) }]);
      expect((await postBoard(serve.port, "/api/send", { key: KEY, text: "go", taskId: "t2" })).status).toBe(409);
      expect((await postBoard(serve.port, "/api/send", { key: KEY, text: "go", taskId: "t9" })).status).toBe(404);
    } finally {
      await serve.stop();
    }
  }, 30_000);

  test("closing the topic from the board drops its open tasks", async () => {
    const r = rig();
    writeSujets(r, [twoTasks()]);
    const serve = await serveWithSlack(r);
    try {
      expect((await postBoard(serve.port, "/api/close", { key: KEY })).status).toBe(200);
      const s = readSujets(r)[0];
      expect(s.status).toBe("closed");
      expect(s.tasks.map((x: { status: string; note: string }) => `${x.status} ${x.note}`)).toEqual(["dropped topic closed", "dropped topic closed"]);
    } finally {
      await serve.stop();
    }
  }, 30_000);
});
