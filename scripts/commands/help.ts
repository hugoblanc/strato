/**
 * `help`: the few commands a person types, grouped by when they need them. The full list, with the commands the
 * master and the sessions call, stays in the header of strato.ts and in SKILL.md.
 */
import { cliCommand } from "./setup.ts";

/** The help text, with `cli` as the way to call Strato from here ("bun ./.claude/skills/strato/scripts/strato.ts"). */
export function helpText(cli: string): string {
  const rows = (list: [string, string][]) => {
    const width = Math.max(...list.map(([c]) => c.length));
    return list.map(([c, what]) => `  ${c.padEnd(width)}   ${what}`).join("\n");
  };
  return [
    "Strato routes your Slack to Claude Code work sessions, one topic per problem, and shows them on a local board.",
    `Commands below start with: ${cli}`,
    "",
    "Getting started",
    rows([
      ["demo", "the board with fictional topics, no Slack needed (--clean removes it)"],
      ["setup --slack-app", "create the Slack app, its manifest filled in"],
      ["setup --token", "store your Slack user token (paste it, it is not shown)"],
      ["setup --providers", "the tools Strato can connect, and how each one signs in"],
      ["setup --connect slack", "connect a Slack workspace: your own app, a token you have, or your team's app (OAuth)"],
      ["setup --check", "what is missing, and the one command to run next"],
      ['claude -n strato "/strato setup"', "the guided setup interview (run as is, not after the prefix)"],
      ["doctor", "what is wired and what is missing, one line each"],
    ]),
    "",
    "Every day",
    rows([
      ['claude -n strato "/strato"', "start the master: Slack listener and board (run as is)"],
      ["serve", "the board alone, on 127.0.0.1 (ui.port, 4343 by default)"],
      ["gates", "what waits for your go"],
      ["list [--all]", "the open topics"],
      ["card <topic>", "one topic's card"],
      ["setup --live", "leave shadow mode: the board can post as you"],
    ]),
    "",
    "Called by the master and the work sessions, you do not need them: listen, watch, hook, backlog, digest, open,",
    "attach, relay, send, set, task, close, gc, refresh, dive, term, get. SKILL.md documents every command.",
  ].join("\n");
}

export function help() {
  process.stdout.write(`${helpText(cliCommand())}\n`);
}
