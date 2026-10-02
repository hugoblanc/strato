/**
 * External providers from the compiled binary: a binary built with `bun build --compile` imports a TypeScript module
 * from disk at runtime, without Bun on the PATH, loads it once trusted, and runs the conformance harness on it.
 *
 * Compiling takes too long for every run. The binary is, in order: STRATO_TEST_BINARY; a fresh build into a temporary
 * folder when STRATO_TEST_COMPILE=1; the one `bun run build:host` left in dist/, when it was built from this tree's SDK
 * file. Without any, the test is skipped.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetName, releaseTarget } from "./core/build-info.ts";
import { cleanupRigs, rig, SCRIPTS } from "./test-rig.ts";

const built: string[] = [];
afterAll(() => {
  cleanupRigs();
  for (const d of built) rmSync(d, { recursive: true, force: true });
});

const SDK = readFileSync(join(SCRIPTS, "providers", "sdk.ts"), "utf8");

function binary(): string | null {
  if (process.env.STRATO_TEST_BINARY) return process.env.STRATO_TEST_BINARY;
  const target = releaseTarget();
  if (!target) return null;
  if (process.env.STRATO_TEST_COMPILE === "1") {
    const out = mkdtempSync(join(tmpdir(), "strato-compiled-"));
    built.push(out);
    const r = Bun.spawnSync([process.execPath, join(SCRIPTS, "build", "compile.ts"), "--target", "host", "--out", out], { cwd: SCRIPTS, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return join(out, assetName(target));
  }
  const dist = join(SCRIPTS, "..", "dist", assetName(target));
  if (!existsSync(dist)) return null;
  // a binary built before this tree's SDK file is another Strato: skipped rather than tested
  const types = Bun.spawnSync([dist, "provider", "types"], { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", HOME: tmpdir() } });
  return types.stdout.toString() === SDK ? dist : null;
}

const BIN = binary();

/** Runs the binary with an environment where no Bun is to be found. */
async function runBin(env: Record<string, string>, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn([BIN as string, ...args], { env: { PATH: "/usr/bin:/bin", HOME: env.HOME, STRATO_STATE: env.STRATO_STATE, STRATO_WORKSPACE: env.STRATO_WORKSPACE, STRATO_UPDATE_CHECK: "off" }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

describe.skipIf(!BIN)("the compiled binary and external providers", () => {
  test("it scaffolds a module, imports it from disk once trusted, and passes it through the harness, without Bun", async () => {
    const r = rig();
    expect(Bun.spawnSync(["/bin/sh", "-c", "command -v bun"], { env: { PATH: "/usr/bin:/bin" } }).exitCode).not.toBe(0);
    const made = await runBin(r.env, ["provider", "new", "demo"]);
    expect(made.code).toBe(0);
    const folder = join(r.state, "providers", "demo");
    writeFileSync(join(r.state, "config.json"), JSON.stringify({ owner: { name: "Alice" }, providers: { demo: { source: { module: "provider.ts" }, accounts: { default: { auth: "api-key", me: "u-alice" } } } } }));
    expect((await runBin(r.env, ["provider", "list"])).out).toContain("demo: not trusted yet");
    // what `provider trust` records after a typed yes, written by the test: trusting needs a terminal
    const trust = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `const t = await import(${JSON.stringify(join(SCRIPTS, "providers/host/trust.ts"))});
         const s = t.trustOf("demo", { module: "provider.ts" });
         const d = (await import(s.resolved.file)).default.descriptor;
         t.writeTrust("demo", { sha256: s.sha256, source: { module: "provider.ts" }, descriptor: d, at: "2026-10-01T00:00:00Z" });`,
      ],
      { cwd: SCRIPTS, env: r.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(trust.stderr.toString()).toBe("");
    const list = await runBin(r.env, ["provider", "list"]);
    expect(list.out).toContain("demo  module · ");
    expect(list.out).toContain("trusted and loaded");
    const tested = await runBin(r.env, ["provider", "test", folder]);
    expect(tested.out).toContain("ok      act comment:");
    expect(tested.out).not.toContain("fail");
    expect(tested.code).toBe(0);
  }, 120_000);
});
