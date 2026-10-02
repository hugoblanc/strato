/**
 * The exec host (providers/host/exec.ts) against a real provider process, test-exec-provider.ts: the handshake, the
 * provider's requests through the account's fetch, one request at a time with timeouts counted from dispatch,
 * `$/cancel`, crash isolation with backoff on an injected clock, protocol mismatch, logs with secrets masked, and an
 * environment without secrets. The pure rules (framing, error mapping, the restart gate) are tested on their own.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExecHostOptions, describeExec, execProvider, type ExecProvider } from "./providers/host/exec.ts";
import { backoffMs, errorOfRpc, execEnv, readLine, startGate, takeLines } from "./providers/host/protocol.ts";
import type { AccountContext, IngestCursor, Item, ProviderDescriptor } from "./providers/sdk.ts";
import { SCRIPTS } from "./test-rig.ts";

const FIXTURE = join(SCRIPTS, "test-exec-provider.ts");
const SECRET = "tk-acme-secret-123456";

const dirs: string[] = [];
const hosts: ExecProvider[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stopAll();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The fake tool behind `http.fetch`: its answers, and every request it received. */
function fakeTool(over: Record<string, (req: Request) => Response | Promise<Response>> = {}) {
  const requests: { method: string; url: string; body: string; auth: string }[] = [];
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const body = req.body ? await req.text() : "";
    requests.push({ method: req.method, url: req.url, body, auth: req.headers.get("authorization") ?? "" });
    const path = new URL(req.url).pathname;
    const own = over[`${req.method} ${path}`];
    if (own) return own(req);
    if (path === "/api/me") return json({ id: "u-alice", workspace: "acme" });
    if (path === "/api/notifications")
      return json([
        { id: "n-1", ticket: "OPS-7", author: "bob", text: "please look @u-alice", at: 1_790_000_100_000 },
        { id: "n-2", ticket: "OPS-8", author: "carol", text: "fyi", at: 1_790_000_200_000 },
      ]);
    if (path.startsWith("/api/tickets/") && req.method === "GET") return json({ title: "Checkout fails", comments: [{ id: "c-1", author: "bob", time: 1, text: "broken" }] });
    if (path.endsWith("/comments")) return json({ id: "c-9" }, 201);
    if (req.method === "DELETE") return json({ ok: true });
    return json({ error: "no" }, 404);
  }) as typeof fetch;
  return { requests, fetchImpl };
}

/** What Strato gives the provider for one account, without the registry: secrets, the fake fetch, a store in memory. */
function ctxOf(o: { fetchImpl?: typeof fetch; signal?: AbortSignal; verifying?: boolean; secret?: string } = {}): AccountContext {
  const store = new Map<string, unknown>();
  return {
    account: { provider: "tickets", id: "default", label: "Tickets", auth: "api-key", ingest: "poll", settings: { me: "u-alice" } },
    identity: null,
    secret: (name) => (name === "TICKETS_API_KEY" ? (o.secret ?? SECRET) : null),
    setSecret() {},
    fetch: o.fetchImpl ?? fakeTool().fetchImpl,
    log() {},
    store: { read: <T>(name: string, fallback: T) => (store.has(name) ? (store.get(name) as T) : fallback), write: (name, value) => void store.set(name, value) },
    signal: o.signal ?? new AbortController().signal,
    locale: "en",
    ...(o.verifying ? { verifying: true } : {}),
  };
}

let descriptorCache: ProviderDescriptor | null = null;
async function fixtureDescriptor(): Promise<ProviderDescriptor> {
  descriptorCache ??= (await describeExec({ id: "tickets", argv: [process.execPath, FIXTURE], cwd: SCRIPTS })).descriptor as ProviderDescriptor;
  return descriptorCache;
}

/** A host for the fixture in `mode`, its log in a temporary folder; `clock` is the injected time. */
async function host(mode = "normal", o: Partial<ExecHostOptions> & { extraArgs?: string[] } = {}): Promise<{ p: ExecProvider; log: () => string; clock: { now: number } }> {
  const dir = mkdtempSync(join(tmpdir(), "strato-exec-"));
  dirs.push(dir);
  const clock = { now: 1_790_000_000_000 };
  const p = execProvider({
    id: "tickets",
    argv: [process.execPath, FIXTURE, "--mode", mode, ...(o.extraArgs ?? [])],
    cwd: SCRIPTS,
    descriptor: await fixtureDescriptor(),
    logFile: () => join(dir, "provider.log"),
    stratoVersion: "0.0.0-test",
    now: () => clock.now,
    ...o,
  });
  hosts.push(p);
  return { p, clock, log: () => (existsSync(join(dir, "provider.log")) ? readFileSync(join(dir, "provider.log"), "utf8") : "") };
}

const errorOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (e) {
    return e as Record<string, unknown>;
  }
  throw new Error("expected an error");
};

describe("the protocol, pure", () => {
  test("lines are framed, a partial line waits, an overlong one is an overflow", () => {
    expect(takeLines("", '{"a":1}\n{"b"')).toEqual({ lines: ['{"a":1}'], rest: '{"b"', overflow: false });
    expect(takeLines('{"b"', ":2}\r\n\n")).toEqual({ lines: ['{"b":2}'], rest: "", overflow: false });
    expect(takeLines("", "x".repeat(20), 10).overflow).toBe(true);
  });

  test("a line is a response, a request, a notification, or not a protocol message", () => {
    expect(readLine('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')).toEqual({ kind: "response", id: 1, result: { ok: true } });
    expect(readLine('{"jsonrpc":"2.0","id":"a","method":"http.fetch","params":{}}')).toEqual({ kind: "request", id: "a", method: "http.fetch", params: {} });
    expect(readLine('{"jsonrpc":"2.0","method":"log","params":{"level":"info"}}')).toEqual({ kind: "notification", method: "log", params: { level: "info" } });
    expect(readLine("hello").kind).toBe("invalid");
    expect(readLine('{"id":1,"result":1}').kind).toBe("invalid");
  });

  test("error objects read as provider errors; a write that failed for an unknown reason may have happened", () => {
    expect(errorOfRpc({ code: -32002, message: "refused" })).toEqual({ code: "invalid_auth", message: "refused", retryable: false, fatal: true });
    expect(errorOfRpc({ code: -32003, message: "slow down", data: { retryAfterMs: 7000 } })).toEqual({ code: "rate_limited", message: "slow down", retryable: true, fatal: false, retryAfterMs: 7000 });
    expect(errorOfRpc({ code: -32601, message: "no" }, "write").outcome).toBe("none");
    expect(errorOfRpc({ code: -32000, message: "boom" }, "write").outcome).toBe("unknown");
    expect(errorOfRpc({ code: -32000, message: "boom", data: { code: "not_found", outcome: "none" } }, "write")).toMatchObject({ code: "not_found", outcome: "none" });
  });

  test("the environment of a provider keeps the proxy and certificates, never a secret", () => {
    const env = execEnv({ PATH: "/bin", HOME: "/home/alice", HTTPS_PROXY: "http://proxy.acme:3128", no_proxy: "localhost", STRATO_SLACK_TOKEN: "xoxp-1", LINEAR_API_KEY: "lin_1", SSL_CERT_FILE: "/etc/acme.pem" });
    expect(env).toEqual({ STRATO_PROVIDER_PROTOCOL: "1", PATH: "/bin", HOME: "/home/alice", HTTPS_PROXY: "http://proxy.acme:3128", no_proxy: "localhost", SSL_CERT_FILE: "/etc/acme.pem" });
  });

  test("restarts wait 1 s, 2 s, 4 s… up to 5 minutes; five crashes in ten minutes mark the account down for fifteen", () => {
    expect([1, 2, 3, 9, 20].map(backoffMs)).toEqual([1_000, 2_000, 4_000, 256_000, 300_000]);
    const t0 = 1_000_000;
    expect(startGate([], t0)).toEqual({ ok: true });
    expect(startGate([t0], t0 + 500)).toEqual({ ok: false, down: false, retryAfterMs: 500 });
    expect(startGate([t0], t0 + 1_000)).toEqual({ ok: true });
    const five = [0, 1, 2, 3, 4].map((i) => t0 + i * 60_000);
    expect(startGate(five, t0 + 5 * 60_000)).toEqual({ ok: false, down: true, retryAfterMs: 14 * 60_000 });
    expect(startGate(five, t0 + 4 * 60_000 + 15 * 60_000)).toEqual({ ok: true });
  });
});

describe("an exec provider process", () => {
  test("handshake, then every tool request goes through the account's fetch, with the secret given at initialize", async () => {
    const tool = fakeTool();
    const { p } = await host();
    const ctx = ctxOf({ fetchImpl: tool.fetchImpl });
    const identity = await p.connect(ctx);
    expect(identity).toMatchObject({ me: "u-alice", workspace: "acme" });
    // the process environment: what execEnv keeps, no secret, no Strato variable but the protocol version
    const env = identity.name.split(",");
    expect(env).toContain("STRATO_PROVIDER_PROTOCOL");
    expect(env).not.toContain("STRATO_STATE");
    expect(env.some((k) => /TOKEN|KEY|SECRET/.test(k))).toBe(false);
    const polled = await (p.poll as NonNullable<ExecProvider["poll"]>)(ctx, null, { since: 0, maxItems: 10 });
    expect(polled.items.map((i) => i.id)).toEqual(["n-1", "n-2"]);
    expect(polled.complete).toBe(true);
    const again = await (p.poll as NonNullable<ExecProvider["poll"]>)(ctx, polled.cursor, { since: 0, maxItems: 10 });
    expect(again.items).toEqual([]);
    const thread = await (p.context as NonNullable<ExecProvider["context"]>)(ctx, "OPS-7", { max: 50 });
    expect(thread).toMatchObject({ thread: "OPS-7", title: "Checkout fails" });
    const replies = await (p.replies as NonNullable<ExecProvider["replies"]>)(ctx, "OPS-7", { since: 0, max: 10 });
    expect(replies.map((i) => i.id)).toEqual(["n-8"]);
    expect(tool.requests.every((r) => r.auth === `Bearer ${SECRET}`)).toBe(true);
    expect(tool.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(["GET /api/me", "GET /api/notifications", "GET /api/notifications", "GET /api/tickets/OPS-7"]);
  }, 30_000);

  test("act and undo: the write carries the text and the idempotency key; a dry run writes nothing", async () => {
    const tool = fakeTool();
    const { p } = await host();
    const ctx = ctxOf({ fetchImpl: tool.fetchImpl });
    const action = { kind: "comment" as const, target: { scope: "ticket" as const, native: "OPS-7", label: "OPS-7" }, text: "The fix is live" };
    const dry = await (p.act as NonNullable<ExecProvider["act"]>)(ctx, { action, idempotencyKey: "tickets:OPS-7#t1#3f9a1c0be27d#1", dryRun: true });
    expect(dry).toMatchObject({ ok: true, dry: "comment on OPS-7" });
    expect(tool.requests).toEqual([]);
    const done = await (p.act as NonNullable<ExecProvider["act"]>)(ctx, { action, idempotencyKey: "tickets:OPS-7#t1#3f9a1c0be27d#1", dryRun: false });
    expect(done).toMatchObject({ ok: true, ref: "c-9", undo: { token: "c-9" } });
    expect(JSON.parse(tool.requests[0].body)).toEqual({ body: "The fix is live", idempotencyKey: "tickets:OPS-7#t1#3f9a1c0be27d#1" });
    expect(await (p.undo as NonNullable<ExecProvider["undo"]>)(ctx, "c-9")).toMatchObject({ ok: true });
    expect(tool.requests.at(-1)).toMatchObject({ method: "DELETE", url: "https://tickets.example/api/comments/c-9" });
  }, 30_000);

  test("errors keep their meaning: a 401 needs setup, a 429 says when to retry", async () => {
    const { p } = await host();
    const refused = fakeTool({ "GET /api/me": () => new Response("", { status: 401 }) });
    expect(await errorOf(() => p.connect(ctxOf({ fetchImpl: refused.fetchImpl })))).toMatchObject({ code: "invalid_auth", fatal: true });
    const slow = fakeTool({ "GET /api/notifications": () => new Response("", { status: 429, headers: { "retry-after": "7" } }) });
    expect(await errorOf(() => (p.poll as NonNullable<ExecProvider["poll"]>)(ctxOf({ fetchImpl: slow.fetchImpl }), null, { since: 0, maxItems: 5 }))).toMatchObject({ code: "rate_limited", retryable: true, retryAfterMs: 7000 });
  }, 30_000);

  test("its stderr and log notifications go to the account's log, secrets masked; pushed items arrive until the subscription is stopped", async () => {
    const { p, log } = await host();
    const stop = new AbortController();
    const ctx = ctxOf({ signal: stop.signal });
    const got: { items: Item[]; cursor?: IngestCursor }[] = [];
    let opened = false;
    const ended = (p.subscribe as NonNullable<ExecProvider["subscribe"]>)(ctx, (items, cursor) => got.push({ items, ...(cursor ? { cursor } : {}) }), { opened: () => (opened = true) });
    for (let i = 0; i < 50 && got.length < 2; i++) await Bun.sleep(20);
    expect(opened).toBe(true);
    expect(got.map((g) => g.items.map((x) => x.id))).toEqual([["n-9"], []]);
    expect(got[0].cursor).toEqual({ value: "1790000900000", at: 1_790_000_900_000 });
    stop.abort();
    expect(await ended).toEqual({ end: "clean" });
    await Bun.sleep(50);
    const text = log();
    expect(text).toContain("stderr: started for default with key tk-a…");
    expect(text).toContain("info: pushed with tk-a…");
    expect(text).toContain("health: ok");
    expect(text).not.toContain(SECRET);
  }, 30_000);

  test("a provider without replies nor complete: the catch-up reads nothing, the items stay as they are", async () => {
    const { p } = await host("no-replies");
    const ctx = ctxOf();
    expect(await (p.replies as NonNullable<ExecProvider["replies"]>)(ctx, "OPS-7", { since: 0, max: 10 })).toEqual([]);
    const items = [{ id: "x" }] as unknown as Item[];
    expect(await (p.complete as NonNullable<ExecProvider["complete"]>)(ctx, items)).toBe(items);
  }, 30_000);
});

describe("timeouts, crashes and restarts", () => {
  test("a timeout counts from dispatch: a call queued behind a slow one keeps its whole budget; $/cancel keeps the process", async () => {
    const { p } = await host("hang-on-poll", { timeouts: { poll: 300, connect: 250 } });
    const ctx = ctxOf();
    await p.connect(ctx);
    const pid = p.processes()[0].pid;
    const [poll, connect] = await Promise.allSettled([(p.poll as NonNullable<ExecProvider["poll"]>)(ctx, null, { since: 0, maxItems: 5 }), p.connect(ctx)]);
    expect(poll.status === "rejected" && poll.reason).toMatchObject({ code: "timeout", retryable: true, outcome: "none" });
    // queued for 300 ms behind the poll, with a 250 ms budget of its own: it still answers
    expect(connect.status).toBe("fulfilled");
    expect(p.processes()[0].pid).toBe(pid);
  }, 30_000);

  test("a provider that ignores $/cancel is killed and restarted after its backoff, counted on the clock", async () => {
    const { p, clock, log } = await host("hang-on-poll", { timeouts: { poll: 200 }, cancelGraceMs: 200, extraArgs: ["--cancel", "ignore"] });
    const ctx = ctxOf();
    await p.connect(ctx);
    const pid = p.processes()[0].pid;
    expect(await errorOf(() => (p.poll as NonNullable<ExecProvider["poll"]>)(ctx, null, { since: 0, maxItems: 5 }))).toMatchObject({ code: "timeout" });
    for (let i = 0; i < 50 && p.processes()[0].pid !== null; i++) await Bun.sleep(20);
    expect(p.processes()[0]).toMatchObject({ pid: null, crashes: 1 });
    expect(log()).toContain("no answer to $/cancel of poll");
    expect(await errorOf(() => p.connect(ctx))).toMatchObject({ code: "restarting", retryable: true, retryAfterMs: 1000 });
    clock.now += 1_000;
    await p.connect(ctx);
    expect(p.processes()[0].pid).not.toBe(pid);
  }, 30_000);

  test("a crash fails only its calls, a write's outcome is then unknown, and five crashes in ten minutes take the account down", async () => {
    const { p, clock } = await host("crash-on-poll");
    const ctx = ctxOf();
    const other = await host();
    for (let n = 1; n <= 5; n++) {
      await p.connect(ctx);
      expect(await errorOf(() => (p.poll as NonNullable<ExecProvider["poll"]>)(ctx, null, { since: 0, maxItems: 5 }))).toMatchObject({ code: "crashed", retryable: true, outcome: "none" });
      for (let i = 0; i < 50 && p.processes()[0].crashes < n; i++) await Bun.sleep(10);
      clock.now += backoffMs(n);
    }
    expect(await errorOf(() => p.connect(ctx))).toMatchObject({ code: "provider_down", retryable: true });
    // another provider process is not affected
    expect(await other.p.connect(ctxOf())).toMatchObject({ me: "u-alice" });
    clock.now += 15 * 60_000;
    expect(await p.connect(ctx)).toMatchObject({ me: "u-alice" });
    // a process that dies during a write: the comment may be out, so the outcome is unknown, never retried blindly
    const tool = fakeTool();
    const writer = await host("crash-on-act");
    const action = { kind: "comment" as const, target: { scope: "ticket" as const, native: "OPS-7", label: "OPS-7" }, text: "The fix is live" };
    const e = await errorOf(() => (writer.p.act as NonNullable<ExecProvider["act"]>)(ctxOf({ fetchImpl: tool.fetchImpl }), { action, idempotencyKey: "k", dryRun: false }));
    expect(e).toMatchObject({ code: "crashed", outcome: "unknown" });
    expect(tool.requests.map((r) => r.method)).toEqual(["POST"]);
  }, 30_000);

  test("a line that is not the protocol restarts the process", async () => {
    const { p, log } = await host("noise");
    expect(await errorOf(() => p.connect(ctxOf()))).toMatchObject({ code: "crashed" });
    expect(log()).toContain("protocol error: not JSON; the process is restarted");
  }, 30_000);

  test("a provider that speaks another protocol version is down, without a restart loop", async () => {
    const { p } = await host("old-protocol");
    expect(await errorOf(() => p.connect(ctxOf()))).toMatchObject({ code: "protocol_version", fatal: true });
    expect(await errorOf(() => p.connect(ctxOf()))).toMatchObject({ code: "provider_down" });
    expect(await errorOf(() => describeExec({ id: "tickets", argv: [process.execPath, FIXTURE, "--mode", "old-protocol"], cwd: SCRIPTS }))).toMatchObject({ code: "protocol_version" });
  }, 30_000);

  test("setup's verify step runs a throwaway process with the candidate secret; an idle process stops by itself", async () => {
    const tool = fakeTool();
    const { p } = await host("normal", { idleMs: 100 });
    expect(await p.connect(ctxOf({ verifying: true, secret: "tk-candidate-000000", fetchImpl: tool.fetchImpl }))).toMatchObject({ me: "u-alice" });
    expect(tool.requests[0].auth).toBe("Bearer tk-candidate-000000");
    expect(p.processes()).toEqual([]);
    await p.connect(ctxOf());
    expect(p.processes()[0].pid).not.toBeNull();
    for (let i = 0; i < 50 && p.processes()[0].pid !== null; i++) await Bun.sleep(20);
    expect(p.processes()[0]).toMatchObject({ pid: null, crashes: 0 });
  }, 30_000);
});
