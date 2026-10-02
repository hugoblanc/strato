/**
 * Where an external provider's code is, the hash of its folder, and what the person trusted (docs/design/providers.md,
 * section 13.4). Nothing is loaded from disk unless config.json names it (`providers.<id>.source`), and nothing runs
 * unless its folder hashes to what the person trusted with `strato provider trust`, in their own terminal.
 *
 * A source's relative paths are read from the provider's own folder, `<state>/providers/<id>/`, where
 * `strato provider new` writes a scaffold; `~` and absolute paths point anywhere else.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ProviderSource } from "../../core/settings.ts";
import { expandHome, F, readJson, writeJson } from "../../app/env.ts";
import type { ProviderDescriptor } from "../sdk.ts";

/** `<state>/providers/<id>/`: the default folder of an external provider's code. */
export const providerHome = (id: string) => join(F.providers, id);

/** What the person trusted, by provider id: in `<state>/providers/trusted.json`, next to the providers' folders. */
export interface TrustRecord {
  sha256: string;
  /** The source as config.json said it when trusted: a source pointing elsewhere is not trusted. */
  source: ProviderSource;
  descriptor: ProviderDescriptor;
  at: string;
}

export const trustFile = () => join(F.providers, "trusted.json");
export const readTrust = (): Record<string, TrustRecord> => readJson<Record<string, TrustRecord>>(trustFile(), {});

export function writeTrust(id: string, record: TrustRecord | null): void {
  mkdirSync(F.providers, { recursive: true });
  const all = readTrust();
  if (record) all[id] = record;
  else delete all[id];
  writeJson(trustFile(), all);
}

/** A source resolved on disk: a module file, or a command line with the folder it runs in. */
export type ResolvedSource =
  | { shape: "module"; file: string; folder: string }
  | { shape: "exec"; argv: string[]; folder: string; cwd: string; pinned: "folder" | "executable" | "none"; pinPath: string | null };

/** A path of a source: `~` expanded, a relative one read from the provider's folder. */
const fromHome = (id: string, p: string) => (isAbsolute(expandHome(p)) ? expandHome(p) : resolve(providerHome(id), p));

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Where a source's code is. A module is its file, pinned by its folder. A command's folder is that of the first
 * argument that names an existing file (`python3 provider.py`), else of the command itself when it is a relative path
 * (`./provider`); that word is passed as an absolute path, and the command runs in that folder. Without such a file
 * (`uv run tool`), the pin covers the executable found on the PATH, and the command runs in the provider's own folder
 * when it exists.
 */
export function resolveSource(id: string, source: ProviderSource): ResolvedSource | null {
  if (typeof source.module === "string" && source.module) {
    const file = fromHome(id, source.module);
    return { shape: "module", file, folder: dirname(file) };
  }
  if (!Array.isArray(source.exec) || !source.exec.length) return null;
  const argv = [...source.exec];
  // the first argument after the command that names a file (`python3 provider.py`); else the command itself, when it
  // is written as a path of the provider's own (`./provider`): an interpreter's folder is never the provider's
  const at = [...argv.keys()].slice(1).find((i) => isFile(fromHome(id, argv[i]))) ?? (argv[0].includes("/") && !isAbsolute(expandHome(argv[0])) && isFile(fromHome(id, argv[0])) ? 0 : -1);
  if (at >= 0) {
    const path = fromHome(id, argv[at]);
    argv[at] = path;
    return { shape: "exec", argv, folder: dirname(path), cwd: dirname(path), pinned: "folder", pinPath: dirname(path) };
  }
  const onPath = Bun.which(argv[0]);
  const home = providerHome(id);
  return { shape: "exec", argv, folder: home, cwd: existsSync(home) ? home : F.providers, pinned: onPath ? "executable" : "none", pinPath: onPath };
}

/** Files of a folder the pin leaves out: caches and the fixtures, which the harness reads and authors edit freely. */
const SKIPPED_DIRS = new Set(["__pycache__", ".git", "fixtures"]);
const skippedFile = (name: string) => name.endsWith(".pyc") || name === ".DS_Store";
/** A folder too large to hash on every start is refused: a provider keeps its code in a folder of its own. */
export const PIN_MAX_FILES = 5_000;
export const PIN_MAX_BYTES = 64 * 1024 * 1024;

export class PinError extends Error {}

/**
 * The SHA-256 of a folder: every regular file under it (symbolic links by their target), as a sorted list of relative
 * paths and content hashes. A provider that writes into its own folder breaks its pin: it keeps state through `store`.
 */
export function hashFolder(dir: string): string {
  const entries: string[] = [];
  let bytes = 0;
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      const st = lstatSync(path);
      const rel = relative(dir, path);
      if (st.isDirectory()) {
        if (!SKIPPED_DIRS.has(name)) walk(path);
      } else if (st.isSymbolicLink()) entries.push(`${rel}\0link:${readlinkSync(path)}`);
      else if (st.isFile() && !skippedFile(name)) {
        bytes += st.size;
        if (entries.length >= PIN_MAX_FILES || bytes > PIN_MAX_BYTES) throw new PinError(`${dir} holds more than ${PIN_MAX_FILES} files or ${PIN_MAX_BYTES / 1024 / 1024} MiB`);
        entries.push(`${rel}\0${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
      }
    }
  };
  walk(dir);
  return createHash("sha256").update(entries.sort().join("\n")).digest("hex");
}

/** The hash a source is pinned by now: its folder's, or the executable's on the PATH; null when nothing can be pinned. */
export function pinOf(r: ResolvedSource): string | null {
  if (r.shape === "module" || r.pinned === "folder") return existsSync(r.folder) ? hashFolder(r.folder) : null;
  if (r.pinned === "executable" && r.pinPath) return createHash("sha256").update(readFileSync(r.pinPath)).digest("hex");
  return null;
}

/** Two sources say the same thing. */
const sameSource = (a: ProviderSource, b: ProviderSource) => JSON.stringify({ m: a.module ?? null, e: a.exec ?? null }) === JSON.stringify({ m: b.module ?? null, e: b.exec ?? null });

/** Where a configured provider stands: trusted as it is now, never trusted, changed since, or its code is missing. */
export type TrustState =
  | { state: "trusted"; resolved: ResolvedSource; sha256: string; record: TrustRecord }
  | { state: "untrusted" | "changed"; resolved: ResolvedSource; sha256: string | null; record: TrustRecord | null }
  | { state: "missing" | "invalid"; resolved: ResolvedSource | null; detail: string };

/**
 * The trust of a configured provider. The folder hash must equal the one trusted, the source must be the one trusted,
 * and when config.json pins a `sha256` too, it must agree.
 */
export function trustOf(id: string, source: ProviderSource, trust: Record<string, TrustRecord> = readTrust()): TrustState {
  const resolved = resolveSource(id, source);
  if (!resolved) return { state: "invalid", resolved: null, detail: "source.module or source.exec" };
  if (resolved.shape === "module" && !isFile(resolved.file)) return { state: "missing", resolved, detail: resolved.file };
  if (resolved.shape === "exec" && resolved.pinned === "none") return { state: "missing", resolved, detail: resolved.argv[0] };
  let sha256: string | null;
  try {
    sha256 = pinOf(resolved);
  } catch (e) {
    return { state: "invalid", resolved, detail: (e as Error).message };
  }
  const record = trust[id] ?? null;
  if (!record) return { state: "untrusted", resolved, sha256, record };
  const pinned = typeof source.sha256 === "string" && source.sha256 ? source.sha256 : null;
  if (!sha256 || record.sha256 !== sha256 || !sameSource(record.source, source) || (pinned && !sha256.startsWith(pinned))) return { state: "changed", resolved, sha256, record };
  return { state: "trusted", resolved, sha256, record };
}
