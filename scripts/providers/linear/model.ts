/**
 * The pure side of the Linear provider: its descriptor. Until the linear stage, Linear is what the `tracker` section
 * has always made it, a link and ticket id recognizer: the links below give exactly the results of the former
 * `ticketUrl` and `linearIssueId` on today's keys. Ingest, context and actions come with the linear stage.
 */
import { PROVIDER_API } from "../api.ts";
import type { LinkSpec, ProviderDescriptor, Text } from "../sdk.ts";

const key = (k: string): Text => ({ key: `provider.linear.${k}` });

/**
 * A link of the account's workspace whose id has one of its prefixes; a comment link adds the comment as the item.
 * An id outside the prefixes, or a link of another workspace, is left to the bare ticket id rule (core/links.ts).
 */
export const LINEAR_LINKS: LinkSpec = {
  parse: [
    { host: "linear.app", pattern: "^/{settings.workspace}/issue/((?:{settings.prefixes})-\\d+)(?:/[^?#]*)?(?:\\?[^#]*)?#comment-([A-Za-z0-9-]+)", thread: "$1", item: "$1/comment/$2" },
    { host: "linear.app", pattern: "^/{settings.workspace}/issue/((?:{settings.prefixes})-\\d+)(?![A-Za-z0-9])", thread: "$1" },
  ],
  of: [
    { match: "^([A-Za-z0-9]+-\\d+)$", url: "https://linear.app/{settings.workspace}/issue/$1" },
    { match: "^([A-Za-z0-9]+-\\d+)/comment/([A-Za-z0-9-]+)$", url: "https://linear.app/{settings.workspace}/issue/$1#comment-$2" },
  ],
};

export const LINEAR_DESCRIPTOR: ProviderDescriptor = {
  id: "linear",
  label: key("label"),
  api: { min: PROVIDER_API, max: PROVIDER_API },
  kinds: ["tracker"],
  capabilities: {
    ingest: { push: false, poll: true },
    participation: true,
    // reading a ticket comes with the linear stage: until then sessions read tickets through the Linear MCP
    context: false,
    actions: ["comment", "reply", "react", "setStatus", "assign", "create", "delete"],
    undo: ["comment", "reply", "setStatus", "assign", "react"],
    idempotent: ["comment", "reply", "create"],
    edits: false,
    identity: true,
  },
  auth: [
    {
      id: "api-key",
      kind: "api-key",
      label: key("auth.apiKey"),
      docs: "https://linear.app/developers/graphql",
      steps: [
        { kind: "open", url: "https://linear.app/settings/account/security", say: key("auth.apiKey.open") },
        { kind: "paste", secret: "LINEAR_API_KEY", say: key("auth.apiKey.paste"), shape: "lin_api_" },
        { kind: "verify" },
      ],
      stores: [{ name: "LINEAR_API_KEY" }],
    },
    {
      id: "oauth-pkce",
      kind: "oauth2",
      label: key("auth.oauth"),
      docs: "https://linear.app/developers/oauth-2-0-authentication",
      steps: [
        { kind: "oauth", authorizeUrl: "https://linear.app/oauth/authorize", tokenUrl: "https://api.linear.app/oauth/token", clientId: "setting", pkce: true, scopes: ["read", "write"] },
        { kind: "verify" },
      ],
      stores: [{ name: "LINEAR_ACCESS_TOKEN", refreshable: true }, { name: "LINEAR_REFRESH_TOKEN", refreshable: true }],
    },
  ],
  settings: [
    { key: "workspace", type: "string", label: key("setting.workspace") },
    { key: "prefixes", type: "string[]", label: key("setting.prefixes"), default: [] },
    { key: "clientId", type: "string", label: key("setting.clientId") },
    { key: "watchTeams", type: "string[]", label: key("setting.watchTeams"), default: [], ask: key("ask.watchTeams"), triage: "watch" },
    { key: "ignoreTeams", type: "string[]", label: key("setting.ignoreTeams"), default: [], ask: key("ask.ignoreTeams"), triage: "ignore" },
    { key: "ignoreAuthors", type: "string[]", label: key("setting.ignoreAuthors"), default: [], ask: key("ask.ignoreAuthors"), triage: "ignoreAuthors" },
  ],
  vocabulary: {
    item: key("word.item"),
    thread: key("word.thread"),
    conversation: key("word.conversation"),
    targetFormat: "to=linear:PLAT-12 (a comment on the ticket)",
  },
  links: LINEAR_LINKS,
  hosts: ["linear.app"],
  apiHosts: ["api.linear.app"],
  ticketIds: { prefixesFrom: "prefixes" },
  mcp: {
    server: "linear",
    readTools: ["get_issue", "list_issues", "list_comments", "get_team", "list_teams", "list_users", "get_user"],
    writeTools: ["save_issue", "save_comment", "delete_comment", "create_attachment"],
  },
};
