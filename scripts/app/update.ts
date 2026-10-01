/**
 * The installation's version and its update from the board. An installation is either a compiled binary (updated from
 * GitHub releases, app/release.ts) or a git clone of the skill's repository (below); what belongs to the installation
 * lives outside both (the state folder), so updating replaces code only. `mode` picks one, by default the running one.
 *
 * Git clone mode:
 *
 * - `localVersion()`: package.json version, short sha, modified files, branch, upstream.
 * - `checkUpdates()`: `git fetch`, then the commits between HEAD and its upstream, sorted by core/version.ts.
 * - `applyUpdate()`: refuses a modified tree (a master may have fixed a file by hand: never overwrite it),
 *   `git pull --ff-only`, `bun install` if the dependencies changed, then `bun run check`; a failed check puts the
 *   clone back on its previous commit.
 *
 * Never throws on a git or network failure: every outcome is a value the board can show.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareSemver, type GroupedChanges, groupChanges } from "../core/version.ts";
import { applyRelease, binaryLocalVersion, checkRelease, type ReleaseOptions } from "./release.ts";
import { COMPILED } from "./self.ts";

/** The repository root of a development clone: the parent of `scripts/`. Meaningless inside a binary. */
export const SKILL_ROOT = join(import.meta.dir, "..", "..");

export interface UpdateOptions extends ReleaseOptions {
  /** `binary` (GitHub releases) or `git` (the clone); the running mode by default. */
  mode?: "binary" | "git";
  /** Repository root, `SKILL_ROOT` by default. */
  root?: string;
  /** Command run in `<root>/scripts` after the pull: `bun run check` by default (typecheck and tests). */
  check?: string[];
  /** Command run in `<root>/scripts` when package.json or bun.lock changed: `bun install` by default. */
  install?: string[];
}

export interface LocalVersion {
  /** `version` of scripts/package.json, null when unreadable. */
  version: string | null;
  sha: string;
  branch: string;
  /** Upstream branch (`origin/main`), null for a development clone without one. */
  upstream: string | null;
  /** Modified or untracked files, outside `.claude/` (worktrees and local settings). */
  dirty: string[];
}

export interface Commit {
  sha: string;
  subject: string;
}

export interface UpdateCheck {
  checkedAt: string;
  available: boolean;
  /**
   * Why no update is offered: no upstream, fetch failed, local commits not in the upstream, or (binary) a newer
   * release without a binary for this platform.
   */
  reason?: "noUpstream" | "fetchFailed" | "diverged" | "noAsset";
  /** The git error, for `fetchFailed`. */
  error?: string;
  upstream: string | null;
  /** Version of the upstream's package.json. */
  target: string | null;
  /** True when the upstream's version is higher than the installed one. */
  newer: boolean;
  /** Commits of HEAD..@{u}, merges excluded, newest first. */
  commits: Commit[];
  changes: GroupedChanges;
}

/**
 * `checkFailed` is the test suite (git) or the new binary refusing to start (binary). Binary only: `noAsset` (no binary
 * for this platform, or no SHA256SUMS), `downloadFailed`, `checksumFailed`, `replaceFailed` (the swap on disk).
 */
export type UpdateFailure = "noUpstream" | "dirty" | "pullFailed" | "installFailed" | "checkFailed" | "noAsset" | "downloadFailed" | "checksumFailed" | "replaceFailed";

export type UpdateResult =
  | { ok: true; from: string; to: string; fromVersion: string | null; toVersion: string | null; changes: GroupedChanges }
  | { ok: false; reason: UpdateFailure; from: string; files?: string[]; output?: string };

interface Ran {
  code: number;
  out: string;
  err: string;
}

type Env = Record<string, string | undefined>;

/** git never prompts: a fetch that needs credentials fails instead of hanging the server. */
const gitEnv = (): Env => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" });

/**
 * The environment of `bun install` and `bun run check`: the server's, without the installation's `STRATO_*` and
 * `AIGUILLEUR_*` variables. The suite builds throwaway states, and an inherited STRATO_STATE wins over them: the tests
 * would read and write the installation's real state (seen in the end-to-end run of 01/10, where ingest.test.ts caught it).
 */
export function checkEnv(env: Env): Env {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^(STRATO|AIGUILLEUR)_/.test(k)));
}

/** Runs a command without a shell; a timeout or a missing binary is a failed result, never an exception. */
async function sh(cmd: string[], cwd: string, timeoutMs: number, env: Env = gitEnv()): Promise<Ran> {
  try {
    const proc = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    try {
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return timedOut ? { code: code || 124, out, err: `${err}\ntimed out after ${Math.round(timeoutMs / 1000)} s`.trim() } : { code, out, err };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { code: 127, out: "", err: (e as Error).message };
  }
}

const git = (root: string, args: string[], timeoutMs = 10_000) => sh(["git", ...args], root, timeoutMs);
const lineOf = (r: Ran) => r.out.trim();
/** The last lines of a command's output: enough to read the failing test, not the whole suite. */
const tail = (r: Ran, n = 30) => `${r.out}\n${r.err}`.trim().split("\n").slice(-n).join("\n");

function versionOf(json: string): string | null {
  try {
    const v = (JSON.parse(json) as { version?: unknown }).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** `git status --porcelain` -> paths, `.claude/` excluded. */
export function dirtyFiles(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => l.slice(3).replace(/^.* -> /, "").replace(/^"(.*)"$/, "$1"))
    .filter((p) => !p.startsWith(".claude/") && p !== ".claude");
}

const commitsOf = (out: string): Commit[] =>
  out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf("\t");
      return { sha: l.slice(0, i), subject: l.slice(i + 1) };
    });

const binaryMode = (opts: UpdateOptions) => (opts.mode ?? (COMPILED ? "binary" : "git")) === "binary";

export async function localVersion(opts: UpdateOptions = {}): Promise<LocalVersion> {
  if (binaryMode(opts)) return binaryLocalVersion(opts);
  const root = opts.root ?? SKILL_ROOT;
  let version: string | null = null;
  try {
    version = versionOf(readFileSync(join(root, "scripts", "package.json"), "utf8"));
  } catch {}
  const [sha, branch, upstream, status] = await Promise.all([
    git(root, ["rev-parse", "--short", "HEAD"]),
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
    git(root, ["status", "--porcelain"]),
  ]);
  return {
    version,
    sha: sha.code === 0 ? lineOf(sha) : "",
    branch: branch.code === 0 ? lineOf(branch) : "",
    upstream: upstream.code === 0 && lineOf(upstream) ? lineOf(upstream) : null,
    dirty: status.code === 0 ? dirtyFiles(status.out) : [],
  };
}

export async function checkUpdates(opts: UpdateOptions = {}): Promise<UpdateCheck> {
  if (binaryMode(opts)) return checkRelease(opts);
  const root = opts.root ?? SKILL_ROOT;
  const local = await localVersion(opts);
  const base = { checkedAt: new Date().toISOString(), available: false, upstream: local.upstream, target: null, newer: false, commits: [], changes: groupChanges([]) };
  if (!local.upstream) return { ...base, reason: "noUpstream" };
  const fetched = await git(root, ["fetch", "--quiet"], 20_000);
  if (fetched.code !== 0) return { ...base, reason: "fetchFailed", error: tail(fetched, 3) || `git fetch: code ${fetched.code}` };
  const [log, ahead, pkg] = await Promise.all([
    git(root, ["log", "--no-merges", "--format=%h%x09%s", "HEAD..@{u}"]),
    git(root, ["rev-list", "--count", "@{u}..HEAD"]),
    git(root, ["show", "@{u}:scripts/package.json"]),
  ]);
  const commits = log.code === 0 ? commitsOf(log.out) : [];
  const target = pkg.code === 0 ? versionOf(pkg.out) : null;
  const result: UpdateCheck = { ...base, commits, changes: groupChanges(commits), target, newer: compareSemver(target, local.version) > 0 };
  if (Number(lineOf(ahead)) > 0) return { ...result, reason: "diverged" };
  return { ...result, available: commits.length > 0 };
}

export async function applyUpdate(opts: UpdateOptions = {}): Promise<UpdateResult> {
  if (binaryMode(opts)) return applyRelease(opts);
  const root = opts.root ?? SKILL_ROOT;
  const scripts = join(root, "scripts");
  const local = await localVersion(opts);
  const from = lineOf(await git(root, ["rev-parse", "HEAD"]));
  if (!local.upstream) return { ok: false, reason: "noUpstream", from };
  if (local.dirty.length) return { ok: false, reason: "dirty", from, files: local.dirty };

  const pulled = await git(root, ["pull", "--ff-only", "--quiet"], 60_000);
  if (pulled.code !== 0) return { ok: false, reason: "pullFailed", from, output: tail(pulled, 10) };
  const to = lineOf(await git(root, ["rev-parse", "HEAD"]));
  const after = await localVersion(opts);
  const log = await git(root, ["log", "--no-merges", "--format=%h%x09%s", `${from}..${to}`]);
  const changes = groupChanges(log.code === 0 ? commitsOf(log.out) : []);
  if (from === to) return { ok: true, from, to, fromVersion: local.version, toVersion: after.version, changes };

  // the tree was clean and we just fast-forwarded it: going back to `from` loses nothing of the installation
  let installed = false;
  const install = opts.install ?? [process.execPath, "install"];
  const rollback = async () => {
    await git(root, ["reset", "--hard", "--quiet", from]);
    if (installed) await sh(install, scripts, 180_000, checkEnv(process.env));
  };
  const diff = await git(root, ["diff", "--name-only", from, to]);
  if (diff.out.split("\n").some((f) => f === "scripts/package.json" || f === "scripts/bun.lock")) {
    installed = true;
    const r = await sh(install, scripts, 180_000, checkEnv(process.env));
    if (r.code !== 0) {
      await rollback();
      return { ok: false, reason: "installFailed", from, output: tail(r) };
    }
  }
  const checked = await sh(opts.check ?? [process.execPath, "run", "check"], scripts, 300_000, checkEnv(process.env));
  if (checked.code !== 0) {
    await rollback();
    return { ok: false, reason: "checkFailed", from, output: tail(checked) };
  }
  return { ok: true, from, to, fromVersion: local.version, toVersion: after.version, changes };
}
