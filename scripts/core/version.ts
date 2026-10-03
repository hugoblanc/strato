/**
 * The version of an installation, and what changed between two versions, in pure functions.
 * There is no CHANGELOG: "what's new" is read from the commit subjects (`feat(scope): …`, `fix(scope): …`, `docs`,
 * `test`, `chore`, `refactor`, `style`, `perf`), between the installed commit and its upstream (app/update.ts).
 */

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/** "1.2.3", "v1.2.3" or "1.2.3-beta" -> { 1, 2, 3 } (the pre-release tag is ignored); anything else -> null. */
export function parseSemver(s: string | null | undefined): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(s ?? "").trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

/** Negative if a < b, 0 if equal, positive if a > b. An unreadable version sorts before any readable one. */
export function compareSemver(a: string | null | undefined, b: string | null | undefined): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch;
}

export interface Change {
  sha: string;
  /** The subject without its type and scope: "board shows the version". */
  text: string;
  /** The scope between parentheses, when there is one. */
  scope?: string;
}

export interface GroupedChanges {
  features: Change[];
  fixes: Change[];
  /** docs, test, chore, refactor, style, perf, and any subject without a conventional prefix. */
  other: Change[];
}

const CONVENTIONAL = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;

/** Sorts commit subjects (newest first, as `git log` gives them) into features, fixes and the rest, keeping their order. */
export function groupChanges(subjects: (string | { sha: string; subject: string })[]): GroupedChanges {
  const out: GroupedChanges = { features: [], fixes: [], other: [] };
  for (const item of subjects) {
    const { sha, subject } = typeof item === "string" ? { sha: "", subject: item } : item;
    const m = CONVENTIONAL.exec(subject.trim());
    if (!m) {
      out.other.push({ sha, text: subject.trim() });
      continue;
    }
    const type = m[1].toLowerCase();
    const change: Change = { sha, text: m[4].trim(), ...(m[2] ? { scope: m[2] } : {}) };
    if (type === "feat") out.features.push(change);
    else if (type === "fix") out.fixes.push(change);
    else out.other.push(change);
  }
  return out;
}
