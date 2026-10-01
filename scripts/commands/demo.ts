/**
 * `demo`: the board with fictional topics, before any Slack token, profile or Claude session.
 *
 *   demo [--port 4394] [--locale en|fr]   writes a throwaway installation (Acme, Alice, Bob…) and serves its board
 *   demo --clean                          removes that installation
 *
 * The demo never touches the real installation: its state, workspace and home live in `$TMPDIR/strato-demo`, the
 * Slack tokens are blanked, `claude` is a stub that knows no session, and shadow mode is on. Nothing can be posted,
 * nothing is read from Slack, no session is started.
 * app/env.ts is imported inside `demo()` only: it resolves the state folder when loaded, and the data helpers below
 * must stay importable from tests without it.
 */
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localeFromEnv } from "../core/setup.ts";

export const DEMO_DIR = join(tmpdir(), "strato-demo");
export const DEMO_PORT = 4394;

const SLACK = "https://acme.slack.com/archives";
/** The one session the stub `claude` reports, busy: the topic at work reads as working, not as a dead session. */
const DEMO_SESSION = { id: "demo0c", sessionId: "00000000-0000-4000-8000-00000000000c", status: "busy", name: "DM · Grace · C" };
const ago = (now: number, minutes: number) => new Date(now - minutes * 60_000).toISOString();
/** A Slack thread of the fictional workspace: its key (`channel:ts`) and permalink. */
const thread = (channel: string, ts: string) => ({ key: `${channel}:${ts}`, permalink: `${SLACK}/${channel}/p${ts.replace(".", "")}` });

/** The fictional profile: Alice, lead of the Platform team at Acme, in shadow mode. */
export function demoProfile(locale: "en" | "fr") {
  return {
    owner: { name: "Alice" },
    slack: { team: "Acme", workspace: "acme", me: "U0ALICE0001", subteams: ["S0ACMEPLAT"], teamAlias: "@platform", teammates: ["Bob", "Carol"], watchChannels: ["C0ACMEREQ01"] },
    tracker: { kind: "linear", workspace: "acme", prefixes: ["ENG", "OPS"] },
    forge: null,
    workers: { shadow: true },
    refresh: { auto: false },
    gc: { everyMinutes: 0 },
    ui: { iterm: false, slackApp: false, locale },
  };
}

/**
 * Four fictional topics, one per kind of card the board shows: a draft ready to send, a decision, a session at work,
 * a topic waiting on a teammate. Only the topic at work has a session, which the stub `claude` lists as busy.
 */
export function demoTopics(now: number, reportsDir: string) {
  const task = (id: string, at: string, fields: Record<string, string>) => ({ id, status: "open", origin: "task", createdAt: at, updatedAt: at, ...fields });
  const base = (letter: string, t: { key: string; permalink: string }, over: Record<string, unknown>) => ({
    key: t.key,
    threads: [t.key],
    letter,
    permalink: t.permalink,
    sessionId: null,
    shortId: null,
    gate: "none",
    waiting: "",
    next: "",
    summary: "",
    history: [],
    ...over,
  });
  const a = thread("C0ACMEREQ01", "1759219200.000100");
  const b = thread("C0ACMEINC01", "1759222800.000200");
  const c = thread("D0ACME0001", "1759226400.000300");
  const d = thread("C0ACMEREQ01", "1759230000.000400");
  return [
    base("A", a, {
      title: "Globex rate limit before Thursday's launch",
      channel: "#acme-requests",
      asker: "Bob",
      name: "acme-requests · Bob · A",
      status: "gate",
      gate: "draft",
      why: "Bob asks you directly, and the API quotas are yours.",
      summary: "Globex runs 40 requests per second at peak; their plan allows 50. No change needed before Thursday.",
      steps: "done:read the thread and Globex's plan|done:check last week's peak in the API metrics|now:answer Bob",
      report: join(reportsDir, "A.md"),
      createdAt: ago(now, 42),
      updatedAt: ago(now, 6),
      tasks: [
        task("t1", ago(now, 6), {
          kind: "draft",
          ask: "Bob: is Globex's rate limit enough for their launch on Thursday?",
          proposal: "Yes: their peak last week was 40 req/s for a 50 req/s plan. Say so, and offer a temporary raise if their launch traffic is 25% above that.",
          action: `post the draft in the thread ${a.permalink}`,
          draft: "Hi Bob, yes: Globex peaked at 40 req/s last week and their plan allows 50. If they expect more than 25% extra on launch day, tell me before Wednesday noon and I will raise it for the week.",
          draftTo: a.permalink,
        }),
      ],
    }),
    base("B", b, {
      title: "Roll back web!2041 or ship a hotfix?",
      channel: "#acme-incidents",
      asker: "Carol",
      name: "acme-incidents · Carol · B",
      status: "gate",
      gate: "decision",
      why: "Carol needs your call: you own the release train.",
      summary: "web!2041 broke the CSV export for 3 customers. The fix is a one-line revert of the date format, already tested by Carol.",
      steps: "done:reproduce the export failure|done:find the commit in web!2041|now:choose rollback or hotfix",
      createdAt: ago(now, 75),
      updatedAt: ago(now, 12),
      tasks: [
        task("t1", ago(now, 12), {
          kind: "decision",
          ask: "Carol: roll back web!2041, or ship her one-line hotfix?",
          proposal: "Ship the hotfix: the rollback would also remove the invoice fix Initech is waiting for.",
          action: "tell Carol to merge the hotfix and deploy it today",
        }),
      ],
    }),
    base("C", c, {
      title: "Audit log export for Grace (compliance)",
      channel: "DM Grace",
      asker: "Grace",
      name: "DM · Grace · C",
      status: "working",
      sessionId: DEMO_SESSION.sessionId,
      shortId: DEMO_SESSION.id,
      why: "A direct message to you.",
      next: "listing which audit events are kept after 90 days",
      steps: "done:read Grace's request|now:list the retained audit events|todo:prepare the export command|todo:draft the answer",
      createdAt: ago(now, 20),
      updatedAt: ago(now, 2),
    }),
    base("D", d, {
      title: "Review of ENG-12, the new on-call schedule",
      channel: "#acme-requests",
      asker: "Dave",
      name: "acme-requests · Dave · D",
      status: "waiting",
      waiting: "Bob, who reviews the schedule today",
      why: "Your team group was mentioned; Bob took it.",
      summary: "Bob answered in the thread that he reviews it this afternoon.",
      createdAt: ago(now, 180),
      updatedAt: ago(now, 30),
    }),
  ];
}

const REPORT_A = `# A · Globex rate limit before Thursday's launch

Fictional report, written by the demo. A real session writes what it checked here, with its sources.

- Globex's plan: 50 requests per second.
- Last week's peak: 40 requests per second (Tuesday, 14:05).
- Margin: 25%. A launch above that would need a temporary raise.
`;

/** Writes the throwaway installation: profile, topics, a report, a heartbeat, and a stub `claude`. */
export function writeDemo(dir: string, locale: "en" | "fr", now = Date.now(), pid = process.pid) {
  rmSync(dir, { recursive: true, force: true });
  const state = join(dir, "state");
  for (const d of [join(state, "reports"), join(dir, "ws"), join(dir, "home"), join(dir, "bin")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(state, "config.json"), JSON.stringify(demoProfile(locale), null, 2));
  writeFileSync(join(state, "sujets.json"), JSON.stringify(demoTopics(now, join(state, "reports")), null, 2));
  writeFileSync(join(state, "reports", "A.md"), REPORT_A);
  writeTick(state, now);
  // a `claude` that only lists the demo's session and starts nothing: a click on resume or stop does nothing
  writeFileSync(join(dir, "bin", "claude"), `#!/bin/sh\nif [ "$1" = agents ]; then echo '${JSON.stringify([DEMO_SESSION])}'; fi\nexit 0\n`);
  chmodSync(join(dir, "bin", "claude"), 0o755);
  // what Claude Code writes for a live session (~/.claude/sessions/<pid>.json): the board reads "busy" from it. The pid
  // is the demo's own, alive exactly as long as the demo runs.
  const sessions = join(dir, "home", ".claude", "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, `${pid}.json`), JSON.stringify({ pid, sessionId: DEMO_SESSION.sessionId, cwd: join(dir, "ws"), name: DEMO_SESSION.name, status: "busy", kind: "bg", startedAt: now - 20 * 60_000, statusUpdatedAt: now - 2 * 60_000 }));
  return state;
}

/** The listener's heartbeat: without it the board says Strato is stopped, which is not what the demo shows. */
function writeTick(state: string, now = Date.now()) {
  writeFileSync(join(state, "tick.json"), JSON.stringify({ lastTick: now / 1000, beat: 60 }));
}

/** The environment of the demo's `serve`: everything points inside the demo folder, no token reaches it. */
export function demoEnv(dir: string, base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  return {
    ...env,
    PATH: `${join(dir, "bin")}:${base.PATH ?? ""}`,
    HOME: join(dir, "home"),
    STRATO_STATE: join(dir, "state"),
    STRATO_WORKSPACE: join(dir, "ws"),
    AIGUILLEUR_STATE: "",
    AIGUILLEUR_WORKSPACE: "",
    STRATO_SLACK_TOKEN: "",
    AIGUILLEUR_SLACK_TOKEN: "",
    SLACK_MCP_XOXP_TOKEN: "",
    SLACK_APP_TOKEN: "",
    GITLAB_TOKEN: "",
    STRATO_UPDATE_CHECK: "off",
    STRATO_DEMO: "1",
  };
}

export async function demo(args: string[]) {
  const { fail, flags, out, SCRIPT } = await import("../app/env.ts");
  const { opts } = flags(args);
  if (opts.clean) {
    rmSync(DEMO_DIR, { recursive: true, force: true });
    out(`demo removed (${DEMO_DIR})`);
    return;
  }
  const port = Number(opts.port ?? DEMO_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) fail(`usage: demo [--port N] [--locale en|fr] | --clean (invalid port: ${opts.port})`, 64);
  const locale = opts.locale === "fr" || opts.locale === "en" ? opts.locale : localeFromEnv(process.env.LC_ALL || process.env.LANG);
  const state = writeDemo(DEMO_DIR, locale);
  // a compiled binary has no script on disk: it serves by itself
  const child = Bun.spawn([process.execPath, ...(existsSync(SCRIPT) ? [SCRIPT] : []), "serve", "--port", String(port)], { env: demoEnv(DEMO_DIR), stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const beat = setInterval(() => writeTick(state), 60_000);
  const stop = () => {
    clearInterval(beat);
    child.kill();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  out(`Demo board: http://127.0.0.1:${port}/board`);
  out("Fictional data (Acme, Alice, Bob…): nothing is connected to Slack, no Claude session runs (the one at work is simulated), shadow mode is on.");
  out(`Ctrl-C to stop. The demo lives in ${DEMO_DIR}; demo --clean removes it.`);
  const code = await child.exited;
  clearInterval(beat);
  process.exit(code ?? 0);
}
