/**
 * The body of a GitHub release: "What's new" since the previous tag, features then fixes, from the commit subjects
 * (core/version.ts), and the commit it was built from. app/release.ts reads it back for the board's update panel:
 * keep both sides in step (release.test.ts checks the round trip).
 *
 *   bun build/release-notes.ts <tag>      prints the body for <tag> (run in the repository, with its tags fetched)
 */
import { type Change, groupChanges } from "../core/version.ts";

const bullet = (c: Change) => `- ${c.scope ? `**${c.scope}**: ` : ""}${c.text}${c.sha ? ` (${c.sha})` : ""}`;

/** `commits`: newest first, as `git log` gives them. `previous`: the previous tag, null for the first release. */
export function releaseNotes(commits: { sha: string; subject: string }[], sha: string, previous: string | null): string {
  const g = groupChanges(commits);
  const parts = ["## What's new", ""];
  if (g.features.length) parts.push("### Features", "", ...g.features.map(bullet), "");
  if (g.fixes.length) parts.push("### Fixes", "", ...g.fixes.map(bullet), "");
  if (!g.features.length && !g.fixes.length) parts.push("Maintenance release: no new feature or fix.", "");
  if (g.other.length) parts.push(`And ${g.other.length} other change${g.other.length > 1 ? "s" : ""} (docs, tests, internals)${previous ? ` since ${previous}` : ""}.`, "");
  parts.push("Install or update: `curl -fsSL https://raw.githubusercontent.com/hugoblanc/strato/main/install.sh | sh`, or the Update button of the board.", "");
  parts.push(`Commit: ${sha}`);
  return `${parts.join("\n")}\n`;
}

function git(...args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim() };
}

if (import.meta.main) {
  const tag = process.argv[2];
  if (!tag) {
    process.stderr.write("usage: bun build/release-notes.ts <tag>\n");
    process.exit(64);
  }
  const prev = git("describe", "--tags", "--abbrev=0", `${tag}^`);
  const previous = prev.ok && prev.out ? prev.out : null;
  const log = git("log", "--no-merges", "--format=%h%x09%s", previous ? `${previous}..${tag}` : tag);
  const commits = log.out
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ sha: l.slice(0, l.indexOf("\t")), subject: l.slice(l.indexOf("\t") + 1) }));
  process.stdout.write(releaseNotes(commits, git("rev-list", "-n", "1", tag).out, previous));
}
