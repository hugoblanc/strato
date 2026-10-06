<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/strato-lockup-light.svg">
    <img alt="Strato" src="assets/strato-lockup.svg" width="300">
  </picture>
</p>

# Strato

Strato is a control tower for one person, built as a [Claude Code](https://claude.com/claude-code) skill: it routes the requests that reach you, in Slack, in Linear or in a tool you connect, to Claude Code work sessions.

It listens to your Slack workspace (and to the other tools you connect) and surfaces only what is for you: mentions, your team group, DMs, channels you watch, and replies in threads you follow.
Each problem becomes a **topic** with a letter (A, B, C…), and each topic gets its own background Claude Code session.
That session reads the thread, investigates with the access you gave it, and prepares a **card**: what is asked, what it proposes, and the exact action (a draft reply, a ticket, a command).
You read the cards on a local **board** and say "go"; the session, or the master session, carries the action out.
The board has two layouts: Flow, every card stacked by block, a click on a title opening its detail beside them; and Focus (`/board?mode=focus`), the list beside the selected topic's detail.

Nothing is posted on your behalf and nothing is written to production without your go.

## Requirements

- macOS or Linux (x64 or arm64). Windows is best effort: the binary runs, but iTerm2, `osascript` and the sidebar panel do not exist there.
- No runtime to install: Strato ships as a standalone binary. [Bun](https://bun.sh) 1.1 or later only to run it from a clone.
- [Claude Code](https://claude.com/claude-code) with background sessions (`claude --bg`, `claude agents`).
- A Slack connection, in one of three ways (`strato setup --providers` lists them): a user token from your own Slack app, a user token you already have, or your team's shared app over OAuth with PKCE (SETUP.md, "One Slack app for a whole team"). The usual one is a user token (`xoxp-…`) for your workspace, from a Slack app created with [`examples/slack-app-manifest.yaml`](examples/slack-app-manifest.yaml): [create it in one click](https://api.slack.com/apps?new_app=1&manifest_yaml=display_information%3A%0A%20%20name%3A%20Strato%0A%20%20description%3A%20Routes%20your%20Slack%20to%20Claude%20Code%20work%20sessions%20on%20your%20machine.%20Posts%20only%20on%20your%20click.%0A%20%20background_color%3A%20%22%231b1406%22%0Aoauth_config%3A%0A%20%20scopes%3A%0A%20%20%20%20user%3A%0A%20%20%20%20%20%20-%20search%3Aread%0A%20%20%20%20%20%20-%20channels%3Ahistory%0A%20%20%20%20%20%20-%20groups%3Ahistory%0A%20%20%20%20%20%20-%20im%3Ahistory%0A%20%20%20%20%20%20-%20mpim%3Ahistory%0A%20%20%20%20%20%20-%20channels%3Aread%0A%20%20%20%20%20%20-%20groups%3Aread%0A%20%20%20%20%20%20-%20im%3Aread%0A%20%20%20%20%20%20-%20mpim%3Aread%0A%20%20%20%20%20%20-%20users%3Aread%0A%20%20%20%20%20%20-%20usergroups%3Aread%0A%20%20%20%20%20%20-%20chat%3Awrite%0A%20%20%20%20%20%20-%20reactions%3Awrite%0Asettings%3A%0A%20%20event_subscriptions%3A%0A%20%20%20%20user_events%3A%0A%20%20%20%20%20%20-%20message.channels%0A%20%20%20%20%20%20-%20message.groups%0A%20%20%20%20%20%20-%20message.im%0A%20%20%20%20%20%20-%20message.mpim%0A%20%20interactivity%3A%0A%20%20%20%20is_enabled%3A%20false%0A%20%20org_deploy_enabled%3A%20false%0A%20%20socket_mode_enabled%3A%20true%0A%20%20token_rotation_enabled%3A%20false), manifest prefilled. Socket Mode and its app token (`xapp-…`) are optional: without them, Strato polls the search API.
- Optional: `glab` and a `GITLAB_TOKEN` to follow merge requests, a Linear API key (or an OAuth application) to read and act on tickets, `ttyd` for the in-page terminal, iTerm2 for the sidebar panel.

## Try it without Slack

See the board before creating any Slack app: from a clone of this repository,

```bash
bun scripts/strato.ts demo
```

It opens `http://127.0.0.1:4394/board` with four fictional topics (Acme, Alice, Bob…): a draft ready to send, a decision, a session at work, a topic waiting on a teammate.
Nothing is connected to Slack, no Claude session runs, and nothing can be posted; the demo lives in a temporary folder that `demo --clean` removes.
`demo --role support` (or `operations`, `account-manager`, `manager`) shows the topics of that job instead.

## Not a developer?

Strato is not only for people who write code.
You tell it your job once, and the work sessions behave accordingly:

| Your job | Role | What a session does with a request |
| --- | --- | --- |
| Customer support | `support` | Finds what the customer needs to hear, drafts the answer in their tone, and prepares any escalation to engineering as a separate step |
| Operations | `operations` | Follows the runbook, writes every production step as its own action, and drafts the incident update |
| Account management, sales | `account-manager` | Gathers the client's history, drafts the reply, sets a reminder for every promise, and prepares CRM changes for your go |
| Team lead, manager | `manager` | Frames each decision as options with a recommendation, and proposes who to delegate to |
| Software developer | `developer` (the default) | Investigates in the code, implements tickets up to a merge request |

Whatever the role, nothing is sent and nothing is changed without your click on the board.
Without a code forge configured, the board never talks about merge requests, branches or production.

To try it: `strato demo --role support`.
To set it up: run the setup interview (`claude -n strato "/strato setup"`), whose first question is your job, or `strato setup --role support`.
`SETUP.md` has a short path for you, with no developer tools to install.

## Installation

One line, on macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/hugoblanc/strato/main/install.sh | sh
```

It downloads the binary of your platform from the [latest release](https://github.com/hugoblanc/strato/releases/latest), checks its SHA-256 against `SHA256SUMS`, installs it as `~/.local/bin/strato` (`STRATO_INSTALL_DIR` to change it), tells you if that folder is not in your `PATH`, and writes the Claude Code skill to `~/.claude/skills/strato/SKILL.md` (`strato install-skill`).
For a skill scoped to one project instead: `strato install-skill --project <project>`.
Updates come from the board's Update button, or `strato update`; the previous binary stays as `strato.previous` (`strato update --rollback`).

**Windows** (best effort): download `strato-windows-x64.exe` from the [releases page](https://github.com/hugoblanc/strato/releases/latest), check it against `SHA256SUMS`, put it in a folder of your `PATH` as `strato.exe`, then run `strato install-skill`.
The iTerm2 panel, `dive` and `iterm-mark` are macOS only, and the board's terminal needs `ttyd`.

**From a clone** (to contribute, or to run unreleased code), with Bun:

```bash
git clone https://github.com/hugoblanc/strato <project>/.claude/skills/strato     # project skill: the project is the workspace
cd <project>/.claude/skills/strato/scripts && bun install
```

The clone's SKILL.md is used as is: its commands read `$STRATO`, which the master expands to `bun <clone>/scripts/strato.ts`.

Then, from the project folder, run the guided setup:

```bash
claude -n strato "/strato setup"
```

It checks the prerequisites, guesses what it can from Slack and git (`setup --detect`), asks only what is left (your role, your team, who owns what around you, what never goes out without your go), writes the profile in `<project>/.strato/`, rehearses on the last 24 hours, and starts in **shadow mode**: cards and drafts for real, nothing posted until `setup --live`.
**[SETUP.md](SETUP.md)** is the step-by-step guide, Slack app included; [`examples/profile/`](examples/profile/) is a complete fictional profile.
`strato setup --providers` lists how each tool connects, and `strato setup --connect slack`, in your own terminal, connects a workspace in one of three ways: your own Slack app, a user token you already have, or your team's shared app through OAuth with PKCE (Strato ships no app of its own).
`strato setup --connect linear` connects Linear with a personal API key or OAuth with PKCE: your notifications become requests, sessions read tickets with `strato context`, and a comment, a status change or an assignment goes out on your Go.

Every morning after that:

```bash
claude -n strato "/strato"
```

The master arms the Slack listener and starts the board at `http://127.0.0.1:4343/board`.

## Configuration

Everything specific to an installation lives in its state folder, never in the code.
One codebase serves every installation; each installation is a profile.

| File | Role |
| --- | --- |
| `config.json` | Written by `setup --write`. The profile: who is served (`owner.name`) and their job (`owner.role`), the workspace, Slack (`team`, `workspace`, `me`, `subteams`, `teamAlias`, `watchChannels`, `teammates`…), the tracker, the forge, other accounts (`providers`, written by `setup --connect`), the work sessions' permissions, the board's port and language (`ui.locale`: `en` or `fr`) |
| `policy/*.md` | Optional. Replaces a shipped template of `scripts/policy/defaults/` file by file: how sessions handle a message, write a card, what waits for a go. `policy/roles/<role>.md` replaces what a role adds |
| `local.md` | Notes read by the master at startup: who you are, your team, the ownership map around you, what never goes out without your go |
| `providers/` | One folder per connected account (its cursors and small state), the code of the providers you add (`providers/<name>/`), and `trusted.json`, the folders you trusted (`strato provider trust`) |

Environment variables: `STRATO_STATE` (state folder), `STRATO_WORKSPACE` (work sessions' folder), `STRATO_SLACK_TOKEN` (user token), `SLACK_APP_TOKEN` (Socket Mode).
`SKILL.md` documents the full protocol, every command and every profile field.

## Security

Strato acts with your identity. Read this before installing it.

- **Your Slack token.** The user token reads what you can read and posts as you. The board's Send button, ✅ reaction and Undo use it directly, on your click.
- **The board.** It listens on 127.0.0.1 only, checks the `Host` header of every request (against DNS rebinding) and the `Origin` of every POST (against other web pages), and serves each terminal under a random path. From it you can post a draft as you, send instructions or a "go" to a session, stop or close sessions, and open a terminal attached to a session (`ttyd` on loopback ports 7700 to 7799). There is no authentication: any process running on your machine can forge those headers and do the same. Do not expose the port, and do not run Strato on a shared machine.
- **Work sessions.** Each topic runs a Claude Code session in your workspace, with your MCP servers and the permissions listed in `workers.allow`. With `workers.skipPermissions: true`, sessions run with `--dangerously-skip-permissions`: they can run any command and write any file without asking. It is off by default; turn it on only if you accept that.
  Each topic session also loads Strato's mod (`scripts/mod/strato-state`, written to `<state>/mod/` and passed with `--plugin-dir`): it writes the session's state to `<state>/live/` and submits the board's messages from `<state>/mailbox/` as your prompt. It reads and writes nothing else; `workers.mod: false` turns it off.
  Sessions read their topic's threads with `strato context`, through the account Strato already uses, and may also call the read tools of each connected tool's MCP server (Slack's, and Linear's when it is configured) without a prompt; no write tool is pre-approved, a provider you add never pre-approves any MCP tool, and in shadow mode the connected tools' MCP write tools are denied to sessions.
- **External providers.** A tool connected through a provider you add (`strato provider new`, `docs/providers/authoring.md`) runs that provider's code with your privileges. Strato loads only the ones `config.json` names, and only once you trusted their folder as it is with `strato provider trust`, typed in your own terminal; a change to the folder needs a new trust. Their writes go through the same Go as Slack's and Linear's.
- **Untrusted input.** Slack messages, tickets and pages are written by third parties. Strato neutralises their text before quoting it in a prompt, never passes it through a shell command, and every prompt states that quoted text is data, not instructions. This reduces prompt injection risk; it does not remove it. The policy keeps two things behind your explicit go: a message on your behalf, and a production write.

## Development

```bash
cd scripts
bun run check        # strict typecheck and tests
bun run build:host   # the binary of this machine, in dist/
bun run build        # the five release binaries and SHA256SUMS, in dist/
```

A release is a tag `v<version>` matching `scripts/package.json`: `.github/workflows/release.yml` runs the checks, compiles the binaries, and publishes them with "What's new" from the `feat:` and `fix:` commits since the previous tag.

## License

[MIT](LICENSE), Copyright (c) 2026 Hugo Blanc.
