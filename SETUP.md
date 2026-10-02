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

### Not a developer?

You do not need git, GitLab, Bun or a code repository.
The short path:

1. Install the binary (section 2) and Claude Code.
2. See what Strato would do for your job, with fictional topics: `strato demo --role support` (or `operations`, `account-manager`, `manager`).
3. Connect Slack (section 3). If someone on your team already set up a Strato Slack app, ask them for its Client ID and use the OAuth option: no app to create.
4. Run the interview (section 4). Its first question is your job; skip every question about trackers and code forges.
5. Read the cards for a day in shadow mode, then go live (section 6).

Your job sets `owner.role` in your profile; `strato setup --role` lists the roles and what each one changes, and `strato setup --role <role>` sets it.
It changes what sessions do with a request (draft an answer, follow a runbook, frame a decision) and the words of the board.
It never changes what needs your go: nothing leaves without your click.

## 1. Prerequisites

| Tool | Needed for | Required |
| --- | --- | --- |
| [Bun](https://bun.sh) 1.1 or later | Running Strato from a clone (the binary needs nothing) | Only from a clone |
| [Claude Code](https://claude.com/claude-code) with background sessions (`claude --bg`, `claude agents`) | The master and one work session per topic | Yes |
| A Slack user token (`xoxp-…`) | Reading Slack as you, and posting your approved drafts | Yes |
| A Slack app-level token (`xapp-…`) | Socket Mode: messages within a second instead of polling every minute | No |
| `glab` and `GITLAB_TOKEN` | Following merge requests on the board | Only with a GitLab forge |
| A Linear personal API key, or an OAuth application in your Linear workspace | Reading tickets, and commenting, changing a status or an assignee on your Go | Only with Linear |
| Linear MCP server | Extra ticket reads for sessions | No |
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

Want to see the board first? `strato demo` serves it with fictional topics, no token needed.

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

Store it with one command, in your own terminal (not in a Claude session, so the token never enters a transcript):

```bash
strato setup --token
```

Paste the token when asked; it is not shown.
The command refuses a bot (`xoxb-`) or app-level (`xapp-`) token, checks the token with Slack, lists any missing scope, writes it to `~/.config/strato/<workspace>.env` (readable by you only) and fills `slack.userTokenFile`, `slack.team`, `slack.workspace` and `slack.me` in your profile.

Strato looks for the user token in this order, first match wins:

- the file named by `slack.userTokenFile` (`SLACK_USER_TOKEN=…`), what `setup --token` writes;
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
   Shortcut for steps 2 and 3: `strato.ts setup --app-token`, then paste the token; it goes into the same file as the user token.
4. Note the app ID (`A…`, on **Basic Information**) for `slack.appId`: the board links to the app's Event Subscriptions page when Slack stops delivering events.

The master then runs `strato.ts listen`; it falls back to `watch` if the socket does not open.

### Other ways to connect Slack

`strato setup --providers` lists every tool Strato can connect, its accounts in your profile, and its ways of signing in.
`strato setup --connect slack` walks one of them: it asks which one, opens the pages you need, reads each token without showing it, checks it with Slack, stores it in a file readable by you only, and fills your profile.
Run it in your own terminal: it refuses to run in a Claude session or from a pipe, so a token never enters a transcript.

| Method | `--auth` | What you do | Trade-off |
| --- | --- | --- | --- |
| Your own app (default) | `user-token` | Create the app from the manifest above, install it, paste the user token, and the app-level token if you want real time | Real time and Slack's full rate limits; each person creates an app, and a free workspace allows ten |
| A token you already have | `paste-token` | Paste a user token (`xoxp-`) of an app you already use, and its app-level token if it has Socket Mode | Nothing to create; that app needs the scopes of Strato's manifest |
| Your team's app, with OAuth | `oauth-pkce` | Approve Strato in your browser | Nobody handles a token and one app serves the whole team; polling only, and someone creates the app once |

`setup --token` and `setup --app-token` keep working: they are the first method, one token at a time.
`--print` shows the links without opening them.

### One Slack app for a whole team (OAuth with PKCE)

Strato ships no Slack app and no client id of its own: a team creates its app once.

1. Whoever sets Strato up for the team runs `strato setup --slack-app --team`, or opens **[the team app's creation link](https://api.slack.com/apps?new_app=1&manifest_yaml=display_information%3A%0A%20%20name%3A%20Strato%0A%20%20description%3A%20Routes%20your%20Slack%20to%20Claude%20Code%20work%20sessions%20on%20your%20machine.%20Posts%20only%20on%20your%20click.%0A%20%20background_color%3A%20%22%231b1406%22%0Aoauth_config%3A%0A%20%20redirect_urls%3A%0A%20%20%20%20-%20http%3A%2F%2Flocalhost%3A4353%2Foauth%2Fcallback%0A%20%20pkce_enabled%3A%20true%0A%20%20scopes%3A%0A%20%20%20%20user%3A%0A%20%20%20%20%20%20-%20search%3Aread%0A%20%20%20%20%20%20-%20channels%3Ahistory%0A%20%20%20%20%20%20-%20groups%3Ahistory%0A%20%20%20%20%20%20-%20im%3Ahistory%0A%20%20%20%20%20%20-%20mpim%3Ahistory%0A%20%20%20%20%20%20-%20channels%3Aread%0A%20%20%20%20%20%20-%20groups%3Aread%0A%20%20%20%20%20%20-%20im%3Aread%0A%20%20%20%20%20%20-%20mpim%3Aread%0A%20%20%20%20%20%20-%20users%3Aread%0A%20%20%20%20%20%20-%20usergroups%3Aread%0A%20%20%20%20%20%20-%20chat%3Awrite%0A%20%20%20%20%20%20-%20reactions%3Awrite%0Asettings%3A%0A%20%20interactivity%3A%0A%20%20%20%20is_enabled%3A%20false%0A%20%20org_deploy_enabled%3A%20false%0A%20%20socket_mode_enabled%3A%20false%0A%20%20token_rotation_enabled%3A%20false)**: Slack's app creation with [`examples/slack-team-app-manifest.yaml`](examples/slack-team-app-manifest.yaml) filled in.
   Pick the workspace, **Next**, **Create**, then **Install to Workspace**.
2. Keep the app internal to the workspace: do not turn on public distribution (**Manage Distribution**).
3. Share its **Client ID** (**Basic Information** > **App Credentials**).
   It is not a secret.
   Strato never uses the Client Secret: do not share it.
4. Each person runs, in their own terminal:

   ```bash
   strato setup --connect slack --auth oauth-pkce --client-id <Client ID>
   ```

   and approves Strato in the browser page that opens.
   The client id is kept in `slack.clientId`, so the next connection needs only `--auth oauth-pkce`.

What happens: Strato listens once on `http://localhost:4353/oauth/callback`, for five minutes at most, sends Slack a PKCE challenge (S256) and a random `state`, and exchanges the code for your own user token (`xoxp-`), stored like the others.
The manifest declares that redirect URL and turns PKCE on, so Slack treats Strato as a desktop app and asks for no client secret ([Slack: using PKCE](https://docs.slack.dev/authentication/using-pkce)).
The port is `ui.oauthPort`, the board's port + 10 by default; to use another one, change `ui.oauthPort` and the redirect URL in the app's **OAuth & Permissions** together.

Rate limits, from Slack's documentation:

- Slack counts Web API calls per app and per workspace ([rate limits](https://docs.slack.dev/apis/web-api/rate-limits)): people who share one app share its budget, and in a large team Strato may meet `ratelimited` answers, which it waits out and retries.
- An internal app keeps Slack's full limits.
  A distributed app that is not approved for the Slack Marketplace reads `conversations.history` and `conversations.replies` at one request a minute, 15 messages at a time, for every installation since March 2026 ([the change](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)): reading a thread would take minutes.
  This is why Strato publishes no app of its own, and why the team app stays internal.
- The team app has no Socket Mode: Slack spreads the events of one app across all its open connections, so with several people each listener would miss part of its own events.
  Everyone polls, every `slack.pollInterval` seconds.

### A second Slack workspace

`strato setup --connect slack --account partners` connects another workspace as a named account: `providers.slack.accounts.partners` in `config.json`, its tokens in `~/.config/strato/slack-partners.env`.
Your main workspace stays the `slack` section.
`doctor` and `setup --check` print one line per named account, with the command that fixes it when it cannot connect.

## 3b. Connect Linear

Without a Linear account, the `tracker` section keeps doing what it always did: Strato recognizes ticket links and ids (`PLAT-12`), opens ticket topics, and sessions read tickets through the Linear MCP server.
Connecting Linear lets Strato read your notifications, give sessions the ticket as plain text, and carry out a comment, a status change or an assignment on your Go.

Run it in your own terminal:

```bash
strato setup --connect linear
```

| Method | `--auth` | What you do | Trade-off |
| --- | --- | --- | --- |
| Personal API key (default) | `api-key` | Create a key in Linear's **Security & access** settings, and paste it | The quickest; the key acts as you until you revoke it |
| OAuth with PKCE | `oauth-pkce` | Create an OAuth application in your workspace once, then approve Strato in your browser | Nothing pasted, and a token renewed every day; someone creates the application and shares its client id |

For OAuth, whoever creates the application in Linear ([the OAuth application page](https://linear.app/settings/api/applications/new)) gives it the callback URL `http://localhost:4353/oauth/callback` (the port is `ui.oauthPort`), and shares its **Client ID**, which is not a secret.
Each person then runs `strato setup --connect linear --auth oauth-pkce --client-id <Client ID>`.
Strato sends a PKCE challenge (S256) and no client secret, as [Linear's OAuth documentation](https://linear.app/developers/oauth-2-0-authentication) allows, and renews the access token with its refresh token when Linear refuses it.

The key or the tokens go to `~/.config/strato/linear-default.env`, readable by you only, never to `config.json`.
Without a `tracker` section, `--connect` also writes the workspace and the team prefixes Linear reports; with one, the links keep coming from `tracker` and only the account is added under `providers.linear.accounts.default`.

What Strato does with it:

- **Requests.** Every minute it reads your Linear notifications: an issue assigned to you or a comment that mentions you is a request; a new comment on an issue you follow is a follow-up of that thread; a status change says nothing unless a topic follows the issue; a comment or an issue written by a bot or an integration goes to the digest.
  `watchTeams` (team keys) makes every new issue of those teams a request, `ignoreTeams` silences teams, `ignoreAuthors` sets people or integrations aside.
- **Context.** `strato context linear:PLAT-12` prints the issue's status, assignee, labels and priority, its description, then its comments, threaded.
- **Actions, on your Go.** A session prepares a comment as a draft task (`to=linear:PLAT-12`), or a status change or an assignment as an action task (`act=setStatus value="In Progress"`, `act=assign value=bob@acme.example`).
  The board shows each with the ticket's link; Go carries it out, and Undo takes it back for 30 seconds (the comment is deleted, the previous status or assignee comes back).
  A comment is created with an id derived from your Go, so a retry after a cut connection cannot post it twice.
- **Limits.** One poll costs one or two requests; Strato reads Linear's rate limit headers and waits for the reset when the hour's budget is spent.
- **The desktop app.** Set `"desktopApp": true` on the account to open Linear links from the board in Linear's desktop app (`linear://`).

## 3c. Connect another tool with a provider

A tool Strato does not know (a ticket tracker, a CRM, a support desk) connects through a provider: a TypeScript module, or a program in any language speaking a small JSON-RPC protocol.
Strato loads it from disk at runtime, without recompiling the binary.

```bash
strato provider guide                    # how a provider works, for whoever writes it
strato provider new tickets              # a working scaffold in <state>/providers/tickets/ (--exec python for a Python one, --dir <folder> elsewhere)
strato provider test tickets-folder      # the offline conformance harness: fake answers from fixtures/, no network (--trace shows every call)
```

`examples/providers/` holds two providers written by outside authors from the guide alone: `github` (a TypeScript module) and `email` (a Python program over IMAP and SMTP); each folder's README says how to install it.

Then, in your own terminal:

1. Name it in `config.json`: `"providers": { "tickets": { "source": { "module": "provider.ts" } } }`.
   A relative path is read from `<state>/providers/tickets/`; an executable is `{ "exec": ["python3", "provider.py"] }`.
2. Read its code, then trust it: `strato provider trust tickets` shows its folder and its SHA-256, runs it once without secrets after a first `yes` to show what it can reach and do, and records the hash on a second typed `yes`.
   A change to any file of that folder (but `.git/` and the JSON files directly in `fixtures/`) needs a new trust; until then Strato does not load it.
3. Connect your account: `strato setup --connect tickets`.
   It first asks what the tool needs and cannot guess (a server, an address), then walks the sign-in.
   The answers go into `config.json` under `providers.tickets.accounts.default`.

`strato provider list` and `strato doctor` say where each provider stands.
A provider runs with your privileges, like any command-line tool you install; its writes still go through the board's Go, and nothing goes out in shadow mode.
A work session can never trust, scaffold nor test provider code; it runs a trusted provider through Strato's own commands like any other tool.

## 4. Run the setup interview

From the project folder:

```bash
claude -n strato "/strato setup"
```

The master runs `setup --check`, then `setup --detect`, which guesses what it can without asking: your name, Slack ID and workspace, your Slack groups and their members, the channels you write in most, your git remotes and branches, the ticket prefixes in your commit messages, a Linear MCP server.
It shows what it found, then asks only what is missing, in short blocks:

1. your job (developer, support, operations, account manager, manager), which sets `owner.role`, and what each role proposes for what Strato listens to;
2. who you are: scope, what you are responsible for;
3. your team: teammates, their roles, the team's Slack group;
4. the ownership map around you, so sessions can say "not for you, it's X";
5. what never goes out without your go;
6. channels to watch, bots to ignore;
7. tracker and forge;
8. session permissions, and the risk of `skipPermissions`;
9. language of the board and tone of drafts.

It writes `config.json` with `setup --write`, drafts `local.md` for you to reread, then rehearses on the last 24 hours (`backlog --since 24h`, read only) to show what Strato would have raised, and tunes the filters with you.
Finally it starts the board and the listener in **shadow mode**.

Prefer doing it by hand? Copy [`examples/profile/`](examples/profile/), edit it, then:

```bash
strato setup --write my-profile.json
cp my-local.md .strato/local.md
```

The example's Slack ids (`U_EXAMPLE_ALICE`, `C_EXAMPLE_REQUESTS`…) are placeholders: with a token, `setup --write` checks every id against your workspace and prints a `warn:` line for each one Slack does not know.

## 5. What each profile file does

**`config.json`.** Every section is optional; a missing field keeps its default.
`SKILL.md` ("The profile") documents every field. The ones that shape what you see:

| Field | Effect |
| --- | --- |
| `owner.name` | Your first name, in prompts, cards and the board |
| `owner.role` | Your job: `developer` (default), `support`, `operations`, `account-manager` or `manager`. What sessions do with a request, and the board's words |
| `slack.me`, `slack.subteams` | What counts as "for you": a mention of you or of one of these groups |
| `slack.teamAlias`, `slack.teammates` | A mention of the group means "someone from the team"; if a teammate answers in a thread, the topic leaves your queue |
| `slack.watchChannels` | Channels where every message is a request for you |
| `slack.ignoreChannels`, `slack.ignoreAuthors` | Channels never raised, bots whose messages go to the digest instead |
| `tracker`, `forge` | Ticket links and merge requests followed to production; `null` turns each off |
| `workers.allow` | Extra permissions given to work sessions (read-only MCP tools, for instance) |
| `workers.skipPermissions` | Sessions run without permission prompts. Off by default; read "Security" below |
| `workers.shadow` | Shadow mode: nothing is posted (below) |
| `ui.locale` | `en` or `fr`: the board and the master's messages to you |

**The state folder ignores itself in git.** A new `.strato/` holds a `.gitignore` with `*`: Slack messages, reports and ids never land in your repository by a `git add .`.
To version your profile, copy `config.json` and `local.md` somewhere else.

**`local.md`.** Free Markdown, read by the master every morning.
The interview writes five sections: *Who I am*, *My team*, *Ownership map*, *Never without my go*, *Notes*.
The master uses it to triage: a request that belongs to someone on your ownership map is ignored, not turned into a topic.

**`policy/*.md`.** The prompts of the work sessions are Markdown templates in `scripts/policy/defaults/`.
A file with the same name in `.strato/policy/` replaces the default, for this installation only.
An overridden template no longer follows upstream improvements of that file: override as few as you can.
A common one: `worker.md`, to tell sessions to read a voice file before writing a draft.
What your role adds lives in `scripts/policy/defaults/roles/<role>.md` (`strato policy-default roles/<role>` prints it); a file with the same name in `.strato/policy/roles/` replaces it.

## 6. Shadow mode, then live

The first day runs in shadow mode (`workers.shadow: true`):

- work sessions prepare everything (cards, drafts, reports) and post nothing, execute nothing that writes outside Strato's local state;
- the board shows "Shadow mode: nothing is posted" in place of Send and Go;
- the server refuses to post a draft, send a go or add a check mark (HTTP 409), whatever the page shows.

Read the cards for a day or two.
When the drafts are ones you would send, go live:

```bash
strato setup --live
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
- **External providers.** A provider you add runs with your privileges: your files and your network. Strato loads only the ones `config.json` names, and only once you trusted their folder as it is (`strato provider trust`, in your own terminal); their writes still go through the board's Go.
- **What always waits for your go**, whatever the profile: a message on your behalf, and a production write.
