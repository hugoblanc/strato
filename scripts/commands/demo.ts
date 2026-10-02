/**
 * `demo`: the board with fictional topics, before any Slack token, profile or Claude session.
 *
 *   demo [--port 4394] [--locale en|fr] [--role <role>]   writes a throwaway installation (Acme, Alice, Bob…) and
 *                                         serves its board; --role shows the topics of that job (core/roles.ts)
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
import { permalinkFor } from "../chat/slack-model.ts";
import { formatKey } from "../core/keys.ts";
import { localeFromEnv } from "../core/setup.ts";
import { DEFAULT_ROLE, isRole, type Role, ROLE_PROPOSALS, ROLES } from "../core/roles.ts";

export const DEMO_DIR = join(tmpdir(), "strato-demo");
export const DEMO_PORT = 4394;

const SLACK = "https://acme.slack.com";
/** The one session the stub `claude` reports, busy: the topic at work reads as working, not as a dead session. */
const DEMO_SESSION = { id: "demo0c", sessionId: "00000000-0000-4000-8000-00000000000c", status: "busy", name: "DM · Grace · C" };
const ago = (now: number, minutes: number) => new Date(now - minutes * 60_000).toISOString();
/** A Slack thread of the fictional workspace: its key (`channel:ts`) and permalink. */
const thread = (channel: string, ts: string) => ({ key: formatKey("slack", "default", `${channel}:${ts}`) as string, permalink: permalinkFor(SLACK, channel, ts) });

/** The group Alice belongs to, by role. */
const TEAM_ALIAS: Record<Role, string> = { developer: "@platform", support: "@support", operations: "@ops", "account-manager": "@accounts", manager: "@platform-leads" };
/** The fictional customer channel a support person or an account manager watches (their role proposes it). */
const CUSTOMER_CHANNEL = "C0ACMECUS01";
/** The fictional alert bot an operations person sets aside (their role proposes it). */
const ALERT_BOT = "Acme Alerts";

/**
 * The fictional profile: Alice at Acme, in shadow mode. As a developer (the default) she leads the Platform team; for
 * another role, `owner.role` is set and the settings that role proposes are taken, as the interview would.
 */
export function demoProfile(locale: "en" | "fr", role: Role = DEFAULT_ROLE) {
  const proposed = ROLE_PROPOSALS[role].map((p) => p.setting);
  const watch = ["C0ACMEREQ01", ...(proposed.includes("slack.watchChannels") ? [CUSTOMER_CHANNEL] : [])];
  return {
    owner: role === DEFAULT_ROLE ? { name: "Alice" } : { name: "Alice", role },
    slack: {
      team: "Acme",
      workspace: "acme",
      me: "U0ALICE0001",
      subteams: ["S0ACMEPLAT"],
      teamAlias: TEAM_ALIAS[role],
      teammates: ["Bob", "Carol"],
      watchChannels: watch,
      ...(proposed.includes("slack.ignoreAuthors") ? { ignoreAuthors: [ALERT_BOT] } : {}),
    },
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
export function demoTopics(now: number, reportsDir: string, role: Role = DEFAULT_ROLE) {
  if (role !== "developer") return roleTopics(role, now, reportsDir);
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

/** A topic of a role's demo: the fields every card shares, filled in. */
function demoTopic(letter: string, t: { key: string; permalink: string }, over: Record<string, unknown>) {
  return { key: t.key, threads: [t.key], letter, permalink: t.permalink, sessionId: null, shortId: null, gate: "none", waiting: "", next: "", summary: "", history: [], ...over };
}
const demoTask = (id: string, at: string, fields: Record<string, string>) => ({ id, status: "open", origin: "task", createdAt: at, updatedAt: at, ...fields });
/** A local time `hours` after `now`, in the form `set` writes a due entry ("2026-09-30 18:00"). */
function dueIn(now: number, hours: number, text: string): string {
  const d = new Date(now + hours * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:00 ${text}`;
}

/**
 * The four topics of a role other than developer, one per kind of card as in the developer's demo: a draft ready to
 * send, a decision, a session at work (the stub's busy session), a topic waiting on someone. Slack threads only.
 */
function roleTopics(role: Exclude<Role, "developer">, now: number, reportsDir: string) {
  const a = thread(role === "support" || role === "account-manager" ? CUSTOMER_CHANNEL : "C0ACMEREQ01", "1759219200.000100");
  const b = thread("C0ACMEREQ01", "1759222800.000200");
  const c = thread("D0ACME0001", "1759226400.000300");
  const d = thread(role === "operations" ? "C0ACMEINC01" : "C0ACMEREQ01", "1759230000.000400");
  const draft = (o: { title: string; channel: string; asker: string; why: string; summary: string; steps: string; ask: string; proposal: string; text: string; due?: string }) =>
    demoTopic("A", a, {
      title: o.title,
      channel: o.channel,
      asker: o.asker,
      name: `${o.channel.replace(/^#/, "")} · ${o.asker} · A`,
      status: "gate",
      gate: "draft",
      why: o.why,
      summary: o.summary,
      steps: o.steps,
      ...(o.due ? { due: o.due } : {}),
      report: join(reportsDir, "A.md"),
      createdAt: ago(now, 42),
      updatedAt: ago(now, 6),
      tasks: [demoTask("t1", ago(now, 6), { kind: "draft", ask: o.ask, proposal: o.proposal, action: `post the draft in the thread ${a.permalink}`, draft: o.text, draftTo: a.permalink })],
    });
  const decision = (o: { title: string; asker: string; why: string; summary: string; steps: string; ask: string; proposal: string; action: string }) =>
    demoTopic("B", b, {
      title: o.title,
      channel: "#acme-requests",
      asker: o.asker,
      name: `acme-requests · ${o.asker} · B`,
      status: "gate",
      gate: "decision",
      why: o.why,
      summary: o.summary,
      steps: o.steps,
      createdAt: ago(now, 75),
      updatedAt: ago(now, 12),
      tasks: [demoTask("t1", ago(now, 12), { kind: "decision", ask: o.ask, proposal: o.proposal, action: o.action })],
    });
  const working = (o: { title: string; asker: string; why: string; next: string; steps: string }) =>
    demoTopic("C", c, { ...o, channel: `DM ${o.asker}`, name: DEMO_SESSION.name, status: "working", sessionId: DEMO_SESSION.sessionId, shortId: DEMO_SESSION.id, createdAt: ago(now, 20), updatedAt: ago(now, 2) });
  const waiting = (o: { title: string; channel: string; asker: string; waiting: string; why: string; summary: string }) =>
    demoTopic("D", d, { ...o, name: `${o.channel.replace(/^#/, "")} · ${o.asker} · D`, status: "waiting", createdAt: ago(now, 180), updatedAt: ago(now, 30) });
  switch (role) {
    case "support":
      return [
        draft({
          title: "Globex cannot export invoices since this morning",
          channel: "#acme-globex",
          asker: "Dana",
          why: "A customer writes in a channel you watch.",
          summary: "The export fails for invoices that carry a credit note: 12 of Globex's 340 invoices. Engineering ships the fix today; the other invoices export fine.",
          steps: "done:reproduce the failed export|done:check which invoices fail|now:answer Dana|todo:escalate the bug to engineering",
          ask: "Dana: why does Globex's invoice export fail since this morning?",
          proposal: "Tell her which invoices are affected, that the fix ships today, and how to export the others meanwhile.",
          text: "Hi Dana, thanks for the details. The export fails only for the 12 invoices that carry a credit note; all the others export as usual. The fix ships today and I will confirm here once it is live.",
        }),
        decision({
          title: "Refund Initech's duplicate charge or credit it?",
          asker: "Carol",
          why: "Carol needs your call: refunds above 500 USD are yours.",
          summary: "Initech was charged twice for September (2 x 1,200 USD). A refund takes 5 to 10 days; a credit applies to October's invoice at once.",
          steps: "done:confirm the duplicate charge|now:choose refund or credit|todo:answer Initech",
          ask: "Carol: refund Initech's duplicate 1,200 USD charge, or credit it on October's invoice?",
          proposal: "Refund it: Initech asked for their money back, and a credit they did not ask for reads as keeping it.",
          action: "tell Carol to issue the refund today",
        }),
        working({ title: "Password reset emails not reaching Umbrella", asker: "Grace", why: "A direct message to you.", next: "checking the mail logs for Umbrella's domain", steps: "done:read Grace's request|now:check the mail logs|todo:draft the answer" }),
        waiting({ title: "Bug report escalated to engineering (ENG-12)", channel: "#acme-requests", asker: "Dave", waiting: "Bob, who fixes ENG-12 today", why: "Your team group was mentioned; the fix is with engineering.", summary: "Bob confirmed the bug and fixes it today; Dave is told once it ships." }),
      ];
    case "operations":
      return [
        draft({
          title: "Status update for the API latency incident",
          channel: "#acme-requests",
          asker: "Bob",
          why: "You lead the incident, and the update goes out on your go.",
          summary: "Latency is back to normal since 14:05 UTC, after the read replicas were scaled. Nothing else is affected.",
          steps: "done:scale the read replicas|done:check latency for 20 minutes|now:post the update|todo:close the incident ticket",
          ask: "Bob: can we tell customers the API latency incident is over?",
          proposal: "Yes: post that it is resolved, the cause in one sentence, and that you keep watching for an hour.",
          text: "Update 14:25 UTC: API latency is back to normal since 14:05 UTC, after we scaled the database read replicas. We keep watching for an hour; next update at 15:30 UTC.",
        }),
        decision({
          title: "Renew the expiring certificate now or tonight?",
          asker: "Carol",
          why: "Carol needs your call: production changes are yours.",
          summary: "The certificate of the customer portal expires tomorrow at 09:00 UTC. The runbook renews it in 5 minutes, with one restart of the proxy.",
          steps: "done:find the runbook|done:check the expiry date|now:choose the window",
          ask: "Carol: renew the portal certificate now, or in tonight's maintenance window?",
          proposal: "Tonight: the restart drops open connections, and the window leaves 9 hours of margin.",
          action: "tell Carol to schedule the renewal at 22:00 UTC with the runbook",
        }),
        working({ title: "Read access to the warehouse for Grace", asker: "Grace", why: "A direct message to you.", next: "checking the access policy for the analytics group", steps: "done:read Grace's request|now:check the access policy|todo:prepare the exact grant" }),
        waiting({ title: "Disk alert on the backup host", channel: "#acme-incidents", asker: ALERT_BOT, waiting: "the hosting provider, who replaces the disk tonight", why: "The alert mentioned your group, and the host is yours.", summary: "The provider confirmed a failing disk and replaces it tonight; backups run on the second host meanwhile." }),
      ];
    case "account-manager":
      return [
        draft({
          title: "Globex asks for a Q4 roadmap call",
          channel: "#acme-globex",
          asker: "Dana",
          why: "Your client asks you directly in your shared channel.",
          summary: "Dana wants the Q4 roadmap before their budget review on Friday. Your calendar is free Thursday at 15:00.",
          steps: "done:read the thread|done:check your calendar|now:answer Dana|todo:send the invite with the agenda",
          ask: "Dana: can we walk Globex through the Q4 roadmap before Friday?",
          proposal: "Offer Thursday 15:00, and promise the invite with the agenda today.",
          text: "Hi Dana, happy to walk you through it before your review. Does Thursday at 15:00 work for you? I will send the invite with the agenda today.",
          due: dueIn(now, 3, "send Globex the invite with the agenda"),
        }),
        decision({
          title: "Initech asks for 15% off to renew",
          asker: "Carol",
          why: "Carol needs your call: discounts above 10% are yours.",
          summary: "Initech renews in three weeks and asks for 15% off. Their usage grew 40% this year; a two-year term at 10% keeps the same yearly revenue.",
          steps: "done:check Initech's usage and contract|now:choose the counter-offer|todo:answer Initech",
          ask: "Carol: accept Initech's 15% discount, or counter with 10% on a two-year term?",
          proposal: "Counter with 10% on two years: same revenue, and a longer commitment.",
          action: "tell Carol to send the counter-offer",
        }),
        working({ title: "Renewal brief for Umbrella", asker: "Grace", why: "A direct message to you.", next: "gathering Umbrella's usage and open tickets", steps: "done:read Grace's request|now:gather usage and tickets|todo:draft the brief" }),
        waiting({ title: "Contract changes requested by Vandelay", channel: "#acme-requests", asker: "Dave", waiting: "Bob, from legal, who reviews the changes today", why: "Your team group was mentioned; legal took it.", summary: "Bob reviews Vandelay's changes this afternoon; you answer Vandelay once he has." }),
      ];
    case "manager":
      return [
        draft({
          title: "Who takes the on-call swap next week?",
          channel: "#acme-requests",
          asker: "Bob",
          why: "Bob asks you directly, and the on-call schedule is yours.",
          summary: "Bob is off next week. Carol was on call last week; Dave has not been on call this month.",
          steps: "done:read the schedule|now:answer Bob|todo:update the schedule",
          ask: "Bob: who covers my on-call week?",
          proposal: "Dave: he has not been on call this month, and Carol just was.",
          text: "Hi Bob, Dave takes your on-call week: he has not been on call this month. Dave, I will update the schedule today.",
        }),
        decision({
          title: "Hire a contractor or move the mobile release?",
          asker: "Carol",
          why: "Carol needs your call: the release date and the budget are yours.",
          summary: "The mobile release is three weeks late. A contractor costs 18,000 USD and keeps the date; moving it to November costs nothing but the launch campaign.",
          steps: "done:list the options with Carol|now:choose|todo:announce it to the team",
          ask: "Carol: hire a contractor for six weeks, or move the mobile release to November?",
          proposal: "Move the release: the campaign can move, and onboarding a contractor costs two of the six weeks.",
          action: "tell Carol to move the release and the campaign to November",
        }),
        working({ title: "Q4 priorities for Thursday's review", asker: "Grace", why: "A direct message to you.", next: "collecting each team's top three requests", steps: "done:read Grace's request|now:collect the requests|todo:draft the options" }),
        waiting({ title: "Carol's promotion packet", channel: "#acme-requests", asker: "Erin", waiting: "Erin, from HR, who checks the packet this week", why: "Erin asked your team group; HR reviews it.", summary: "Erin has the packet and answers by Friday." }),
      ];
  }
}

/** The report of each demo's topic A: what a session would have written there, with its sources. */
const ROLE_REPORTS: Record<Exclude<Role, "developer">, string> = {
  support: `# A · Globex cannot export invoices since this morning

Fictional report, written by the demo. A real session writes what it checked here, with its sources.

- 12 of Globex's 340 invoices fail to export: all carry a credit note.
- The others export as usual.
- Engineering ships the fix today (ENG-12).
`,
  operations: `# A · Status update for the API latency incident

Fictional report, written by the demo. A real session writes what it checked here, with its sources.

- Runbook followed: database read replicas, scaling.
- Latency back under 200 ms since 14:05 UTC.
- No other service affected.
`,
  "account-manager": `# A · Globex asks for a Q4 roadmap call

Fictional report, written by the demo. A real session writes what it checked here, with its sources.

- Globex's budget review: Friday.
- Your calendar: free Thursday 15:00.
- Promise to keep: the invite with the agenda, today.
`,
  manager: `# A · Who takes the on-call swap next week?

Fictional report, written by the demo. A real session writes what it checked here, with its sources.

- Carol: on call last week.
- Dave: not on call this month.
- Erin: on leave next week.
`,
};

const REPORT_A = `# A · Globex rate limit before Thursday's launch

Fictional report, written by the demo. A real session writes what it checked here, with its sources.

- Globex's plan: 50 requests per second.
- Last week's peak: 40 requests per second (Tuesday, 14:05).
- Margin: 25%. A launch above that would need a temporary raise.
`;

/** Writes the throwaway installation: profile, topics, a report, a heartbeat, and a stub `claude`. */
export function writeDemo(dir: string, locale: "en" | "fr", now = Date.now(), pid = process.pid, role: Role = DEFAULT_ROLE) {
  rmSync(dir, { recursive: true, force: true });
  const state = join(dir, "state");
  for (const d of [join(state, "reports"), join(dir, "ws"), join(dir, "home"), join(dir, "bin")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(state, "config.json"), JSON.stringify(demoProfile(locale, role), null, 2));
  writeFileSync(join(state, "sujets.json"), JSON.stringify(demoTopics(now, join(state, "reports"), role), null, 2));
  writeFileSync(join(state, "reports", "A.md"), role === "developer" ? REPORT_A : ROLE_REPORTS[role]);
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
  if (!Number.isInteger(port) || port <= 0 || port > 65535) fail(`usage: demo [--port N] [--locale en|fr] [--role <role>] | --clean (invalid port: ${opts.port})`, 64);
  const asked = opts.role ?? DEFAULT_ROLE;
  const role: Role = isRole(asked) ? asked : fail(`usage: demo [--port N] [--locale en|fr] [--role <role>] | --clean (unknown role: ${asked}; roles: ${ROLES.join(", ")})`, 64);
  const locale = opts.locale === "fr" || opts.locale === "en" ? opts.locale : localeFromEnv(process.env.LC_ALL || process.env.LANG);
  const state = writeDemo(DEMO_DIR, locale, Date.now(), process.pid, role);
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
