# Setting up Strato

This guide takes you from a fresh clone to a running Strato that knows who you are, who your team is, and what it must never do without your go.
It takes about twenty minutes, most of it spent answering a short interview.

At the end, your project holds a state folder `.strato/` with:

| File | What it is | Who writes it |
| --- | --- | --- |
| `config.json` | Your profile: Slack identity, team group, watched channels, tracker, forge, session permissions, board language | `setup --write`, during the interview |
| `local.md` | Plain notes read by the master at startup: who you are, your team, who owns what around you, what never goes out without your go | The interview drafts it, you reread it |
| `policy/*.md` | Optional. Your own version of a shipped prompt template (`scripts/policy/defaults/`), file by file | You, when the defaults do not fit |

A complete fictional profile lives in [`examples/profile/`](examples/profile/): Alice, lead of the Platform team at Acme.
It is the shape the interview aims at.

## 1. Prerequisites

| Tool | Needed for | Required |
| --- | --- | --- |
| [Bun](https://bun.sh) 1.1 or later | Running Strato from a clone (the binary needs nothing) | Only from a clone |
| [Claude Code](https://claude.com/claude-code) with background sessions (`claude --bg`, `claude agents`) | The master and one work session per topic | Yes |
| A Slack user token (`xoxp-…`) | Reading Slack as you, and posting your approved drafts | Yes |
| A Slack app-level token (`xapp-…`) | Socket Mode: messages within a second instead of polling every minute | No |
| `glab` and `GITLAB_TOKEN` | Following merge requests on the board | Only with a GitLab forge |
| Linear MCP server | Tickets | Only with Linear |
| `ttyd` | A terminal attached to a session, inside the board | No |
| iTerm2 | Sidebar panel and `dive` (macOS) | No |

GitHub is not wired as a forge yet: sessions can still use `gh`, but the board has no delivery line for GitHub pull requests.

## 2. Install

Install the binary (macOS or Linux, x64 or arm64):

```bash
curl -fsSL https://raw.githubusercontent.com/hugoblanc/strato/main/install.sh | sh
```

It installs `~/.local/bin/strato` after checking its SHA-256, and writes the skill to `~/.claude/skills/strato/SKILL.md`.
`STRATO_INSTALL_DIR` changes the folder, `STRATO_VERSION=v0.2.0` pins a release, and `STRATO_SKILL_ARGS="--project $HOME/dev/acme"` writes a project skill instead of the global one.
If the script says `~/.local/bin` is not in your `PATH`, add it: the skill then calls `strato` by name, else by its full path.
To write the skill again later, or for another project: `strato install-skill [--project <project>]` (`--force` replaces a SKILL.md it did not write).
On Windows, download `strato-windows-x64.exe` from the releases page, rename it `strato.exe` in a folder of your `PATH`, and run `strato install-skill`; iTerm2, `osascript` and the sidebar panel do not exist there.

Your project folder is the **workspace**: work sessions run there, with its `CLAUDE.md` and `.mcp.json`.
Start Claude Code from it; Strato finds its state folder (`.strato/`) from there, or from any subfolder.
An umbrella folder that holds several repositories works well.

Check what is missing:

```bash
cd <project>
strato setup --check
```

It prints one line per prerequisite and exits with code 1 while a blocking one is missing.

**From a clone instead** (to contribute), with Bun: clone the repository into the project and use `bun .claude/skills/strato/scripts/strato.ts` wherever this guide says `strato`.

```bash
git clone https://github.com/hugoblanc/strato <project>/.claude/skills/strato
cd <project>/.claude/skills/strato/scripts && bun install
```

## 3. Connect Slack

Strato reads and posts **as you**, with a user token.
Both options below start from the same Slack app, created from [`examples/slack-app-manifest.yaml`](examples/slack-app-manifest.yaml):

1. **[Create the Strato app in Slack](https://api.slack.com/apps?new_app=1&manifest_yaml=display_information%3A%0A%20%20name%3A%20Strato%0A%20%20description%3A%20Routes%20your%20Slack%20to%20Claude%20Code%20work%20sessions%20on%20your%20machine.%20Posts%20only%20on%20your%20click.%0A%20%20background_color%3A%20%22%231b1406%22%0Aoauth_config%3A%0A%20%20scopes%3A%0A%20%20%20%20user%3A%0A%20%20%20%20%20%20-%20search%3Aread%0A%20%20%20%20%20%20-%20channels%3Ahistory%0A%20%20%20%20%20%20-%20groups%3Ahistory%0A%20%20%20%20%20%20-%20im%3Ahistory%0A%20%20%20%20%20%20-%20mpim%3Ahistory%0A%20%20%20%20%20%20-%20channels%3Aread%0A%20%20%20%20%20%20-%20groups%3Aread%0A%20%20%20%20%20%20-%20im%3Aread%0A%20%20%20%20%20%20-%20mpim%3Aread%0A%20%20%20%20%20%20-%20users%3Aread%0A%20%20%20%20%20%20-%20usergroups%3Aread%0A%20%20%20%20%20%20-%20chat%3Awrite%0A%20%20%20%20%20%20-%20reactions%3Awrite%0Asettings%3A%0A%20%20event_subscriptions%3A%0A%20%20%20%20user_events%3A%0A%20%20%20%20%20%20-%20message.channels%0A%20%20%20%20%20%20-%20message.groups%0A%20%20%20%20%20%20-%20message.im%0A%20%20%20%20%20%20-%20message.mpim%0A%20%20interactivity%3A%0A%20%20%20%20is_enabled%3A%20false%0A%20%20org_deploy_enabled%3A%20false%0A%20%20socket_mode_enabled%3A%20true%0A%20%20token_rotation_enabled%3A%20false)**: this link opens Slack's app creation with the manifest already filled in. Pick your workspace, then **Next** and **Create**. From a terminal, `strato.ts setup --slack-app` opens the same link.
2. **Install to Workspace** (your workspace admin may have to approve it).
3. Copy the **User OAuth Token** (`xoxp-…`) from **OAuth & Permissions**.

If the link does not open the creation flow, create the app by hand: https://api.slack.com/apps, **Create New App**, **From an app manifest**, pick your workspace, paste the manifest.

The app's pages show several tokens and secrets. Strato needs one, and a second only for real time:

| Token | Starts with | Where on the Slack app's pages | Needed? |
| --- | --- | --- | --- |
| User OAuth Token | `xoxp-` | **OAuth & Permissions** | Yes |
| App-Level Token | `xapp-` | **Basic Information** > **App-Level Tokens** (you generate it) | Only for Socket Mode (option B) |
| Bot User OAuth Token | `xoxb-` | **OAuth & Permissions**, when the app has a bot | No, ignore it |
| Signing Secret, Client Secret, Verification Token | (no prefix) | **Basic Information** | No, ignore them |

`setup --check` names a token of the wrong kind when it finds one.

The manifest asks for the scopes the code actually calls: `search:read`; `channels:history`, `groups:history`, `im:history`, `mpim:history`; `channels:read`, `groups:read`, `im:read`, `mpim:read`; `users:read`, `usergroups:read`; `chat:write` and `reactions:write` for the board's Send button and check mark.
`setup --check` lists any scope your token lacks, and what stops working without it.

Put the user token where Strato looks for it, first match wins:

- `STRATO_SLACK_TOKEN` in the environment;
- `SLACK_MCP_XOXP_TOKEN` under `env` in `<project>/.claude/settings.local.json` (the same token can serve a Slack MCP server for the sessions);
- `SLACK_MCP_XOXP_TOKEN` in the `slack` server of `<project>/.mcp.json`;
- `SLACK_MCP_XOXP_TOKEN` in the environment.

Several tokens for several workspaces may coexist: Strato keeps the one whose `auth.test` returns `slack.team`.

### Option A: user token only, by polling

Nothing more to do.
The master runs `strato.ts watch`, which looks up new messages through the search API every `slack.pollInterval` seconds (60 by default).
Messages arrive with up to a minute or two of delay, because the search index lags.

### Option B: Socket Mode, in real time

The manifest already enables Socket Mode and subscribes to `message.channels`, `message.groups`, `message.im` and `message.mpim` **on behalf of users**: the app receives what you see, and no bot has to join any channel.

1. In the app's **Basic Information**, under **App-Level Tokens**, generate a token with the `connections:write` scope (`xapp-…`).
2. Store it in a file only you can read, for instance `~/.config/strato/slack-app.env` with `chmod 600`:

   ```
   SLACK_APP_TOKEN=xapp-…
   ```

3. Point `slack.appTokenFile` at that file (the interview asks), or export `SLACK_APP_TOKEN`.
4. Note the app ID (`A…`, on **Basic Information**) for `slack.appId`: the board links to the app's Event Subscriptions page when Slack stops delivering events.

The master then runs `strato.ts listen`; it falls back to `watch` if the socket does not open.

## 4. Run the setup interview

From the project folder:

```bash
claude -n strato "/strato setup"
```

The master runs `setup --check`, then `setup --detect`, which guesses what it can without asking: your name, Slack ID and workspace, your Slack groups and their members, the channels you write in most, your git remotes and branches, the ticket prefixes in your commit messages, a Linear MCP server.
It shows what it found, then asks only what is missing, in short blocks:

1. who you are: role, scope, what you are responsible for;
2. your team: teammates, their roles, the team's Slack group;
3. the ownership map around you, so sessions can say "not for you, it's X";
4. what never goes out without your go;
5. channels to watch, bots to ignore;
6. tracker and forge;
7. session permissions, and the risk of `skipPermissions`;
8. language of the board and tone of drafts.

It writes `config.json` with `setup --write`, drafts `local.md` for you to reread, then rehearses on the last 24 hours (`backlog --since 24h`, read only) to show what Strato would have raised, and tunes the filters with you.
Finally it starts the board and the listener in **shadow mode**.

Prefer doing it by hand? Copy [`examples/profile/`](examples/profile/), edit it, then:

```bash
bun .claude/skills/strato/scripts/strato.ts setup --write my-profile.json
cp my-local.md .strato/local.md
```

## 5. What each profile file does

**`config.json`.** Every section is optional; a missing field keeps its default.
`SKILL.md` ("The profile") documents every field. The ones that shape what you see:

| Field | Effect |
| --- | --- |
| `owner.name` | Your first name, in prompts, cards and the board |
| `slack.me`, `slack.subteams` | What counts as "for you": a mention of you or of one of these groups |
| `slack.teamAlias`, `slack.teammates` | A mention of the group means "someone from the team"; if a teammate answers in a thread, the topic leaves your queue |
| `slack.watchChannels` | Channels where every message is a request for you |
| `slack.ignoreChannels`, `slack.ignoreAuthors` | Channels never raised, bots whose messages go to the digest instead |
| `tracker`, `forge` | Ticket links and merge requests followed to production; `null` turns each off |
| `workers.allow` | Extra permissions given to work sessions (read-only MCP tools, for instance) |
| `workers.skipPermissions` | Sessions run without permission prompts. Off by default; read "Security" below |
| `workers.shadow` | Shadow mode: nothing is posted (below) |
| `ui.locale` | `en` or `fr`: the board and the master's messages to you |

**`local.md`.** Free Markdown, read by the master every morning.
The interview writes five sections: *Who I am*, *My team*, *Ownership map*, *Never without my go*, *Notes*.
The master uses it to triage: a request that belongs to someone on your ownership map is ignored, not turned into a topic.

**`policy/*.md`.** The prompts of the work sessions are Markdown templates in `scripts/policy/defaults/`.
A file with the same name in `.strato/policy/` replaces the default, for this installation only.
An overridden template no longer follows upstream improvements of that file: override as few as you can.
A common one: `worker.md`, to tell sessions to read a voice file before writing a draft.

## 6. Shadow mode, then live

The first day runs in shadow mode (`workers.shadow: true`):

- work sessions prepare everything (cards, drafts, reports) and post nothing, execute nothing that writes outside Strato's local state;
- the board shows "Shadow mode: nothing is posted" in place of Send and Go;
- the server refuses to post a draft, send a go or add a check mark (HTTP 409), whatever the page shows.

Read the cards for a day or two.
When the drafts are ones you would send, go live:

```bash
bun .claude/skills/strato/scripts/strato.ts setup --live
```

The running board picks it up without a restart.
Sessions started in shadow mode keep their instruction until you send them a go from the board, which is only possible once live.

## 7. Adjusting later

- `setup --write <partial.json>` merges a partial file into `config.json` and prints the diff; it never overwrites without `--force`.
- `setup --check` and `doctor` say what is missing or misconfigured.
- Edit `.strato/local.md` directly; the master reads it at its next start.
- Too much noise: add the bot to `slack.ignoreAuthors` or the channel to `slack.ignoreChannels`. Missed requests: add the channel to `slack.watchChannels` or the group to `slack.subteams`.
- `/strato setup` again reruns the interview; it starts from your current profile.

## 8. Security

Strato acts with your identity. Read this before going live.

- **The board acts in your name.** From `http://127.0.0.1:4343/board` you can post a draft as you, send a go that makes a session carry out an action, stop sessions and open terminals. It listens on 127.0.0.1 only and checks the `Host` and `Origin` of every request, but has no authentication: any process on your machine could do the same. Do not expose the port, and do not run Strato on a shared machine.
- **Your Slack token.** It reads everything you can read and posts as you. Keep it out of git (`.claude/settings.local.json` is ignored by default; check your `.gitignore` for `.mcp.json`).
- **`workers.skipPermissions`.** With `true`, every work session runs with `--dangerously-skip-permissions`: it can run any command and write any file in your workspace without asking, while reading text written by third parties (Slack messages, tickets). Prompt injection becomes a real risk. Keep it off unless your workspace has nothing you could not lose, and prefer `workers.allow` for the few read-only tools you want without prompts.
- **What always waits for your go**, whatever the profile: a message on your behalf, and a production write.
