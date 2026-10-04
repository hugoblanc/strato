<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/strato-lockup-light.svg">
    <img alt="Strato" src="assets/strato-lockup.svg" width="300">
  </picture>
</p>

# Strato

Strato is a Slack control tower for one person, built as a [Claude Code](https://claude.com/claude-code) skill.

It listens to your Slack workspace and surfaces only what is for you: mentions, your team group, DMs, channels you watch, and replies in threads you follow.
Each problem becomes a **topic** with a letter (A, B, C…), and each topic gets its own background Claude Code session.
That session reads the thread, investigates with the access you gave it, and prepares a **card**: what is asked, what it proposes, and the exact action (a draft reply, a ticket, a command).
You read the cards on a local **board** and say "go"; the session, or the master session, carries the action out.

Nothing is posted on your behalf and nothing is written to production without your go.

## Requirements

- macOS or Linux, [Bun](https://bun.sh) 1.1 or later.
- [Claude Code](https://claude.com/claude-code) with background sessions (`claude --bg`, `claude agents`).
- A Slack user token (`xoxp-…`) for your workspace, from a Slack app created with [`examples/slack-app-manifest.yaml`](examples/slack-app-manifest.yaml). Socket Mode and its app token (`xapp-…`) are optional: without them, Strato polls the search API.
- Optional: `glab` and a `GITLAB_TOKEN` to follow merge requests, the Linear MCP for tickets, `ttyd` for the in-page terminal, iTerm2 for the sidebar panel.

## Installation

Clone the repository as a Claude Code skill, either for one project or for your user:

```bash
git clone <repo-url> <project>/.claude/skills/strato     # project skill: the project is the workspace
cd <project>/.claude/skills/strato/scripts && bun install
```

Then, from the project folder, run the guided setup:

```bash
claude -n strato "/strato setup"
```

It checks the prerequisites, guesses what it can from Slack and git (`setup --detect`), asks only what is left (your role, your team, who owns what around you, what never goes out without your go), writes the profile in `<project>/.strato/`, rehearses on the last 24 hours, and starts in **shadow mode**: cards and drafts for real, nothing posted until `setup --live`.
**[SETUP.md](SETUP.md)** is the step-by-step guide, Slack app included; [`examples/profile/`](examples/profile/) is a complete fictional profile.

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
| `config.json` | Written by `setup --write`. The profile: who is served (`owner.name`), the workspace, Slack (`team`, `workspace`, `me`, `subteams`, `teamAlias`, `watchChannels`, `teammates`…), the tracker, the forge, the work sessions' permissions, the board's port and language (`ui.locale`: `en` or `fr`) |
| `policy/*.md` | Optional. Replaces a shipped template of `scripts/policy/defaults/` file by file: how sessions handle a message, write a card, what waits for a go |
| `local.md` | Notes read by the master at startup: who you are, your team, the ownership map around you, what never goes out without your go |

Environment variables: `STRATO_STATE` (state folder), `STRATO_WORKSPACE` (work sessions' folder), `STRATO_SLACK_TOKEN` (user token), `SLACK_APP_TOKEN` (Socket Mode).
`SKILL.md` documents the full protocol, every command and every profile field.

## Security

Strato acts with your identity. Read this before installing it.

- **Your Slack token.** The user token reads what you can read and posts as you. The board's Send button, ✅ reaction and Undo use it directly, on your click.
- **The board.** It listens on 127.0.0.1 only, checks the `Host` header of every request (against DNS rebinding) and the `Origin` of every POST (against other web pages), and serves each terminal under a random path. From it you can post a draft as you, send instructions or a "go" to a session, stop or close sessions, and open a terminal attached to a session (`ttyd` on loopback ports 7700 to 7799). There is no authentication: any process running on your machine can forge those headers and do the same. Do not expose the port, and do not run Strato on a shared machine.
- **Work sessions.** Each topic runs a Claude Code session in your workspace, with your MCP servers and the permissions listed in `workers.allow`. With `workers.skipPermissions: true`, sessions run with `--dangerously-skip-permissions`: they can run any command and write any file without asking. It is off by default; turn it on only if you accept that.
- **Untrusted input.** Slack messages, tickets and pages are written by third parties. Strato neutralises their text before quoting it in a prompt, never passes it through a shell command, and every prompt states that quoted text is data, not instructions. This reduces prompt injection risk; it does not remove it. The policy keeps two things behind your explicit go: a message on your behalf, and a production write.

## Development

```bash
cd scripts
bun run check    # strict typecheck and tests
```

## License

[MIT](LICENSE), Copyright (c) 2026 Hugo Blanc.
