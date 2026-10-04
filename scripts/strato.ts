#!/usr/bin/env bun
/**
 * strato: routes Slack to Claude Code work sessions, one topic per problem (one or more threads).
 *
 *   bun strato.ts doctor                         checks token, state, claude agents
 *   bun strato.ts setup --check | --detect | --write <profile.json> [--force] | --live   guided setup (SKILL.md)
 *   bun strato.ts watch [interval]               for Monitor: one line per event, by polling
 *   bun strato.ts listen [--sessions 5]          same over Socket Mode: messages by WebSocket, topics declared by hook
 *   bun strato.ts hook                           called by Claude Code inside a topic session, reads the event on stdin
 *   bun strato.ts backlog [--since 12h]          recent relevant messages, to catch up
 *   bun strato.ts digest [--since 6h]            messages set aside (third parties, bots) since the last digest
 *   bun strato.ts open [<link>] --msg <id> --title …   (or --from … --channel … --text … without --msg)
 *   bun strato.ts attach <topic> <Slack link | ABC-123>   attaches a thread or a ticket to the topic
 *   bun strato.ts relay <topic> --kind suite|moi --msg <id>
 *   bun strato.ts send <topic> <message…>        free message to the topic's session
 *   bun strato.ts set <topic> key=value …        state of the topic (status, waiting, next, summary, title, why,
 *                                                steps, blocker, mrs, due, unverified, report); the legacy card fields
 *                                                (gate, ask, proposal, action, draft, draftTo) still become tasks
 *   bun strato.ts task <topic> add kind=draft|action|decision|question ask="…" proposal="…" [action="…"] [draft="…" draftTo="…"]
 *   bun strato.ts task <topic> done|drop <id> [note="…"]   closes a task (carried out, or no longer applies)
 *   bun strato.ts task <topic> edit <id> key=value…       fixes an open task (same request)
 *   bun strato.ts close <topic>                  closes the topic and stops its session
 *   bun strato.ts gc [--dry]                     stops the sessions of closed topics and those idle for gc.idleHours
 *   bun strato.ts refresh [<topic>…] [--stale] [--dry]   each session revalidates its card (all, or the late ones)
 *   bun strato.ts list [--all] | gates | card <topic> | get <topic>
 *   bun strato.ts dive <topic | Slack link> [--no-tab] [--window]   opens the topic's session in a tab of the current window
 *   bun strato.ts serve [--port N]               board and iTerm2 panel on 127.0.0.1, port ui.port by default
 *
 * <topic> = letter (A), any key of the topic (channel:ts, linear:ABC-123), short session id,
 * sessionId or Slack link of one of its threads.
 * Exit code 3 on relay/send: the session is alive, the master must use SendMessage
 * with the printed name and message.
 * `aiguilleur.ts` is a one-line legacy alias of this file: sessions started before the rename still call it.
 */
import { agentsBySession, hookSession } from "./app/claude.ts";
import { CorruptState, F, fail, flags, nowIso, out, readJson, SCRIPT, writeJson } from "./app/env.ts";
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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// lock unavailable or unreadable state file: the command stops on one clear line, exit code 1, no stack
process.on("uncaughtException", (e) => {
  if (e instanceof LockTimeout || e instanceof CorruptState) fail(e.message);
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
  default: {
    const lines = readFileSync(SCRIPT, "utf8").split("\n");
    out(lines.slice(1, lines.indexOf(" */")).join("\n"));
    process.exit(cmd ? 64 : 0);
  }
}
