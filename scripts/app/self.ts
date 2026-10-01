/**
 * How Strato calls itself: the hooks of topic sessions, their permission, the commands their prompts give them,
 * and the processes the server spawns (ttyd terminals, dive, restart after an update).
 *
 * Two ways to run Strato:
 * - development: a clone of the repository run by Bun, `bun <clone>/scripts/strato.ts <command>`;
 * - compiled: a standalone executable (`bun build --compile`, scripts/build/compile.ts), `<path of the binary> <command>`.
 *   Inside a binary, `import.meta.dir` points into Bun's virtual file system: no path can be derived from the code.
 *
 * Pure functions take the mode explicitly (tested both ways); the constants below are the running process's.
 * This module imports nothing from the installation: app/env.ts loads the profile, this must stay loadable before it.
 */
import { join } from "node:path";

declare const STRATO_BUILD_SHA: string | undefined;

/** True inside a binary built by `bun build --compile`. */
export const COMPILED: boolean = Bun.isStandaloneExecutable;

/** The commit the binary was built from (`--define` at build time), empty in development. */
export const BUILD_SHA: string = typeof STRATO_BUILD_SHA === "string" ? STRATO_BUILD_SHA : "";

/** The development entry point. Meaningless inside a binary, where it is a path of the virtual file system. */
export const DEV_SCRIPT = join(import.meta.dir, "..", "strato.ts");

export interface SelfMode {
  compiled: boolean;
  /** `process.execPath`: the binary when compiled, the bun executable in development. */
  execPath: string;
  /** The development entry point, `scripts/strato.ts`. */
  script: string;
}

export const RUNNING: SelfMode = { compiled: COMPILED, execPath: process.execPath, script: DEV_SCRIPT };

/** The entry point as a path: the binary when compiled, `scripts/strato.ts` in development. */
export const entryOf = (m: SelfMode = RUNNING) => (m.compiled ? m.execPath : m.script);

/** Quotes a word for a POSIX shell only when it needs it: `/a/b` stays as is, `/a b/c` becomes `'/a b/c'`. */
export function shellWord(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Strato's own command line, for a shell: what hooks run and what prompts tell sessions to type.
 * `/Users/a/.local/bin/strato` when compiled, `bun /path/scripts/strato.ts` in development (`bun` from the PATH,
 * as Claude Code sessions have it: the hooks and permissions of existing sessions keep that exact form).
 */
export function selfCommand(m: SelfMode = RUNNING): string {
  return m.compiled ? shellWord(m.execPath) : `bun ${shellWord(m.script)}`;
}

/** The same as an argv, for spawning without a shell: `[binary]`, or `[bun, script]`. */
export function selfArgv(m: SelfMode = RUNNING): string[] {
  return m.compiled ? [m.execPath] : [m.execPath, m.script];
}

/**
 * The command that runs a given entry point, as prompts receive it (`script` in policy/prompts.ts): a `.ts` file is
 * run by bun, anything else is an executable. Lets a prompt built with the binary's path and one built with the
 * script's path both come out right.
 */
export function commandForEntry(entry: string): string {
  return /\.[cm]?[jt]s$/.test(entry) ? `bun ${shellWord(entry)}` : shellWord(entry);
}
