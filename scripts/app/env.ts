/**
 * The startup shared by every command: where the script is, where the state is, which profile is loaded.
 * Importing this module installs the profile (`useSettings`) and the policy folders (`usePolicyDirs`) for all others.
 *
 * - Workspace: `STRATO_WORKSPACE` (legacy `AIGUILLEUR_WORKSPACE`), else `workspace` from config.json, else (development
 *   clone only) what precedes `/.claude/` in the skill path (a project skill lives in `<project>/.claude/skills/<name>/`),
 *   else the nearest folder above the cwd holding a `.strato` or `.aiguilleur` state folder, else the cwd.
 *   A compiled binary has no skill path: it relies on the environment, the state folder found from the cwd, or the cwd.
 * - State: `STRATO_STATE` (legacy `AIGUILLEUR_STATE`), else `<workspace>/.strato`, or `<workspace>/.aiguilleur` when
 *   only that one exists (core/paths.ts).
 */
import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeBin } from "../claude/model.ts";
import { envValue, findStateRoot, resolveStateDir } from "../core/paths.ts";
import { resolveSettings, useSettings } from "../core/settings.ts";
import { parseDuration } from "../core/text.ts";
import { usePolicyDirs } from "../policy/prompts.ts";
import { COMPILED, entryOf } from "./self.ts";
import { statSync } from "node:fs";

/**
 * The entry point: the binary when compiled, `scripts/strato.ts` in development. Sessions, hooks and ttyd all call it,
 * always through app/self.ts (`selfCommand()`, `selfArgv()`), never as `bun ${SCRIPT}`.
 */
export const SCRIPT = entryOf();
/**
 * The pre-rename entry point, a one-line alias of `scripts/strato.ts`: hooks and prompts of older sessions still call
 * it. Null in a binary, which has no such file.
 */
export const LEGACY_SCRIPT: string | null = COMPILED ? null : join(import.meta.dir, "..", "aiguilleur.ts");
/** The claude binary, resolved once: the panel server does not necessarily have ~/.local/bin in its PATH. */
export const CLAUDE_BIN = claudeBin();
export const HOME = homedir();

/** `~/x` -> absolute path. */
export const expandHome = (p: string) => (p === "~" ? HOME : p.startsWith("~/") ? join(HOME, p.slice(2)) : p);

/** An unreadable state file: never silently replaced by its default value. */
export class CorruptState extends Error {
  constructor(
    readonly path: string,
    readonly copy: string,
    cause: string,
  ) {
    super(`${path} is unreadable (${cause}): copy kept in ${copy}, repair it by hand`);
    this.name = "CorruptState";
  }
}

const inState = (path: string) => path.startsWith(join(STATE, "/"));

/**
 * Reads a JSON file. Missing: the default value. Unreadable: it depends on who writes it.
 * - Outside the state folder (Claude Code, project settings): the default value, the file may be mid-write.
 * - Inside the state folder: a `CorruptState` error, and a copy `<name>.corrupt-<date>`. sujets.json and config.json
 *   stay in place, so every write fails until they are repaired; the others (queues, caches) are moved aside and
 *   start over. Reading a broken sujets.json as empty would let the next `set` overwrite every topic.
 */
export function readJson<T>(path: string, fallback: T): T {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || !inState(path)) return fallback;
    throw e;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    if (!inState(path)) return fallback;
    // the file's mtime names the copy: rereading the same broken file does not multiply copies
    const copy = `${path}.corrupt-${new Date(mtimeOf(path) || Date.now()).toISOString().replace(/[:.]/g, "-")}`;
    try {
      if (path === F.sujets || path === F.config) {
        if (!existsSync(copy)) copyFileSync(path, copy);
      } else renameSync(path, copy);
    } catch {}
    throw new CorruptState(path, copy, (e as Error).message);
  }
}

/** Writes a JSON file in one go: temp file, fsync, then rename. A reader sees the old content or the new one, never a fragment. */
export function writeJson(path: string, value: unknown) {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}


/**
 * The workspace without config.json: the environment, else the project that contains the skill (development clone),
 * else the nearest folder above the cwd that holds a state folder, else the cwd. The skill path only helps when the
 * skill is a real folder of the project: Bun resolves symbolic links, so a skill linked from a shared clone reports
 * the clone's path; a binary has no skill path at all. Walking up from the cwd (like git looks for .git) then finds
 * the project from any of its subfolders and worktrees.
 */
function derivedWorkspace(): string {
  const fromEnv = envValue(process.env, "WORKSPACE");
  if (fromEnv) return expandHome(fromEnv);
  const i = COMPILED ? -1 : SCRIPT.indexOf("/.claude/");
  if (i > 0) return SCRIPT.slice(0, i);
  return findStateRoot(process.cwd()) ?? process.cwd();
}

export const STATE = resolveStateDir(process.env, derivedWorkspace());
export const F = {
  config: join(STATE, "config.json"),
  sujets: join(STATE, "sujets.json"),
  seen: join(STATE, "seen.json"),
  users: join(STATE, "users.json"),
  events: join(STATE, "events.ndjson"),
  tick: join(STATE, "tick.json"),
  /** Today's letter counter and the date of the last digest. File name kept for existing installations. */
  counters: join(STATE, "compteurs.json"),
  reports: join(STATE, "reports"),
  lock: join(STATE, ".lock"),
  /** What topic sessions declare about themselves, one file per session, written by their hooks. */
  live: join(STATE, "live"),
  /** The installation's policy templates, which replace the skill's defaults file by file. */
  policy: join(STATE, "policy"),
  /** iTerm2 session unique ID -> topic key, for the tabs opened by dive. */
  tabs: join(STATE, "iterm-tabs.json"),
  /** Topics snoozed from the board: key -> { until, since }. */
  snooze: join(STATE, "snooze.json"),
  /** Requests made to the master from the board (full review): written by serve, emitted by listen. */
  master: join(STATE, "master.json"),
  /** Messages surfaced to the master, one file per message: `open` and `relay` reread them by --msg. */
  inbox: join(STATE, "inbox"),
  /** Images pasted in the board for a session, one folder per topic: the session reads them by path. */
  uploads: join(STATE, "uploads"),
};

const loaded = resolveSettings(readJson<unknown>(F.config, {}));
/** The working directory of topic sessions (cwd, CLAUDE.md, .mcp.json). */
export const WORKSPACE = envValue(process.env, "WORKSPACE") ? derivedWorkspace() : expandHome(loaded.workspace) || derivedWorkspace();
useSettings({ ...loaded, workspace: WORKSPACE });
usePolicyDirs([F.policy]);

export const out = (line: string) => process.stdout.write(`${line}\n`);
export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export function fail(message: string, code = 1): never {
  process.stderr.write(`strato: ${message}\n`);
  process.exit(code);
}

export function flags(args: string[]): { positional: string[]; opts: Record<string, string> } {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) opts[a.slice(2)] = "true";
      else {
        opts[a.slice(2)] = next;
        i++;
      }
    } else positional.push(a);
  }
  return { positional, opts };
}

export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const dayOfIso = (iso: string) => localDay(Date.parse(iso));

export function localTime(iso: string): string {
  const d = new Date(Date.parse(iso));
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function durationOrFail(s: string): number {
  try {
    return parseDuration(s);
  } catch (e) {
    fail((e as Error).message);
  }
}

/** `listen` heartbeat in tick.json: the board's badge says Strato is silent after three missed beats. */
export const HEARTBEAT_MS = 60_000;

/** Runs a command without a shell, returns its exit code and stdout; killed after `timeoutMs`. */
export async function run(cmd: string[], timeoutMs = 5_000): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const out = await new Response(proc.stdout).text();
    return { code: await proc.exited, out };
  } finally {
    clearTimeout(timer);
  }
}

/** "15/09 13:44" (day/month) in local time. */
export function dayTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${localTime(iso)}`;
}

export function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
