#!/usr/bin/env bun
/**
 * strato: routes Slack to Claude Code work sessions, one topic per problem (one or more threads).
 * The commands are listed in USAGE below (what `strato help` prints).
 * Run compiled (`strato <command>`, scripts/build/compile.ts) or from a clone (`bun scripts/strato.ts <command>`):
 * app/self.ts says which, and how Strato calls itself.
 */
import { agentsBySession, hookSession } from "./app/claude.ts";
import { CorruptState, F, fail, flags, nowIso, out, readJson, writeJson } from "./app/env.ts";
import { LockTimeout, requireSujet, withLock } from "./app/store.ts";
import { dive, term } from "./commands/dive.ts";
import { gc } from "./commands/gc.ts";
import { refresh } from "./commands/refresh.ts";
import { attach, close, doctor, gates, list, open, relay, route, set } from "./commands/sujets.ts";
import { backlog, digest, listen, watch } from "./commands/watch.ts";
import { cardLines } from "./core/cards.ts";
import { type MasterRequest } from "./core/master.ts";
import { serve } from "./server/serve.ts";
import { setup } from "./commands/setup.ts";
import { task } from "./commands/tasks.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPILED, BUILD_SHA } from "./app/self.ts";
import { applyUpdate, checkUpdates } from "./app/update.ts";
import { rollbackBinary } from "./app/release.ts";
import { installSkillCommand, UsageError } from "./commands/install-skill.ts";
import { releaseTarget, STRATO_VERSION } from "./core/build-info.ts";
import { EMBEDDED_DEFAULTS, POLICY_TEMPLATES, type PolicyTemplate } from "./policy/prompts.ts";
import itermMark from "./iterm-mark.zsh" with { type: "text" };

export const USAGE = `strato: routes Slack to Claude Code work sessions, one topic per problem (one or more threads).

  strato doctor                         checks token, state, claude agents
  strato setup --check | --detect | --write <profile.json> [--force] | --live   guided setup (SKILL.md)
  strato watch [interval]               for Monitor: one line per event, by polling
  strato listen [--sessions 5]          same over Socket Mode: messages by WebSocket, topics declared by hook
  strato hook                           called by Claude Code inside a topic session, reads the event on stdin
  strato backlog [--since 12h]          recent relevant messages, to catch up
  strato digest [--since 6h]            messages set aside (third parties, bots) since the last digest
  strato open [<link>] --msg <id> --title …   (or --from … --channel … --text … without --msg)
  strato attach <topic> <Slack link | ABC-123>   attaches a thread or a ticket to the topic
  strato relay <topic> --kind suite|moi --msg <id>
  strato send <topic> <message…>        free message to the topic's session
  strato set <topic> key=value …        state of the topic (status, waiting, next, summary, title, why,
                                        steps, blocker, mrs, due, unverified, report); the legacy card fields
                                        (gate, ask, proposal, action, draft, draftTo) still become tasks
  strato task <topic> add kind=draft|action|decision|question ask="…" proposal="…" [action="…"] [draft="…" draftTo="…"]
  strato task <topic> done|drop <id> [note="…"]   closes a task (carried out, or no longer applies)
  strato task <topic> edit <id> key=value…       fixes an open task (same request)
  strato close <topic>                  closes the topic and stops its session
  strato gc [--dry]                     stops the sessions of closed topics and those idle for gc.idleHours
  strato refresh [<topic>…] [--stale] [--dry]   each session revalidates its card (all, or the late ones)
  strato list [--all] | gates | card <topic> | get <topic>
  strato dive <topic | Slack link> [--no-tab] [--window]   opens the topic's session in a tab of the current window
  strato serve [--port N]               board and iTerm2 panel on 127.0.0.1, port ui.port by default
  strato install-skill [--project <dir>] [--global] [--force] [--refresh]   writes the skill for Claude Code
  strato update [--check] [--rollback]  installs the latest release (binary) or pulls the clone (git)
  strato version                        version, commit and install mode
  strato iterm-mark                     marks the master's iTerm2 tab (amber tab and badge)
  strato policy-default <template>      prints a default policy template, to copy into <state>/policy/

<topic> = letter (A), any key of the topic (channel:ts, linear:ABC-123), short session id,
sessionId or Slack link of one of its threads.
Exit code 3 on relay/send: the session is alive, the master must use SendMessage
with the printed name and message.

In a development clone, \`strato\` is \`bun scripts/strato.ts\`; \`scripts/aiguilleur.ts\` is its legacy alias.`;

// lock unavailable or unreadable state file: the command stops on one clear line, exit code 1, no stack
process.on("uncaughtException", (e) => {
  if (e instanceof LockTimeout || e instanceof CorruptState || e instanceof UsageError) fail(e.message);
  process.stderr.write(`${e.stack ?? e}\n`);
  process.exit(1);
});

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "doctor":
    await doctor();
    break;
  case "setup":
    await setup(rest);
    break;
  case "demo":
    await (await import("./commands/demo.ts")).demo(rest);
    break;
  case "help":
  case "--help":
  case "-h":
    (await import("./commands/help.ts")).help();
    break;
  case "watch":
    await watch(rest[0]);
    break;
  case "listen":
    await listen(flags(rest).opts);
    break;
  case "hook":
    await hookSession();
    break;
  case "backlog":
    await backlog(flags(rest).opts);
    break;
  case "digest":
    await digest(flags(rest).opts);
    break;
  case "open":
    await open(rest);
    break;
  case "attach":
    await attach(rest);
    break;
  case "relay":
    await relay(rest);
    break;
  case "send": {
    const [ref, ...words] = rest;
    if (!words.length) fail("usage: send <topic> <message…>");
    await route(requireSujet(ref), words.join(" "));
    break;
  }
  case "set":
    await set(rest);
    break;
  case "task":
    await task(rest);
    break;
  case "refresh":
    await refresh(rest);
    break;
  case "brand": {
    // writes the logo files (mark, lockup, favicon, social image) into assets/ at the root of the repo
    if (COMPILED) fail("brand is a development command: run it from a clone, `bun scripts/strato.ts brand`");
    const { brandFiles } = await import("./core/brand.ts");
    const dir = join(import.meta.dir, "..", "assets");
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(brandFiles())) writeFileSync(join(dir, name), content);
    out(`assets written in ${dir}`);
    break;
  }
  case "gc":
    await gc(rest);
    break;
  case "revue-done": {
    const [id, ...words] = rest;
    if (!id || !words.length) fail("usage: revue-done <id> <summary…>");
    const done = await withLock(() => {
      const list = readJson<MasterRequest[]>(F.master, []);
      const r = list.find((x) => x.id === id);
      if (!r) return false;
      r.doneAt = nowIso();
      r.summary = words.join(" ");
      writeJson(F.master, list);
      return true;
    });
    if (!done) fail(`request ${id} not found in master.json`);
    out(`[strato] review ${id} closed, summary shown on the board`);
    break;
  }
  case "close":
    await close(rest[0]);
    break;
  case "list":
    list(flags(rest).opts.all === "true");
    break;
  case "gates":
    gates();
    break;
  case "card":
    for (const line of cardLines(requireSujet(rest[0]))) out(line);
    break;
  case "dive":
    await dive(rest);
    break;
  case "term":
    await term(rest);
    break;
  case "serve":
    await serve(rest);
    break;
  case "get": {
    const s = requireSujet(rest[0]);
    out(JSON.stringify({ ...s, session: s.sessionId ? (agentsBySession()?.get(s.sessionId) ?? null) : null }, null, 2));
    break;
  }
  case "install-skill":
    await installSkillCommand(rest);
    break;
  case "version":
  case "--version":
    out(`strato ${STRATO_VERSION} (${COMPILED ? "binary" : "git clone"}${BUILD_SHA ? `, ${BUILD_SHA}` : ""}, ${releaseTarget() ?? `${process.platform}-${process.arch}`})`);
    break;
  case "update":
    await updateCommand(rest);
    break;
  case "iterm-mark": {
    // the script is embedded: a binary has no file next to its code. zsh -c keeps its walk up to the terminal's tty.
    const p = Bun.spawn(["zsh", "-c", itermMark, "iterm-mark"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    process.exit(await p.exited);
  }
  case "policy-default": {
    const name = rest[0] as PolicyTemplate;
    if (!POLICY_TEMPLATES.includes(name)) fail(`usage: policy-default <${POLICY_TEMPLATES.join("|")}>`);
    process.stdout.write(EMBEDDED_DEFAULTS[name]);
    break;
  }
  default: {
    out(USAGE);
    process.exit(cmd && cmd !== "help" && cmd !== "--help" ? 64 : 0);
  }
}

/** `strato update`: the board's update, from a terminal. `--check` only reports, `--rollback` puts the previous binary back. */
async function updateCommand(args: string[]) {
  const { opts } = flags(args);
  if (opts.rollback === "true") {
    if (!COMPILED) fail("--rollback is for a binary install; a clone goes back with git");
    if (!rollbackBinary(process.execPath)) fail(`no previous binary next to ${process.execPath}`);
    out(`[strato] back on the previous binary: ${process.execPath}`);
    return;
  }
  const check = await checkUpdates();
  if (check.reason === "fetchFailed") fail(`could not check for updates: ${check.error ?? ""}`);
  if (!check.available) {
    out(check.reason === "noAsset" ? `[strato] ${check.error}` : `[strato] up to date (${STRATO_VERSION})`);
    return;
  }
  for (const c of [...check.changes.features, ...check.changes.fixes]) out(`  ${c.text}`);
  if (opts.check === "true") {
    out(`[strato] ${check.target ?? "a new version"} is available: \`strato update\` installs it`);
    return;
  }
  const r = await applyUpdate();
  if (!r.ok) fail(`update failed (${r.reason})${r.output ? `: ${r.output}` : ""}`);
  out(`[strato] updated ${r.fromVersion ?? "?"} -> ${r.toVersion ?? "?"}; restart \`strato serve\` and the listener to run the new code`);
}
