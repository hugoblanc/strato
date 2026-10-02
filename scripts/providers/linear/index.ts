/**
 * The Linear provider (docs/design/providers.md, section 12.2): Linear's GraphQL API behind the provider interface.
 * It connects with a personal API key or an OAuth access token (renewed with its refresh token), polls the person's
 * notifications and the new issues of the watched teams, reads an issue with its comments for sessions, and lists the
 * issues the person created or is assigned. Its writes (a comment, a status, an assignee) live in providers/linear/
 * act.ts, which only the registry imports.
 *
 * A links-only account (the `tracker` section without an account of its own) never reaches this code: its auth is
 * "none", which no Linear method is, so the core neither reads, polls nor acts through it.
 */
import { t } from "../../core/i18n.ts";
import { defineProvider } from "../api.ts";
import type { AccountContext, ContextResult, Detected, Identity, IngestCursor, Item, PollResult, ProviderError } from "../sdk.ts";
import { LinearError, linearProviderError, linearQuery } from "./client.ts";
import {
  CONTEXT_PAGE,
  createdItem,
  CURSOR_MARGIN_MS,
  commentItem,
  identityOf,
  ISSUE_QUERY,
  issueContext,
  LINEAR_DESCRIPTOR,
  type LinearCursor,
  type LinearIssue,
  type LinearNotification,
  type LinearPerson,
  linearDeepLink,
  MINE_QUERY,
  NOTIFICATIONS_QUERY,
  notificationItem,
  readCursor,
  TEAMS_QUERY,
  ticketOfNative,
  VIEWER_QUERY,
  WATCHED_QUERY,
} from "./model.ts";

/** Notifications read per page; a pass reads pages back to its cursor, `maxItems` at most. */
const PAGE = 50;

/** An error this provider throws; its message in the person's language when it is one of Strato's own texts. */
const providerFail = (code: string, message: string, fatal: boolean): ProviderError => ({ code, message, retryable: !fatal, fatal });

/** A read that failed, as the error the provider throws. */
async function read<T>(ctx: AccountContext, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  try {
    return await linearQuery<T>(ctx, query, variables);
  } catch (e) {
    throw linearProviderError(e);
  }
}

const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The notifications since `floor` (Unix ms), newest first, page after page, `max` at most: the items they bring, the
 * newest and oldest times read, and whether the read reached `floor`.
 */
async function notificationsSince(ctx: AccountContext, floor: number, max: number): Promise<{ items: Item[]; newest: number; oldest: number; complete: boolean }> {
  const me = ctx.identity?.me ?? "";
  const items: Item[] = [];
  let newest = 0;
  let oldest = Number.POSITIVE_INFINITY;
  let count = 0;
  let after: string | null = null;
  for (;;) {
    const data: { notifications: { nodes: LinearNotification[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await read(ctx, NOTIFICATIONS_QUERY, { first: Math.min(PAGE, max - count), after });
    const nodes = data.notifications?.nodes ?? [];
    for (const n of nodes) {
      const at = Date.parse(n.createdAt);
      if (!Number.isFinite(at) || at <= floor) return { items, newest, oldest, complete: true };
      count++;
      newest = Math.max(newest, at);
      oldest = Math.min(oldest, at);
      const item = notificationItem(n, me);
      if (item) items.push(item);
      if (count >= max) return { items, newest, oldest, complete: false };
    }
    const page = data.notifications?.pageInfo;
    if (!page?.hasNextPage || !page.endCursor || !nodes.length) return { items, newest, oldest, complete: true };
    after = page.endCursor;
  }
}

/** The new issues of the watched teams since `floor`, `max` at most. */
async function createdSince(ctx: AccountContext, teams: string[], floor: number, max: number): Promise<{ items: Item[]; newest: number; oldest: number; complete: boolean }> {
  const me = ctx.identity?.me ?? "";
  const data = await read<{ issues: { nodes: LinearIssue[] } }>(ctx, WATCHED_QUERY, { teams, since: iso(floor), first: max });
  const nodes = (data.issues?.nodes ?? []).filter((i) => Date.parse(String(i.createdAt)) > floor);
  const times = nodes.map((i) => Date.parse(String(i.createdAt)));
  return { items: nodes.flatMap((i) => createdItem(i, me) ?? []), newest: Math.max(0, ...times), oldest: Math.min(Number.POSITIVE_INFINITY, ...times), complete: nodes.length < max };
}

/** Who the person is, from the viewer; a workspace other than the one the profile names is refused. */
async function viewer(ctx: AccountContext): Promise<Identity> {
  // the tracker section alone: Linear's links and ticket ids, never a connection
  if (ctx.account.auth === "none") throw providerFail("links_only", `Linear is set up for its links and ticket ids only: connect it with setup --connect linear`, true);
  const data = await read<{ viewer?: LinearPerson; organization?: { name?: string; urlKey?: string } }>(ctx, VIEWER_QUERY);
  const identity = identityOf(data);
  if (!identity) throw providerFail("invalid_answer", t("provider.linear.error.noViewer"), false);
  const wanted = ctx.account.settings.workspace;
  if (typeof wanted === "string" && wanted && identity.tenant && identity.tenant.toLowerCase() !== wanted.toLowerCase()) {
    throw providerFail("wrong_workspace", t("provider.linear.error.wrongWorkspace", { account: ctx.account.id, got: identity.tenant, want: wanted }), true);
  }
  return identity;
}

/** One issue with its fields and comments, or a not-found error that will not clear. */
async function issueOf(ctx: AccountContext, native: string): Promise<LinearIssue> {
  const t = ticketOfNative(native);
  if (!t) throw providerFail("not_found", `not a Linear issue: ${native}`, false);
  let data: { issue?: LinearIssue | null };
  try {
    data = await linearQuery<{ issue?: LinearIssue | null }>(ctx, ISSUE_QUERY, { id: t.issue, first: CONTEXT_PAGE });
  } catch (e) {
    // an issue that does not exist, or that this key cannot see: Linear answers with an error, nothing to retry
    if (e instanceof LinearError && e.answered && !e.retryable && !e.fatal) throw { ...e.toProviderError(), code: "not_found" } satisfies ProviderError;
    throw linearProviderError(e);
  }
  if (!data.issue) throw { code: "not_found", message: `Linear: no issue ${t.issue}`, retryable: false, fatal: false } satisfies ProviderError;
  return data.issue;
}

export const linearProvider = defineProvider({
  descriptor: LINEAR_DESCRIPTOR,

  connect: viewer,

  /**
   * One pass: the notifications since the cursor, and the new issues of the watched teams (`watchTeams`). Each part
   * reads newest first back to its own time; a part stopped at `maxItems` keeps the time of the oldest item it read,
   * so the backlog older than it is dropped, as the cursor contract says (section 4.8).
   */
  async poll(ctx: AccountContext, cursor: IngestCursor | null, opts: { since: number; maxItems: number }): Promise<PollResult> {
    const prev: LinearCursor | null = readCursor(cursor?.value);
    const floorOf = (iso: string | undefined) => (iso ? Date.parse(iso) - CURSOR_MARGIN_MS : opts.since);
    const nFloor = floorOf(prev?.n);
    const max = Math.max(1, opts.maxItems);
    const n = await notificationsSince(ctx, nFloor, max);
    const teams = stringList(ctx.account.settings.watchTeams);
    const wFloor = floorOf(prev?.w);
    const w = teams.length ? await createdSince(ctx, teams, wFloor, max) : { items: [], newest: 0, oldest: Number.POSITIVE_INFINITY, complete: true };
    // a complete part moves to the newest time read; a capped one to the oldest; never backwards
    const next = (part: { newest: number; oldest: number; complete: boolean }, before: string | undefined) => {
      const was = before ? Date.parse(before) : opts.since;
      return iso(Math.max(was, part.complete ? part.newest : part.oldest));
    };
    const value: LinearCursor = { n: next(n, prev?.n), w: next(w, prev?.w) };
    const items = [...n.items, ...w.items].sort((a, b) => a.time - b.time);
    return { items, cursor: { value: JSON.stringify(value), at: Math.min(Date.parse(value.n), Date.parse(value.w)) }, complete: n.complete && w.complete };
  },

  /** The comments of a tracked issue posted since `since`, the newest `max`. */
  async replies(ctx: AccountContext, thread: string, opts: { since: number; max: number }): Promise<Item[]> {
    const issue = await issueOf(ctx, thread);
    const me = ctx.identity?.me ?? "";
    return (issue.comments?.nodes ?? [])
      .filter((c) => Date.parse(String(c.createdAt)) >= opts.since)
      .sort((a, b) => Date.parse(String(a.createdAt)) - Date.parse(String(b.createdAt)))
      .slice(-Math.max(1, opts.max))
      .map((c) => commentItem(issue, c, me));
  },

  /** The issues the person created or is assigned, updated in the last `days` days. */
  async participated(ctx: AccountContext, days: number): Promise<string[]> {
    const data = await read<{ viewer?: { createdIssues?: { nodes: { identifier: string }[] }; assignedIssues?: { nodes: { identifier: string }[] } } }>(ctx, MINE_QUERY, { since: iso(Date.now() - days * 86_400_000) });
    const ids = [...(data.viewer?.createdIssues?.nodes ?? []), ...(data.viewer?.assignedIssues?.nodes ?? [])].map((i) => i.identifier).filter(Boolean);
    return [...new Set(ids)];
  },

  /** An issue for a session: its fields, its description and its comments, threaded (a comment key reads its issue). */
  async context(ctx: AccountContext, thread: string, opts: { since?: number; max: number }): Promise<ContextResult> {
    return issueContext(await issueOf(ctx, thread), opts.max, opts.since);
  },

  setup: {
    /** The workspace and the team prefixes: what `setup --connect linear` writes, and what the interview offers. */
    async detect(ctx: AccountContext): Promise<Record<string, Detected>> {
      const v = await read<{ organization?: { urlKey?: string } }>(ctx, VIEWER_QUERY);
      const teams = await read<{ teams?: { nodes: { key: string }[] } }>(ctx, TEAMS_QUERY);
      const keys = (teams.teams?.nodes ?? []).map((x) => x.key).filter(Boolean);
      return {
        ...(v.organization?.urlKey ? { workspace: { value: v.organization.urlKey, source: "organization.urlKey", confidence: "high" as const } } : {}),
        ...(keys.length ? { prefixes: { value: keys, source: "teams", confidence: "medium" as const, candidates: keys } } : {}),
      };
    },
  },

  deepLink: (url, account) => linearDeepLink(url, account),
});
