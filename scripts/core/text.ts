import { resolve, sep } from "node:path";
export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** Session name readable in `claude agents`: letter · channel · person · topic. */
export function sessionName(channel: string, from: string, title: string, letter?: string): string {
  return truncate(`${letter ? `${letter} · ` : ""}${channel} · ${from} · ${title}`, 70);
}

/** "6h", "30m", "2d" (or the French "2j") -> milliseconds. Without a unit: hours. */
export function parseDuration(s: string): number {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|h|j|d)?$/i);
  if (!m) throw new Error(`unreadable duration: "${s}" (e.g. 6h, 30m, 2d)`);
  const unit = (m[2] ?? "h").toLowerCase();
  const factor = unit === "m" || unit === "min" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return Number(m[1]) * factor;
}

/** File name of a topic's report, derived from its main key. */
export function reportFile(key: string): string {
  return `${key.replace(/[^A-Za-z0-9._-]+/g, "_")}.md`;
}

/** Single quotes for the shell. */
export function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** Last segment of the cwd; a worktree `<repo>/.claude/worktrees/<name>` reads "repo · worktree name". */
export function repoLabel(cwd: string): string {
  const clean = cwd.replace(/\/+$/, "");
  const worktree = clean.match(/^(.*)\/\.claude\/worktrees\/([^/]+)/);
  if (worktree) return `${worktree[1].split("/").pop() || worktree[1]} · worktree ${worktree[2]}`;
  return clean.split("/").pop() || cwd;
}

/** Cuts a long text at a word boundary, with "…", keeping its line breaks (three or more breaks -> two). */
export function clip(text: string, max: number): string {
  const t = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.search(/\s\S*$/);
  return `${(space > max * 0.7 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A report path is followed only if it stays inside the reports folder, once `..` and relative links are resolved. */
export function reportPathAllowed(path: string, reportsDir: string): boolean {
  const dir = resolve(reportsDir);
  const p = resolve(path);
  return p.startsWith(dir + sep) && p.endsWith(".md");
}

/**
 * A text written by a third party (Slack message, display name, channel) before it goes into a prompt.
 * It must not be able to close the « … » quote nor imitate a trust marker: the master's `[strato]` (or legacy
 * `[aiguilleur]`), or the prefix of a message sent from the board. Square brackets become parentheses, guillemets
 * become straight quotes.
 */
export function untrusted(text: string): string {
  return text.replace(/\[/g, "(").replace(/\]/g, ")").replace(/[«»]/g, '"');
}
