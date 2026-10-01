/**
 * Compiles Strato into standalone executables (`bun build --compile`): no Bun or Node needed where they run.
 *
 *   bun build/compile.ts                         every release target
 *   bun build/compile.ts --target darwin-arm64   one target (repeatable); `--target host` for this machine
 *   bun build/compile.ts --out <dir>             output folder, `<repo>/dist` by default (ignored by git)
 *
 * Writes `strato-<os>-<arch>[.exe]` per target and `SHA256SUMS` (the `sha256sum` format, which install.sh and the
 * board's update check). The commit is embedded (`STRATO_BUILD_SHA`), the version comes from package.json.
 * On macOS, darwin binaries get an ad hoc signature: Apple Silicon refuses to run an unsigned executable.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assetName, RELEASE_TARGETS, type ReleaseTarget, releaseTarget } from "../core/build-info.ts";
import { sha256Hex } from "../app/release.ts";

const SCRIPTS = join(import.meta.dir, "..");
const ROOT = join(SCRIPTS, "..");

function run(cmd: string[], cwd = SCRIPTS): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}\n${r.stderr.toString()}${r.stdout.toString()}`);
  return r.stdout.toString().trim();
}

const args = process.argv.slice(2);
const targets: ReleaseTarget[] = [];
let out = join(ROOT, "dist");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") out = resolve(args[++i]);
  else if (args[i] === "--target") {
    const t = args[++i] === "host" ? releaseTarget() : (args[i] as ReleaseTarget);
    if (!t || !(RELEASE_TARGETS as readonly string[]).includes(t)) throw new Error(`unknown target ${args[i]} (${RELEASE_TARGETS.join(", ")}, host)`);
    targets.push(t);
  } else throw new Error(`unknown option ${args[i]}`);
}
if (!targets.length) targets.push(...RELEASE_TARGETS);

let sha = process.env.GITHUB_SHA?.slice(0, 7) ?? "";
if (!sha) {
  try {
    sha = run(["git", "rev-parse", "--short", "HEAD"], ROOT);
  } catch {}
}
mkdirSync(out, { recursive: true });

for (const t of targets) {
  const file = join(out, assetName(t));
  rmSync(file, { force: true });
  const started = Date.now();
  run([
    process.execPath, "build", "--compile",
    `--target=bun-${t}`,
    // whitespace and syntax only: identifiers stay readable in a stack trace
    "--minify-whitespace", "--minify-syntax",
    "--define", `STRATO_BUILD_SHA=${JSON.stringify(sha)}`,
    "--outfile", file,
    join(SCRIPTS, "strato.ts"),
  ]);
  if (t.startsWith("darwin") && process.platform === "darwin") run(["codesign", "--force", "--sign", "-", file]);
  const mb = (Bun.file(file).size / 1024 / 1024).toFixed(1);
  process.stdout.write(`${assetName(t)}  ${mb} MB  ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
}

// SHA256SUMS covers every binary in the folder: a partial build next to an earlier full one stays consistent
const names = readdirSync(out).filter((f) => /^strato-[a-z]+-[a-z0-9]+(\.exe)?$/.test(f)).sort();
const sums = names.map((n) => `${sha256Hex(readFileSync(join(out, n)))}  ${n}`).join("\n");
writeFileSync(join(out, "SHA256SUMS"), `${sums}\n`);
process.stdout.write(`SHA256SUMS  ${names.length} files  (${out})\n`);
