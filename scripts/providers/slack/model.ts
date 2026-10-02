/**
 * The pure side of the Slack provider: its descriptor (capabilities, auth, settings, vocabulary, links as data) and
 * the adapters of chat/slack-model.ts to the provider interface. chat/slack-model.ts stays where it is, with its tests.
 */
import { DRAFT_MAX, draftDestination, humanize, slackAppLink } from "../../chat/slack-model.ts";
import { t } from "../../core/i18n.ts";
import { SLACK_SCOPES, slackAppLink as manifestLink } from "../../core/setup.ts";
import manifestYaml from "../../../examples/slack-app-manifest.yaml" with { type: "text" };
import teamManifestYaml from "../../../examples/slack-team-app-manifest.yaml" with { type: "text" };
import { PROVIDER_API } from "../api.ts";
import type { Account, AuthMethod, Identity, LinkSpec, ProviderDescriptor, ProviderPure, RenderNames, SecretSpec, Target, Text } from "../sdk.ts";

const key = (k: string): Text => ({ key: `provider.slack.${k}` });

const REPLY = "^/archives/([A-Z0-9]+)/p(\\d{10})(\\d{6})[^?#]*\\?(?:[^#]*&)?thread_ts=(\\d+\\.\\d+)";
const MESSAGE = "^/archives/([A-Z0-9]+)/p(\\d{10})(\\d{6})";

/**
 * Slack's links. A reply's link carries its root in `thread_ts`: the thread is the root, the item the reply. A
 * channel id alone links to the channel (a separate message). The workspace's own host names its account; any other
 * `*.slack.com` host reads as the default account, which comes first, as `parsePermalink` always did (core/links.ts
 * tries exact hosts before wildcards).
 */
export const SLACK_LINKS: LinkSpec = {
  parse: [
    { host: "{settings.workspace}.slack.com", pattern: REPLY, thread: "$1:$4", item: "$1:$2.$3" },
    { host: "{settings.workspace}.slack.com", pattern: MESSAGE, thread: "$1:$2.$3" },
    { host: "*.slack.com", pattern: REPLY, thread: "$1:$4", item: "$1:$2.$3" },
    { host: "*.slack.com", pattern: MESSAGE, thread: "$1:$2.$3" },
  ],
  of: [
    { match: "^([A-Z0-9]+):(\\d{10})\\.(\\d{6})$", url: "https://{settings.workspace}.slack.com/archives/$1/p$2$3" },
    { match: "^([CGD][A-Z0-9]+)$", url: "https://{settings.workspace}.slack.com/archives/$1" },
  ],
};

/** Slack's app creation, with Strato's manifest filled in: one app per person (`setup --slack-app`). */
export const SLACK_APP_LINK = manifestLink(manifestYaml);
/** The same for one internal app a team shares, signed in through with OAuth and PKCE (`setup --slack-app --team`). */
export const SLACK_TEAM_APP_LINK = manifestLink(teamManifestYaml);

/** A user token, and the app-level token that opens Socket Mode. The environment variables are the default account's legacy sources. */
const TOKEN_STORES: SecretSpec[] = [
  { name: "SLACK_USER_TOKEN", env: ["STRATO_SLACK_TOKEN", "AIGUILLEUR_SLACK_TOKEN", "SLACK_MCP_XOXP_TOKEN"] },
  { name: "SLACK_APP_TOKEN", env: ["SLACK_APP_TOKEN"] },
];

/** The app-level token, optional: without it the account is polled. */
const APP_TOKEN_STEP = { kind: "paste", secret: "SLACK_APP_TOKEN", say: key("auth.appToken.paste"), shape: "xapp-", optional: true } as const;

/**
 * How a Slack account connects (docs/design/providers.md, section 12.1), official flows only: the person's own app from
 * Strato's manifest (today's flow, the default), a user token they already have, or OAuth with PKCE through one
 * internal app a team shares. Strato ships no client id: a project-wide app would be a distributed app, whose thread
 * reads Slack slows to one request a minute.
 */
export const SLACK_AUTH: AuthMethod[] = [
  {
    id: "user-token",
    kind: "user-token",
    label: key("auth.userToken"),
    tradeoff: key("auth.userToken.tradeoff"),
    docs: "https://docs.slack.dev/authentication/tokens#user",
    steps: [
      { kind: "open", url: SLACK_APP_LINK, say: key("auth.userToken.open") },
      { kind: "paste", secret: "SLACK_USER_TOKEN", say: key("auth.userToken.paste"), shape: "xoxp-" },
      APP_TOKEN_STEP,
      { kind: "verify" },
    ],
    stores: TOKEN_STORES,
  },
  {
    id: "paste-token",
    kind: "user-token",
    label: key("auth.pasteToken"),
    tradeoff: key("auth.pasteToken.tradeoff"),
    docs: "https://docs.slack.dev/authentication/tokens#user",
    steps: [{ kind: "paste", secret: "SLACK_USER_TOKEN", say: key("auth.userToken.paste"), shape: "xoxp-" }, APP_TOKEN_STEP, { kind: "verify" }],
    stores: TOKEN_STORES,
  },
  {
    id: "oauth-pkce",
    kind: "oauth2",
    label: key("auth.oauth"),
    tradeoff: key("auth.oauth.tradeoff"),
    docs: "https://docs.slack.dev/authentication/using-pkce",
    steps: [
      {
        kind: "oauth",
        authorizeUrl: "https://slack.com/oauth/v2/authorize",
        tokenUrl: "https://slack.com/api/oauth.v2.access",
        clientId: "setting",
        pkce: true,
        scopes: SLACK_SCOPES.map((x) => x.scope),
        scopeParam: "user_scope",
        scopeSeparator: ",",
        // Slack treats a localhost redirect as a desktop app's when PKCE is on: no client secret
        redirectHost: "localhost",
        tokenField: "authed_user.access_token",
        secret: "SLACK_USER_TOKEN",
      },
      { kind: "verify" },
    ],
    stores: [{ name: "SLACK_USER_TOKEN" }],
    // one app shared by several people cannot use Socket Mode: Slack spreads its events across their connections
    limits: { ingest: { push: false } },
  },
];

export const SLACK_DESCRIPTOR: ProviderDescriptor = {
  id: "slack",
  label: key("label"),
  api: { min: PROVIDER_API, max: PROVIDER_API },
  kinds: ["chat"],
  capabilities: {
    ingest: { push: true, poll: true },
    participation: true,
    context: true,
    actions: ["reply", "post", "react", "delete"],
    undo: ["reply", "post", "react"],
    // chat.postMessage has no idempotency key
    idempotent: [],
    edits: true,
    identity: true,
  },
  auth: SLACK_AUTH,
  settings: [
    { key: "team", type: "string", label: key("setting.team") },
    { key: "workspace", type: "string", label: key("setting.workspace") },
    { key: "me", type: "string", label: key("setting.me"), ask: key("ask.me"), triage: "me" },
    { key: "subteams", type: "string[]", label: key("setting.subteams"), default: [], ask: key("ask.subteams"), candidatesFrom: "slack.subteams", triage: "groups" },
    { key: "teamAlias", type: "string", label: key("setting.teamAlias"), default: "", ask: key("ask.teamAlias"), triage: "groupAlias" },
    { key: "watchChannels", type: "string[]", label: key("setting.watchChannels"), default: [], ask: key("ask.watchChannels"), candidatesFrom: "slack.watchChannels", triage: "watch" },
    { key: "ignoreChannels", type: "string[]", label: key("setting.ignoreChannels"), default: [], ask: key("ask.ignoreChannels"), triage: "ignore" },
    { key: "ignoreAuthors", type: "string[]", label: key("setting.ignoreAuthors"), default: [], ask: key("ask.ignoreAuthors"), triage: "ignoreAuthors" },
    { key: "teammates", type: "string[]", label: key("setting.teammates"), default: [], ask: key("ask.teammates"), triage: "teammates" },
    { key: "appId", type: "string", label: key("setting.appId"), default: "" },
    { key: "appTokenFile", type: "string", label: key("setting.appTokenFile"), default: "" },
    { key: "userTokenFile", type: "string", label: key("setting.userTokenFile"), default: "" },
    { key: "clientId", type: "string", label: key("setting.clientId"), default: "" },
  ],
  vocabulary: {
    item: key("word.item"),
    thread: key("word.thread"),
    conversation: key("word.conversation"),
    targetFormat:
      'a reply in a thread = the channel AND the Slack link of the thread ("#support, https://…"); a separate message in a channel = the name, the channel ID and "new message" ("#announcements (C0123456789), new message"). For a DM, the link of a message of the conversation',
    targetHint: "channel and thread link, or channel id and new message",
    doneMarker: "✅ (white_check_mark) to the original message of the thread with the Slack MCP",
  },
  links: SLACK_LINKS,
  hosts: ["slack.com", "*.slack.com"],
  apiHosts: ["slack.com"],
  maxText: DRAFT_MAX,
  mcp: { server: "slack", readTools: ["conversations_replies", "conversations_history", "conversations_search_messages"], writeTools: ["conversations_add_message"] },
  undoMs: 30_000,
  done: { kind: "react", emoji: "white_check_mark" },
};

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * A draft as Slack will show it, for the board: "<@U012AB3CD>" becomes "@Ann", "<#C…|support>" becomes "#support",
 * "<https://…|Staff access>" becomes a link "Staff access". Display only: the posted and copied text keeps the Slack
 * format. `names` gives people's and channels' names by Slack id.
 */
export function slackHtml(text: string, names: RenderNames = {}): string {
  const people = names.people ?? {};
  const channels = names.conversations ?? {};
  return escapeHtml(text)
    .replace(/&lt;@([UW][A-Z0-9]+)(?:\|([^&]+))?&gt;/g, (_m, id: string, label?: string) => `<span class="font-medium text-link">@${escapeHtml(people[id] ?? label ?? id)}</span>`)
    .replace(/&lt;#([CG][A-Z0-9]+)(?:\|([^&]*))?&gt;/g, (_m, id: string, label?: string) => `<span class="font-medium text-link">#${escapeHtml(label || channels[id]?.replace(/^#/, "") || id)}</span>`)
    .replace(/&lt;!subteam\^[A-Z0-9]+(?:\|([^&]+))?&gt;/g, (_m, label?: string) => `<span class="font-medium text-link">${escapeHtml(label ?? t("board.draft.group"))}</span>`)
    .replace(/&lt;!(here|channel|everyone)&gt;/g, "<span class=\"font-medium text-link\">@$1</span>")
    .replace(/&lt;(https?:\/\/(?:[^|&\s]|&amp;)+)\|([^&]+)&gt;/g, (_m, url: string, label: string) => `<a href="${url}" target="_blank" rel="noopener" class="text-link underline underline-offset-2">${label}</a>`)
    .replace(/&lt;(https?:\/\/(?:[^&\s]|&amp;)+)&gt;/g, (_m, url: string) => `<a href="${url}" target="_blank" rel="noopener" class="text-link underline underline-offset-2">${url}</a>`);
}

/** mrkdwn to plain text, mentions left as ids (the network side, app/slack.ts `readable`, knows people's names); to the board's HTML with `slackHtml`. */
export const slackRender = {
  plain: (text: string) => humanize(text, (uid) => uid),
  html: slackHtml,
};

/**
 * The words the board shows for a free-text destination: the text without its links and channel ids ("#support"),
 * else the topic's conversation.
 */
export function slackTargetWords(text: string, conversation: string): string {
  const to = text.replace(/https?:\/\/\S+/g, "").replace(/\s*\([CGD][A-Z0-9]{8,}\)/g, "").replace(/[,;]\s*$/, "").trim();
  return to.replace(/^vers\s+/i, "") || conversation;
}

/**
 * A free-text destination (`draftTo`) to a target, with today's rules (`draftDestination`): the thread linked in it, a
 * channel id for a separate message, else the topic's own thread. The label is what the board shows next to the draft,
 * also when the destination cannot be posted to.
 */
export function slackParseTarget(text: string, topic: { thread: string; conversation: { id: string; label: string } }): Target | { error: Text; label: string } {
  const label = slackTargetWords(text, topic.conversation.label);
  const dest = draftDestination({ key: topic.thread, draftTo: text, channel: topic.conversation.label });
  if ("error" in dest) return { error: { en: dest.error }, label };
  return dest.ts ? { scope: "thread", native: `${dest.channel}:${dest.ts}`, label } : { scope: "conversation", native: dest.channel, label };
}

/** What a Slack thread id says: its channel, and the time of its first message. */
export function slackThreadInfo(native: string): { conversation: string; at?: number } | null {
  const [channel, ts] = native.split(":");
  if (!channel || !ts) return null;
  const at = Math.floor(Number(ts) * 1000);
  return { conversation: channel, ...(Number.isFinite(at) && at > 0 ? { at } : {}) };
}

/** The `slack://` link of a Slack link, on the account's team: opens the message in the app. */
export function slackDeepLink(url: string, _account: Account, identity: Identity): string | null {
  return identity.tenant ? slackAppLink(url, identity.tenant) : null;
}

/** The page of the Slack app's event subscriptions, where a listener that hears nothing is turned back on. */
export const slackEventsPage = (appId: string) => `https://api.slack.com/apps/${appId}/event-subscriptions`;

/** The Slack provider's pure parts, installed at startup (providers/builtin.ts). */
export const SLACK_PURE: ProviderPure = { descriptor: SLACK_DESCRIPTOR, parseTarget: slackParseTarget, render: slackRender, threadInfo: slackThreadInfo, deepLink: slackDeepLink };
