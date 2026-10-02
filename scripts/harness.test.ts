/**
 * `strato provider new` and `strato provider test`: a scaffold works as is in both shapes and type-checks against the
 * printed SDK file; the conformance harness passes it, and fails a broken copy on the check each break concerns. Every
 * run is a real `strato` process on a throwaway state, the harness answering from the fixtures, offline.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, FakeTool, matches } from "./providers/harness/fake.ts";
import { cleanupRigs, cli, type Rig, rig, SCRIPTS } from "./test-rig.ts";

afterEach(cleanupRigs);

const PYTHON = Bun.which("python3");

/** A scaffold of `demo` in the rig, its folder. */
async function scaffold(r: Rig, extra: string[] = []): Promise<string> {
  const res = await cli(r, ["provider", "new", "demo", "--dir", join(r.dir, "src"), ...extra]);
  if (res.code !== 0) throw new Error(res.err);
  return join(r.dir, "src", "demo");
}

/** The harness on a folder: its lines, as `status check` pairs, and its exit code. */
async function harness(r: Rig, folder: string): Promise<{ code: number; lines: string[]; out: string }> {
  const res = await cli(r, ["provider", "test", folder]);
  return { code: res.code, out: res.out + res.err, lines: res.out.split("\n").filter(Boolean) };
}

/** The scaffold's module with one piece of its code replaced: the break a test makes on purpose. */
function patch(folder: string, from: string, to: string): void {
  const file = join(folder, "provider.ts");
  const src = readFileSync(file, "utf8");
  if (!src.includes(from)) throw new Error(`not in the template: ${from}`);
  writeFileSync(file, src.replace(from, to));
}

/** The line of one check. */
const line = (h: { lines: string[] }, check: string) => h.lines.find((l) => l.includes(` ${check}`)) ?? "";

describe("provider new", () => {
  test("a module scaffold passes the harness with no edit, and type-checks against the printed SDK file", async () => {
    const r = rig();
    const folder = await scaffold(r);
    for (const f of ["provider.ts", "strato-provider.d.ts", "fixtures/sample.json", "README.md"]) expect(existsSync(join(folder, f))).toBe(true);
    expect(readFileSync(join(folder, "strato-provider.d.ts"), "utf8")).toBe(readFileSync(join(SCRIPTS, "providers", "sdk.ts"), "utf8"));
    const h = await harness(r, folder);
    expect(h.out).not.toContain("fail");
    expect(h.code).toBe(0);
    for (const check of ["descriptor", "connect", "poll", "links", "triage", "context", "act comment, dry", "act comment:", "undo comment", "act comment, timeout", "errors", "network"]) expect(h.out).toContain(`ok      ${check}`);
    // the scaffold, compiled by TypeScript against the declaration file alone, as an author's editor sees it
    writeFileSync(join(folder, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ESNext", module: "ESNext", moduleResolution: "bundler", allowImportingTsExtensions: true, lib: ["ESNext", "DOM"], types: [] }, files: ["provider.ts"] }));
    const tsc = Bun.spawnSync([process.execPath, join(SCRIPTS, "node_modules", "typescript", "bin", "tsc"), "-p", join(folder, "tsconfig.json")], { stdout: "pipe", stderr: "pipe" });
    expect(tsc.stdout.toString() + tsc.stderr.toString()).toBe("");
    expect(tsc.exitCode).toBe(0);
  }, 60_000);

  test.skipIf(!PYTHON)("a Python scaffold speaks the protocol and passes the harness with no edit", async () => {
    const r = rig();
    const folder = await scaffold(r, ["--exec", "python"]);
    expect(existsSync(join(folder, "provider.py"))).toBe(true);
    const h = await harness(r, folder);
    expect(h.out).not.toContain("fail");
    expect(h.out).toContain("ok      protocol");
    expect(h.out).toContain("ok      act comment:");
    expect(h.code).toBe(0);
  }, 60_000);

  test("by default in the provider's own folder, with a relative source; never over existing files; a session cannot", async () => {
    const r = rig();
    const res = await cli(r, ["provider", "new", "demo"]);
    expect(res.out).toContain('{"providers":{"demo":{"source":{"module":"provider.ts"}}}}');
    expect(existsSync(join(r.state, "providers", "demo", "provider.ts"))).toBe(true);
    const again = await cli(r, ["provider", "new", "demo"]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("already holds files");
    expect((await cli(r, ["provider", "new", "slack"])).err).toContain('"slack" is a built-in tool');
    expect((await cli(r, ["provider", "new", "crm", "--exec", "cobol"])).err).toContain("No scaffold for cobol yet (python)");
    const session = await cli(r, ["provider", "new", "other"], { STRATO_CALLER: "session" });
    expect(session.code).toBe(77);
    expect(existsSync(join(r.state, "providers", "other"))).toBe(false);
  }, 60_000);
});

describe("provider test fails a broken provider on the check it breaks", () => {
  const cases: { name: string; from: string; to: string; check: string; says: string }[] = [
    {
      name: "a dry run that writes",
      from: "    if (input.dryRun) return {",
      to: "    if (input.dryRun) await api(ctx, \"POST\", `/api/threads/${a.target.native}/comments`, { text: a.text });\n    if (input.dryRun) return {",
      check: "act comment, dry",
      says: "a dry run made requests that write: POST https://demo.example/api/threads/OPS-7/comments",
    },
    { name: "a 401 read as retryable", from: 'message: "the API key was refused", fatal: true', to: 'message: "the API key was refused", retryable: true', check: "errors", says: "a 401 must give a fatal error" },
    { name: "a write timeout that says it surely did not happen", from: 'message: String((e as Error)?.message ?? e), retryable: true', to: 'message: String((e as Error)?.message ?? e), retryable: true, outcome: "none"', check: "act comment, timeout", says: "it must never say outcome none" },
    { name: "a cursor that gives the same items again", from: "cursor: { value: String(at), at }", to: 'cursor: { value: "0", at }', check: "poll", says: "gave back 2 item(s) already returned" },
    { name: "a request no fixture answers", from: '"/api/me"', to: '"/api/whoami"', check: "network", says: "requests that match no fixture: GET https://demo.example/api/whoami" },
    { name: "a link pattern that does not read its own links", from: 'url: `https://${HOST}/t/$1`', to: 'url: `https://${HOST}/items/$1`', check: "links", says: "for OPS-7, DOC-3" },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      const r = rig();
      const folder = await scaffold(r);
      patch(folder, c.from, c.to);
      const h = await harness(r, folder);
      expect(h.code).toBe(1);
      const failed = h.lines.filter((l) => l.startsWith("fail"));
      expect(failed.some((l) => l.includes(` ${c.check}`) && l.includes(c.says))).toBe(true);
    }, 60_000);
  }

  test("items that come without any request through the fake are not verifiable offline, and nothing is written for real", async () => {
    const r = rig();
    const folder = await scaffold(r);
    // its own connection: the activity comes from somewhere the harness cannot see
    patch(folder, 'const all: Activity[] = await api(ctx, "GET", "/api/activity");', 'const all: Activity[] = [{ id: "a-1", thread: "OPS-7", author: { id: "u-bob", name: "Bob" }, text: "hi", at: 1790000100000 }];');
    const h = await harness(r, folder);
    expect(h.out).toContain("not verifiable offline poll");
    expect(h.out).toContain("not verifiable offline act comment:");
    expect(h.out).not.toContain("ok      act comment:");
  }, 60_000);

  test("a provider never seen talking through the fake is not written to for real, even with a thread to act on", async () => {
    const r = rig();
    const folder = await scaffold(r);
    // no request from connect nor poll: the fixture's act thread alone would otherwise lead to a real write
    patch(folder, 'const me = await api(ctx, "GET", "/api/me");', 'const me = { id: "u-alice", name: "Alice", workspace: "acme" };');
    patch(folder, 'const all: Activity[] = await api(ctx, "GET", "/api/activity");', "const all: Activity[] = [];");
    const h = await harness(r, folder);
    expect(h.out).toContain("ok      act comment, dry");
    expect(h.out).toContain("not verifiable offline act comment:");
    expect(h.out).not.toContain("ok      act comment:");
  }, 60_000);

  test("an exec provider's pushed items are compared with the fixture's, and its keys read back as its threads", async () => {
    const r = rig();
    const folder = join(r.dir, "exec");
    mkdirSync(join(folder, "fixtures"), { recursive: true });
    writeFileSync(join(folder, "provider.ts"), readFileSync(join(SCRIPTS, "test-exec-provider.ts"), "utf8").replace('from "./providers/sdk.ts"', `from ${JSON.stringify(join(SCRIPTS, "providers/sdk.ts"))}`));
    const wrapper = join(folder, "provider");
    writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(folder, "provider.ts"))} "$@"\n`);
    chmodSync(wrapper, 0o755);
    const fixture = (push: string[]) => ({
      secrets: { TICKETS_API_KEY: "test-key-not-a-real-one" },
      settings: { me: "u-alice" },
      exchanges: [
        { request: { method: "GET", url: "https://tickets.example/api/me" }, response: { body: { id: "u-alice", workspace: "acme" } }, repeat: true },
        { request: { method: "GET", url: "https://tickets.example/api/notifications" }, response: { body: [{ id: "n-1", ticket: "OPS-7", author: "bob", text: "please look @u-alice", at: 1_790_000_100_000 }] }, repeat: true },
      ],
      expect: { push },
      push: { waitMs: 500 },
    });
    writeFileSync(join(folder, "fixtures", "sample.json"), JSON.stringify(fixture(["n-9"])));
    const good = await harness(r, wrapper);
    expect(good.out).toContain("ok      keys");
    expect(good.out).toMatch(/(ok|not verifiable offline) +push: 1 item\(s\), clean/);
    writeFileSync(join(folder, "fixtures", "sample.json"), JSON.stringify(fixture(["n-1"])));
    const bad = await harness(r, wrapper);
    expect(line(bad, "push")).toBe("fail    push: pushed n-9 where the fixture expects n-1");
  }, 60_000);

  test("the process's own fetch is refused: a provider reaches its tool through ctx.fetch only", async () => {
    const r = rig();
    const folder = await scaffold(r);
    patch(folder, "res = await ctx.fetch(", "res = await fetch(");
    const h = await harness(r, folder);
    expect(h.code).toBe(1);
    expect(line(h, "connect")).toContain("the conformance harness is offline");
  }, 60_000);

  test("a descriptor with problems stops the run at its first check", async () => {
    const r = rig();
    const folder = await scaffold(r);
    patch(folder, 'kinds: ["tracker"],', 'kinds: ["crm" as never],');
    const h = await harness(r, folder);
    expect(h.code).toBe(1);
    expect(h.lines).toEqual(['fail    descriptor: kinds: "crm" is not one of "chat", "tracker", "mail", "forge"']);
  }, 60_000);

  test("a session never runs the harness, nor its internal command", async () => {
    const r = rig();
    const folder = await scaffold(r);
    expect((await cli(r, ["provider", "test", folder], { STRATO_CALLER: "session" })).code).toBe(77);
    // the harness process refuses a state folder that `provider test` did not make
    const inner = await cli(r, ["provider", "_harness"]);
    expect(inner.code).toBe(64);
    mkdirSync(join(r.state, "providers"), { recursive: true });
    writeFileSync(join(r.state, "harness.json"), JSON.stringify({ nonce: "n", target: { shape: "module", file: join(folder, "provider.ts") }, fixturesDir: null, live: null, locale: "en" }));
    expect((await cli(r, ["provider", "_harness"], { STRATO_HARNESS_NONCE: "other" })).code).toBe(64);
  }, 60_000);
});

describe("the fake tool", () => {
  test("matches method, URL with its query as a set, then the body as canonical JSON or by substrings", () => {
    const ex = { request: { method: "POST", url: "https://t.example/a?x=1&y=2", body: { b: 1, a: [1, 2] } } };
    expect(matches(ex, { method: "post", url: "https://T.example/a?y=2&x=1", body: '{"a":[1,2],"b":1}' })).toBe(true);
    expect(matches(ex, { method: "POST", url: "https://t.example/a?x=1", body: '{"a":[1,2],"b":1}' })).toBe(false);
    expect(matches({ request: { method: "POST", url: "https://t.example/a", bodyContains: ["fix", "t1"] } }, { method: "POST", url: "https://t.example/a", body: "the fix #t1" })).toBe(true);
    expect(canonicalJson({ b: 1, a: { d: 2, c: 1 } })).toBe('{"a":{"c":1,"d":2},"b":1}');
  });

  test("an exchange answers once unless it repeats; a GET or an exchange marked safe writes nothing; errors on demand", async () => {
    const fake = new FakeTool([
      { request: { method: "GET", url: "https://t.example/a" }, response: { body: { n: 1 } } },
      { request: { method: "POST", url: "https://t.example/b" }, response: { status: 201 }, repeat: true },
    ]);
    expect(await (await fake.fetch("https://t.example/a")).json()).toEqual({ n: 1 });
    expect((await fake.fetch("https://t.example/a")).status).toBe(599);
    expect((await fake.fetch("https://t.example/b", { method: "POST" })).status).toBe(201);
    expect((await fake.fetch("https://t.example/b", { method: "POST" })).status).toBe(201);
    expect(fake.requests.map((r) => [r.exchange, r.safe])).toEqual([[0, true], [null, false], [1, false], [1, false]]);
    expect(fake.unmatched.length).toBe(1);
    fake.mode = "429";
    const res = await fake.fetch("https://t.example/b", { method: "POST" });
    expect([res.status, res.headers.get("retry-after")]).toEqual([429, "7"]);
    fake.mode = "timeout";
    expect(await fake.fetch("https://t.example/a").catch((e) => (e as Error).name)).toBe("TimeoutError");
    expect(fake.unmatched.length).toBe(1);
  });
});
