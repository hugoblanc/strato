/**
 * Joining a topic's session: `term` in the current terminal, `dive` in an iTerm2 tab with its sheet.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentsBySession, pathWithClaude } from "../app/claude.ts";
import { CLAUDE_BIN, F, fail, flags, nowIso, out, readJson, STATE, WORKSPACE, writeJson } from "../app/env.ts";
import { initSlack, readThreads } from "../app/slack.ts";
import { ensureState, reportOf, requireSujet } from "../app/store.ts";
import { diveMarkdown } from "../core/cards.ts";
import { settings } from "../core/settings.ts";
import { shellQuote, truncate } from "../core/text.ts";
import { itermTabScript, type TabTarget } from "../terminal/iterm.ts";

/**
 * `term <topic>`: opens the topic's session in the current terminal, joining it if it runs (`claude attach`),
 * else resuming it (`claude --resume`). This is the command ttyd runs for the board's terminal; it also works
 * by hand. The exit code is claude's.
 */
export async function term(args: string[]) {
  const s = requireSujet(args[0]);
  if (!s.sessionId) fail(`topic ${s.letter} has no session`);
  const rows = agentsBySession();
  const live = rows?.get(s.sessionId);
  const argv = live?.id ? [CLAUDE_BIN, "attach", live.id] : [CLAUDE_BIN, "--resume", s.sessionId];
  process.stderr.write(`[strato] ${s.letter} · ${s.title} · ${live ? `claude attach ${live.id}` : "claude --resume (session stopped)"}\n`);
  const proc = Bun.spawn(argv, { cwd: WORKSPACE, stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, PATH: pathWithClaude() } });
  process.exit(await proc.exited);
}

/** Opens a topic's session in an iTerm2 tab; its sheet (card, threads, report) is written to <state>/dive/. */
export async function dive(args: string[]) {
  ensureState();
  const { positional, opts } = flags(args);
  const s = requireSujet(positional[0]);
  await initSlack(settings().slack);
  const dumps = await readThreads(s);
  const report = reportOf(s);
  const dir = join(STATE, "dive");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${s.letter}.md`);
  writeFileSync(file, diveMarkdown(s, dumps, report, nowIso()));
  const live = Boolean(s.sessionId && agentsBySession()?.has(s.sessionId));
  // a stopped session is resumed interactively in the tab; `claude attach` only works on a live session
  const sessionCmd = live ? `claude attach ${shellQuote(s.shortId ?? "")}` : s.sessionId ? `claude --resume ${shellQuote(s.sessionId)}` : "echo 'no session for this topic'";
  out(`sheet   : ${file}`);
  out(`session : ${sessionCmd}${live ? "" : " (session stopped, resumed interactively)"}`);
  if (opts["no-tab"] === "true") return;
  const title = `${s.letter} · ${truncate(s.title, 40)}`;
  const command = `cd ${shellQuote(WORKSPACE)} && ${sessionCmd}`;
  // By default, a tab in the window of the terminal the command runs from: ITERM_SESSION_ID is
  // "w0t1p0:<unique ID>". --window, or outside iTerm2, opens the tab in the dive window.
  // Never a split: the topic's context shows in the Strato panel of the sidebar.
  const anchorId = process.env.ITERM_SESSION_ID?.split(":")[1];
  const inAnchorWindow = Boolean(anchorId) && opts.window !== "true";
  const windowFile = join(STATE, "iterm.json");
  const saved = readJson<{ windowId?: number }>(windowFile, {});
  const target: TabTarget = inAnchorWindow ? { anchorSessionId: anchorId as string } : { windowId: saved.windowId ?? null };
  const r = Bun.spawnSync(["osascript", "-e", itermTabScript(title, command, target)], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) fail(`iTerm2 did not open the tab: ${r.stderr.toString().trim()}`);
  const [windowIdText, itermSessionId] = r.stdout.toString().trim().split(",");
  const windowId = Number(windowIdText);
  if (!inAnchorWindow && Number.isFinite(windowId) && windowId > 0) writeJson(windowFile, { windowId });
  if (itermSessionId) rememberTab(itermSessionId, s.key);
  const where = inAnchorWindow ? "this terminal's window" : saved.windowId === windowId ? "dive window" : "new dive window";
  out(`iTerm2 tab opened: ${title} (${where})`);
}

/** Remembers which topic `dive` opened in which iTerm2 session, for the panel (last 50 tabs). */
function rememberTab(itermSessionId: string, key: string) {
  const tabs = readJson<Record<string, string>>(F.tabs, {});
  delete tabs[itermSessionId];
  tabs[itermSessionId] = key;
  writeJson(F.tabs, Object.fromEntries(Object.entries(tabs).slice(-50)));
}
