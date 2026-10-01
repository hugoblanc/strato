/**
 * The act path end to end, on a throwaway state with a real `serve`, a fake Slack (preload, no network) and a fake
 * `claude`: every board write goes through the gate (app/act.ts) and the Slack provider, is logged, can be undone from
 * a board restarted within the window, and is refused in shadow mode, for a tool that is not connected, and when the
 * content changed since the Go. Also the structural rule: nothing but app/act.ts reaches a provider's writes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { cleanupRigs, cli, KEY, LINK, lines, postBoard, readSujets, type Rig, rig, SCRIPTS, startServe, sujet, writeSujets } from "./test-rig.ts";

afterEach(cleanupRigs);

/** Slack replaced in the serve process: each call is logged with its form body; FAKE_POST_FAIL=network makes the first chat.postMessage fail without an answer. */
const FAKE_SLACK = `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const real = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith("https://slack.com/api/")) return real(input, init);
  const method = url.slice("https://slack.com/api/".length).split("?")[0];
  const body = init?.body instanceof URLSearchParams ? init.body.toString() : "";
  appendFileSync(process.env.FAKE_SLACK_LOG as string, method + " " + body + "\\n");
  const once = process.env.FAKE_SLACK_LOG + ".failed";
  if (method === "chat.postMessage" && process.env.FAKE_POST_FAIL === "network" && !existsSync(once)) {
    writeFileSync(once, "1");
    throw new TypeError("fetch failed: socket hang up");
  }
  const reply =
    method === "auth.test" ? { ok: true, team: "Acme", user_id: "UALICE", url: "https://acme.slack.com/" }
    : method === "chat.postMessage" ? { ok: true, ts: "1759219400.000300" }
    : method === "conversations.replies" ? { ok: true, messages: [{ ts: "1759219200.000100" }] }
    : { ok: true };
  return new Response(JSON.stringify(reply), { headers: { "Content-Type": "application/json" } });
}) as typeof fetch;
`;

const T = "2026-09-30T08:00:00Z";
const task = (o: Record<string, unknown> = {}) => ({ id: "t1", kind: "draft", ask: "Bob asks", proposal: "", action: "post the draft", draft: "First answer.", draftTo: LINK, createdAt: T, updatedAt: T, status: "open", origin: "task", ...o });
const draftTopic = (o: Record<string, unknown> = {}) => sujet({ status: "gate", gate: "draft", tasks: [task(o)] });

async function serveWithSlack(r: Rig, env: Record<string, string> = {}) {
  writeFileSync(join(r.dir, "fake-slack.ts"), FAKE_SLACK);
  return startServe(r, { preload: join(r.dir, "fake-slack.ts"), env: { STRATO_SLACK_TOKEN: "xoxp-acme-factice", FAKE_SLACK_LOG: join(r.dir, "slack.log"), ...env } });
}
const slackCalls = (r: Rig) => lines(join(r.dir, "slack.log"));
const posts = (r: Rig) => slackCalls(r).filter((l) => l.startsWith("chat.postMessage "));
const events = (r: Rig) => lines(join(r.state, "events.ndjson")).map((l) => JSON.parse(l) as Record<string, unknown>);
const taskOf = (r: Rig) => readSujets(r)[0].tasks[0];

/** The hash of the plan the board shows for a task: what a click on Send sends back. */
async function shownSha(port: number, taskId = "t1"): Promise<string> {
  const html = await (await fetch(`http://127.0.0.1:${port}/board`)).text();
  const form = html.match(new RegExp(`<form[^>]*data-task="${taskId}"[^>]*>`))?.[0] ?? "";
  return form.match(/data-sha="([0-9a-f]{64})"/)?.[1] ?? "";
}
const send = (port: number, sha: string, extra: Record<string, unknown> = {}) => postBoard(port, "/api/post-draft", { key: KEY, taskId: "t1", text: "First answer.", draft: "First answer.", draftTo: LINK, sha, ...extra });

describe("the board's writes go through the gate", () => {
  test("Send: the provider posts the exact text shown, the act and its hash are logged, the sent record is on the task", async () => {
    const r = rig();
    writeSujets(r, [draftTopic()]);
    const serve = await serveWithSlack(r);
    try {
      const sha = await shownSha(serve.port);
      expect(sha).toMatch(/^[0-9a-f]{64}$/);
      expect((await send(serve.port, sha)).status).toBe(200);
      expect(posts(r)).toEqual(["chat.postMessage channel=C0ACME0001&thread_ts=1759219200.000100&text=First+answer."]);
      const act = events(r).find((e) => e.type === "act");
      expect(act).toMatchObject({ by: "board", key: KEY, task: "t1", account: "slack", kinds: ["reply"], sha: sha.slice(0, 12), attempt: 1, ok: true, link: "https://acme.slack.com/archives/C0ACME0001/p1759219400000300?thread_ts=1759219200.000100&cid=C0ACME0001" });
      expect(events(r).map((e) => e.type)).toContain("board-post");
      const x = taskOf(r);
      expect(x.status).toBe("done");
      expect(x.sent).toMatchObject({ sha, by: "board", ref: "C0ACME0001:1759219400.000300", undo: { token: "message:C0ACME0001:1759219400.000300", kind: "reply" } });
      expect(x.inFlight).toBeUndefined();
    } finally {
      await serve.stop();
    }
  }, 30_000);

  test("Undo from a board restarted within the window: the message is deleted, the task reopens with a new attempt", async () => {
    const r = rig();
    writeSujets(r, [draftTopic()]);
    let serve = await serveWithSlack(r);
    try {
      expect((await send(serve.port, await shownSha(serve.port))).status).toBe(200);
      await serve.stop();
      serve = await serveWithSlack(r);
      // the undo window lives on the task, not in the memory of the board that posted
      expect(await (await fetch(`http://127.0.0.1:${serve.port}/board`)).text()).toContain(`data-unpost="${KEY}" data-task="t1"`);
      expect((await postBoard(serve.port, "/api/unpost", { key: KEY, taskId: "t1" })).status).toBe(200);
      expect(slackCalls(r)).toContain("chat.delete channel=C0ACME0001&ts=1759219400.000300");
      const x = taskOf(r);
      expect(x.status).toBe("open");
      expect(x.sent).toBeUndefined();
      expect(x.attempt).toBe(2);
      expect(readSujets(r)[0].posted).toBeUndefined();
      expect(events(r).find((e) => e.type === "act-undo")).toMatchObject({ by: "board", key: KEY, task: "t1", ok: true });
      // nothing left to undo
      expect((await postBoard(serve.port, "/api/unpost", { key: KEY, taskId: "t1" })).status).toBe(409);
    } finally {
      await serve.stop();
    }
  }, 30_000);

  test("content changed since the Go: refused, nothing posted, the refusal logged", async () => {
    const r = rig();
    writeSujets(r, [draftTopic()]);
    const serve = await serveWithSlack(r);
    try {
      const sha = await shownSha(serve.port);
      // a session moves the destination after the person read the card: the page's draft and draftTo still match
      writeSujets(r, [draftTopic({ to: "C0ACME0001:1759219300.000200" })]);
      const res = await send(serve.port, sha);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("draft-changed");
      expect(posts(r)).toEqual([]);
      expect(events(r).find((e) => e.type === "act-refused")).toMatchObject({ by: "board", task: "t1", reason: "sha" });
      expect(taskOf(r).status).toBe("open");
    } finally {
      await serve.stop();
    }
  }, 30_000);

  test("a destination on a tool that is not connected: refused, nothing posted", async () => {
    const r = rig();
    writeSujets(r, [draftTopic({ to: "tickets:PLAT-12" })]);
    const serve = await serveWithSlack(r);
    try {
      const res = await send(serve.port, "0".repeat(64));
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain("tickets");
      expect(posts(r)).toEqual([]);
      expect(events(r).find((e) => e.type === "act-refused")).toMatchObject({ reason: "tool" });
    } finally {
      await serve.stop();
    }
  }, 30_000);

  test("shadow mode: Send, Undo and ✅ write nothing, each refusal logged", async () => {
    const r = rig();
    writeFileSync(join(r.state, "config.json"), JSON.stringify({ owner: { name: "Alice" }, slack: { team: "Acme", workspace: "acme", me: "UALICE" }, workers: { shadow: true } }));
    writeSujets(r, [draftTopic(), sujet({ key: "C0ACME0002:1759219500.000100", threads: ["C0ACME0002:1759219500.000100"], letter: "B", status: "closed", summary: "closed: done" })]);
    const serve = await serveWithSlack(r);
    try {
      const res = await send(serve.port, "0".repeat(64));
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("shadow");
      expect((await postBoard(serve.port, "/api/unpost", { key: KEY, taskId: "t1" })).status).toBe(409);
      expect((await postBoard(serve.port, "/api/check", { key: "C0ACME0002:1759219500.000100" })).status).toBe(409);
      expect(slackCalls(r).filter((l) => !l.startsWith("auth.test"))).toEqual([]);
      expect(events(r).filter((e) => e.type === "act-refused").map((e) => e.reason)).toEqual(["shadow", "shadow", "shadow"]);
    } finally {
      await serve.stop();
    }
  }, 30_000);

  test("no answer from Slack: the message may have gone out, Send asks for a retry, and the retry posts", async () => {
    const r = rig();
    writeSujets(r, [draftTopic()]);
    const serve = await serveWithSlack(r, { FAKE_POST_FAIL: "network" });
    try {
      const sha = await shownSha(serve.port);
      const first = await send(serve.port, sha);
      expect(first.status).toBe(502);
      expect(((await first.json()) as { code: string }).code).toBe("unknown");
      expect(taskOf(r)).toMatchObject({ status: "open", unknown: { sha, attempt: 1 } });
      expect(events(r).find((e) => e.type === "act")).toMatchObject({ ok: false, outcome: "unknown" });
      // the board says so before any new click
      expect(await (await fetch(`http://127.0.0.1:${serve.port}/board`)).text()).toContain("may have gone out");
      const again = await send(serve.port, sha);
      expect(again.status).toBe(409);
      expect(((await again.json()) as { code: string }).code).toBe("unknown");
      expect((await send(serve.port, sha, { retry: true })).status).toBe(200);
      expect(posts(r)).toHaveLength(2);
      expect(taskOf(r)).toMatchObject({ status: "done" });
      expect(taskOf(r).unknown).toBeUndefined();
    } finally {
      await serve.stop();
    }
  }, 30_000);

  test("a typed target: a separate message in the conversation the key names", async () => {
    const r = rig();
    writeSujets(r, [draftTopic({ draftTo: "", to: "slack:C0ACMEANN01" })]);
    const serve = await serveWithSlack(r);
    try {
      const res = await postBoard(serve.port, "/api/post-draft", { key: KEY, taskId: "t1", text: "First answer.", draft: "First answer.", draftTo: "", sha: await shownSha(serve.port) });
      expect(res.status).toBe(200);
      expect(posts(r)).toEqual(["chat.postMessage channel=C0ACMEANN01&text=First+answer."]);
    } finally {
      await serve.stop();
    }
  }, 30_000);

  test("✅ goes out as the provider's react, logged as an act", async () => {
    const r = rig();
    writeSujets(r, [sujet({ status: "closed", summary: "closed: done" })]);
    const serve = await serveWithSlack(r);
    try {
      expect((await postBoard(serve.port, "/api/check", { key: KEY })).status).toBe(200);
      expect(events(r).find((e) => e.type === "act")).toMatchObject({ key: KEY, task: null, kinds: ["react"], ok: true });
      expect(events(r).map((e) => e.type)).toContain("board-check");
    } finally {
      await serve.stop();
    }
  }, 30_000);

  test("a session cannot write the gate's fields of a task", async () => {
    const r = rig();
    writeSujets(r, [draftTopic()]);
    for (const field of ["sent", "inFlight", "unknown", "attempt"]) {
      const res = await cli(r, ["task", KEY, "edit", "t1", `${field}=x`]);
      expect(res.code).not.toBe(0);
      expect(res.err).toContain(`unknown task field: ${field}`);
    }
  }, 30_000);
});

// ------------------------------------------------------------------ nothing else reaches a provider's writes

/** The source files of the program, tests and fixtures aside. */
function sources(dir = SCRIPTS): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === "node_modules" || f.startsWith(".")) return [];
    if (statSync(p).isDirectory()) return sources(p);
    return f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith("test-") && !f.endsWith(".d.ts") ? [relative(SCRIPTS, p)] : [];
  });
}

describe("one act path", () => {
  test("only app/act.ts calls a provider's act or undo, and only it imports the registry's actorOf", () => {
    const files = sources();
    expect(files).toContain("app/act.ts");
    const calls = files.filter((f) => /\.(act|undo)\s*\(|\bactor\??\.(act|undo)\b/.test(readFileSync(join(SCRIPTS, f), "utf8")));
    expect(calls).toEqual(["app/act.ts"]);
    const actorOf = files.filter((f) => /\bactorOf\b/.test(readFileSync(join(SCRIPTS, f), "utf8")));
    expect(actorOf.sort()).toEqual(["app/act.ts", "providers/registry.ts"]);
  });

  test("a provider's writes live in a module only the registry imports", () => {
    const writes = sources().filter((f) => /^providers\/[^/]+\/act\.ts$/.test(f));
    expect(writes).toEqual(["providers/slack/act.ts"]);
    for (const w of writes) {
      const name = w.split("/").slice(1).join("/").replace(/\.ts$/, "");
      const importers = sources().filter((f) => f !== w && readFileSync(join(SCRIPTS, f), "utf8").includes(`${name}.ts"`));
      expect(importers).toEqual(["providers/registry.ts"]);
    }
  });

  test("every provider the registry and the links hand out is a view without act or undo", async () => {
    const r = rig();
    // in a child process: the registry reads the profile of a state folder, and a fake tool with writes is added
    writeFileSync(
      join(r.dir, "check.ts"),
      [
        `import * as registry from ${JSON.stringify(join(SCRIPTS, "providers/registry.ts"))};`,
        `import { pureOf } from ${JSON.stringify(join(SCRIPTS, "core/links.ts"))};`,
        `import { fakeProvider } from ${JSON.stringify(join(SCRIPTS, "test-provider.ts"))};`,
        `const fake = fakeProvider({ id: "tickets", label: "Tickets" });`,
        `registry.addProvider({ ...fake, act: async () => ({ ok: true, ref: "x", link: "" }), undo: async () => ({ ok: true, ref: "x", link: "" }) });`,
        `const handed = [...Object.values(registry.BUILTIN), ...registry.accounts().map((a) => a.provider).filter(Boolean), pureOf("slack"), pureOf("tickets")];`,
        `console.log(JSON.stringify(handed.map((p) => ["act" in p, "undo" in p])));`,
      ].join("\n"),
    );
    writeFileSync(join(r.state, "config.json"), JSON.stringify({ owner: { name: "Alice" }, slack: { team: "Acme", workspace: "acme", me: "UALICE" }, providers: { tickets: { source: { module: "x.ts" }, accounts: { default: { auth: "api-key" } } } } }));
    const p = Bun.spawn([process.execPath, join(r.dir, "check.ts")], { cwd: SCRIPTS, env: r.env, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    const flags = JSON.parse(out) as [boolean, boolean][];
    expect(flags.length).toBeGreaterThanOrEqual(5);
    expect(flags.flat().every((x) => x === false)).toBe(true);
  }, 30_000);
});
