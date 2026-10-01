/**
 * `strato install-skill [--project <dir>] [--global] [--force]`: writes the Strato skill for Claude Code.
 *
 * - `--global` (default): `~/.claude/skills/strato/SKILL.md` (`$CLAUDE_CONFIG_DIR/skills/…` when set);
 * - `--project <dir>`: `<dir>/.claude/skills/strato/SKILL.md`.
 *
 * The SKILL.md is the repository's template, embedded in the binary, with the command filled in (core/skill.ts):
 * `strato` when the `strato` found in the PATH is this very binary, else its absolute path.
 * A SKILL.md that install-skill did not write (a hand-written one, a development clone) is never overwritten without
 * `--force`; a skill folder that is a development clone (it holds `scripts/strato.ts`) is refused even with it, since
 * writing there would modify the clone. A skill folder that is a symbolic link is replaced by a real folder with
 * `--force`, never written through.
 *
 * Every SKILL.md written is listed in `~/.config/strato/skills.json`: `install-skill --refresh`, run by the update
 * of a binary, rewrites those that still carry the marker, so the skill follows the binary's version.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import skillTemplate from "../../SKILL.md" with { type: "text" };
import { COMPILED, RUNNING, type SelfMode, selfCommand, shellWord } from "../app/self.ts";
import { isGeneratedSkill, renderSkill, skillCommandOf } from "../core/skill.ts";
import { STRATO_VERSION } from "../core/build-info.ts";

export interface InstallSkillOptions {
  /** The SKILL.md to write. */
  target: string;
  /** The command written in place of `$STRATO`. */
  command: string;
  version: string;
  compiled: boolean;
  force?: boolean;
  /** The template, the embedded SKILL.md by default. */
  template?: string;
}

export type InstallSkillResult =
  | { ok: true; path: string; replaced: "new" | "generated" | "forced" }
  | { ok: false; path: string; reason: "foreign" | "clone" | "symlink"; message: string };

/** The global skills folder of Claude Code. */
export const globalSkillsDir = (env: Record<string, string | undefined> = process.env) => join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "skills");

/** The SKILL.md for `--project <dir>`, or the global one. */
export const skillTarget = (project: string | null, env: Record<string, string | undefined> = process.env) =>
  project ? join(resolve(project), ".claude", "skills", "strato", "SKILL.md") : join(globalSkillsDir(env), "strato", "SKILL.md");

/**
 * The command to write: `strato` when the PATH's `strato` is this binary (same real path), else the binary's path;
 * in development, `bun <script>`.
 */
export function skillCommand(m: SelfMode = RUNNING, which: (bin: string) => string | null = (b) => Bun.which(b)): string {
  if (!m.compiled) return selfCommand(m);
  const found = which("strato");
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return found && real(found) === real(m.execPath) ? "strato" : shellWord(m.execPath);
}

export function installSkill(o: InstallSkillOptions): InstallSkillResult {
  const path = o.target;
  const dir = dirname(path);
  let replaced: "new" | "generated" | "forced" = "new";
  if (existsSync(join(dir, "scripts", "strato.ts"))) {
    return { ok: false, path, reason: "clone", message: `${dir} is a development clone of Strato: it is not overwritten, even with --force. Remove it or link it elsewhere first.` };
  }
  let isLink = false;
  try {
    isLink = lstatSync(dir).isSymbolicLink();
  } catch {}
  if (isLink) {
    if (!o.force) return { ok: false, path, reason: "symlink", message: `${dir} is a symbolic link: rerun with --force to replace the link (not its target) by a real folder.` };
    unlinkSync(dir);
    replaced = "forced";
  } else if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    if (isGeneratedSkill(current)) replaced = "generated";
    else if (o.force) replaced = "forced";
    else return { ok: false, path, reason: "foreign", message: `${path} exists and was not written by install-skill: rerun with --force to replace it.` };
  }
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, renderSkill(o.template ?? skillTemplate, o.command, o.version, o.compiled));
  renameSync(tmp, path);
  return { ok: true, path, replaced };
}

/** Where the written SKILL.md files are listed, for `--refresh`. */
export const registryPath = (env: Record<string, string | undefined> = process.env) => join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "strato", "skills.json");

function readRegistry(file: string): string[] {
  try {
    const list = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function register(file: string, path: string) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify([...new Set([...readRegistry(file), path])], null, 2)}\n`);
  } catch {}
}

/**
 * Rewrites every registered SKILL.md that still carries the marker, with this binary's template and version.
 * The ones removed or edited by hand since are skipped. Returns the paths rewritten.
 */
export function refreshSkills(command: string, version: string, compiled: boolean, file = registryPath()): string[] {
  const done: string[] = [];
  for (const path of readRegistry(file)) {
    let current: string;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (!isGeneratedSkill(current)) continue;
    // each skill keeps the command it was written with: the updating process may not share the PATH of Claude Code
    const r = installSkill({ target: path, command: skillCommandOf(current) ?? command, version, compiled });
    if (r.ok) done.push(path);
  }
  return done;
}

export async function installSkillCommand(args: string[]): Promise<void> {
  const say = (line: string) => process.stdout.write(`${line}\n`);
  let project: string | null = null;
  let force = false;
  let refresh = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--project") {
      project = args[++i] ?? null;
      if (!project) throw new UsageError("usage: install-skill [--project <dir>] [--global] [--force] [--refresh]");
    } else if (a === "--global") project = null;
    else if (a === "--force") force = true;
    else if (a === "--refresh") refresh = true;
    else throw new UsageError(`unknown option ${a} · usage: install-skill [--project <dir>] [--global] [--force] [--refresh]`);
  }
  const command = skillCommand();
  if (refresh) {
    const done = refreshSkills(command, STRATO_VERSION, COMPILED);
    say(done.length ? `skill rewritten for ${STRATO_VERSION}: ${done.join(", ")}` : "no skill written by install-skill to refresh");
    return;
  }
  const r = installSkill({ target: skillTarget(project), command, version: STRATO_VERSION, compiled: COMPILED, force });
  if (!r.ok) throw new UsageError(r.message);
  register(registryPath(), r.path);
  say(`skill written: ${r.path}${r.replaced === "generated" ? " (updated)" : r.replaced === "forced" ? " (replaced)" : ""}`);
  say(`command: ${command}`);
  say(`In Claude Code${project ? ` opened in ${resolve(project)}` : ""}, type /strato (or "start strato"); the first run walks you through the setup.`);
}

/** A refusal to show on one line, exit code 1. */
export class UsageError extends Error {}
