/**
 * Secret files and reading a secret from the person, shared by `setup` and every provider account
 * (docs/design/providers.md, section 11.4): one `KEY=value` file per account, folder 700, file 600, written then
 * renamed. A secret is read from stdin, never from the command line, and never printed whole.
 */
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { t } from "../core/i18n.ts";
import { setEnvLine } from "../core/setup.ts";
import { expandHome } from "./env.ts";

/**
 * `KEY=value` written into a secret file: folder 700, file 600, the other lines kept, written then renamed. The value
 * is stored in a form that reads back unchanged (quoted when it holds a space, a quote, `#`, `$` or a backslash). A
 * value with a line break or a NUL is refused, naming the secret and never its value.
 */
export function writeSecret(file: string, name: string, value: string): void {
  checkSecretValue(name, value);
  const path = expandHome(file);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let current = "";
  try {
    current = readFileSync(path, "utf8");
  } catch {}
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, setEnvLine(current, name, value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Throws, naming the secret and never its value, when a value cannot be stored on one line of a secret file. */
export function checkSecretValue(name: string, value: string): void {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refused characters
  if (/[\r\n\u0000]/.test(value)) throw new Error(t("cli.secret.badValue", { name }));
}

/** A secret as it may be shown: its first five and last four characters. */
export const maskSecret = (s: string) => `${s.slice(0, 5)}…${s.slice(-4)}`;

/** The lines of stdin, read one at a time by every prompt of one command. */
let stdinLines: AsyncIterator<string> | null = null;

/**
 * One line of stdin. In a terminal the prompt is shown on stderr and, for a secret, the typing is not echoed; from a
 * pipe the next line is read. An empty string when stdin is over.
 */
export async function readLine(prompt: string, opts: { secret?: boolean } = {}): Promise<string> {
  const tty = Boolean(process.stdin.isTTY);
  const hide = tty && opts.secret === true;
  if (tty) process.stderr.write(prompt);
  if (hide) Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
  try {
    stdinLines ??= (console as unknown as AsyncIterable<string>)[Symbol.asyncIterator]();
    const r = await stdinLines.next();
    return r.done ? "" : String(r.value).trim();
  } finally {
    if (hide) {
      Bun.spawnSync(["stty", "echo"], { stdin: "inherit" });
      process.stderr.write("\n");
    }
  }
}

/**
 * Lets go of stdin once a command has read what it asked: the reader of `readLine` keeps stdin open, and an open
 * terminal keeps the process alive after its last line. Called when a one-shot command returns.
 */
export async function releaseStdin(): Promise<void> {
  const lines = stdinLines;
  stdinLines = null;
  await lines?.return?.();
}

/** A secret typed or pasted by the person, without echo in a terminal. */
export const readSecret = (prompt: string): Promise<string> => readLine(prompt, { secret: true });
