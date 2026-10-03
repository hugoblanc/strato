import { findSujet, preferOpen, type Sujet } from "../core/sujet.ts";

/** Quoted AppleScript literal. */
function appleScriptString(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Where `dive` opens its tab: the window of the starting terminal, or the window dedicated to dives. */
export type TabTarget = { anchorSessionId: string } | { windowId: number | null };

/**
 * AppleScript that opens a named iTerm2 tab, without splitting, and runs `command` in it.
 * - `anchorSessionId`: the tab opens in the window that holds the iTerm2 session with this `unique ID` (the terminal
 *   the command comes from, read from ITERM_SESSION_ID); error if it is gone.
 * - `windowId`: window dedicated to dives, reused if it still exists, else created.
 * Never targets `current window`: that is the active window, maybe another topic's.
 * No existing tab or pane is modified. Returns "windowId,sessionUniqueId" of the created tab.
 */
export function itermTabScript(title: string, command: string, target: TabTarget): string {
  const lines = ['tell application "iTerm2"', "  set w to missing value"];
  if ("anchorSessionId" in target) {
    lines.push(
      "  repeat with aWindow in windows",
      "    repeat with aTab in tabs of aWindow",
      "      repeat with aSession in sessions of aTab",
      `        if unique ID of aSession is ${appleScriptString(target.anchorSessionId)} then set w to (contents of aWindow)`,
      "      end repeat",
      "    end repeat",
      "  end repeat",
      '  if w is missing value then error "starting terminal not found"',
      "  tell w to set t to (create tab with default profile)",
    );
  } else {
    if (target.windowId) lines.push("  try", `    set w to (first window whose id is ${Math.trunc(target.windowId)})`, "  end try");
    lines.push(
      "  if w is missing value then",
      "    set w to (create window with default profile)",
      "    set t to current tab of w",
      "  else",
      "    tell w to set t to (create tab with default profile)",
      "  end if",
    );
  }
  lines.push(
    "  select w",
    "  set s to current session of t",
    "  tell s",
    `    set name to ${appleScriptString(title)}`,
    `    write text ${appleScriptString(command)}`,
    "  end tell",
    '  return ((id of w) as text) & "," & (unique ID of s)',
    "end tell",
  );
  return lines.join("\n");
}

// ------------------------------------------------------------------ iTerm2 panel: session -> topic

/**
 * Name of an iTerm2 session without what does not belong to the topic: leading status glyphs and spaces (✳, ◑, ●,
 * braille spinner), and the trailing "(claude)" iTerm2 adds for the running process.
 */
export function cleanSessionName(raw: string): string {
  return raw
    .replace(/\s*\(claude\)\s*$/i, "")
    .replace(/^[\s\p{So}️]+/u, "")
    .trim();
}

const withoutEllipsis = (s: string) => s.replace(/…$/, "").trim();

/**
 * Topic shown in the panel for an iTerm2 session, from its name. In this order:
 * 1. the cleaned name is exactly a topic's `name` (the one passed to `claude --bg -n`);
 * 2. it starts with "<letter> ·" (tab opened by `dive`): among the topics with that letter, the one whose title
 *    matches the rest of the name, then the open topic, then the most recent;
 * 3. a topic's `name`, without its truncation "…", is contained in the session name.
 * null otherwise: the panel then shows the list of topics.
 */
export function sujetForSessionName(sessionName: string, sujets: Sujet[]): Sujet | null {
  const name = cleanSessionName(sessionName);
  if (!name) return null;
  const exact = sujets.filter((s) => s.name && s.name.trim() === name);
  if (exact.length) return preferOpen(exact) ?? null;
  const lettered = name.match(/^([A-Z]{1,3}) · (.+)$/);
  if (lettered) {
    const candidates = sujets.filter((s) => s.letter === lettered[1]);
    const rest = withoutEllipsis(lettered[2]);
    const titled = candidates.filter((s) => rest && (s.title.startsWith(rest) || rest.startsWith(s.title)));
    const best = preferOpen(titled.length ? titled : candidates);
    if (best) return best;
  }
  const contained = sujets.filter((s) => withoutEllipsis(s.name ?? "") && name.includes(withoutEllipsis(s.name)));
  return preferOpen(contained) ?? null;
}

/**
 * Topic of a session that gets focus: by its name first, then by the tab `dive` opened for it (`tabs` = iTerm2
 * session unique ID -> topic key), useful when Claude Code renamed the session.
 */
export function sujetForFocus(sessionName: string, sessionId: string | undefined, sujets: Sujet[], tabs: Record<string, string>): Sujet | null {
  const byName = sujetForSessionName(sessionName, sujets);
  if (byName) return byName;
  const key = sessionId ? tabs[sessionId] : undefined;
  return key ? (findSujet(sujets, key) ?? null) : null;
}

/** AppleScript that returns the tty ("/dev/ttys006") of the iTerm2 session with this `unique ID`, or an empty string. Read-only. */
export function itermTtyScript(uniqueId: string): string {
  return [
    'tell application "iTerm2"',
    "  repeat with aWindow in windows",
    "    repeat with aTab in tabs of aWindow",
    "      repeat with aSession in sessions of aTab",
    `        if unique ID of aSession is ${appleScriptString(uniqueId)} then return tty of aSession`,
    "      end repeat",
    "    end repeat",
    "  end repeat",
    '  return ""',
    "end tell",
  ].join("\n");
}

/** "/dev/ttys006" -> "ttys006", the name `ps -t` expects. null for anything that is not a tty. */
export function ttyName(raw: string): string | null {
  const m = raw.trim().match(/^(?:\/dev\/)?(ttys?\d+)$/);
  return m ? m[1] : null;
}
