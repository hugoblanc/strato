/**
 * Writing config.json: the one path every setup command goes through (`--write`, `--live`, `--token`, `--app-token`,
 * `--connect`), so a profile is always validated, merged and shown as a diff the same way.
 */
import { existsSync } from "node:fs";
import { mergeProfile, profileDiff, profileErrors } from "../core/setup.ts";
import { missingSettings, NEW_INSTALL_PROFILE, resolveSettings, useSettings } from "../core/settings.ts";
import { F, fail, out, readJson, writeJson } from "./env.ts";
import { createStateDir } from "./store.ts";
import { externalKnowledge } from "../providers/external.ts";

/** Writes `incoming` into config.json: created, merged into the existing file, or replaced with `force`. */
export function writeProfile(incoming: unknown, force: boolean, label: string): void {
  const existed = existsSync(F.config);
  const before = existed ? readJson<unknown>(F.config, {}) : {};
  // an external provider's accounts are checked against the descriptor trusted for the source the profile will have
  const errors = profileErrors(incoming, externalKnowledge(force ? incoming : mergeProfile(before, incoming)));
  if (errors.length) fail(`${label} refused, nothing written:\n  ${errors.join("\n  ")}`);
  createStateDir();
  // a profile created here starts in shadow mode unless it says otherwise: the first day posts nothing
  const next = existed ? (force ? incoming : mergeProfile(before, incoming)) : mergeProfile(NEW_INSTALL_PROFILE, incoming);
  const diff = profileDiff(before, next);
  writeJson(F.config, next);
  out(`${existed ? (force ? "replaced (--force)" : "merged into") : "created"} ${F.config}`);
  for (const line of diff.length ? diff : ["no change"]) out(`  ${line}`);
  const s = resolveSettings(next);
  const missing = missingSettings(s);
  out(missing.length ? `to fill in: ${missing.join(", ")}` : "profile complete");
  out(`shadow mode: ${s.workers.shadow ? "on, nothing is posted" : "off"}`);
}

/** The profile as written now, installed for the rest of the command. */
export function reloadProfile(): void {
  useSettings(resolveSettings(readJson<unknown>(F.config, {})));
}
