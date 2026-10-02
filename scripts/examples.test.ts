/**
 * The example providers written by outside authors (examples/providers/): each passes the offline conformance
 * harness with every fixture file, its own unit tests pass, its types file is the SDK as printed, and nothing in it
 * names a local path. The Python one is skipped where python3 is missing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupRigs, cli, rig, SCRIPTS } from "./test-rig.ts";

afterEach(cleanupRigs);

const EXAMPLES = join(SCRIPTS, "..", "examples", "providers");
const PYTHON = Bun.which("python3");
const SDK = readFileSync(join(SCRIPTS, "providers", "sdk.ts"), "utf8");

/** Every file of a folder, recursively. */
const filesOf = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? filesOf(join(dir, f)) : [join(dir, f)]));

/** The harness on an example: no failing line, every fixture file run, exit code 0. */
async function conformance(name: string, fixtures: string[]): Promise<string> {
  const r = rig();
  const res = await cli(r, ["provider", "test", join(EXAMPLES, name)]);
  const out = res.out + res.err;
  expect(out.split("\n").filter((l) => l.startsWith("fail"))).toEqual([]);
  for (const f of fixtures) expect(out).toContain(`fixtures: ${f}`);
  expect(res.code).toBe(0);
  return out;
}

describe("examples/providers", () => {
  test("each example's types file is the SDK as `strato provider types` prints it, and no file names a local path", () => {
    for (const name of ["github", "email"]) {
      expect(readFileSync(join(EXAMPLES, name, "strato-provider.d.ts"), "utf8")).toBe(SDK);
      for (const file of filesOf(join(EXAMPLES, name))) expect(readFileSync(file, "utf8")).not.toMatch(/\/(Users|home)\/[a-z]/);
    }
  });

  test("github, a TypeScript module, passes the harness on both fixture files and its own tests", async () => {
    const out = await conformance("github", ["paged.json", "sample.json"]);
    expect(out).toContain("ok      keys: github:acme/api%2312, github:acme/web%237");
    expect(out).toContain("ok      errors, 403 secondary rate limit");
    expect(out).toContain("ok      errors, 403 on a repository the token was not given");
    expect(out).toContain("ok      undo comment");
    const unit = Bun.spawnSync([process.execPath, "test"], { cwd: join(EXAMPLES, "github"), stdout: "pipe", stderr: "pipe" });
    expect(unit.stderr.toString()).toContain(" 0 fail");
    expect(unit.exitCode).toBe(0);
  }, 120_000);

  test("github type-checks strictly against its types file alone, as an author's editor sees it", () => {
    const dir = join(rig().dir, "tsc");
    const folder = join(EXAMPLES, "github");
    Bun.spawnSync(["mkdir", "-p", dir]);
    const config = join(dir, "tsconfig.json");
    writeFileSync(config, JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ESNext", module: "ESNext", moduleResolution: "bundler", allowImportingTsExtensions: true, lib: ["ESNext", "DOM"], types: [] }, files: [join(folder, "provider.ts")] }));
    const tsc = Bun.spawnSync([process.execPath, join(SCRIPTS, "node_modules", "typescript", "bin", "tsc"), "-p", config], { stdout: "pipe", stderr: "pipe" });
    expect(tsc.stdout.toString() + tsc.stderr.toString()).toBe("");
    expect(tsc.exitCode).toBe(0);
  }, 60_000);

  test.skipIf(!PYTHON)("email, a Python executable, passes the harness on both fixture files, with recipients, and its own tests", async () => {
    const out = await conformance("email", ["alias-encoded.json", "sample.json"]);
    expect(out).toContain("ok      protocol");
    expect(out).toContain('ok      act reply, dry: reply "Re: Checkout fails" to carol@acme.example, dan@acme.example');
    expect(out).toContain("ok      act reply, timeout");
    // the process never writes bytecode next to its code: that would break the folder's trust pin
    const unit = Bun.spawnSync([PYTHON as string, "-m", "unittest"], { cwd: join(EXAMPLES, "email"), env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, stdout: "pipe", stderr: "pipe" });
    expect(unit.stderr.toString()).toContain("OK");
    expect(unit.exitCode).toBe(0);
  }, 120_000);
});
