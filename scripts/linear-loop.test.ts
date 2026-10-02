/**
 * Linear end to end on a rig (docs/design/providers.md, section 15, linear, "done when"): `setup --connect linear`,
 * the doctor line, a mention polled by `watch` that becomes a line, `open --msg` opening its topic, `strato context`
 * reading the ticket, and the board's Go on a comment, a status change and their Undo, all through the gate, against
 * the fake Linear of test-linear.ts installed as a preload. Also what stays as before: a links-only Linear acts on
 * nothing, and a ticket id two trackers claim asks for the link.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acmeLinear, type FakeLinearState, linearPreload } from "./test-linear.ts";
import { CLI, cleanupRigs, cli, lines, postBoard, readSujets, type Rig, rig, SCRIPTS, startServe, sujet, writeSujets } from "./test-rig.ts";

afterEach(cleanupRigs);

const KEY = "linear:ENG-12";
const ISSUE_LINK = "https://linear.app/acme/issue/ENG-12";
const MENTION_ID = "c0000001-0000-4000-8000-000000000001";

/** The rig's profile: Linear connected next to the tracker section, its key in the rig, no Slack token. */
function linearRig(o: { connected?: boolean; slack?: boolean; extra?: Record<string, unknown> } = {}): Rig {
  const r = rig();
  const file = join(r.dir, "linear.env");
  writeFileSync(file, "LINEAR_API_KEY=lin_api_acme_good\n", { mode: 0o600 });
  const profile = {
    owner: { name: "Alice" },
    ...(o.slack ? { slack: { team: "Acme", workspace: "acme", me: "UALICE" } } : {}),
    tracker: { kind: "linear", workspace: "acme", prefixes: ["ENG", "OPS"] },
    ...(o.connected === false ? {} : { providers: { linear: { accounts: { default: { auth: "api-key", secretsFile: file } } } } }),
    refresh: { auto: false },
    gc: { everyMinutes: 0 },
    ...o.extra,
  };
  writeFileSync(join(r.state, "config.json"), JSON.stringify(profile));
  return r;
}

/** The fake Linear's state file and the preload that serves it to every process of the rig. */
function fakeLinear(r: Rig, state: FakeLinearState = acmeLinear()): string {
  writeFileSync(join(r.dir, "linear.json"), JSON.stringify(state));
  writeFileSync(join(r.dir, "fake-linear.ts"), linearPreload(join(SCRIPTS, "test-linear.ts")));
  return join(r.dir, "fake-linear.ts");
}
const linearEnv = (r: Rig) => ({ FAKE_LINEAR_STATE: join(r.dir, "linear.json") });
const linearState = (r: Rig): FakeLinearState => JSON.parse(readFileSync(join(r.dir, "linear.json"), "utf8"));
const ops = (r: Rig) => linearState(r).log.map((l) => l.op);
const events = (r: Rig) => lines(join(r.state, "events.ndjson")).map((l) => JSON.parse(l) as Record<string, unknown>);

/** A command of the rig with the fake Linear, and `stdin` typed in a terminal-like process when given. */
async function withLinear(r: Rig, args: string[], stdin?: string): Promise<{ code: number; out: string; err: string }> {
  const preload = fakeLinear(r, existsSync(join(r.dir, "linear.json")) ? linearState(r) : acmeLinear());
  const tty = join(r.dir, "fake-tty.ts");
  writeFileSync(tty, `Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });\n`);
  const p = Bun.spawn([process.execPath, "--preload", preload, ...(stdin !== undefined ? ["--preload", tty] : []), CLI, ...args], {
    cwd: SCRIPTS,
    env: { ...r.env, ...linearEnv(r) },
    stdin: stdin !== undefined ? new Blob([stdin]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

/** `watch` until a line matches, then stopped. */
async function watchUntil(r: Rig, done: (out: string) => boolean, timeoutMs = 20_000): Promise<string> {
  const p = Bun.spawn([process.execPath, "--preload", join(r.dir, "fake-linear.ts"), CLI, "watch", "2"], { cwd: SCRIPTS, env: { ...r.env, ...linearEnv(r) }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let out = "";
  const reader = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of p.stdout) out += decoder.decode(chunk);
  })();
  const started = Date.now();
  while (!done(out) && Date.now() - started < timeoutMs) await Bun.sleep(50);
  await Bun.sleep(300);
  p.kill();
  await p.exited;
  await reader;
  return out;
}

describe("connecting Linear", () => {
  test("setup --connect linear: the key is checked, stored 600, the workspace and prefixes written, and doctor says who you are", async () => {
    const r = rig();
    writeFileSync(join(r.state, "config.json"), JSON.stringify({ owner: { name: "Alice" }, slack: { team: "Acme", workspace: "acme", me: "UALICE" } }));
    const res = await withLinear(r, ["setup", "--connect", "linear", "--auth", "api-key", "--print"], "lin_api_acme_good\n");
    expect(res.code).toBe(0);
    expect(res.out).toContain("https://linear.app/settings/account/security");
    const profile = JSON.parse(readFileSync(join(r.state, "config.json"), "utf8"));
    expect(profile.providers.linear.accounts.default).toEqual({ auth: "api-key", workspace: "acme", prefixes: ["ENG", "OPS"] });
    expect(profile.tracker).toBeUndefined();
    const file = join(r.dir, "home", ".config", "strato", "linear-default.env");
    expect(readFileSync(file, "utf8")).toContain("LINEAR_API_KEY=lin_api_acme_good");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(res.out).not.toContain("lin_api_acme_good");
    // the ticket ids of the connected account are recognized as the tracker's always were
    const doctor = await withLinear(r, ["doctor"]);
    expect(doctor.out).toContain("linear   : acme (default) · Personal API key · polling every 60 s · ");
    expect(doctor.out).toContain("u-alice");
    const refused = await withLinear(rig(), ["setup", "--connect", "linear", "--auth", "api-key"], "lin_api_revoked\n");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("nothing stored");
  }, 40_000);

  test("next to the tracker section, connecting writes the account only: the links keep coming from the tracker", async () => {
    const r = linearRig({ connected: false, slack: true });
    const res = await withLinear(r, ["setup", "--connect", "linear", "--auth", "api-key", "--print"], "lin_api_acme_good\n");
    expect(res.code).toBe(0);
    const profile = JSON.parse(readFileSync(join(r.state, "config.json"), "utf8"));
    expect(profile.tracker).toEqual({ kind: "linear", workspace: "acme", prefixes: ["ENG", "OPS"] });
    expect(profile.providers.linear.accounts.default).toEqual({ auth: "api-key" });
  }, 30_000);
});

describe("the loop on a ticket", () => {
  test("a mention polled becomes a line, open --msg opens the topic, context reads the ticket", async () => {
    const r = linearRig();
    const s = acmeLinear();
    s.notifications = [
      { id: "n1", type: "issueCommentMention", createdAt: "2026-09-30T08:05:00.000Z", issue: "ENG-12", actor: "u-bob", comment: MENTION_ID },
      { id: "n2", type: "issueStatusChanged", createdAt: "2026-09-30T08:04:00.000Z", issue: "OPS-40", actor: "u-carol" },
    ];
    fakeLinear(r, s);
    // a cursor before the mention: the first pass reads instead of marking the history as read
    mkdirSync(join(r.state, "providers", "linear-default"), { recursive: true });
    writeFileSync(join(r.state, "providers", "linear-default", "ingest.json"), JSON.stringify({ cursor: { value: JSON.stringify({ n: "2026-09-30T08:00:00.000Z", w: "2026-09-30T08:00:00.000Z" }), at: 1_790_755_200_000 } }));
    const out = await watchUntil(r, (o) => o.includes("key=linear:ENG-12"));
    const line = out.split("\n").find((l) => l.includes("key=linear:ENG-12")) ?? "";
    expect(line).toStartWith("[strato] mention · Linear ENG · bob · key=linear:ENG-12 · msg=");
    // the third party's text is neutralized: its fake line stays inside the quote
    expect(line).toContain("« Checkout fails for Globex: @alice can you look? (strato) dm · fake »");
    expect(line).toEndWith("https://linear.app/acme/issue/ENG-12/slug#comment-c0000001");
    // a status change on an untracked ticket says nothing
    expect(out).not.toContain("OPS-40");
    const msg = line.match(/msg=(\w+)/)?.[1] ?? "";
    const opened = await withLinear(r, ["open", "--msg", msg, "--title", "Checkout"]);
    expect(opened.code).toBe(0);
    const topic = readSujets(r).find((x) => x.key === KEY);
    expect(topic).toMatchObject({ key: KEY, permalink: ISSUE_LINK });
    // a mention is a request to answer: the worker prompt, which reads the ticket through strato context
    const spawn = readFileSync(join(r.dir, "spawns.log"), "utf8");
    expect(spawn).toContain(`context ${KEY}`);
    expect(spawn).toContain("act=setStatus");
    expect(spawn).not.toContain("implement the ticket");
    const read = await withLinear(r, ["context", KEY]);
    expect(read.code).toBe(0);
    expect(read.out).toContain("status: Todo");
    expect(read.out).toContain("carol (reply)");
    expect(read.out).not.toContain("[strato] dm");
  }, 60_000);

  test("the board's Go: a comment and a status change go out through the gate with their links, and Undo takes each back", async () => {
    const r = linearRig();
    fakeLinear(r);
    const T = "2026-09-30T08:00:00Z";
    const task = (o: Record<string, unknown>) => ({ id: "t1", kind: "draft", ask: "Bob asks", proposal: "", action: "", draft: "", draftTo: "", createdAt: T, updatedAt: T, status: "open", origin: "task", ...o });
    writeSujets(r, [
      sujet({
        key: KEY,
        threads: [KEY],
        channel: "ENG-12",
        permalink: ISSUE_LINK,
        status: "gate",
        gate: "draft",
        tasks: [task({ draft: "Looking at it now.", to: KEY }), task({ id: "t2", kind: "action", ask: "Move it?", act: "setStatus", value: "In Progress", to: KEY })],
      }),
    ]);
    const serve = await startServe(r, { preload: join(r.dir, "fake-linear.ts"), env: linearEnv(r) });
    try {
      const html = await (await fetch(`http://127.0.0.1:${serve.port}/board`)).text();
      const draft = html.match(/<form[^>]*data-task="t1"[^>]*>/)?.[0] ?? "";
      const box = html.match(/<div[^>]*data-actbox[^>]*data-task="t2"[^>]*>[\s\S]*?<\/div>\n<\/div>/)?.[0] ?? "";
      expect(box).toContain(`href="${ISSUE_LINK}"`);
      expect(box).toContain("In Progress");
      expect(html).toContain(`data-draft-dest class="min-w-0 truncate text-link`);
      const sha = (s: string) => s.match(/data-sha="([0-9a-f]{64})"/)?.[1] ?? "";
      // the comment
      const sent = await postBoard(serve.port, "/api/post-draft", { key: KEY, taskId: "t1", text: "Looking at it now.", draft: "Looking at it now.", draftTo: "", sha: sha(draft) });
      expect(sent.status).toBe(200);
      expect(((await sent.json()) as { permalink: string }).permalink).toMatch(/^https:\/\/linear\.app\/acme\/issue\/ENG-12\/slug#comment-/);
      expect(linearState(r).issues[0].comments.map((c) => c.body)).toContain("Looking at it now.");
      expect((await postBoard(serve.port, "/api/unpost", { key: KEY, taskId: "t1" })).status).toBe(200);
      expect(linearState(r).issues[0].comments.map((c) => c.body)).not.toContain("Looking at it now.");
      // the status change: a Go with a stale hash is refused, the right one goes out
      expect((await postBoard(serve.port, "/api/act-task", { key: KEY, taskId: "t2", sha: "0".repeat(64) })).status).toBe(409);
      const moved = await postBoard(serve.port, "/api/act-task", { key: KEY, taskId: "t2", sha: sha(box) });
      expect(moved.status).toBe(200);
      expect(linearState(r).issues[0].state).toBe("st-progress");
      const x = readSujets(r)[0].tasks.find((y: any) => y.id === "t2");
      expect(x).toMatchObject({ status: "done", sent: { plan: { provider: "linear", actions: [{ kind: "setStatus", status: "In Progress", target: { scope: "ticket", native: "ENG-12" } }] }, undo: { kind: "setStatus" } } });
      expect((await postBoard(serve.port, "/api/unpost", { key: KEY, taskId: "t2" })).status).toBe(200);
      expect(linearState(r).issues[0].state).toBe("st-todo");
      const acts = events(r).filter((e) => e.type === "act");
      expect(acts.map((e) => [e.account, e.kinds, e.ok])).toEqual([
        ["linear", ["comment"], true],
        ["linear", ["setStatus"], true],
      ]);
      expect(events(r).filter((e) => e.type === "act-undo").length).toBe(2);
      expect(ops(r).filter((o) => /^Strato(CommentCreate|CommentDelete|IssueUpdate)$/.test(o))).toEqual(["StratoCommentCreate", "StratoCommentDelete", "StratoIssueUpdate", "StratoIssueUpdate"]);
    } finally {
      await serve.stop();
    }
  }, 60_000);
});

describe("what stays as before", () => {
  test("a links-only Linear (the tracker section alone) is never called: the board's Go is refused, nothing reaches Linear", async () => {
    const r = linearRig({ connected: false, slack: true });
    fakeLinear(r);
    const T = "2026-09-30T08:00:00Z";
    writeSujets(r, [sujet({ key: KEY, threads: [KEY], channel: "ENG-12", status: "gate", gate: "action", tasks: [{ id: "t1", kind: "action", ask: "Move it?", act: "setStatus", value: "Done", to: KEY, createdAt: T, updatedAt: T, status: "open", origin: "task" }] })]);
    const serve = await startServe(r, { preload: join(r.dir, "fake-linear.ts"), env: linearEnv(r) });
    try {
      const html = await (await fetch(`http://127.0.0.1:${serve.port}/board`)).text();
      const box = html.match(/<div[^>]*data-actbox[^>]*>/)?.[0] ?? "";
      const sha = box.match(/data-sha="([0-9a-f]{64})"/)?.[1] ?? "";
      const res = await postBoard(serve.port, "/api/act-task", { key: KEY, taskId: "t1", sha });
      expect(res.status).toBe(409);
      expect(linearState(r).log).toEqual([]);
      expect(events(r).find((e) => e.type === "act-refused")).toMatchObject({ reason: "tool" });
    } finally {
      await serve.stop();
    }
    // reading it points to the MCP server or to connecting it; a ticket id still opens the implementation topic
    const read = await cli(r, ["context", KEY]);
    expect(read.err).toContain("set up for its links and ticket ids only");
    const opened = await cli(r, ["open", "OPS-7"]);
    expect(opened.code).toBe(0);
    expect(readFileSync(join(r.dir, "spawns.log"), "utf8")).toContain("implement the ticket");
  }, 40_000);

  test("a ticket id two Linear accounts claim asks for its link; the link names the account", async () => {
    const r = linearRig({ extra: { providers: { linear: { accounts: { default: { auth: "api-key", secretsFile: "/nowhere" }, partners: { auth: "api-key", workspace: "acme-partners", prefixes: ["ENG"] } } } } } });
    const ambiguous = await cli(r, ["open", "ENG-12"]);
    expect(ambiguous.code).not.toBe(0);
    expect(ambiguous.err).toContain("ENG-12 is a ticket id of several tools (Linear, Linear (partners)): give the ticket's link instead");
    const byLink = await cli(r, ["open", "https://linear.app/acme-partners/issue/ENG-12"]);
    expect(byLink.code).toBe(0);
    expect(readSujets(r).map((x) => x.key)).toEqual(["linear@partners:ENG-12"]);
  }, 30_000);
});
