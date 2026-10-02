/**
 * The pure side of the Linear provider (docs/design/providers.md, section 12.2): its descriptor, the GraphQL queries it
 * reads with, and the mapping of Linear's answers to items, context and identity. No network here: providers/linear/
 * client.ts sends the queries, providers/linear/index.ts reads, providers/linear/act.ts writes.
 *
 * The `tracker` section keeps giving what it always gave: a link and ticket id recognizer (links-only account, no
 * auth, no ingest). An account with its own auth method (`providers.linear.accounts.default`) also reads, ingests and
 * acts. The links below give exactly the results of the former `ticketUrl` and `linearIssueId` on today's keys.
 *
 * The shapes follow Linear's public GraphQL schema (the SDK's schema and the developer documentation): notifications
 * are `IssueNotification`s whose `type` is one of the `NOTIFICATION_EVENTS` below; an issue is read by its identifier
 * (`issue(id: "PLAT-12")`, as Linear's documentation shows); connections are read newest first.
 */
import { createHash } from "node:crypto";
import { PROVIDER_API } from "../api.ts";
import type { Account, ContextResult, Identity, Item, ItemEvent, LinkSpec, ProviderDescriptor, Text } from "../sdk.ts";

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

/** The secrets of each auth method: a personal API key, or OAuth's access token and the refresh token that renews it. */
export const LINEAR_SECRETS = { apiKey: "LINEAR_API_KEY", access: "LINEAR_ACCESS_TOKEN", refresh: "LINEAR_REFRESH_TOKEN" } as const;

/** Linear's GraphQL endpoint and its OAuth token endpoint, both on the one API host the account's fetch may reach. */
export const LINEAR_API = "https://api.linear.app/graphql";
export const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";

export const LINEAR_DESCRIPTOR: ProviderDescriptor = {
  id: "linear",
  label: key("label"),
  api: { min: PROVIDER_API, max: PROVIDER_API },
  kinds: ["tracker"],
  capabilities: {
    // webhooks need a public HTTPS endpoint: a laptop polls
    ingest: { push: false, poll: true },
    participation: true,
    context: true,
    // what the provider carries out in this version: a comment (a reply when the target is a comment), a status, an assignee
    actions: ["comment", "setStatus", "assign"],
    undo: ["comment", "setStatus", "assign"],
    idempotent: ["comment"],
    edits: false,
    identity: true,
  },
  auth: [
    {
      id: "api-key",
      kind: "api-key",
      label: key("auth.apiKey"),
      tradeoff: key("auth.apiKey.tradeoff"),
      docs: "https://linear.app/developers/graphql",
      steps: [
        { kind: "open", url: "https://linear.app/settings/account/security", say: key("auth.apiKey.open") },
        { kind: "paste", secret: LINEAR_SECRETS.apiKey, say: key("auth.apiKey.paste"), shape: "lin_api_" },
        { kind: "verify" },
      ],
      stores: [{ name: LINEAR_SECRETS.apiKey }],
    },
    {
      id: "oauth-pkce",
      kind: "oauth2",
      label: key("auth.oauth"),
      tradeoff: key("auth.oauth.tradeoff"),
      docs: "https://linear.app/developers/oauth-2-0-authentication",
      steps: [
        { kind: "oauth", authorizeUrl: "https://linear.app/oauth/authorize", tokenUrl: LINEAR_TOKEN_URL, clientId: "setting", pkce: true, scopes: ["read", "write"], scopeSeparator: ",", redirectHost: "localhost", secret: LINEAR_SECRETS.access, refreshSecret: LINEAR_SECRETS.refresh },
        { kind: "verify" },
      ],
      stores: [{ name: LINEAR_SECRETS.access, refreshable: true }, { name: LINEAR_SECRETS.refresh, refreshable: true }],
    },
  ],
  settings: [
    { key: "workspace", type: "string", label: key("setting.workspace") },
    { key: "prefixes", type: "string[]", label: key("setting.prefixes"), default: [], candidatesFrom: "prefixes" },
    { key: "clientId", type: "string", label: key("setting.clientId") },
    { key: "watchTeams", type: "string[]", label: key("setting.watchTeams"), default: [], ask: key("ask.watchTeams"), candidatesFrom: "prefixes", triage: "watch" },
    { key: "ignoreTeams", type: "string[]", label: key("setting.ignoreTeams"), default: [], ask: key("ask.ignoreTeams"), candidatesFrom: "prefixes", triage: "ignore" },
    { key: "ignoreAuthors", type: "string[]", label: key("setting.ignoreAuthors"), default: [], ask: key("ask.ignoreAuthors"), triage: "ignoreAuthors" },
    { key: "desktopApp", type: "boolean", label: key("setting.desktopApp"), default: false },
  ],
  vocabulary: {
    item: key("word.item"),
    thread: key("word.thread"),
    conversation: key("word.conversation"),
    targetFormat:
      'to=linear:PLAT-12 for a comment on the ticket (to=linear:PLAT-12/comment/<id> answers a comment); a status change or an assignment is a kind=action task with act=setStatus value="<status name>" or act=assign value=<email, name, me or none>, and to=linear:PLAT-12',
  },
  links: LINEAR_LINKS,
  hosts: ["linear.app"],
  apiHosts: ["api.linear.app"],
  ticketIds: { prefixesFrom: "prefixes" },
  undoMs: 30_000,
  mcp: {
    server: "linear",
    readTools: ["get_issue", "list_issues", "list_comments", "get_team", "list_teams", "list_users", "get_user"],
    writeTools: ["save_issue", "save_comment", "delete_comment", "create_attachment"],
  },
};

// ------------------------------------------------------------------ queries (reads only: writes live in act.ts)

const ISSUE_REF = "id identifier title url team { key name }";
const PERSON = "id name displayName";

export const VIEWER_QUERY = `query StratoViewer { viewer { ${PERSON} } organization { name urlKey } }`;

export const TEAMS_QUERY = "query StratoTeams { teams(first: 100) { nodes { key name } } }";

/** The person's notifications, newest first, one page. */
export const NOTIFICATIONS_QUERY = `query StratoNotifications($first: Int!, $after: String) {
  notifications(first: $first, after: $after, orderBy: createdAt) {
    nodes {
      id type createdAt
      ... on IssueNotification {
        actor { ${PERSON} } botActor { name }
        issue { ${ISSUE_REF} state { name } }
        comment { id body url createdAt user { ${PERSON} } botActor { name } }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** The issues created in the watched teams since a time, newest first. */
export const WATCHED_QUERY = `query StratoWatched($teams: [String!], $since: DateTimeOrDuration, $first: Int!) {
  issues(first: $first, orderBy: createdAt, filter: { team: { key: { in: $teams } }, createdAt: { gt: $since } }) {
    nodes { ${ISSUE_REF} description createdAt creator { ${PERSON} } botActor { name } }
  }
}`;

/** The issues the person created or is assigned, updated since a time: the threads they take part in. */
export const MINE_QUERY = `query StratoMine($since: DateTimeOrDuration) {
  viewer {
    createdIssues(first: 100, filter: { updatedAt: { gt: $since } }) { nodes { identifier } }
    assignedIssues(first: 100, filter: { updatedAt: { gt: $since } }) { nodes { identifier } }
  }
}`;

/** One issue by its identifier, with its fields and its comments. */
export const ISSUE_QUERY = `query StratoIssue($id: String!, $first: Int!) {
  issue(id: $id) {
    ${ISSUE_REF} description createdAt priorityLabel
    state { id name } assignee { ${PERSON} } creator { ${PERSON} } botActor { name }
    labels { nodes { name } }
    comments(first: $first, orderBy: createdAt) { nodes { id body url createdAt user { ${PERSON} } botActor { name } parent { id } } }
  }
}`;

// ------------------------------------------------------------------ shapes

export interface LinearPerson {
  id: string;
  name?: string | null;
  displayName?: string | null;
}

export interface LinearIssueRef {
  id: string;
  identifier: string;
  title?: string | null;
  url?: string | null;
  team?: { key: string; name?: string | null } | null;
  state?: { id?: string; name?: string | null } | null;
}

export interface LinearComment {
  id: string;
  body?: string | null;
  url?: string | null;
  createdAt?: string | null;
  user?: LinearPerson | null;
  botActor?: { name?: string | null } | null;
  parent?: { id: string } | null;
}

export interface LinearNotification {
  id: string;
  type: string;
  createdAt: string;
  actor?: LinearPerson | null;
  botActor?: { name?: string | null } | null;
  issue?: LinearIssueRef | null;
  comment?: LinearComment | null;
}

export interface LinearIssue extends LinearIssueRef {
  description?: string | null;
  createdAt?: string | null;
  priorityLabel?: string | null;
  assignee?: LinearPerson | null;
  creator?: LinearPerson | null;
  botActor?: { name?: string | null } | null;
  labels?: { nodes: { name: string }[] } | null;
  comments?: { nodes: LinearComment[] } | null;
}

// ------------------------------------------------------------------ identity

/** Who the person is on Linear: the viewer, in the organization whose URL key names the workspace. */
export function identityOf(data: { viewer?: LinearPerson | null; organization?: { name?: string | null; urlKey?: string | null } | null }): Identity | null {
  const v = data.viewer;
  if (!v || typeof v.id !== "string" || !v.id) return null;
  const org = data.organization ?? {};
  return { me: v.id, name: personName(v), workspace: String(org.name ?? org.urlKey ?? ""), ...(org.urlKey ? { tenant: String(org.urlKey) } : {}) };
}

/** How a person is named: their display name, else their name, else their id. */
export const personName = (p: LinearPerson | null | undefined): string => String(p?.displayName || p?.name || p?.id || "");

// ------------------------------------------------------------------ items

/**
 * What each notification type means to triage. Types not listed (reactions, an unassignment, notifications about
 * projects or documents) bring nothing to answer: they are skipped.
 */
export const NOTIFICATION_EVENTS: Record<string, { event: ItemEvent; mentionsMe: boolean; reason: NonNullable<Item["reason"]> }> = {
  issueAssignedToYou: { event: "assigned", mentionsMe: true, reason: "assigned" },
  issueMention: { event: "created", mentionsMe: true, reason: "mentioned" },
  issueCommentMention: { event: "comment", mentionsMe: true, reason: "mentioned" },
  issueNewComment: { event: "comment", mentionsMe: false, reason: "subscribed" },
  issueStatusChanged: { event: "status", mentionsMe: false, reason: "subscribed" },
};

/** The conversation of an issue: its team, by key. */
const conversationOf = (issue: LinearIssueRef): Item["conversation"] => {
  const team = issue.team?.key ?? issue.identifier.replace(/-\d+$/, "");
  return { id: team, label: `Linear ${team}`, kind: "ticket" };
};

/** The native id of a comment item: `PLAT-12/comment/<id>`. */
export const commentNative = (identifier: string, commentId: string) => `${identifier}/comment/${commentId}`;

/** The author of a comment, an issue or a notification: a bot or an integration when Linear says so. */
function authorOf(user: LinearPerson | null | undefined, bot: { name?: string | null } | null | undefined, me: string): Item["author"] {
  if (user?.id) return { id: user.id, name: personName(user), isMe: user.id === me, isBot: false };
  return { id: "", name: String(bot?.name || "Linear"), isMe: false, isBot: true };
}

const timeOf = (iso: string | null | undefined): number => {
  const t = Date.parse(String(iso ?? ""));
  return Number.isFinite(t) ? t : 0;
};

/**
 * A notification -> an item, or null when it brings nothing to answer. A comment's item is the comment itself (its id,
 * its author, its text), so the same comment reached by two notifications is one item; any other event is an item of
 * its own, named by the notification.
 */
export function notificationItem(n: LinearNotification, me: string): Item | null {
  const kind = NOTIFICATION_EVENTS[n.type];
  const issue = n.issue;
  if (!kind || !issue?.identifier) return null;
  const comment = n.comment?.id ? n.comment : null;
  const base = { thread: issue.identifier, conversation: conversationOf(issue), title: String(issue.title ?? ""), targetsOther: false, mentionsMe: kind.mentionsMe, reason: kind.reason };
  if (comment && kind.event === "comment") {
    return {
      ...base,
      id: commentNative(issue.identifier, comment.id),
      event: "comment",
      author: authorOf(comment.user, comment.botActor, me),
      text: String(comment.body ?? ""),
      time: timeOf(comment.createdAt ?? n.createdAt),
      link: String(comment.url || issue.url || ""),
    };
  }
  const text = kind.event === "assigned" ? "assigned to you" : kind.event === "status" ? `status: ${issue.state?.name ?? "changed"}` : "mentioned you in the description";
  return { ...base, id: `${issue.identifier}/event/${n.id}`, event: kind.event, author: authorOf(n.actor, n.botActor, me), text, time: timeOf(n.createdAt), link: String(issue.url ?? "") };
}

/** A new issue of a watched team -> an item: a request when nobody else is targeted. */
export function createdItem(issue: LinearIssue, me: string): Item | null {
  if (!issue.identifier) return null;
  return {
    thread: issue.identifier,
    id: `${issue.identifier}/event/created`,
    event: "created",
    author: authorOf(issue.creator, issue.botActor, me),
    conversation: conversationOf(issue),
    title: String(issue.title ?? ""),
    text: String(issue.description ?? ""),
    time: timeOf(issue.createdAt),
    link: String(issue.url ?? ""),
    mentionsMe: false,
    targetsOther: false,
    reason: "watched",
  };
}

/** A comment of an issue -> an item of its thread (the catch-up of tracked issues). */
export function commentItem(issue: LinearIssueRef, c: LinearComment, me: string): Item {
  return {
    thread: issue.identifier,
    id: commentNative(issue.identifier, c.id),
    event: "comment",
    author: authorOf(c.user, c.botActor, me),
    conversation: conversationOf(issue),
    title: String(issue.title ?? ""),
    text: String(c.body ?? ""),
    time: timeOf(c.createdAt),
    link: String(c.url || issue.url || ""),
    mentionsMe: false,
    targetsOther: false,
  };
}

/** The comments of an issue in reading order: each root comment by time, followed by its replies by time. */
export function threadedComments(comments: LinearComment[]): { comment: LinearComment; reply: boolean }[] {
  const byTime = [...comments].sort((a, b) => timeOf(a.createdAt) - timeOf(b.createdAt));
  const ids = new Set(byTime.map((c) => c.id));
  const roots = byTime.filter((c) => !c.parent?.id || !ids.has(c.parent.id));
  return roots.flatMap((r) => [{ comment: r, reply: false }, ...byTime.filter((c) => c.parent?.id === r.id).map((c) => ({ comment: c, reply: true }))]);
}

/**
 * An issue -> what a session reads: its fields, then its description and its comments, threaded. `max` keeps the
 * newest comments; the description always leads.
 */
export function issueContext(issue: LinearIssue, max: number, since?: number): ContextResult {
  const all = issue.comments?.nodes ?? [];
  const recent = [...all].sort((a, b) => timeOf(a.createdAt) - timeOf(b.createdAt)).filter((c) => since === undefined || timeOf(c.createdAt) >= since);
  const kept = recent.slice(-Math.max(1, max));
  const items: ContextResult["items"] = [];
  if (issue.description?.trim() && (since === undefined || timeOf(issue.createdAt) >= since)) {
    items.push({ id: issue.identifier, author: personName(issue.creator) || String(issue.botActor?.name || "Linear"), time: timeOf(issue.createdAt), text: issue.description, ...(issue.url ? { link: issue.url } : {}) });
  }
  for (const { comment: c, reply } of threadedComments(kept)) {
    const author = c.user?.id ? personName(c.user) : String(c.botActor?.name || "Linear");
    items.push({ id: commentNative(issue.identifier, c.id), author: reply ? `${author} (reply)` : author, time: timeOf(c.createdAt), text: String(c.body ?? ""), ...(c.url ? { link: c.url } : {}) });
  }
  const fields: Record<string, string> = {};
  if (issue.state?.name) fields.status = issue.state.name;
  fields.assignee = issue.assignee ? personName(issue.assignee) : "none";
  const labels = (issue.labels?.nodes ?? []).map((l) => l.name).filter(Boolean);
  if (labels.length) fields.labels = labels.join(", ");
  if (issue.priorityLabel) fields.priority = issue.priorityLabel;
  return {
    thread: issue.identifier,
    link: String(issue.url ?? ""),
    conversation: conversationOf(issue),
    title: String(issue.title ?? ""),
    fields,
    items,
    complete: kept.length === recent.length && all.length < CONTEXT_PAGE,
    fetchedAt: Date.now(),
  };
}

/** Comments read with an issue: the most one query asks for. */
export const CONTEXT_PAGE = 250;

// ------------------------------------------------------------------ cursors

/**
 * The poll cursor: the newest notification time read, and the newest issue creation time read in the watched teams,
 * both ISO, so that Linear's own clock decides what is new. Opaque to the core.
 */
export interface LinearCursor {
  n: string;
  w: string;
}

export function readCursor(value: string | undefined): LinearCursor | null {
  if (!value) return null;
  try {
    const c = JSON.parse(value) as Partial<LinearCursor>;
    return typeof c.n === "string" && typeof c.w === "string" && Number.isFinite(Date.parse(c.n)) && Number.isFinite(Date.parse(c.w)) ? { n: c.n, w: c.w } : null;
  } catch {
    return null;
  }
}

/** Each poll reads this far before its cursor again: what was created at the same moment is caught, `seen` drops the repeats. */
export const CURSOR_MARGIN_MS = 60_000;

// ------------------------------------------------------------------ writes, pure parts

/**
 * The id a created comment gets from the idempotency key: a UUID v4 shape (Linear's id format), derived from the key,
 * so that a replay of the same Go carries the same id and cannot create the comment twice.
 */
export function stableUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest();
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** A ticket target: the issue identifier, and the comment it answers when the target is a comment. */
export function ticketOfNative(native: string): { issue: string; comment: string | null } | null {
  const m = native.match(/^([A-Za-z0-9]+-\d+)(?:\/comment\/([A-Za-z0-9-]+))?$/);
  return m ? { issue: m[1].toUpperCase(), comment: m[2] ?? null } : null;
}

/** The person an assignment names, among the workspace's users: "me", "none", an email, a display name or a name. */
export function pickAssignee(value: string, users: (LinearPerson & { email?: string | null; active?: boolean | null })[], me: string): { id: string | null } | { error: string } {
  const v = value.trim();
  const low = v.toLowerCase().replace(/^@/, "");
  if (low === "me") return { id: me };
  if (low === "none" || low === "-" || low === "nobody") return { id: null };
  const active = users.filter((u) => u.active !== false);
  const match = (f: (u: (typeof users)[number]) => string | null | undefined) => active.filter((u) => (f(u) ?? "").toLowerCase() === low);
  for (const found of [match((u) => u.email), match((u) => u.displayName), match((u) => u.name)]) {
    if (found.length === 1) return { id: found[0].id };
    if (found.length > 1) return { error: `several Linear users are named "${v}": give their email` };
  }
  return { error: `no Linear user named "${v}"` };
}

/** A workflow state by name, without case: "in progress" is "In Progress". */
export function pickState(value: string, states: { id: string; name: string }[]): { id: string; name: string } | null {
  const low = value.trim().toLowerCase();
  return states.find((s) => s.name.toLowerCase() === low) ?? null;
}

// ------------------------------------------------------------------ deep links

/**
 * The desktop app's link of a Linear link, when the account asks for it (`desktopApp`): Linear documents that
 * `linear://` followed by the rest of the URL opens that page in the app (linear.app/docs/get-the-app).
 */
export function linearDeepLink(url: string, account: Account): string | null {
  if (account.settings.desktopApp !== true) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "linear.app" ? `linear://linear.app${u.pathname}${u.search}${u.hash}` : null;
  } catch {
    return null;
  }
}
