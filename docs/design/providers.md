# Providers

Status: proposal, October 2026, branch `feat/providers`.
This document changes no code.
It describes how Strato moves from a Slack tool with a Linear link recognizer and a GitLab delivery line to a tool built on providers, and the nine stages that get it there.

## Decisions at a glance

- Inputs and outputs are providers: Slack and Linear are built in, anything else (Jira, ClickUp, GitHub, email…) is a provider written against one interface, loaded from disk without recompiling the binary.
- The core keeps topics, tasks, triage, the board, sessions and the gate; a provider supplies items, context, actions, links, rendering and vocabulary.
- Every write a provider performs (post, reply, comment, react, delete, status, assignee) goes through one function in the core, which refuses anything without a Go on the exact content and refuses everything in shadow mode.
- Sessions lose their own provider write tools once the gate is strict; the commands they run (a branch push, a script) stay governed by the policy and Claude Code permissions, as today.
- Stored keys are never rewritten: the canonical form of every key already on disk is the form it is stored in.
- The `slack` and `tracker` sections of `config.json` stay where they are and become the default Slack and Linear accounts; new accounts live under `providers`.
- Sessions read context with a provider-agnostic `strato context` command; MCP servers stay optional, with their write tools denied once the gate is strict.
- External providers come in two shapes: a TypeScript module imported at runtime, or any executable speaking a JSON-lines protocol on stdin and stdout.
- Roles (developer by default, support, operations, account manager, recruiter, manager) change templates, board vocabulary, triage emphasis and the demo, never the gate.
- Strato runs on Claude Code only; Claude Cowork and other hosts are out of scope.

## 1. Purpose and audiences

Strato routes the requests that reach one person into one Claude Code work session per topic, and shows the topics on a local board where the person approves every outgoing action before it happens.
Today the requests come from Slack only, the tracker is a link recognizer for Linear, and the forge is a read-only delivery line for GitLab merge requests.

Two audiences share the same loop.

| Audience | Typical topic | Where it ends |
| --- | --- | --- |
| Developers | a question in a channel, a bug report, a ticket to implement | a reply, a ticket comment, a merge request towards the integration branch, a merge on Go |
| Non-developers: support, operations, account managers, recruiters, managers | a customer question, an incident, a follow-up, a candidate, an approval | a reply, a ticket update, a status change, a decision recorded |

### The loop

```
 sources                      core                                         the person
 (providers: ingest)
 Slack, Linear, mail...  --items-->  triage --> topic --> work session --> card + tasks --> board
                                                                                            |
 targets                                                                                    | Go on the
 (providers: act)        <---------------  act path (the gate)  <---------------------------+ exact content
```

1. **Sources.** A provider account delivers items (a Slack message, a Linear comment, an email) by push or by poll.
2. **Topics.** The core triages each item: noise, digest, follow-up of a known topic, or a request that the master turns into a topic with a letter.
3. **Sessions.** Each topic gets one background Claude Code session that reads the context, investigates with the access the person gave it, and prepares the next actions.
4. **Actions with a Go.** The session writes tasks (a draft to send, an action, a decision, a question); the person reads each one on the board and gives a Go on its exact content; the core carries the action out through the provider, or hands it back to the session when it is not a provider action (a command, a merge).

### Host

Strato runs on Claude Code: the master is an interactive Claude Code session, topics are `claude --bg` sessions with hooks, and Strato reads `claude agents` and the transcripts.
Claude Cowork and any other host are out of scope for this design.

### Non-goals

- A hosted service, a shared multi-user state, or a server reachable from the internet.
- Webhooks that need a public HTTPS endpoint: providers ingest by Socket-Mode-like push over an outbound connection, or by poll.
- Reading credentials anywhere but where the person put them through an official flow (no browser cookies, no other application's storage).
- Sandboxing provider code: an external provider runs with the person's privileges (section 13.4).

## 2. Glossary

| Term | Meaning |
| --- | --- |
| **Provider** | A module that connects Strato to one external tool: Slack, Linear, a mailbox. It declares what it can do and implements ingest, context, act, links and rendering for that tool. |
| **Provider kind** | The family a provider belongs to, which sets defaults for vocabulary and prompts: `chat` (Slack), `tracker` (Linear, Jira), `mail` (IMAP, a mail API), `forge` (GitLab, GitHub). A provider may have several kinds. |
| **Account** | One connection of a provider, with its own credentials, identity and settings: "Slack, workspace acme", "Slack, workspace acme-partners", "Linear, workspace acme". Each provider has at most one account named `default`. |
| **Auth method** | One official way of connecting an account: a token from an app the person creates, OAuth 2.0 with PKCE on a loopback redirect, a personal API key, an app password. It says which steps the person takes and which secrets Strato stores. |
| **Capability** | One thing a provider can do, declared in its descriptor: push ingest, poll ingest, context reads, each action kind, undo per action kind, link parsing. The core never calls what is not declared. |
| **Item** | One unit of incoming content: a message, a comment, a ticket event, an email. It carries its thread key, its own id, its author, its conversation, its text and the facts triage needs. |
| **Item key** | The provider-qualified string that names a thread, the unit a topic attaches (`C0ACME0001:1759219200.000100`, `linear:PLAT-12`). The same grammar names a single item (its **item id**, used for deduplication). Section 5. |
| **Conversation** | Where items are exchanged: a Slack channel or DM, a Linear team, a mailbox. It has an id, a label and a kind: `dm`, `group`, `channel`, `ticket`, `email`. |
| **Thread** | A sequence of items about one thing inside a conversation: a Slack thread, a Linear issue with its comments, an email thread. A topic is made of one or more threads. |
| **Target** | Where an action goes: a thread (reply), a conversation (new message), an item (react, delete), a ticket (comment, status, assignee). |
| **Action** | One write a provider can perform: `post`, `reply`, `comment`, `react`, `delete`, `setStatus`, `assign`, `create`. An action plan is one text action plus optional non-text follow-ups (a reaction, a status), approved together. |
| **Gate** | The single function in the core that every action goes through. It checks shadow mode, the Go, the exact content and the task, then calls the provider, logs the result and offers the undo. |
| **Go** | The person's approval of one task's exact content: a click on the board, or a "go" to the master that the master turns into `strato act` with the content hash. |
| **Role** | The kind of work the person does (developer, support, operations, account manager, recruiter, manager). It selects template defaults, board vocabulary, triage emphasis and the demo. |

## 3. Current state

### 3.1 Where Slack, Linear and GitLab are coupled

Measured on `ca7891e`, file and line, for orientation only.

| Area | Where | What is specific |
| --- | --- | --- |
| Auth | `app/slack.ts` `tokenCandidates`:57, `connectSlack`:120 (`auth.test`), `initSlack`:143, `appToken`:231 | Token search order (profile file, env, `.claude/settings.local.json`, `.mcp.json`), workspace check, `xapp-` token |
| Setup | `commands/setup.ts` `slackRead`:69 (a second HTTP client), `probeTokens`:89, `detect`:202, `storeUserToken`:370, `storeAppToken`:392, `crossCheck`:415, `slackApp`:324; `core/setup.ts` `slackWorkspaceFromUrl`:108, `slackAppLink`:209, `tokenKindProblem`:226, `SLACK_SCOPES`:282 | Manifest link, token kinds, scopes, Slack-only detection |
| Ingest | `commands/watch.ts` `listen`:245, `connexionSocket`:451, `watch`:669, `backlog`:711, `backfillThreads`:33, `processMatches`:73; `app/slack.ts` `fetchSince`:177, `participatedThreads`:196, `matchFromEvent`:308 | Socket Mode, `search.messages`, `conversations.replies` catch-up; triage is already shared by `listen` and `watch` |
| Context | `app/slack.ts` `repliesOf`:326, `nameOf`:152, `channelOf`:245, `isMyConversation`:282, `channelNameOf`:356, `threadDump`:339, `readThreads`:371 | Thread reads for the panel, `dive` and the catch-up |
| Writes | `server/serve.ts` `conversations.replies`:475 (thread root), `chat.postMessage`:479, `chat.delete`:511 (undo), `reactions.add`:943 (done marker); all through `app/slack.ts` `slackPost`:25 | The board's Send, Undo and check mark |
| Links | `chat/slack-model.ts` `parsePermalink`:88, `permalinkFor`:99, `slackAppLink`:110; `core/keys.ts` `permalinkOfKey`:63 (hardcoded `slack.com`), `ticketUrl`:45 (hardcoded `linear.app`); `board.ts`:736 and :1257; `server/serve.ts` `OPENABLE_HOSTS`:34, `slackTeamId`:444; `claude/transcript.ts` `SLACK_LINK`:81 | Link parsing and building, deep links, which hosts the board may open |
| Identity and formatting | `chat/slack-model.ts` `mentionedUsers`:191, `mentionsMe`:196, `channelGuess`:171, the destination regex in `draftDestination`:345, `humanize`:291, block text extraction :254-280, `DRAFT_MAX`:326; `board.ts` `slackToHtml`:456 | mrkdwn, `<@U…>` mentions, channel ids |
| Core leaks | `core/keys.ts`:4-8 (keys `channel:ts` and `linear:ABC-123`, a stable on-disk format), `sujets.json`, `seen.json`, `events.ndjson` (`saveSeen` in `watch.ts`:197 reads the `ts` of an id as a time); events typed `"slack"` (`watch.ts`:121, read by `core/refresh.ts`:43, `core/sujet.ts`:232, `board.ts`:243); `Sujet.channel`, `permalink`, `draftTo` hold Slack links or ids (`core/sujet.ts`:23-47, `core/tasks.ts`:35); the triage `Config` is a `Pick` of `SlackSettings` (`chat/slack-model.ts`:31) | The model assumes one chat source |
| Prompts | `policy/defaults/card-style.md`:14 (`draftTo` format), `worker.md`:10 and `SKILL.md`:419 (Slack MCP `conversations_replies`), `execution-rule.md` (the done reaction through the Slack MCP), `policy/prompts.ts`:142 (`team_group` from `slack.teamAlias`) and :174 (`untrustedRule` names a Slack thread); `app/claude.ts`:53-55 allows `mcp__slack__*` read tools; `claude/transcript.ts`:304 labels them | Sessions are told to read and act through the Slack MCP |
| Config | `core/settings.ts` `slack` section :9-35, `ui.slackApp`:114, `missingSettings`:196 (Slack fields required), `LEGACY_SLACK`:158 | Slack is mandatory; `tracker` (Linear: link and prefix recognition) and `forge` (GitLab: merge request tracking) already carry a `kind` |

No abstraction exists: `scripts/chat/` holds only `slack-model.ts`.
Linear is a link recognizer: `open ABC-123` starts an implementation session (`ticket.md`) that reads the ticket through the Linear MCP.
GitLab is read through `glab api` for the delivery line (`app/gitlab.ts`, `forge/mr.ts`).

### 3.2 What stays

These parts do not change shape; they only stop assuming Slack.

- The topic model (`core/sujet.ts`): letters, statuses, `threads`, history, snoozes, the takeover by a teammate.
- Tasks (`core/tasks.ts`): kinds, ids, open, done and dropped, the legacy `set` translation.
- The board's blocks, the panel, `dive`, `term`, the ttyd terminals, the update flow.
- Sessions: `claude --bg`, the six hooks, `live/`, the collector, the card sweep, `deliverToSujet`.
- The master protocol: one line per event on the Monitor, `[strato] <type> · <conversation> · <author> · key=<key> · msg=<id> · « text » · <link>`, with the same `<type>` values (`dm`, `mention`, `canal`, `fil`, `suite`, `moi`, `session`).
- Shadow mode, `setup --live`, the state folder layout, every CLI command and flag.
- The policy template mechanism (`policy/defaults/*.md`, `<state>/policy/*.md`, `{{#if}}` and `{{#si}}`).
- The forge as merge request tracker (section 12.3).

## 4. Interfaces

### 4.1 Where the code lives

| Path | Role | Pure |
| --- | --- | --- |
| `scripts/providers/sdk.ts` | The types of this section and `defineProvider`. Shipped inside the binary and printed by `strato provider sdk` for external authors | yes |
| `scripts/core/keys.ts` | The key grammar (section 5), extended in place | yes |
| `scripts/core/triage.ts` | `classifyItem` and `TriageRules` (section 7) | yes |
| `scripts/core/gate.ts` | Canonical action content, its hash, the act decisions (section 8) | yes |
| `scripts/providers/registry.ts` | Built-in providers, external loading, accounts resolved from settings | no |
| `scripts/providers/slack/` | `model.ts` (re-exports and adapts `chat/slack-model.ts`), `index.ts` (adapts `app/slack.ts`) | split |
| `scripts/providers/linear/` | `model.ts` (links, GraphQL shapes to items, triage rules), `client.ts` (HTTP), `index.ts` | split |
| `scripts/providers/host/` | `module.ts` (TypeScript modules), `exec.ts` (JSON-lines processes) | no |
| `scripts/app/act.ts` | The single act path: the only caller of `Provider.act` | no |
| `scripts/app/secrets.ts`, `scripts/app/oauth.ts` | Secret files and the OAuth loopback flow, shared by every provider | no |

`chat/slack-model.ts` and `app/slack.ts` stay where they are: their tests keep running unchanged, and the Slack provider wraps them.

### 4.2 Descriptor, kinds and capabilities

```ts
/** Version of the provider interface described here. A provider declares the range it was written for. */
export const PROVIDER_API = 1;

export type ProviderKind = "chat" | "tracker" | "mail" | "forge";

/** A user-facing string. Built-in providers use i18n keys; external providers give the text, English required. */
export type Text = { key: string } | { en: string; fr?: string };

export interface ProviderDescriptor {
  /** Lowercase, `^[a-z][a-z0-9-]{1,30}$`. It prefixes the keys of this provider: never renamed once used. */
  id: string;
  label: Text;
  api: { min: number; max: number };
  kinds: ProviderKind[];
  capabilities: Capabilities;
  /** Official flows only (section 11.2); empty only for a provider of local data (an account then says `auth: "none"`). The first one is the default offered by setup. */
  auth: AuthMethod[];
  /** The account settings this provider reads, validated by `setup --write` and shown by the interview. */
  settings: SettingSpec[];
  vocabulary: Vocabulary;
  /** Hosts of the links this provider builds: the board opens them, and only them, for this provider's keys. */
  hosts: string[];
  /** The MCP server sessions may also use for this tool, if any: which tools read and which write. */
  mcp?: { server: string; readTools: string[]; writeTools: string[] };
  /** Undo window of an action, in ms; absent: no undo. */
  undoMs?: number;
}

export type ActionKind = "post" | "reply" | "comment" | "react" | "delete" | "setStatus" | "assign" | "create";

export interface Capabilities {
  ingest: { push: boolean; poll: boolean };
  /** Can list the threads the person took part in recently (a reply there without a mention is probably for them). */
  participation: boolean;
  context: boolean;
  actions: ActionKind[];
  /** The actions this provider can take back within `undoMs`. */
  undo: ActionKind[];
  /** Reports an edit that adds a mention of the person. */
  edits: boolean;
  /** Reads people's display names and the person's groups. */
  identity: boolean;
}

export interface SettingSpec {
  key: string;
  type: "string" | "string[]" | "number" | "boolean" | "map";
  label: Text;
  default?: unknown;
  /** The setting feeds a triage rule of the core (section 7). */
  triage?: "me" | "groups" | "groupAlias" | "watch" | "ignore" | "ignoreAuthors" | "teammates";
}

/** Words of this tool, for prompts (English) and the board (through `Text`). */
export interface Vocabulary {
  /** "message", "comment", "email". */
  item: Text;
  /** "thread", "ticket", "email thread". */
  thread: Text;
  /** "channel", "team", "mailbox". */
  conversation: Text;
  /** Prompt sentence: how a draft destination is written (`to=`), with an example. English. */
  targetFormat: string;
  /** Prompt sentence: the marker that tells everyone a thread is settled, if the tool has one. English. */
  doneMarker?: string;
}
```

### 4.3 Auth method

```ts
export type AuthKind = "user-token" | "api-key" | "app-password" | "oauth2-pkce";

export interface AuthMethod {
  /** "user-token", "oauth-pkce", "api-key". Stored in the account's `auth` field. */
  id: string;
  kind: AuthKind;
  label: Text;
  /** The official documentation of this flow, printed by setup. */
  docs: string;
  steps: AuthStep[];
  /** What setup stores in the account's secret file, by name. Never in config.json. */
  stores: SecretSpec[];
  /** Scopes requested, and what stops working without each: `setup --check` lists the missing ones. */
  scopes?: { scope: string; why: Text }[];
  /** What this method cannot do, subtracted from the descriptor's capabilities. */
  limits?: Partial<Capabilities>;
}

export type AuthStep =
  /** Open a documented page (create an app from a manifest, create an API key). */
  | { kind: "open"; url: string; say: Text }
  /** Read one secret on stdin without echo, in the person's own terminal; never as an argument, never in a chat. */
  | { kind: "paste"; secret: string; say: Text; shape?: string }
  /** OAuth 2.0 authorization code with PKCE (S256) on a loopback redirect. */
  | { kind: "oauth"; authorizeUrl: string; tokenUrl: string; clientId: "setting" | string; scopes: string[]; redirect: "loopback" }
  /** Call `connect` with the new secrets; nothing is stored if it fails. */
  | { kind: "verify" };

export interface SecretSpec {
  /** Name in the secret file: `SLACK_USER_TOKEN`, `LINEAR_API_KEY`. */
  name: string;
  /** Environment variables also accepted, first match wins (legacy sources). */
  env?: string[];
  /** Rewritten by Strato when the provider refreshes it (OAuth refresh tokens). */
  refreshable?: boolean;
}
```

### 4.4 Account and identity

```ts
export interface Account {
  provider: string;
  /** "default", or `^[a-z0-9][a-z0-9-]{0,29}$`. */
  id: string;
  label: string;
  auth: string;
  /** `push`, `poll` or `off`: an account can be a target only. Default: push when available, else poll. */
  ingest: "push" | "poll" | "off";
  /** Validated against the descriptor's `settings`. */
  settings: Record<string, unknown>;
}

/** What `connect` learns: who the person is on this account. */
export interface Identity {
  /** The person's id on this account (Slack `U…`, Linear user id). */
  me: string;
  name: string;
  /** Workspace or tenant, as shown to the person. */
  workspace: string;
  /** The person's groups whose mention counts as a mention of them (Slack user groups). */
  groups?: string[];
}
```

### 4.5 Item

```ts
export type ConversationKind = "dm" | "group" | "channel" | "ticket" | "email";

export interface Item {
  /** Thread key (section 5): what a topic attaches. */
  key: string;
  /** This item's own key, for deduplication. Same grammar. */
  id: string;
  /** `<provider>` or `<provider>@<account>`. */
  account: string;
  author: { id: string; name: string; isMe: boolean; isBot: boolean };
  conversation: { id: string; label: string; kind: ConversationKind };
  /** Plain text, mentions made readable. Third-party text: the core neutralizes it before any prompt. */
  text: string;
  /** Unix ms. */
  time: number;
  /** https link to the item, else to its thread. */
  link: string;
  /** The person, or one of their groups, is mentioned; or the tool says the item targets them (assignment). */
  mentionsMe: boolean;
  /** At least one person is explicitly targeted, and not the person served. */
  targetsOther: boolean;
  /** An edit: the facts of the version before it, so an edit is raised only when it adds a mention. */
  edited?: { before: Pick<Item, "mentionsMe" | "targetsOther"> };
  /** Why the tool notified the person, when it says so (Linear notifications). Informative, for the event line. */
  reason?: "assigned" | "mentioned" | "subscribed" | "watched";
}
```

### 4.6 Target, actions and act result

```ts
export interface Target {
  account: string;
  /** A thread (reply), a conversation (new message), an item (react, delete), a ticket (comment, status, assignee). */
  scope: "thread" | "conversation" | "item" | "ticket";
  /** The key of that thread, item or ticket; the conversation id for a new message. */
  ref: string;
  /** What the board shows before the Go: "#support, thread of 10:42", "PLAT-12". */
  label: string;
  link?: string;
}

export type Action =
  | { kind: "post"; target: Target; text: string }
  | { kind: "reply"; target: Target; text: string }
  | { kind: "comment"; target: Target; text: string }
  | { kind: "react"; target: Target; emoji: string }
  | { kind: "delete"; target: Target }
  | { kind: "setStatus"; target: Target; status: string }
  | { kind: "assign"; target: Target; assignee: string }
  | { kind: "create"; target: Target; title: string; text: string; fields?: Record<string, string> };

/** What the core hands a provider. The Go itself never leaves the core. */
export interface ActInput {
  action: Action;
  /** Stable per task and content: a provider that supports idempotent writes uses it, so a replay cannot write twice. */
  idempotencyKey: string;
  /** Validate and describe, never write. The conformance harness only ever calls this. */
  dryRun: boolean;
}

export type ActResult =
  | { ok: true; ref: string; link: string; undo?: { token: string; until: number }; dry?: string }
  | { ok: false; error: ProviderError };

export interface ProviderError {
  /** Short stable code: "rate_limited", "not_found", "missing_scope", "invalid_auth". */
  code: string;
  message: string;
  retryable: boolean;
  /** The account needs setup again (revoked token, missing scope): Strato stops calling it. */
  fatal: boolean;
  retryAfterMs?: number;
  /** For act only: whether the write may have happened. "unknown" is never retried automatically. */
  outcome?: "none" | "unknown";
}
```

### 4.7 Context result

```ts
export interface ContextResult {
  key: string;
  link: string;
  conversation: Item["conversation"];
  /** A ticket's title, an email's subject. */
  title?: string;
  /** A ticket's fields: status, assignee, labels, priority. */
  fields?: Record<string, string>;
  /** Oldest first. Texts are third-party text. */
  items: { id: string; author: string; time: number; text: string; link?: string }[];
  /** False when the read stopped at a cap: the newest items are always the ones kept. */
  complete: boolean;
  fetchedAt: number;
}
```

### 4.8 Ingest cursor

```ts
/** Opaque to the core, made by the provider: a timestamp, a page token, a notification id. */
export interface IngestCursor {
  value: string;
  /** Unix ms up to which everything is surely read. Only for display and for the catch-up window. */
  at: number;
}

export interface PollResult {
  items: Item[];
  cursor: IngestCursor;
  /** False when the provider stopped before reaching the previous cursor (volume cap). */
  complete: boolean;
}
```

The core stores the cursor only after every item of the batch is handled, and never moves it past a failed or incomplete pass: this is `nextSyncCursor` (`chat/slack-model.ts`:61) generalized.

### 4.9 The provider object

```ts
export interface Provider {
  descriptor: ProviderDescriptor;
  /** Checks the secrets and returns who the person is. Throws a ProviderError. */
  connect(ctx: AccountContext): Promise<Identity>;
  poll?(ctx: AccountContext, cursor: IngestCursor | null, opts: { since: number; maxItems: number }): Promise<PollResult>;
  /** Push: resolves when the connection ends; `onItems` is called as items arrive. */
  subscribe?(ctx: AccountContext, onItems: (items: Item[]) => void): Promise<{ end: "clean" | "cut" | "fatal"; retryAfterMs?: number }>;
  participated?(ctx: AccountContext, days: number): Promise<string[]>;
  context?(ctx: AccountContext, key: string, opts: { since?: number; max: number }): Promise<ContextResult>;
  act?(ctx: AccountContext, input: ActInput): Promise<ActResult>;
  undo?(ctx: AccountContext, token: string): Promise<ActResult>;
  /** Pure: no network, no state. */
  links: {
    parse(url: string, account: Account): { key: string; id?: string } | null;
    of(key: string, account: Account): string | null;
    /** An app link (`slack://…`) for a https link, when the tool has a desktop app. */
    deep?(url: string, identity: Identity): string | null;
  };
  /** Pure. A legacy free-text destination (`draftTo`) to a target, or why it cannot be resolved. */
  parseTarget?(text: string, topicKey: string, account: Account): Target | { error: Text };
  /** Pure. The triage rules of an account, from its settings and identity (section 7). */
  triageRules(account: Account, identity: Identity): TriageRules;
  /** Pure. Display helpers: the tool's markup to plain text and to safe HTML for the board. */
  render?: { plain(text: string): string; html(text: string): string };
}
```

`defineProvider(p: Provider): Provider` is the identity function, so an author gets type checking without importing anything at runtime.

### 4.10 What Strato gives a provider

```ts
export interface AccountContext {
  account: Account;
  identity: Identity | null;
  /** A secret of this account only, from its secret file or its accepted environment variables. */
  secret(name: string): string | null;
  /** Persists a refreshed secret (OAuth) in this account's secret file. */
  setSecret(name: string, value: string): void;
  /** fetch with a timeout and the abort signal; replaced by a fixture server in tests and in the harness. */
  fetch: typeof fetch;
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
  /** Small JSON files in this account's own folder, `<state>/providers/<provider>-<account>/`. */
  store: { read<T>(name: string, fallback: T): T; write(name: string, value: unknown): void };
  signal: AbortSignal;
  locale: "en" | "fr";
}
```

A provider never receives the state folder path, other accounts' secrets, the topics, nor a way to start a session.

### 4.11 Lifecycle

1. **Load.** At startup the registry resolves accounts from `config.json` (section 6), loads the built-ins, and loads external providers only when an account uses them.
2. **Connect.** `connect` runs lazily, at the first use of an account; `doctor` and `setup --check` call it explicitly.
   A fatal error marks the account down; the board and `doctor` say so, with the setup command to run.
3. **Ingest.** `listen` subscribes to every push account and polls the others; `watch` polls every account.
   A push account is also polled every 5 minutes and on wake from sleep, because a dead push connection says nothing (today's catch-up through `search.messages`).
   Items go through one triage (section 7), one dedup, one log.
4. **Context.** Sessions, the panel, `dive` and the card sweep read a thread through `context`, cached 60 s per key as the panel does today.
5. **Act.** Only `app/act.ts` calls `act` and `undo`, after the gate (section 8).
6. **Links.** `links.parse` turns a pasted link into a key (`open`, `attach`, the ⌘K bar, transcript citations); `links.of` turns a key into a link (board, panel, cards); `deep` opens the desktop app.
7. **Rendering.** `render.plain` for event lines and prompts, `render.html` for the board's draft preview (today `humanize` and `slackToHtml`).
8. **Prompt vocabulary.** The descriptor's `vocabulary` fills the template variables of section 10.

## 5. Item keys

### 5.1 Format

```
key          = legacy-slack / qualified
legacy-slack = channel ":" ts                       ; C0ACME0001:1759219200.000100, Slack, default account
qualified    = provider [ "@" account ] ":" native  ; linear:PLAT-12, slack@partners:C0ACME0002:1759219200.000300
provider     = lowercase letter, then lowercase letters, digits, "-"
account      = lowercase letters, digits, "-" (the default account is never written)
native       = 1*( ALPHA / DIGIT / "." / "_" / "~" / ":" / "/" / "+" / "=" / "@" / "," / "-" / pct-encoded )
```

A key starting with an uppercase letter or a digit and matching `^[A-Z0-9]+:\d{10}\.\d{6}$` is a legacy Slack key on the default account.
Provider ids are lowercase and Slack conversation ids are uppercase, so the two never collide.
`linear:PLAT-12`, the ticket key Strato writes today, is already a qualified key on the default Linear account.

| Key | Provider | Account | Native |
| --- | --- | --- | --- |
| `C0ACME0001:1759219200.000100` | slack | default | `C0ACME0001:1759219200.000100` |
| `slack@partners:C0ACME0002:1759219200.000300` | slack | partners | `C0ACME0002:1759219200.000300` |
| `linear:PLAT-12` | linear | default | `PLAT-12` |
| `mail@work:%3Cq3f9@mail.example%3E` | mail | work | `<q3f9@mail.example>` |

`core/keys.ts` gains `parseKey(key) -> { provider, account, native, legacy }`, `formatKey(provider, account, native)` and `canonicalKey(ref)`; `isTicketKey`, `ticketKey`, `threadOfKey` and `sujetKey` keep their signatures and behavior.

### 5.2 Escaping and limits

Keys travel in shell command lines typed by the master and by sessions (`strato set <key> …`, `relay <key>`), unquoted.
So a key may only contain characters that a POSIX shell reads literally inside a word.
Everything else in a native id is percent-encoded as UTF-8 bytes, `%` included (`%25`).
This also keeps a hostile id out of a shell: an email `Message-ID` written by a third party as `<$(id)@x>` becomes `%3C%24%28id%29@x%3E`.

A key is at most 200 characters.
A longer native id is replaced by `~` and the first 26 characters of the base32 SHA-256 of the native id, and the provider keeps the mapping in its account folder (`keys.json`) to resolve it back.

A provider returning an item whose key or id does not parse, or does not belong to the provider and account that returned it, sees the item rejected and logged; it never reaches triage.

### 5.3 Legacy keys

- A bare Slack key is read as Slack on the default account, everywhere: `sujets.json`, `seen.json`, `events.ndjson`, `snooze.json`, report names, the master's lines, the hooks of running sessions.
- The default Slack account's canonical form is the bare form: new Slack items of the default account keep producing bare keys, byte for byte as today.
- `linear:ABC-123` stays the canonical key of a ticket on the default Linear account.
- `seen.json` keeps holding the default Slack account's item ids (`channel:ts` of each message) with its 3-day purge; other accounts keep their dedup ids, with their time, in `<state>/providers/<provider>-<account>/seen.json` as `{ id: unixMs }`, because `saveSeen` reads the `ts` part of a bare id as a time and could not purge other shapes.

### 5.4 Stored keys are never rewritten

Recommendation: never rewrite a stored key, not even lazily.

- Nothing needs it: the canonical form of every key that exists on disk today is exactly its stored form.
- Running sessions carry their topic key in their prompt and in their hooks' commands (`strato set C0ACME0001:… status=…`); a rewritten key would make their writes fail with "topic not found".
- `strato update --rollback` puts the previous binary back on the same state folder: it must still read every key.
- `events.ndjson` is an append-only log; rewriting it is a full-file rewrite racing with the listener, the board and the sessions.
- When a key genuinely changes outside Strato (a Linear issue moved to another team, `PLAT-12` becoming `OPS-40`), the new key is attached to the topic (`attachThread`), the old one stays: additive, and the history says why.

### 5.5 Report and upload names

`reportFile(key)` keeps its result for bare Slack keys and `linear:` keys, so existing reports stay where sessions write them.
For any other key, the sanitized name gets a 6-character hash suffix (`slack_partners_C0ACME0002_1759219200.000300-3f9a1c.md`), because sanitizing alone can map two keys to one file.

### 5.6 Unknown providers in stored keys

A key whose provider is not configured (an account removed from the profile, a provider renamed) is kept as is: shown raw on the board, never read, never acted on.
`doctor` lists the topics that carry one, with the provider id.

## 6. Config schema

### 6.1 The `providers` section

```json
{
  "owner": { "name": "Alice", "role": "developer" },
  "slack": {
    "team": "Acme",
    "workspace": "acme",
    "me": "U0ALICE0001",
    "subteams": ["S0ACMEPLAT"],
    "teamAlias": "@platform",
    "watchChannels": ["C0ACMEREQ01"],
    "userTokenFile": "~/.config/strato/acme.env",
    "appTokenFile": "~/.config/strato/acme.env"
  },
  "tracker": { "kind": "linear", "workspace": "acme", "prefixes": ["PLAT", "OPS"] },
  "providers": {
    "linear": {
      "accounts": {
        "default": {
          "auth": "api-key",
          "secretsFile": "~/.config/strato/linear-default.env",
          "watchTeams": ["PLAT"],
          "ignoreAuthors": ["Deploy Bot"]
        }
      }
    },
    "slack": {
      "accounts": {
        "partners": {
          "auth": "user-token",
          "secretsFile": "~/.config/strato/slack-partners.env",
          "team": "Acme Partners",
          "workspace": "acme-partners",
          "me": "U0ALICE0P01",
          "ingest": "poll"
        }
      }
    },
    "maildir": {
      "source": { "module": "~/.config/strato/providers/maildir/provider.ts", "sha256": "9f2c…" },
      "accounts": { "default": { "auth": "none", "path": "~/Mail/acme" } }
    },
    "tickets": {
      "source": { "exec": ["python3", "~/.config/strato/providers/tickets/provider.py"], "sha256": "41aa…" },
      "accounts": { "default": { "auth": "api-key", "baseUrl": "https://tickets.example" } }
    }
  }
}
```

Per account, these keys are reserved and handled by the core; every other key is a provider setting, validated against the descriptor.

| Key | Default | Meaning |
| --- | --- | --- |
| `auth` | the provider's first method | The auth method id |
| `secretsFile` | `~/.config/strato/<provider>-<account>.env` | `KEY=value` file, mode 600, holding this account's secrets |
| `ingest` | `push` when available, else `poll` | `off` makes the account a target only |
| `enabled` | `true` | `false` keeps the account in the file without loading it |
| `label` | the identity's workspace | How the board and `doctor` name it |
| `pollInterval` | 60 | Seconds between polls |
| `mcpServer` | the descriptor's `mcp.server` | The name of the matching MCP server in the workspace's `.mcp.json`, for the session permissions |

`source` exists only for external providers (section 13): `module` or `exec`, and the trusted `sha256`.
`auth: "none"` is accepted only for a provider that declares no auth method (a local folder).

### 6.2 How the legacy sections map

| In `config.json` today | Read as | Written by setup |
| --- | --- | --- |
| `slack` section, or the legacy flat keys at the root (`LEGACY_SLACK`) | The default Slack account's settings | Still `slack`, as today |
| `slack.userTokenFile`, `STRATO_SLACK_TOKEN`, `SLACK_MCP_XOXP_TOKEN` in the workspace files | The default Slack account's `SLACK_USER_TOKEN`, in today's search order | `setup --token`, unchanged |
| `slack.appTokenFile`, `SLACK_APP_TOKEN` | The default Slack account's push secret | `setup --app-token`, unchanged |
| `tracker` with `kind: "linear"` | The default Linear account's link settings (`workspace`, `prefixes`); without `providers.linear.accounts.default`, a links-only account: no auth, no ingest, no act, exactly today's behavior | Still `tracker` |
| `tracker: null` | No Linear account, unless `providers.linear` has one | |
| `forge` | Unchanged: the merge request tracker (section 12.3) | Still `forge` |
| `ui.slackApp` | The Slack provider's deep-link preference | Still `ui` |
| `workers.allow` | Unchanged; the per-provider read tools are added to it (section 9) | |

`providers.slack.accounts.default` is refused while a `slack` section or flat keys exist: one place per account, so a field is never set in two places with two values.
The same holds for `providers.linear.accounts.default` link fields (`workspace`, `prefixes`) when `tracker` is set; its other fields (`auth`, `watchTeams`…) live under `providers.linear.accounts.default`.
No profile is migrated: an installation that never touches setup keeps its file byte for byte.

### 6.3 Defaults

- `providers`: `{}`.
- A profile needs at least one source account (an account whose `ingest` is not `off`); the default Slack account counts as soon as the `slack` section names `team` or `me`, or a Slack token is found, as today.
- `missingSettings` asks for the Slack fields only when the default Slack account is in use, and for `auth` and the identity of each account otherwise: a person with Linear only is not asked for `slack.me`.
- `owner.role`: `developer`.
- `workers.gate`: `strict` in a profile Strato creates (`NEW_INSTALL_PROFILE`), `legacy` when the key is absent from an older profile, following the pattern already used for `workers.shadow` (section 8.6).

### 6.4 Validation messages

`profileErrors` (`core/setup.ts`) learns the `providers` section; `setup --write` refuses the whole file on any error, as today.
New messages go through `core/i18n.ts` under `cli.setup.*`, in English and French.

| Input | Message |
| --- | --- |
| `providers.slack.accounts.default` next to a `slack` section | `providers.slack.accounts.default: the default Slack account lives in the "slack" section; keep one of the two` |
| `"auth": "oauth"` for Linear | `providers.linear.accounts.default.auth: "oauth" is not an auth method of linear (api-key, oauth-pkce)` |
| Account `Work` | `providers.linear.accounts.Work: an account name is lowercase letters, digits and dashes` |
| `watchTeam` | `providers.linear.accounts.default.watchTeam: unknown field (known: watchTeams, ignoreAuthors, pollInterval, …)` |
| `providers.tickets` without `source` | `providers.tickets: unknown provider (built in: slack, linear); an external provider needs source.module or source.exec` |
| `apiKey` in an account | `providers.linear.accounts.default.apiKey: a secret never goes in config.json; strato setup --connect linear stores it in a file only you can read` |
| Module changed since trusted | `providers.maildir.source: the file changed since you trusted it (sha256 9f2c… expected); read it, then strato provider trust maildir` |
| No source account | `no source: connect at least one tool (strato setup --connect slack, or --connect linear)` |

## 7. Triage

Triage decides, for each item, whether it is ignored, set aside for the digest, or raised to the master, and under which `<type>`.
Today it is `classify` (`chat/slack-model.ts`:221) on a `SlackMatch` with a `Config` picked from `SlackSettings`.

### 7.1 What stays in the core

`core/triage.ts` holds the rules, pure, on `Item` and `TriageRules`:

```ts
export interface TriageRules {
  /** Conversations where every item is a request (Slack watchChannels, Linear watchTeams). */
  watch: string[];
  /** Conversations never raised. */
  ignore: string[];
  /** Display names whose items outside a topic go to the digest (bots). */
  ignoreAuthors: string[];
  /** Display names of the teammates: one of them answering takes the topic over. */
  teammates: string[];
}

export type Kind = "suite" | "moi" | "dm" | "mention" | "canal" | "fil" | "tiers" | "bot";

export function classifyItem(item: Item, rules: TriageRules, tracked: Set<string>, participated: Set<string>): Kind | null;
```

The order is today's, unchanged: a tracked thread gives `moi` or `suite`; the person's own item elsewhere is ignored; an ignored conversation is ignored; then `dm` (or `tiers` in a group DM that targets someone else), `mention`, `canal` (or `tiers`), `fil` (or `tiers`); an `ignoreAuthors` author turns a kept item into `bot`.
Also in the core: deduplication per account, the edit rule (an edit is raised only when it adds a mention and its previous version was not raised), the digest of `tiers` and `bot`, the takeover by a teammate (`takenBy`), the closing of a draft task when the person posts its text by hand (`draftMatches`), the one-line-per-event output and the `msg=<id>` inbox.
`classify` stays exported with its signature: it builds the `Item` and the rules from a `SlackMatch` and a `Config`, then calls `classifyItem`, so every existing triage test keeps running.

No new `<type>` is added to the master's protocol: providers map their signals onto the existing ones.

### 7.2 What providers supply

- The facts on each item: `conversation.kind`, `author.isMe`, `author.isBot`, `mentionsMe` (including group mentions and assignments), `targetsOther`, `edited`.
- The participated threads (`participated`), when the tool can tell them.
- `triageRules(account, identity)`: the core rules filled from the account's settings.

### 7.3 Rules per provider

| Signal | Slack (as today) | Linear |
| --- | --- | --- |
| `dm` | DM, or group DM not targeting someone else | not used |
| `mention` | `<@me>` or a group of `subteams`, in text, attachments or blocks | the person is assigned, or mentioned in a description or a comment (notifications) |
| `canal` | any message in `watchChannels` | an issue created in `watchTeams` (or a watched project) |
| `fil` | a reply in a thread the person wrote in during the last 7 days | a new comment on an issue the person created, commented or subscribed to |
| `suite` / `moi` | a message in a tracked thread | a comment or a status change on a tracked issue; the person's own comment is `moi` |
| `tiers` | explicitly targets someone else | a comment that mentions someone else only, on a watched or subscribed issue |
| `bot` | author in `ignoreAuthors` | author in `ignoreAuthors` (integrations, automations) |
| ignored | `ignoreChannels`, edits that add nothing | `ignoreTeams`, status changes on untracked issues |

The event line names the conversation with its label (`#support`, `Linear PLAT`), so the master reads the same line shape for every provider.
`eventLine` (`core/cards.ts`) stops reading a channel from `key.split(":")[0]` and uses the item's conversation id to list the open topics of the same conversation.

## 8. The gate and safety

### 8.1 What the gate protects against

- A work session steered by text a third party wrote (prompt injection) that would post, comment or change a status in the person's name.
- A text that changed between what the person read and what goes out (a session editing a draft while the person reads it).
- Anything leaving in shadow mode.
- A double write (double click, two tabs, a retry after a timeout).

It does not protect against code that runs with the person's privileges and decides to bypass Strato: a session with an unrestricted shell, or a malicious external provider.
Strato's gate is a property of Strato's own code paths and of the Claude Code permissions it sets, not a sandbox.

### 8.2 One act path

`app/act.ts` exports one function, and it is the only module that calls `Provider.act` and `Provider.undo`:

```ts
/** The outcome is the provider's ActResult, plus the task's state once written. */
export async function act(req: { topic: string; task: string; sha: string; by: "board" | "master" }): Promise<ActOutcome>;
```

It runs these steps in this order.
Steps 1 to 6 read and mark the task under the state lock; the provider call runs outside the lock, which is never held during a network call (`LOCK_STALE_MS` is 30 s); step 8 or 9 writes the result under the lock again, on the topic reread from disk.

1. Shadow mode as `config.json` says now (`shadowNow`): refused, whoever asks.
2. The topic exists and is open; the task exists, is open, and resolves to an action plan (a structured `act` task, or a draft whose destination the provider's `parseTarget` resolves).
3. The provider and account are configured, connected, and declare every action kind of the plan.
4. `core/gate.ts` computes the canonical content of the plan (sorted JSON of account, kind, target and every payload field, texts normalized as `taskDraftText` does) and its SHA-256; it must equal `sha`.
5. `postOnlyAction` and `sendsUnseenMessage` still apply: a plan never carries a message the person has not read.
6. The task is marked "in flight" so a second request on it is refused until the outcome is known.
7. The provider's `act` runs with `idempotencyKey = <topic>#<task>#<sha 12 hex>`.
8. On success: the task is done with the link, the topic follows (`waiting` when no task is left), the undo window opens, the session is told after it (as the board does today with `notify`).
9. On failure: the task stays open with the provider's message; an `outcome: "unknown"` failure is never retried automatically and the board says "may have gone out: check <link>".

The board's ✅ has no task: the server builds a one-action plan (the provider's done marker on the topic's main item, `checkable` still required) and calls the same function, the click being the Go on that plan.

The registry never exposes `act` on the provider objects it hands to other modules: it hands out a view without `act` and `undo`, and a test asserts that `app/act.ts` is the only importer of the full objects.

### 8.3 Go on exact content

A task that the core can carry out shows, on the board, the full plan: each action, its target label and link, and the text as it will go out.
The page sends back what it showed (as `draftConflict` does today for drafts, `board.ts`:854); the server recomputes the hash from the task on disk and refuses on any difference, so the person always approves the bytes that go out.
An edited draft on the board is the person's own text: the server builds the plan from it and hashes that.
`strato card <topic>` prints, for each such task, the plan and its hash (12 hex characters), which is what the master quotes back to `strato act`.

### 8.4 Who can give a Go

| Origin | How | Accepted |
| --- | --- | --- |
| Board | Send, Go, ✅ or Undo, a POST with the board's origin (`server/guard.ts`) | yes |
| Master | the person says "A send" in the master's conversation; the master shows the exact text if the person has not seen it, then runs `strato act A t1 --sha <hash>` | yes |
| Work session | a session calling `strato act` | no: refused when `STRATO_CALLER=session` is in its environment (set by `workerSettings`), and `Bash(<strato> act *)` is a deny rule in its settings |

A go typed by the person inside a work session (terminal, claude.ai) still exists: in strict mode the session answers that the task is ready and the person presses Go on the board or tells the master; in legacy mode it carries the action out itself, as today.
Deny rules are evaluated before the permission mode in Claude Code, so they also hold with `--dangerously-skip-permissions`; they match the command as written, so they are a second lock, not the only one.

### 8.5 Shadow mode

Three locks, any one of them enough: the gate refuses every act (step 1); the board shows no Send and no Go (today); every prompt carries `shadowRule` (today).
In strict mode, the provider write tools of the sessions' MCP servers are denied as well, from the start.

### 8.6 Strict and legacy gate modes

| | `legacy` (existing profiles without the key) | `strict` (new profiles, or `setup --strict-gate`) |
| --- | --- | --- |
| Board Send, Undo, ✅ | through the act path | through the act path |
| Board Go on a provider task | through the act path | through the act path |
| Board Go on another task (a command, a merge) | sent to the session | sent to the session |
| Sessions' MCP write tools of configured providers | allowed, as today | denied (`permissions.deny`, from the descriptor's `mcp.writeTools` and the account's `mcpServer`) |
| A go typed inside a session | the session acts itself, as today | the session points to the board or the master |
| Ticket comments without a go | as the policy says (today: allowed) | always a task, approved by a Go |

`legacy` keeps every existing installation working with no manual step; the invariant holds for everything Strato itself writes.
`strict` extends it to the sessions' sanctioned tools.
`doctor` prints the mode and, in `legacy`, the one command that turns `strict` on.

### 8.7 Audit

Every attempt is a line in `events.ndjson`:

```json
{"at":"2026-10-01T09:12:03.120Z","type":"act","by":"board","key":"C0ACME0001:1759219200.000100","task":"t2","account":"slack","kinds":["reply","react"],"sha":"3f9a1c0be27d","ok":true,"link":"https://acme.slack.com/archives/C0ACME0001/p1759309923000200"}
{"at":"2026-10-01T09:14:40.001Z","type":"act-refused","by":"master","key":"linear:PLAT-12","task":"t1","reason":"sha"}
{"at":"2026-10-01T09:12:20.500Z","type":"act-undo","by":"board","key":"C0ACME0001:1759219200.000100","task":"t2","ok":true}
```

The text itself stays in the task, not in the log: the log carries the hash, so a text can be proven without copying third-party content twice.
The board's existing events (`board-post`, `board-unpost`, `board-check`) keep being written for Slack, so an older binary after a rollback still reads its history.

### 8.8 Undo

Undo is offered when the provider declares the action kind in `capabilities.undo`, during `undoMs`.

| Provider | Undo |
| --- | --- |
| Slack | reply and post: `chat.delete` within 30 s (today); react: `reactions.remove` |
| Linear | comment and reply: delete the comment; setStatus and assign: restore the previous value read before the act; react: remove the reaction |
| External | what the provider declares |

The click on Undo is the person's Go on the undo; it goes through the same path and is logged.

### 8.9 Failures and retries

Ingest, context and links retry with backoff.
An act is never retried by Strato after a failure whose outcome is unknown, unless the provider supports the idempotency key; the person decides.

## 9. How sessions read context

Two ways exist, and they are not exclusive.

| | `strato context` | MCP server of the tool |
| --- | --- | --- |
| Works for | every provider with `context` | only tools with an MCP server configured in the workspace |
| Credentials | the account Strato already uses | a second configuration, often a second token |
| Third-party text | neutralized by the core (`untrusted`), framed as data | raw |
| Writes | none | present: must be denied by permissions |
| Tests | offline, through the provider fixtures | not testable by Strato |
| Breadth | the topic's threads | search, users, everything the server offers |

Decision: the default prompts point sessions to `strato context`, and MCP read tools stay allowed as an extra.

```
strato context <topic | key | link> [--since 2h] [--max 200]
```

It prints each thread of the topic (or the one named), oldest first: a header line with the provider, the conversation label, the title and the link, then one block per item, `[time] author: text`, every third-party string passed through `untrusted()` and the whole framed by the sentence of `untrustedRule`.
It is a read: `Bash(<strato> *)` already allows it, and it needs no new permission.
The master uses it too, inside its three-read budget, in place of the Slack MCP's `conversations_replies`.

Allowed tools per provider, added by `workerSettings` for each configured account whose `mcpServer` exists in the workspace:

| Provider | Read tools (allowed) | Write tools (denied in strict mode) |
| --- | --- | --- |
| Slack | `conversations_replies`, `conversations_history`, `conversations_search_messages` (today) | `conversations_add_message`, and every reaction or edit tool the server exposes |
| Linear | `get_issue`, `list_issues`, `list_comments`, `get_team`, `list_teams`, `list_users`, `get_user` | `save_issue`, `save_comment`, `delete_comment`, `create_attachment` and the other `save_*` and `delete_*` tools |
| External | `mcp.readTools` | `mcp.writeTools` |

Rules use the account's `mcpServer` name: `mcp__<server>__<tool>`.
The legacy Slack read rules stay in the list whatever the profile, so sessions started from old prompts keep reading their threads.

## 10. Prompts

### 10.1 Vocabulary variables

`baseVars()` (`policy/prompts.ts`) gains variables that are always defined, empty when they do not apply, so `renderTemplate` never meets an unknown one.
They describe the topic's main key, and are English, like every prompt.

| Variable | Slack topic | Linear topic |
| --- | --- | --- |
| `source` | `Slack` | `Linear` |
| `thread_word` | `thread` | `ticket` |
| `conversation_word` | `channel` | `team` |
| `item_word` | `message` | `comment` |
| `read_thread` | `strato context C0ACME0001:1759219200.000100 (or the Slack MCP, conversations_replies)` | `strato context linear:PLAT-12` |
| `target_format` | the `draftTo` sentence of `card-style.md`:14 | `to=linear:PLAT-12 (a comment on the ticket)` |
| `done_marker` | `the ✅ reaction on the original message` | empty |
| `is_chat`, `is_ticket`, `is_mail` | `yes` or empty, for `{{#if}}` blocks | |

Values are computed by the code with the topic's real key and command: an inserted value is never read again by `renderTemplate`, so a value cannot carry `{{key}}`.
`team_group` keeps reading `slack.teamAlias`, and becomes the default account's group alias of whichever provider has one.

### 10.2 Templates

The shipped defaults use the variables instead of naming Slack: `worker.md` step 1 becomes "Read the whole {{thread_word}} before anything else: {{read_thread}}"; `card-style.md` uses `{{target_format}}`; `execution-rule.md` mentions `{{done_marker}}` inside `{{#if done_marker}}`.
`card_command` (code) learns the structured task fields: `to=<key, link or conversation>`, `act=<reply|post|comment|react|setStatus|assign|create>`, `value=<emoji, status or assignee>`.
`draftTo` keeps being accepted and resolved by the provider's `parseTarget`.

A topic opened from an ingested item (`open --msg`) always uses `worker.md`, whatever the provider: a Linear mention is a request to answer.
A topic opened by the master from a ticket id without a message (`open PLAT-12`) keeps using `ticket.md`, the implementation flow, for the developer role.

### 10.3 Existing overrides

A template in `<state>/policy/` predates the variables and names Slack literally.
It keeps working unchanged for Slack topics, which is what it was written for.
For a topic of another provider, the code appends a context rule after the template, as it already appends `untrustedRule` and `shadowRule`: "This topic comes from Linear: read it with `strato context linear:PLAT-12`; a draft's destination is written as …".
`doctor` names each overridden template and says whether it uses the new variables.
French overrides, `{{#si}}` blocks, `bun {{script}}` and the elided forms `d_owner` and `qu_owner` stay supported.

## 11. Setup

### 11.1 Per-provider setup modules

Each provider ships a setup module next to it:

```ts
export interface SetupModule {
  /** What can be guessed with the account's secrets, read only: identity, groups, active conversations. */
  detect?(ctx: AccountContext): Promise<Record<string, Detected>>;
  /** The interview questions specific to this tool, with where each answer goes. */
  interview: { ask: Text; goesTo: string; candidatesFrom?: string }[];
  /** `setup --check` and `doctor` lines for this account. */
  check(ctx: AccountContext): Promise<CheckItem[]>;
}
```

`setup --detect` merges the fields of every configured account under their path (`providers.linear.accounts.default.watchTeams`), with the existing `fields`, `suggested` and `notes` shape; the Slack fields keep their current paths (`slack.me`…).

### 11.2 Auth flows, official only

```
strato setup --connect <provider> [--account <name>] [--auth <method>]
```

It walks the method's steps: open the documented page, read the secret on stdin without echo (or run the OAuth flow), `verify` with `connect`, then store the secret and write the account into `config.json` through the same `writeProfile` as `setup --write`, diff printed.
`setup --token` and `setup --app-token` stay, as the Slack user-token method of the default account.

| Kind | What the person does | Notes |
| --- | --- | --- |
| `user-token` | Creates their own app from a manifest, installs it, pastes the token | Slack today |
| `api-key` | Creates a personal API key in the tool's settings, pastes it | Linear |
| `oauth2-pkce` | Approves in the browser; Strato listens on `127.0.0.1` on a free port for the redirect | S256 challenge, `state` checked, one-shot listener closed after the code or after 5 minutes, never ports 4343 or 4344 |
| `app-password` | Creates an app password in the account's security page, pastes it | Future mail providers |

Never implemented: reading cookies or tokens from a browser, from a desktop app's storage, or from another application's files.
The legacy Slack sources in the workspace's `.claude/settings.local.json` and `.mcp.json` stay, because they are configuration files the person wrote for their own MCP server, with a token of their own app.

### 11.3 Secret storage

- One file per account, `~/.config/strato/<provider>-<account>.env` by default, folder 700, file 600, `KEY=value` lines, written by `storeSecret` (`commands/setup.ts`) generalized into `app/secrets.ts`.
- The default Slack account keeps its current file and its search order.
- Refreshed OAuth tokens are rewritten in place, atomically (write then rename).
- A secret is never printed (masked as `xoxp-…ab12`), never in `config.json`, never in a prompt, never in a session's environment, never in a provider log line (the host masks known secret values).
- An exec provider receives its secrets in its `initialize` message on stdin, not in its environment or arguments.
- The operating system keychain is an open question (section 16).

### 11.4 Doctor lines

`doctor` prints one line per account, after the profile and owner lines:

```
slack    : Acme (default) · you are U0ALICE0001 · user token ~/.config/strato/acme.env · socket: app token found
slack    : Acme Partners (partners) · you are U0ALICE0P01 · polling every 60 s
linear   : acme (default) · api key · you are alice · polling every 60 s · 2,431 requests left this hour
maildir  : external module ~/.config/strato/providers/maildir/provider.ts · trusted · last poll 09:12
gate     : strict · shadow mode: nothing is posted (setup --live)
```

A down account prints its reason and the one command that fixes it; exit code 78 only when no source account can connect.

### 11.5 The guided interview

SKILL.md's block "f. Tracker and forge" becomes "f. Your tools", and a block "a2. Your role" joins "a. Who you are".

1. Which tools do requests reach you through, and which tools do you answer in?
   Detection proposes what it found (a Slack token, a Linear MCP server, git remotes).
2. For each tool, how to connect it: the methods of the descriptor with their trade-off in one sentence each, the default first.
3. The tool's own questions from its setup module (Slack: channels to watch, groups; Linear: teams to watch, bots to ignore).
4. The rehearsal (`backlog --since 24h`) covers every source account.

## 12. Built-in providers

### 12.1 Slack

The current code, behind the interface; nothing changes for a person using it today.

| Capability | Slack |
| --- | --- |
| Ingest, push | Socket Mode with an app-level token (`xapp-`) of a per-person app |
| Ingest, poll | `search.messages` with the user token; the search index lags up to a minute or two |
| Participation | `search.messages from:<@me>`, 7 days |
| Context | `conversations.replies`, paged up to 2,000 messages |
| Identity | `auth.test`, `users.info`, `usergroups.list` |
| Actions | `reply`, `post`, `react`, `delete` (own messages) |
| Undo | `reply` and `post` (delete within 30 s), `react` (`reactions.remove`) |
| Edits | `message_changed` that adds a mention |
| Links | permalinks, `slack://` deep links |
| Rendering | mrkdwn to plain text (`humanize`), to HTML (`slackToHtml`) |
| Limits | 3,900 characters per message (`DRAFT_MAX`) |

| Auth method | What the person does | Stores |
| --- | --- | --- |
| `user-token` (default) | Creates the app from `examples/slack-app-manifest.yaml`, installs it, pastes the User OAuth Token in `setup --token` | `SLACK_USER_TOKEN` |
| `oauth-pkce` | Creates the same app with PKCE and a loopback redirect enabled, runs `setup --connect slack --auth oauth-pkce`, approves in the browser | `SLACK_USER_TOKEN` |
| App-level token, add-on of either | Generates the `xapp-` token in the app's Basic Information | `SLACK_APP_TOKEN` |

PKCE spares the copy and paste of a token; Slack supports it for desktop apps on a loopback redirect, with user scopes only, which is all Strato asks for.

Which app, and why:

| App model | Rate limits | Socket Mode | App slots | Verdict |
| --- | --- | --- | --- | --- |
| Per-person app (today) | full | yes | one per person; a free workspace allows at most 10 apps | the default |
| One internal app for a team, each person connecting with PKCE | full, the app is not distributed (to confirm in the setup stage) | not for two people: Slack spreads the payloads of one app across its open connections, so each listener would miss the others' events | one | the fallback on a crowded free workspace: polling only |
| A distributed app published by the project | `conversations.history` and `conversations.replies` at 1 request per minute and 15 objects unless Marketplace-approved (`search.messages` is not affected) | yes | one | refused: context reads and the catch-up would starve |

### 12.2 Linear

New: today Linear is only recognized in links.

| Capability | Linear |
| --- | --- |
| Ingest, push | no: webhooks need a public HTTPS endpoint, out of scope on a laptop |
| Ingest, poll | the person's notifications (GraphQL), plus issues updated in `watchTeams`; cursor = last notification and update time read |
| Participation | issues the person created, commented on or subscribed to |
| Context | the issue (title, description, status, assignee, labels, priority) and its comments, threaded |
| Identity | the `viewer` query |
| Actions | `comment`, `reply` (in a comment thread), `react`, `setStatus`, `assign`, `create`, `delete` (own comment) |
| Undo | `comment` and `reply` (delete), `setStatus` and `assign` (previous value), `react` (remove) |
| Edits | no |
| Links | `https://linear.app/<workspace>/issue/<ID>[/<slug>][#comment-<id>]`; issue key `linear:<ID>`, comment id `linear:<ID>/comment/<id>` |
| Rendering | Markdown to plain text and to HTML |

| Auth method | What the person does | Stores | Facts from Linear's documentation |
| --- | --- | --- | --- |
| `api-key` (default) | Creates a personal API key in Settings, Security & access, pastes it | `LINEAR_API_KEY` | Header `Authorization: <key>`, without `Bearer`; 2,500 requests and 3,000,000 complexity points per hour |
| `oauth-pkce` | Creates an OAuth application in their Linear workspace with a loopback redirect, runs `setup --connect linear --auth oauth-pkce` | `LINEAR_ACCESS_TOKEN`, `LINEAR_REFRESH_TOKEN` | PKCE supported, client secret optional with PKCE; authorize at `https://linear.app/oauth/authorize`, token at `https://api.linear.app/oauth/token`; access token valid 24 hours, refresh token; header `Authorization: Bearer <token>`; 5,000 requests per hour; scopes `read`, `write`, or narrower `comments:create`, `issues:create` |

A poll every 60 seconds costs one notifications query plus one query per watched team: about 60 to 180 requests an hour, far below both limits.
Writes that create (`commentCreate`, `issueCreate`) pass an id derived from the idempotency key, so a replay after an unknown outcome cannot create twice (the accepted id format is to be checked against the schema in the linear stage).
Notification type names and the exact GraphQL shapes are pinned from Linear's schema in the linear stage, with recorded fixtures.

Without `providers.linear.accounts.default`, the `tracker` section keeps giving exactly today's behavior: links and prefixes recognized, ticket topics opened by the master, sessions reading the ticket through the Linear MCP.

### 12.3 GitLab, the forge

The forge stays what it is: the merge request tracker behind the board's delivery line (`forge/mr.ts`, `app/gitlab.ts`), configured by the `forge` section, read through `glab api`.
It is not a provider in these nine stages, because its job (following a merge request to production) is not the loop of items, topics and actions.

Its path towards a provider, as follow-up work:

1. The delivery tracker reads its token through `app/secrets.ts`, keeping `GITLAB_TOKEN` and the existing keychain fallback as legacy sources.
2. A `gitlab` provider of kind `forge`: ingest from the To-Do list API (review requests, mentions in merge request notes), context = description and discussions, actions `comment` and, behind a Go, `merge` towards the integration branch.
3. The `forge` section reads as `providers.gitlab.accounts.default`, under the same one-place rule as `slack`.
4. A GitHub provider with the same capabilities (notifications API), which also gives the board a delivery line for pull requests.

Until then, pushing a feature branch and opening a merge request stay session work governed by the policy (section 16, first open question).

## 13. External providers

An external provider is configured in `providers.<id>.source` and loaded only when an account uses it.

### 13.1 TypeScript modules

```json
"maildir": { "source": { "module": "~/.config/strato/providers/maildir/provider.ts", "sha256": "9f2c…" } }
```

The registry checks the file's SHA-256, then `await import()` of its absolute file URL: a binary built with `bun build --compile` imports and runs a `.ts` file from disk at runtime, without Bun installed.
The module's default export is a `Provider` (usually `defineProvider({...})`).
It imports Strato's types only (`import type … from "./strato-provider.d.ts"`): every runtime helper comes through `AccountContext`, so the module never depends on Strato's internal files.
Third-party packages are not supported in a module (resolution from a compiled binary is not guaranteed); a provider that needs them uses the exec shape.

### 13.2 The exec protocol

```json
"tickets": { "source": { "exec": ["python3", "~/.config/strato/providers/tickets/provider.py"], "sha256": "41aa…" } }
```

Strato starts the command per account (argv, no shell), with the provider's folder as working directory and a minimal environment (`PATH`, `HOME`, `LANG`, `TZ`, `STRATO_PROVIDER_PROTOCOL=1`).
The `sha256` covers the file named after the interpreter (or the executable itself).
The command line comes from `config.json` only: no key, item text or other provider output is ever placed in an argument or an environment variable; everything travels as JSON on stdin and stdout.

**Framing.** JSON-RPC 2.0 messages, one per line, UTF-8, on the child's stdin and stdout; a line is at most 4 MiB.
Stdout carries protocol messages only: a line that is not a JSON-RPC message is a protocol error, logged, and the process is restarted.
Stderr is free text, captured as the provider's log.

**Requests from Strato.**

| Method | Params | Result |
| --- | --- | --- |
| `initialize` | `{ protocols: [1], strato: "0.2.0", locale, account: { id, label, settings }, secrets: { NAME: value }, offline: false }` | `{ protocol: 1, descriptor }` |
| `connect` | `{}` | `Identity` |
| `poll` | `{ cursor, since, maxItems }` | `PollResult` |
| `subscribe` | `{}` | `{ ok: true }`, then `items` notifications until `unsubscribe` |
| `unsubscribe` | `{}` | `{ ok: true }` |
| `participated` | `{ days }` | `{ keys: string[] }` |
| `context` | `{ key, since?, max }` | `ContextResult` |
| `act` | `{ action, idempotencyKey, dryRun }` | `ActResult` |
| `undo` | `{ token }` | `ActResult` |
| `links.parse` | `{ url }` | `{ key, id? }` or `null` |
| `links.of` | `{ key }` | `{ url }` or `null` |
| `parseTarget` | `{ text, topicKey }` | `Target` or `{ error }` |
| `shutdown` | `{}` | `{ ok: true }`, then the process exits |

Pure methods (`links.*`, `parseTarget`) are cached by Strato per input; `triageRules` and `render` are derived from the descriptor (`settings` with their `triage` roles, plain-text rendering) for exec providers.

**Notifications from the provider.** `items` `{ items }` (push), `log` `{ level, message }`, `health` `{ status: "ok" | "degraded" | "down", detail }`.

**Requests from the provider.** `secret.set` `{ name, value }`, to persist a refreshed token; Strato accepts only names declared in the auth method's `stores`.

**Versioning.** Strato offers the protocol versions it speaks; the provider answers the one it picks.
No common version: `initialize` fails with code -32001 and `doctor` names both ranges.
Within a version, changes are additive: unknown fields are ignored on both sides.

**Errors.** JSON-RPC error objects; `data` carries a `ProviderError` (code, retryable, fatal, retryAfterMs, outcome).

| Code | Meaning |
| --- | --- |
| -32700, -32600, -32602 | parse error, invalid request, invalid params |
| -32601 | method not found: the capability is absent, and must also be absent from the descriptor |
| -32000 | provider error, details in `data` |
| -32001 | protocol version unsupported |
| -32002 | authentication: the account needs setup (`fatal: true`) |
| -32003 | rate limited (`retryAfterMs`) |
| -32004 | cancelled |

**Timeouts.** `initialize` 15 s, `connect` 20 s, `poll` 60 s, `context` 30 s, `act` and `undo` 30 s, `links.*` and `parseTarget` 2 s, `shutdown` 5 s.

**Cancellation.** On a timeout or when Strato no longer needs the answer, it sends the notification `$/cancel` `{ id }`; the provider answers -32004 or its result within 5 s, else the process is killed and restarted.
A cancelled or timed-out `act` is reported with `outcome: "unknown"` and never replayed.

**Logging.** Stderr and `log` notifications go to `<state>/providers/<provider>-<account>/provider.log`, capped at 1 MiB with one rotation, secrets masked.
Nothing a provider writes reaches the master's Monitor; Strato prints one line when an account goes down and one when it is back, like the socket outage lines of `listen`.

**Restart policy.** Started lazily, stopped after 10 idle minutes unless subscribed.
A crash restarts the process with backoff (1 s, 2 s, 4 s… up to 5 minutes); five crashes within 10 minutes mark the account down, retried every 15 minutes, shown by `doctor` and the board.

### 13.3 The SDK types file

`scripts/providers/sdk.ts` is the source of section 4: types, `PROVIDER_API`, `defineProvider`, and the JSON-RPC message types of 13.2.
It is embedded in the binary and printed by `strato provider sdk` (as `policy-default` prints a template), so an author writes `strato provider sdk > strato-provider.d.ts` next to their module.
Any change to it bumps `PROVIDER_API` when it is not additive.

### 13.4 Security model

- **Opt-in.** Nothing is loaded from disk unless `config.json` names it; Strato never scans a folder for providers.
- **Trust pinning.** `strato provider trust <id>` prints the file's path, its SHA-256 and the descriptor (kinds, auth methods, actions it can perform, hosts), and records the hash after a confirmation typed on stdin; a changed file is refused until trusted again.
  The pin covers the named file, not what it imports or runs.
- **Same privileges as the person.** A provider runs as the person, with their files and their network; Strato cannot sandbox it.
  Installing one is the same decision as installing any command-line tool.
- **The gate still holds for Strato's paths.** A provider never decides to act: only `app/act.ts` calls `act`, after a Go.
  A provider that writes on its own initiative is malicious, and pinning is the defense.
- **Isolation of what Strato gives it.** Its own account's secrets and its own folder; never the state folder, other accounts, the topics or the sessions.
- **Its output is untrusted.** Item texts, names and labels are neutralized before any prompt and never reach a command line; keys are validated against the grammar; links must be https and on the descriptor's `hosts` to be opened by the board.

### 13.5 The conformance harness

```
strato provider test <id | path> [--account <name>] [--fixtures <dir>]
```

Offline: it never reaches the network.
A module gets a `ctx.fetch` served from `fixtures/*.json` (recorded request and response pairs) that fails on any request it does not know; an exec provider receives `offline: true` and the fixtures folder in `initialize`, and is responsible for serving from it.

| Check | What it verifies |
| --- | --- |
| Descriptor | schema, id, kinds, official auth kinds, action kinds, English labels, hosts |
| Protocol | `initialize`, `shutdown`, unknown method is -32601, `$/cancel` honored within 5 s |
| Keys | every key and id parses, belongs to the provider; `links.of` then `links.parse` returns the same key |
| Poll | required item fields, chronological order, polling again from the returned cursor yields no new id, `complete` set |
| Context | items oldest first, for keys returned by poll |
| Act | only `dryRun: true`, for each declared action kind; a dry result and no write |
| Text | no control characters, sizes under the limits |

One line per check, `ok` or `fail` with the reason; exit code 1 on any failure.

### 13.6 Scaffolding

```
strato provider new <id> [--exec python] [--dir <folder>]
```

It writes `<folder>/<id>/provider.ts` (or `provider.py`, standard library only), `strato-provider.d.ts`, `fixtures/sample.json` and a `README.md`, with a working fake source of two items and one dry-run action.
It prints the `config.json` snippet to add and the `strato provider test` command to run.
The template is written so that a Claude Code session given the tool's API documentation can fill it in and run the harness until it passes.

### 13.7 New command line surface

All additions; nothing existing is renamed or removed.

| Command | Role |
| --- | --- |
| `strato context <topic \| key \| link> [--since] [--max]` | A topic's threads as neutralized text |
| `strato act <topic> <task> --sha <hash>` | The master carries out a Go |
| `strato setup --connect <provider> [--account] [--auth]` | Connect an account |
| `strato setup --strict-gate` | Turn the strict gate on |
| `strato provider list \| sdk \| new \| test \| trust` | Providers |
| `strato demo --role <role>` | The demo for a role |

## 14. Roles for non-developers

`owner.role`, `developer` by default.

| Role | Templates | Board vocabulary | Triage emphasis | Demo |
| --- | --- | --- | --- | --- |
| `developer` (default) | today's, byte for byte, including `ticket.md` | today's | today's | today's Acme topics |
| `support` | answer first, customer tone, the done marker after each settled answer, escalation as a task | "request", "customer" | watched channels and shared customer conversations raised as `canal` | a customer question, a refund, a bug escalated |
| `operations` | runbook first, every production step a separate task | "incident", "change" | alert bots grouped in the digest unless they mention the person | an incident, an approval, a change window |
| `account-manager` | follow-ups with deadlines (`due`), summaries for the account | "account", "follow-up" | DMs and customer conversations first | a renewal, a promise to keep, a meeting recap |
| `recruiter` | candidate communication, internal notes never in drafts | "candidate", "loop" | DMs and the mailbox first | a candidate reply, a scheduling question |
| `manager` | decisions framed as options, delegation proposed before doing | "decision", "team" | `canal` to the digest unless it mentions the person; the "A decision" block first | an approval, a conflict, a weekly digest |

What a role changes, and nothing else:

- **Templates.** A role folder of embedded defaults (`policy/roles/<role>/*.md`), file by file; the precedence is `<state>/policy/*.md`, then the role's file, then the shipped default.
- **Board vocabulary.** i18n keys `role.<role>.*` for block titles, empty states and the task labels, in English and French; the delivery line only shows with a forge.
- **Triage emphasis.** Default digest routing and block order, always overridable by the account settings; a role never drops a mention or a DM.
- **Demo.** `strato demo --role <role>` serves fictional topics of that role.

A role never changes the gate, shadow mode, the CLI, or the master protocol.

## 15. Implementation plan

Each stage is one or more commits that leave `bun run check` green and the guard passing, and can ship alone.

### seam

- **Scope.** The provider types, the registry, the key grammar, the `providers` settings section, and the Slack provider wrapping today's code, with no behavior change.
  Links go through the registry.
- **Files.** New: `providers/sdk.ts`, `providers/registry.ts`, `providers/slack/model.ts`, `providers/slack/index.ts`.
  Changed: `core/keys.ts` (`parseKey`, `formatKey`, `canonicalKey`; `permalinkOfKey` and `sujetKey` read the providers' pure `links` functions, installed at startup the way `useSettings` installs the profile, so the module stays pure), `core/settings.ts` (`providers`, accounts resolved with the legacy mapping of 6.2), `core/setup.ts` (`profileErrors` shapes and messages), `core/text.ts` (`reportFile` suffix for new keys), `server/serve.ts` (`OPENABLE_HOSTS` from the descriptors), `claude/transcript.ts` (citations through `links.parse`), `board.ts` (`keyLink`), `core/i18n.ts`, `lib.ts`.
- **Tests.** `keys.test.ts`: legacy Slack keys parse as Slack default, `linear:` keys as Linear default, round trips, rejection of shell metacharacters, the 200-character rule.
  `settings.test.ts`: the legacy flat format and the current format resolve to the same accounts; the one-place rule; every message of 6.4.
  A fixture state folder with bare keys loads identically (`loadSujets`, `findSujet` by link and by letter).
  Every existing test unchanged.
- **Compatibility.** No stored format changes; `reportFile` is unchanged for existing keys; no CLI change.
- **Done when.** Check green; `doctor` prints the same lines on the test rig; no `slack.com` or `linear.app` string is built outside `providers/` and `chat/`.

### ingest

- **Scope.** `classifyItem` in the core; Slack produces items; one ingest loop per account; poll accounts in `listen` and `watch`; per-account state folders and cursors; the generic event type for non-Slack items.
- **Files.** New: `core/triage.ts`.
  Changed: `chat/slack-model.ts` (`classify` as a wrapper), `commands/watch.ts` (`processMatches` becomes `processItems`, a poll loop per account), `app/store.ts` (account folders, `keepMessage` stores the key and the conversation), `core/refresh.ts`, `core/sujet.ts` (`takenBy`), `board.ts` (`lastMessageOf`), `core/cards.ts` (`eventLine`), a helper `isItemEvent(e)` accepting `"slack"` and `"item"`.
- **Tests.** A golden replay: a fixture batch of socket events and search matches produces byte-identical stdout lines and `events.ndjson` lines before and after the change.
  A fake poll provider declared in the test produces lines with `key=fake:…`, dedup across passes, a cursor that does not move on a failed pass.
  Per-account `seen.json` purge by time.
- **Compatibility.** Slack events keep `type: "slack"`; `seen.json` and `tick.json` unchanged; the master's line format and `<type>` values unchanged; `listen` with Slack alone behaves as today.
- **Done when.** Check green; `listen` and `watch` on the rig, with the fake Slack preload of `check.test.ts`, print the same lines as before.

### act

- **Scope.** `core/gate.ts`, `app/act.ts`, structured task fields, the board's Send, Undo and ✅ through the act path, `strato act` for the master, `workers.gate` with strict and legacy modes, session deny rules, audit events.
- **Files.** New: `core/gate.ts`, `app/act.ts`, `commands/act.ts`.
  Changed: `server/serve.ts` (`postDraft`, `unpost`, `/api/check`, the Go of provider tasks), `core/tasks.ts` (fields `to`, `act`, `value`; validation; `TASK_FIELDS`), `core/settings.ts` (`workers.gate`, `NEW_INSTALL_PROFILE`), `app/claude.ts` (`STRATO_CALLER=session`, deny rules in strict mode), `core/cards.ts` (`card` prints the plan and its hash), `commands/setup.ts` (`--strict-gate`), `strato.ts` (USAGE), `core/i18n.ts`.
- **Tests.** Shadow refuses every origin; a hash mismatch refuses; a second act on the same task refuses; an act with `STRATO_CALLER=session` refuses; the board's Send posts exactly the shown text through the fake Slack; Undo deletes; ✅ goes through `react`; audit lines written; deny rules present in strict mode only; `check.test.ts` and `tasks-serve.test.ts` unchanged and green.
- **Compatibility.** Routes `/api/post-draft`, `/api/unpost`, `/api/check` keep their names and payloads; `board-post`, `board-unpost`, `board-check` still logged; existing profiles stay `legacy`; `set` and `task` keep every field they accept.
- **Done when.** Check green; a grep shows `Provider.act` called from `app/act.ts` only; `slackPost` is no longer imported by `server/serve.ts`.

### prompts

- **Scope.** The vocabulary variables, `strato context`, the context rule appended by code, the default templates rewritten with the variables, SKILL.md (context through `strato context`, a go through `strato act`).
- **Files.** New: `commands/context.ts`.
  Changed: `policy/prompts.ts`, `policy/defaults/*.md`, `SKILL.md`, `strato.ts`, `core/i18n.ts` (the CLI's human lines).
- **Tests.** Every default template renders for a Slack topic and for a Linear topic; fixture overrides in the older styles (French, `{{#si}}`, `bun {{script}}`) render byte for byte as before; an unknown variable still fails; `strato context` output is neutralized (brackets, guillemets, a fake `[strato]` line) for a fake provider; `prompts.test.ts` unchanged.
- **Compatibility.** No template renamed; every new variable always defined; legacy Slack MCP read rules kept.
- **Done when.** Check green; a Slack topic's rendered worker prompt differs from today's only in the lines that name the context command.

### setup

- **Scope.** Per-provider setup modules, `setup --connect`, the OAuth PKCE loopback helper, the secret store, `doctor` and `setup --check` per account, `--detect` per provider, the interview in SKILL.md and SETUP.md.
- **Files.** New: `app/secrets.ts`, `app/oauth.ts`, `providers/slack/setup.ts`.
  Changed: `commands/setup.ts`, `core/setup.ts`, `commands/sujets.ts` (`doctor`), `core/i18n.ts`, `SKILL.md`, `SETUP.md`, `README.md`.
- **Tests.** The PKCE helper against a local fake authorization server started on port 0: S256 challenge, `state` mismatch refused, timeout, the listener closed after one code, ports 4343 and 4344 never used.
  Secret files written 600 in a 700 folder; `--token` and `--app-token` print what they print today; `--detect` keeps its current fields and adds the providers' ones.
- **Compatibility.** Every `setup` flag kept; the Slack token search order unchanged; `config.json` written only through `writeProfile`.
- **Done when.** Check green; a fresh rig goes from no profile to a connected fake provider account with `setup --connect` and stdin input only.

### linear

- **Scope.** The Linear provider: GraphQL client, API key and OAuth with refresh, notifications polling, participation, context, actions with undo, links, triage rules, vocabulary, setup module, MCP tool lists.
- **Files.** New: `providers/linear/model.ts`, `providers/linear/client.ts`, `providers/linear/index.ts`, `providers/linear/setup.ts`.
  Changed: `providers/registry.ts`, `core/i18n.ts`, SETUP.md.
- **Tests.** A fake Linear GraphQL server on port 0 with recorded fixtures; the `Authorization` header with and without `Bearer` by auth method; refresh on an expired token; poll, cursor and dedup; context threading; comment, setStatus and assign with undo; rate-limit headers respected; a profile with `tracker` and no account behaves as links-only.
- **Compatibility.** `linear:ABC-123` keys; `open ABC-123` still opens the implementation topic; the Linear MCP stays usable by sessions.
- **Done when.** Check green; the full loop runs on the rig against the fake server: a mention becomes a line, `open --msg` opens a topic, a comment task goes out on a board Go and is undone.

### external

- **Scope.** The module loader, the exec host, the SDK file, and `strato provider list | sdk | new | test | trust`.
- **Files.** New: `providers/host/module.ts`, `providers/host/exec.ts`, `commands/provider.ts`, `providers/templates/` (the scaffolding texts, embedded).
  Changed: `providers/registry.ts`, `core/settings.ts` and `core/setup.ts` (`source`), `strato.ts`, `core/i18n.ts`.
- **Tests.** A module fixture loaded from a temp folder; an exec fixture provider (a small Bun script in the test fixtures) speaking the protocol; timeouts, `$/cancel`, restart and backoff with an injected clock; protocol mismatch; secrets absent from the child's environment; a changed hash refused; the harness passes a good fixture provider and fails a broken one on each check.
  Loading a module from a compiled binary runs in a test gated by `STRATO_TEST_COMPILE=1`, because compiling takes too long for every run.
- **Compatibility.** Nothing loads without a `source` in the profile.
- **Done when.** Check green; `strato provider new demo` then `strato provider test` passes with no edit.

### proof

- **Scope.** Show that the interface holds without touching Strato: two example providers built only against the SDK, and the full loop with one of them.
- **Files.** New: `examples/providers/maildir/` (a module reading a local Maildir, kind `mail`, `reply` writing into a local outbox folder, so nothing leaves the machine), `examples/providers/jsonl/` (an exec provider reading a local JSONL file of generic requests).
- **Tests.** Both pass the harness; an end-to-end test on the rig with the fake `claude`: an item becomes a topic, the session's draft task shows on the board, Send writes the outbox file once, Undo removes it, shadow mode writes nothing.
- **Compatibility.** Examples only; the guard keeps them free of real names (acme, alice, bob).
- **Done when.** Check green; a Claude Code session given only `strato provider sdk`, the scaffold and a tool's public API documentation produces a provider that passes the harness (manual acceptance, recorded in the stage's merge request).

### roles

- **Scope.** `owner.role`, role template sets, board vocabulary, triage emphasis presets, the demo per role, the interview's role question.
- **Files.** New: `policy/roles/<role>/*.md`.
  Changed: `policy/prompts.ts` (role folder in the precedence), `core/settings.ts`, `core/setup.ts` (enum), `core/i18n.ts` (`role.*`), `board.ts`, `commands/demo.ts`, `SKILL.md`, `SETUP.md`.
- **Tests.** The developer role renders byte-identical prompts to the shipped defaults; every role renders every template; i18n parity in both locales; `demo --role support` serves its topics; block titles follow the role.
- **Compatibility.** A profile without `owner.role` is a developer profile, unchanged.
- **Done when.** Check green; the demo of each role shows on the board in English and French.

## 16. Risks and open questions

1. **The developer flow and the invariant.** Today sessions push feature branches, open merge requests and comment on tickets without a go (`execution-rule.md`, `ticket.md`).
   Under the strict gate, ticket comments become tasks; branch pushes and merge requests stay session work until the forge becomes a provider.
   Is a merge request towards the integration branch "the outside world" that needs a Go?
   Proposal: no for the push, yes for the merge request once the forge is a provider, with one Go covering title, description and target branch.
2. **A go given to the master is not proof of a human.** The master is a Claude Code session that also reads third-party text; `strato act --sha` binds the go to the exact content but not to a person.
   An option is `workers.goFrom: ["board"]`, where `strato act` only queues the go and the board asks for one confirming click.
3. **Legacy gate mode.** Existing installations keep their sessions' MCP write tools until they turn strict on.
   How hard should `doctor` and the board push for it?
4. **Deny rules are not a sandbox.** They depend on the MCP server names in the workspace, and a session with a shell and network access can still call an API with a token it finds.
   Hiding the token files from sessions (`Read` deny rules on `~/.config/strato/**`) narrows it; it does not close it.
5. **Slack app model.** Per-person apps hit the 10-app cap of free workspaces in teams larger than that; the shared internal app gives up Socket Mode.
   The rate limits of an internal app shared by several users, and Slack's PKCE details (redirect port rules, token rotation), must be confirmed in the setup stage.
6. **Linear identifiers move.** An issue moved to another team changes identifier; the old one redirects.
   Keys stay `linear:<old>` and the new identifier is attached, but a search by the new link must find the topic: the provider resolves both through the API.
7. **Rollback with new keys.** After `update --rollback`, an older binary meets keys of providers it does not know.
   It skips `linear:` keys in its catch-up but would try to read other qualified keys as Slack channels and get `channel_not_found`, which it already tolerates.
   A note in the release is enough, or a key prefix check backported in a patch release.
8. **External modules and packages.** Package resolution from a module imported by a compiled binary is not guaranteed; the design pushes such providers to the exec shape.
   Worth a spike before the external stage.
9. **Unknown outcomes.** A timed-out act of a provider without idempotency may or may not have written; the person is asked to check.
   How often this happens per tool decides whether a provider should read back before reporting.
10. **i18n of external providers.** Built-in strings always exist in English and French; an external provider's labels come as `{ en, fr? }` and fall back to English on a French board.
    Should the harness require French, or only warn?
11. **Secret storage.** Files with mode 600 are today's practice.
    The macOS keychain and the Secret Service API on Linux are better at rest but add platform code and prompts; to decide before mail providers, whose app passwords open a whole mailbox.
12. **A public OAuth client.** Shipping a client id owned by the project would spare the person creating an OAuth application, but makes the project an app every user trusts and, for Slack, a distributed app with throttled history reads.
    Proposal: no, each person or team creates their own app.
13. **Polling cost with many accounts.** Each poll account adds a loop in the listener and requests to its tool; the board's freshness pill must aggregate their health without becoming noise.
14. **Prompt injection remains.** Neutralization, the untrusted rule and the gate reduce it; they do not remove it.
    More sources mean more third-party text in sessions.
