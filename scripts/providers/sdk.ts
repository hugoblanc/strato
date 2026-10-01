/**
 * The provider interface: what a provider declares and implements, and what Strato gives it.
 * Types only, without imports or values, so that this file is a valid declaration file as it is printed
 * (docs/design/providers.md, sections 4 and 13.3). `PROVIDER_API` and `defineProvider` live in providers/api.ts.
 *
 * A provider speaks native ids only (`C0ACME0001:1759219200.000100`, `PLAT-12`): the core builds, escapes and parses
 * the keys (core/keys.ts) and evaluates the declared link patterns (core/links.ts).
 */

// ------------------------------------------------------------------ descriptor

export type ProviderKind = "chat" | "tracker" | "mail" | "forge";

/** A user-facing string. Built-in providers use i18n keys; external providers give the text, English required. */
export type Text = { key: string } | { en: string; fr?: string };

export interface ProviderDescriptor {
  /** Lowercase, `^[a-z][a-z0-9-]{1,30}$`. It prefixes the keys of this provider: never renamed once used. */
  id: string;
  label: Text;
  /** The `PROVIDER_API` versions this provider was written for. */
  api: { min: number; max: number };
  kinds: ProviderKind[];
  capabilities: Capabilities;
  /** Official flows only; empty only for a provider of local data (an account then says `auth: "none"`). The first one is the default offered by setup. */
  auth: AuthMethod[];
  /** The account settings this provider reads, validated by `setup --write` and asked by the interview. */
  settings: SettingSpec[];
  vocabulary: Vocabulary;
  /** Links as data, evaluated by the core. */
  links: LinkSpec;
  /** Hosts of the links this provider builds: the board opens them, and only them, for this provider's keys. A leading `*.` matches any subdomain. */
  hosts: string[];
  /** Hosts its API calls may reach; `{settings.baseUrl}` stands for the host of that setting. */
  apiHosts: string[];
  /** Bare ticket ids (`PLAT-12`) this provider claims: the prefixes come from this string[] setting. */
  ticketIds?: { prefixesFrom: string };
  /** Per text action kind, the audience fields the tool has; each one declared here is required on a plan. */
  audience?: Partial<Record<"post" | "reply" | "comment", AudienceSpec>>;
  /** Longest text an action may carry, in characters. */
  maxText?: number;
  /** The MCP server sessions may also use for this tool, if any: which tools read and which write. */
  mcp?: { server: string; readTools: string[]; writeTools: string[] };
  /** Undo window of an action, in ms; absent: no undo. */
  undoMs?: number;
  /**
   * The marker that tells everyone a thread is settled, if the tool has one: the board's check mark puts it on the
   * thread's first item (Slack: the ✅ reaction).
   */
  done?: { kind: "react"; emoji: string };
}

export interface AudienceSpec {
  /** Recipients chosen per action (mail): `to`, and `cc` when true. */
  to?: boolean;
  cc?: boolean;
  /** A subject line (mail). */
  subject?: boolean;
  /** Public reply or internal note (support tools), with the default the task form proposes. */
  visibility?: { default: "public" | "internal" };
}

export type ActionKind = "post" | "reply" | "comment" | "react" | "delete" | "setStatus" | "assign" | "create";

export interface Capabilities {
  /** `push` requires `poll`: a push account is also polled, to catch up after a silent cut. */
  ingest: { push: boolean; poll: boolean };
  /** Can list the threads the person took part in recently (a reply there without a mention is probably for them). */
  participation: boolean;
  context: boolean;
  actions: ActionKind[];
  /** The actions this provider can take back within `undoMs`. */
  undo: ActionKind[];
  /** The actions for which the provider honors `idempotencyKey`, so a replay cannot write twice. */
  idempotent: ActionKind[];
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
  /** The interview's question for this setting; required when `triage` is set. */
  ask?: Text;
  /** A field returned by `setup.detect` whose candidates the interview offers. */
  candidatesFrom?: string;
  /** The setting feeds a triage rule or the identity. */
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

// ------------------------------------------------------------------ auth

export type AuthKind = "user-token" | "api-key" | "app-password" | "oauth2";

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
  /** What this method cannot do, removed from the descriptor's capabilities. */
  limits?: CapabilityLimits;
}

/** A `false` removes that capability; a list removes those action kinds from the matching list. Nothing is ever added. */
export interface CapabilityLimits {
  ingest?: { push?: false; poll?: false };
  participation?: false;
  context?: false;
  edits?: false;
  identity?: false;
  actions?: ActionKind[];
  undo?: ActionKind[];
  idempotent?: ActionKind[];
}

export type AuthStep =
  /** Open a documented page (create an app from a manifest, create an API key). */
  | { kind: "open"; url: string; say: Text }
  /** Read one secret without echo, in the person's own terminal or on the board's Connect page; never as an argument, never in a chat. */
  | { kind: "paste"; secret: string; say: Text; shape?: string }
  /** OAuth 2.0 authorization code on the loopback redirect, with PKCE (S256) wherever the service supports it. */
  | { kind: "oauth"; authorizeUrl: string; tokenUrl: string; clientId: "setting" | string; clientSecret?: string; pkce: boolean; scopes: string[] }
  /** Check the candidate secrets with a throwaway `connect`; nothing is stored if it fails. */
  | { kind: "verify" };

export interface SecretSpec {
  /** Name in the secret file: `SLACK_USER_TOKEN`, `LINEAR_API_KEY`. */
  name: string;
  /** Environment variables also accepted, first match wins (legacy sources). */
  env?: string[];
  /** Rewritten by Strato when the provider refreshes it (OAuth refresh tokens). */
  refreshable?: boolean;
}

// ------------------------------------------------------------------ account

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
  /** The tool's own id of that workspace (Slack `T…`), when a link needs it. */
  tenant?: string;
  /** The person's groups whose mention counts as a mention of them (Slack user groups). */
  groups?: string[];
}

// ------------------------------------------------------------------ items

export type ConversationKind = "dm" | "group" | "channel" | "ticket" | "email";

/** What happened: a message or a comment, an issue created, a status change, an assignment. */
export type ItemEvent = "message" | "comment" | "created" | "status" | "assigned";

export interface Item {
  /** Native id of the thread: the core builds the key a topic attaches. */
  thread: string;
  /** Native id of this item, for deduplication. */
  id: string;
  event: ItemEvent;
  author: { id: string; name: string; isMe: boolean; isBot: boolean };
  conversation: { id: string; label: string; kind: ConversationKind };
  /** A ticket's title, an email's subject. Third-party text. */
  title?: string;
  /** Plain text, mentions made readable. Third-party text: the core flattens and neutralizes it before any prompt. */
  text: string;
  /** Unix ms. */
  time: number;
  /**
   * https link to the item, else to its thread. The core drops it unless it is https, on `hosts`, without whitespace
   * nor credentials, and percent-encodes what a shell would read in it.
   */
  link: string;
  /** The person, or one of their groups, is mentioned; or the tool says the item targets them (assignment). */
  mentionsMe: boolean;
  /** At least one person is explicitly targeted, and not the person served. */
  targetsOther: boolean;
  /**
   * An edit: the facts of the version before it, so an edit is raised only when it adds a mention. The core raises an
   * edit of an item once, even when overlapping polls report it again.
   */
  edited?: { before: Pick<Item, "mentionsMe" | "targetsOther"> };
  /** Why the tool notified the person, when it says so. Informative, for the event line. */
  reason?: "assigned" | "mentioned" | "subscribed" | "watched";
}

// ------------------------------------------------------------------ actions

export interface Target {
  /** A thread (reply), a conversation (new message), an item (react, delete), a ticket (comment, status, assignee). */
  scope: "thread" | "conversation" | "item" | "ticket";
  /** Native id of that thread, item or ticket; the conversation id for a new message. */
  native: string;
  /** What the board shows before the Go: "#support, thread of 10:42", "PLAT-12". */
  label: string;
  link?: string;
}

/** Who sees a text action. Every field the descriptor's `audience` declares for that kind is required. */
export interface Audience {
  to?: string[];
  cc?: string[];
  visibility?: "public" | "internal";
}

export type Action =
  | { kind: "post"; target: Target; text: string; subject?: string; audience?: Audience }
  | { kind: "reply"; target: Target; text: string; subject?: string; audience?: Audience }
  | { kind: "comment"; target: Target; text: string; audience?: Audience }
  | { kind: "react"; target: Target; emoji: string }
  | { kind: "delete"; target: Target }
  /** A workflow transition; some tools require fields with it (a resolution). */
  | { kind: "setStatus"; target: Target; status: string; fields?: Record<string, string> }
  | { kind: "assign"; target: Target; assignee: string }
  | { kind: "create"; target: Target; title: string; text: string; fields?: Record<string, string> };

/** What the core hands a provider. The Go itself never leaves the core. */
export interface ActInput {
  action: Action;
  /** `<topic>#<task>#<sha 12 hex>#<attempt>`: a provider that declares the kind in `capabilities.idempotent` uses it. */
  idempotencyKey: string;
  /** Validate and describe, never write. */
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
  /** For act and undo only: whether the write may have happened. "unknown" is never retried automatically. */
  outcome?: "none" | "unknown";
}

// ------------------------------------------------------------------ reads

export interface ContextResult {
  /** Native id of the thread read. */
  thread: string;
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

/** Opaque to the core, made by the provider: a timestamp, a page token, a notification id. */
export interface IngestCursor {
  value: string;
  /** Unix ms up to which everything is surely read. Only for display and for the catch-up window. */
  at: number;
}

export interface PollResult {
  /** Oldest first. */
  items: Item[];
  cursor: IngestCursor;
  /** False when the provider stopped at `maxItems` before reaching the previous cursor. */
  complete: boolean;
}

// ------------------------------------------------------------------ links

export interface LinkSpec {
  /** A pasted link to native ids. Tried in order, first match wins. */
  parse: {
    /** Host, compared without case. `{settings.workspace}` and other settings are substituted; a leading `*.` matches any subdomain. */
    host: string;
    /** Regular expression on path, query and fragment, anchored at the start. */
    pattern: string;
    /** Native thread id built from the groups, such as `$1:$2.$3`. */
    thread: string;
    /** Native item id, when the link points to one item. */
    item?: string;
  }[];
  /** A native thread or item id to its link. Tried in order, first match wins. */
  of: { match: string; url: string }[];
}

// ------------------------------------------------------------------ setup

export type Confidence = "high" | "medium" | "low";

/** One guessed field: its value, where it comes from, how sure, and the options when it is a choice to make. */
export interface Detected {
  value: unknown;
  source: string;
  confidence: Confidence;
  candidates?: unknown[];
}

/** One line of `setup --check` and `doctor`. `blocking`: Strato cannot run without it. */
export interface CheckItem {
  name: string;
  status: "ok" | "missing" | "warn" | "skip";
  detail: string;
  blocking: boolean;
}

export interface SetupModule {
  /** What can be guessed with the account's secrets, read only: identity, groups, active conversations. */
  detect?(ctx: AccountContext): Promise<Record<string, Detected>>;
  /** `setup --check` and `doctor` lines for this account. */
  check?(ctx: AccountContext): Promise<CheckItem[]>;
}

// ------------------------------------------------------------------ the provider object

export interface Provider {
  descriptor: ProviderDescriptor;
  /** Checks the secrets and returns who the person is. */
  connect(ctx: AccountContext): Promise<Identity>;
  /**
   * Poll: reads newest first back to `cursor` (or to `since`, Unix ms, without one), keeps at most `maxItems`, and
   * returns them oldest first. A capped pass returns the cursor of the oldest item it read; a failed pass throws.
   */
  poll?(ctx: AccountContext, cursor: IngestCursor | null, opts: { since: number; maxItems: number }): Promise<PollResult>;
  /**
   * Push: resolves when the connection ends, or soon after `ctx.signal` aborts it. `onItems` is called as items
   * arrive, with a cursor when the tool gives one, and with no item at all for a delivery that carried none, which
   * tells the listener the connection is alive. `events.opened` says the connection is open; `events.failed` says a
   * delivery could not be read into an item (its link, and why), which the listener prints like a triage error;
   * `refused` says why the tool refused to open it.
   */
  subscribe?(
    ctx: AccountContext,
    onItems: (items: Item[], cursor?: IngestCursor) => void,
    events?: { opened(): void; failed?(link: string, reason: string): void },
  ): Promise<{ end: "clean" | "cut" | "fatal"; retryAfterMs?: number; refused?: string }>;
  /**
   * The replies of one thread posted since `since` (Unix ms), oldest first, without the item that opened the thread:
   * the catch-up of the threads of open topics, which a poll does not always return. At most `max`, the newest kept.
   * An error that may clear on the next try is `retryable`; a thread unreadable for good (archived) is not.
   */
  replies?(ctx: AccountContext, thread: string, opts: { since: number; max: number }): Promise<Item[]>;
  /**
   * What was too costly to read for every item (people's display names, readable text), filled in only for the items
   * triage keeps: the same items, in the same order. Items whose author's name is not read yet carry their id.
   */
  complete?(ctx: AccountContext, items: Item[]): Promise<Item[]>;
  /** Native ids of the threads the person took part in recently. */
  participated?(ctx: AccountContext, days: number): Promise<string[]>;
  context?(ctx: AccountContext, thread: string, opts: { since?: number; max: number }): Promise<ContextResult>;
  act?(ctx: AccountContext, input: ActInput): Promise<ActResult>;
  undo?(ctx: AccountContext, token: string): Promise<ActResult>;
  /**
   * Pure. A destination to a target on this account: a legacy free-text `draftTo`, or a native id as is (the native
   * part of a task's typed `to` key). When it cannot be resolved, why, and the words the board shows for it.
   */
  parseTarget?(text: string, topic: { thread: string; conversation: { id: string; label: string } }, account: Account): Target | { error: Text; label?: string };
  /**
   * Pure. The tool's markup to plain text and to safe HTML for the board. Default: the text as is, HTML-escaped.
   * `names` are the display names the board knows, by the tool's ids, for the mentions in the text.
   */
  render?: { plain(text: string): string; html(text: string, names?: RenderNames): string };
  /** Pure. What a native thread id says by itself: its conversation's id and, when the id carries it, its time (Unix ms). */
  threadInfo?(native: string): { conversation: string; at?: number } | null;
  /** Detection and checks for setup and doctor. */
  setup?: SetupModule;
  /** Built-in providers only: a pure link function where a pattern cannot say it. */
  deepLink?(url: string, account: Account, identity: Identity): string | null;
}

/** Display names the board knows, by the tool's own ids: people, and conversations (`#support`). */
export interface RenderNames {
  people?: Record<string, string>;
  conversations?: Record<string, string>;
}

/**
 * The pure parts of a provider, installed by the core at startup with the descriptors: the board, the panel and the
 * gate resolve targets, render text and build deep links with them, without loading any network code.
 */
export type ProviderPure = Pick<Provider, "descriptor" | "parseTarget" | "render" | "threadInfo" | "deepLink">;

// ------------------------------------------------------------------ what Strato gives a provider

export interface AccountContext {
  account: Account;
  identity: Identity | null;
  /** A secret of this account only, from its secret file or its accepted environment variables. */
  secret(name: string): string | null;
  /** Persists a refreshed secret (OAuth) in this account's secret file. Only names declared in `stores`. */
  setSecret(name: string, value: string): void;
  /** fetch limited to `apiHosts`, with a timeout, the abort signal and secrets masked in errors. */
  fetch: typeof fetch;
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
  /** Small JSON files in this account's own folder, `<state>/providers/<provider>-<account>/`. */
  store: { read<T>(name: string, fallback: T): T; write(name: string, value: unknown): void };
  signal: AbortSignal;
  locale: "en" | "fr";
}
