/**
 * Where an installation lives, and the environment variables that override it.
 *
 * Strato used to be called "aiguilleur": installations made before the rename keep their `.aiguilleur/` state
 * folder and their `AIGUILLEUR_*` variables. Both are still read, after the new names. Pure: tested without disk.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

/** `STRATO_<name>`, else the legacy `AIGUILLEUR_<name>`, else undefined. An empty value counts as unset. */
export function envValue(env: Env, name: string): string | undefined {
  return env[`STRATO_${name}`] || env[`AIGUILLEUR_${name}`] || undefined;
}

/** State folder names, preferred first. */
export const STATE_DIR_NAME = ".strato";
export const LEGACY_STATE_DIR_NAME = ".aiguilleur";

/**
 * The state folder: `STRATO_STATE`, else `AIGUILLEUR_STATE`, else `<workspace>/.strato` if it exists,
 * else `<workspace>/.aiguilleur` if it exists, else `<workspace>/.strato` (a new installation).
 */
export function resolveStateDir(env: Env, workspace: string, exists: (path: string) => boolean = existsSync): string {
  const explicit = envValue(env, "STATE");
  if (explicit) return explicit;
  const current = join(workspace, STATE_DIR_NAME);
  const legacy = join(workspace, LEGACY_STATE_DIR_NAME);
  if (exists(current)) return current;
  return exists(legacy) ? legacy : current;
}
