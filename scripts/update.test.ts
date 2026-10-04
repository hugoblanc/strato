/**
 * app/update.ts end to end, on throwaway repositories: an "upstream" with its own scripts/package.json (whose `check`
 * is `true` or fails, never the real suite) and a clone of it, the way an installation is a clone of the skill.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyUpdate, checkUpdates, dirtyFiles, localVersion } from "./app/update.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
const pkg = (version: string, check = "true") => JSON.stringify({ name: "strato", version, private: true, scripts: { check } }, null, 2);

function commit(repo: string, files: Record<string, string>, subject: string) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), body);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", subject);
}

/** An upstream with two commits and a clone of it; `install` is a no-op so no test touches the network. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "strato-update-"));
  dirs.push(dir);
  const upstream = join(dir, "upstream");
  mkdirSync(upstream);
  git(upstream, "init", "-q", "-b", "main");
  commit(upstream, { "scripts/package.json": pkg("0.1.0"), "SKILL.md": "v1\n" }, "feat(strato): first");
  commit(upstream, { "README.md": "hello\n" }, "docs: readme");
  git(dir, "clone", "-q", upstream, "clone");
  const clone = join(dir, "clone");
  return { dir, upstream, clone, opts: { root: clone, install: ["true"] } };
}

function solo(dir: string): string {
  const repo = join(dir, "solo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  commit(repo, { "scripts/package.json": pkg("0.1.0") }, "feat: solo");
  return repo;
}

describe("localVersion", () => {
  test("version, sha, branch and upstream of a clean clone", async () => {
    const { clone, opts } = setup();
    const v = await localVersion(opts);
    expect(v.version).toBe("0.1.0");
    expect(v.sha).toBe(git(clone, "rev-parse", "--short", "HEAD"));
    expect(v.branch).toBe("main");
    expect(v.upstream).toBe("origin/main");
    expect(v.dirty).toEqual([]);
  });
  test("a modified file is dirty, .claude/ is not", async () => {
    const { clone, opts } = setup();
    mkdirSync(join(clone, ".claude", "worktrees"), { recursive: true });
    writeFileSync(join(clone, ".claude", "worktrees", "x"), "x");
    expect((await localVersion(opts)).dirty).toEqual([]);
    writeFileSync(join(clone, "SKILL.md"), "fixed by hand\n");
    expect((await localVersion(opts)).dirty).toEqual(["SKILL.md"]);
  });
  test("porcelain parsing: renames and quoted paths", () => {
    expect(dirtyFiles(' M a.ts\nR  old.ts -> new.ts\n?? "with space.ts"\n?? .claude/settings.local.json\n')).toEqual(["a.ts", "new.ts", "with space.ts"]);
  });
});

describe("checkUpdates", () => {
  test("two new commits upstream: available, grouped, with the target version", async () => {
    const { upstream, opts } = setup();
    commit(upstream, { "scripts/package.json": pkg("0.2.0"), "a.txt": "a" }, "feat(board): update from the board");
    commit(upstream, { "b.txt": "b" }, "fix(serve): restart on the same port");
    const c = await checkUpdates(opts);
    expect(c.available).toBe(true);
    expect(c.reason).toBeUndefined();
    expect(c.commits.map((x) => x.subject)).toEqual(["fix(serve): restart on the same port", "feat(board): update from the board"]);
    expect(c.changes.features.map((x) => x.text)).toEqual(["update from the board"]);
    expect(c.changes.fixes.map((x) => x.text)).toEqual(["restart on the same port"]);
    expect(c.target).toBe("0.2.0");
    expect(c.newer).toBe(true);
  });
  test("up to date: nothing available, no reason", async () => {
    const { opts } = setup();
    const c = await checkUpdates(opts);
    expect(c.available).toBe(false);
    expect(c.reason).toBeUndefined();
    expect(c.commits).toEqual([]);
  });
  test("no upstream: a reason, no fetch", async () => {
    const { dir } = setup();
    expect(await checkUpdates({ root: solo(dir) })).toMatchObject({ available: false, reason: "noUpstream", upstream: null });
  });
  test("an unreachable remote: a readable failure, no exception", async () => {
    const { dir, clone, opts } = setup();
    rmSync(join(dir, "upstream"), { recursive: true, force: true });
    const c = await checkUpdates(opts);
    expect(c.available).toBe(false);
    expect(c.reason).toBe("fetchFailed");
    expect(c.error).toBeTruthy();
    expect(git(clone, "status", "--porcelain")).toBe("");
  });
  test("local commits not upstream: diverged, not offered", async () => {
    const { upstream, clone, opts } = setup();
    commit(upstream, { "a.txt": "a" }, "feat: upstream");
    commit(clone, { "local.txt": "l" }, "fix: local only");
    const c = await checkUpdates(opts);
    expect(c.available).toBe(false);
    expect(c.reason).toBe("diverged");
  });
});

describe("applyUpdate", () => {
  test("fast-forwards the clone and returns what changed", async () => {
    const { upstream, clone, opts } = setup();
    const before = git(clone, "rev-parse", "HEAD");
    commit(upstream, { "scripts/package.json": pkg("0.2.0") }, "feat(board): update from the board");
    commit(upstream, { "b.txt": "b" }, "fix(serve): restart");
    const r = await applyUpdate(opts);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.from).toBe(before);
    expect(r.to).toBe(git(upstream, "rev-parse", "HEAD"));
    expect(git(clone, "rev-parse", "HEAD")).toBe(r.to);
    expect(r.fromVersion).toBe("0.1.0");
    expect(r.toVersion).toBe("0.2.0");
    expect(r.changes.features.map((c) => c.text)).toEqual(["update from the board"]);
    expect(r.changes.fixes.map((c) => c.text)).toEqual(["restart"]);
  });
  test("runs the install command only when package.json or bun.lock changed", async () => {
    const { dir, upstream, clone } = setup();
    const marker = join(dir, "installed");
    const opts = { root: clone, install: ["sh", "-c", `echo x >> ${marker}`] };
    commit(upstream, { "b.txt": "b" }, "fix: no deps");
    expect((await applyUpdate(opts)).ok).toBe(true);
    expect(() => readFileSync(marker)).toThrow();
    commit(upstream, { "scripts/package.json": pkg("0.3.0") }, "chore: bump");
    expect((await applyUpdate(opts)).ok).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe("x\n");
  });
  test("a modified file: refused with the list, nothing touched", async () => {
    const { upstream, clone, opts } = setup();
    const before = git(clone, "rev-parse", "HEAD");
    commit(upstream, { "SKILL.md": "v2\n" }, "docs: skill v2");
    writeFileSync(join(clone, "SKILL.md"), "fixed by hand\n");
    const r = await applyUpdate(opts);
    expect(r).toMatchObject({ ok: false, reason: "dirty", files: ["SKILL.md"] });
    expect(git(clone, "rev-parse", "HEAD")).toBe(before);
    expect(readFileSync(join(clone, "SKILL.md"), "utf8")).toBe("fixed by hand\n");
  });
  test("a failing check (the package's own script): back on the previous commit, with the output", async () => {
    const { upstream, clone, opts } = setup();
    const before = git(clone, "rev-parse", "HEAD");
    commit(upstream, { "scripts/package.json": pkg("0.2.0", "echo 'test broken' && false") }, "feat: broken");
    const r = await applyUpdate(opts);
    expect(r).toMatchObject({ ok: false, reason: "checkFailed", from: before });
    if (!r.ok) expect(r.output).toContain("test broken");
    expect(git(clone, "rev-parse", "HEAD")).toBe(before);
    expect(git(clone, "status", "--porcelain")).toBe("");
    expect(JSON.parse(readFileSync(join(clone, "scripts", "package.json"), "utf8")).version).toBe("0.1.0");
  });
  test("a given check command that fails rolls back too", async () => {
    const { upstream, clone } = setup();
    const before = git(clone, "rev-parse", "HEAD");
    commit(upstream, { "b.txt": "b" }, "fix: fine");
    const r = await applyUpdate({ root: clone, install: ["true"], check: ["false"] });
    expect(r).toMatchObject({ ok: false, reason: "checkFailed" });
    expect(git(clone, "rev-parse", "HEAD")).toBe(before);
  });
  test("the check never sees the installation's STRATO_* variables (it would aim the tests at the real state)", async () => {
    const { upstream, clone } = setup();
    commit(upstream, { "b.txt": "b" }, "fix: fine");
    const saved = { s: process.env.STRATO_STATE, a: process.env.AIGUILLEUR_STATE };
    process.env.STRATO_STATE = "/real/installation/state";
    process.env.AIGUILLEUR_STATE = "/real/legacy/state";
    try {
      const r = await applyUpdate({ root: clone, install: ["true"], check: ["sh", "-c", 'test -z "$STRATO_STATE$AIGUILLEUR_STATE" && test -n "$PATH"'] });
      expect(r.ok).toBe(true);
    } finally {
      for (const [k, v] of [["STRATO_STATE", saved.s], ["AIGUILLEUR_STATE", saved.a]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
  test("no upstream: refused", async () => {
    const { dir } = setup();
    expect(await applyUpdate({ root: solo(dir) })).toMatchObject({ ok: false, reason: "noUpstream" });
  });
});
