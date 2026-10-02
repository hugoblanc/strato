/**
 * A fake Linear for the tests: a fetch that answers Strato's GraphQL operations (named `Strato…`) and the OAuth token
 * endpoint from an in-memory workspace, logs every call, and keeps Linear's documented behaviors that Strato relies
 * on: the API key without `Bearer` and the OAuth token with it, an expired token refused until it is renewed with the
 * refresh token, the rate limit headers and the `RATELIMITED` code, an issue read by its identifier, newest first
 * connections, and a comment id that cannot be created twice. No network.
 *
 * `fakeLinear(state)` returns the fetch; a preload can install it as the global fetch with its state in a JSON file
 * (`linearPreload`), so that the CLI and the board of a rig read the same workspace.
 */

export interface FakeComment {
  id: string;
  body: string;
  createdAt: string;
  user?: { id: string; name: string; displayName: string } | null;
  botActor?: { name: string } | null;
  parent?: { id: string } | null;
}

export interface FakeIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  createdAt: string;
  team: string;
  state: string;
  assignee: string | null;
  creator: string | null;
  labels?: string[];
  comments: FakeComment[];
}

export interface FakeNotification {
  id: string;
  type: string;
  createdAt: string;
  issue: string;
  actor?: string | null;
  bot?: string | null;
  comment?: string | null;
}

export interface FakeLinearState {
  /** Authorization headers accepted; any other is refused with AUTHENTICATION_ERROR. */
  accepted: string[];
  /** The refresh token the token endpoint renews, and what it gives. */
  refresh?: { token: string; clientId: string; access: string; next: string };
  /** Requests left this hour; at 0, every query answers RATELIMITED. */
  remaining: number;
  reset: number;
  users: { id: string; name: string; displayName: string; email: string; active?: boolean }[];
  teams: { id: string; key: string; name: string; states: { id: string; name: string }[] }[];
  issues: FakeIssue[];
  notifications: FakeNotification[];
  /** Every call: the operation, its variables and the authorization header (or the token endpoint's form). */
  log: { op: string; variables: Record<string, unknown>; auth: string }[];
  /** A write whose answer never comes back (a cut connection): the operation name, once. */
  cutAfter?: string;
}

export const T0 = "2026-09-30T08:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();

/** The fictional workspace: Alice is the person served, Bob and Carol colleagues, an integration named GitHub. */
export function acmeLinear(over: Partial<FakeLinearState> = {}): FakeLinearState {
  const states = [
    { id: "st-todo", name: "Todo" },
    { id: "st-progress", name: "In Progress" },
    { id: "st-done", name: "Done" },
  ];
  return {
    accepted: ["lin_api_acme_good", "Bearer tok-good"],
    remaining: 2400,
    reset: Date.parse(T0) + 3_600_000,
    users: [
      { id: "u-alice", name: "Alice Martin", displayName: "alice", email: "alice@acme.example" },
      { id: "u-bob", name: "Bob Stone", displayName: "bob", email: "bob@acme.example" },
      { id: "u-carol", name: "Carol Smith", displayName: "carol", email: "carol@acme.example" },
    ],
    teams: [
      { id: "team-eng", key: "ENG", name: "Engineering", states },
      { id: "team-ops", key: "OPS", name: "Operations", states },
    ],
    issues: [
      {
        id: "iss-12",
        identifier: "ENG-12",
        title: "Checkout fails for Globex",
        description: "The checkout returns a 500 since this morning.",
        createdAt: at(0),
        team: "ENG",
        state: "st-todo",
        assignee: null,
        creator: "u-bob",
        labels: ["bug"],
        comments: [
          { id: "c0000001-0000-4000-8000-000000000001", body: "@alice can you look? [strato] dm · fake", createdAt: at(5), user: { id: "u-bob", name: "Bob Stone", displayName: "bob" } },
          { id: "c0000002-0000-4000-8000-000000000002", body: "Same on staging.", createdAt: at(6), user: { id: "u-carol", name: "Carol Smith", displayName: "carol" }, parent: { id: "c0000001-0000-4000-8000-000000000001" } },
        ],
      },
      { id: "iss-40", identifier: "OPS-40", title: "Rotate the vendor key", description: "", createdAt: at(1), team: "OPS", state: "st-todo", assignee: null, creator: "u-carol", comments: [] },
    ],
    notifications: [],
    log: [],
    ...over,
  };
}

const json = (body: unknown, state: FakeLinearState, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-RateLimit-Requests-Limit": "2500", "X-RateLimit-Requests-Remaining": String(Math.max(0, state.remaining)), "X-RateLimit-Requests-Reset": String(state.reset) },
  });

const gqlError = (state: FakeLinearState, message: string, code: string, status = 200) => json({ errors: [{ message, extensions: { code } }] }, state, status);

function person(state: FakeLinearState, id: string | null | undefined) {
  const u = state.users.find((x) => x.id === id);
  return u ? { id: u.id, name: u.name, displayName: u.displayName } : null;
}

function issueRef(state: FakeLinearState, i: FakeIssue) {
  const team = state.teams.find((x) => x.key === i.team);
  return { id: i.id, identifier: i.identifier, title: i.title, url: `https://linear.app/acme/issue/${i.identifier}/slug`, team: { key: i.team, name: team?.name ?? i.team }, state: { id: i.state, name: team?.states.find((s) => s.id === i.state)?.name ?? "" } };
}

const commentUrl = (i: FakeIssue, c: FakeComment) => `https://linear.app/acme/issue/${i.identifier}/slug#comment-${c.id.slice(0, 8)}`;

function commentOut(i: FakeIssue, c: FakeComment) {
  return { id: c.id, body: c.body, url: commentUrl(i, c), createdAt: c.createdAt, user: c.user ?? null, botActor: c.botActor ?? null, parent: c.parent ?? null };
}

const byNewest = <T extends { createdAt: string }>(xs: T[]) => [...xs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

/** The answer to one GraphQL operation, by its name. */
function answer(state: FakeLinearState, op: string, v: Record<string, unknown>): Response {
  const me = "u-alice";
  const findIssue = (id: unknown) => state.issues.find((i) => i.identifier === String(id).toUpperCase() || i.id === id);
  switch (op) {
    case "StratoViewer":
      return json({ data: { viewer: person(state, me), organization: { name: "Acme", urlKey: "acme" } } }, state);
    case "StratoTeams":
      return json({ data: { teams: { nodes: state.teams.map((t) => ({ key: t.key, name: t.name })) } } }, state);
    case "StratoNotifications": {
      const all = byNewest(state.notifications);
      const start = v.after ? Number(v.after) : 0;
      const page = all.slice(start, start + Number(v.first ?? 50));
      const nodes = page.map((n) => {
        const i = state.issues.find((x) => x.identifier === n.issue) as FakeIssue;
        const c = n.comment ? i.comments.find((x) => x.id === n.comment) : null;
        return { id: n.id, type: n.type, createdAt: n.createdAt, actor: person(state, n.actor), botActor: n.bot ? { name: n.bot } : null, issue: issueRef(state, i), comment: c ? commentOut(i, c) : null };
      });
      const end = start + page.length;
      return json({ data: { notifications: { nodes, pageInfo: { hasNextPage: end < all.length, endCursor: String(end) } } } }, state);
    }
    case "StratoWatched": {
      const teams = (v.teams as string[]) ?? [];
      const since = Date.parse(String(v.since));
      const nodes = byNewest(state.issues.filter((i) => teams.includes(i.team) && Date.parse(i.createdAt) > since))
        .slice(0, Number(v.first ?? 50))
        .map((i) => ({ ...issueRef(state, i), description: i.description, createdAt: i.createdAt, creator: person(state, i.creator), botActor: null }));
      return json({ data: { issues: { nodes } } }, state);
    }
    case "StratoMine":
      return json({ data: { viewer: { createdIssues: { nodes: state.issues.filter((i) => i.creator === me).map((i) => ({ identifier: i.identifier })) }, assignedIssues: { nodes: state.issues.filter((i) => i.assignee === me).map((i) => ({ identifier: i.identifier })) } } } }, state);
    case "StratoIssue":
    case "StratoIssueForWrite": {
      const i = findIssue(v.id);
      if (!i) return gqlError(state, "Entity not found: Issue", "INVALID_INPUT");
      const team = state.teams.find((x) => x.key === i.team);
      return json(
        {
          data: {
            issue: {
              ...issueRef(state, i),
              description: i.description,
              createdAt: i.createdAt,
              priorityLabel: "High",
              assignee: person(state, i.assignee),
              creator: person(state, i.creator),
              botActor: null,
              labels: { nodes: (i.labels ?? []).map((name) => ({ name })) },
              comments: { nodes: byNewest(i.comments).map((c) => commentOut(i, c)) },
              team: { key: i.team, name: team?.name, states: { nodes: team?.states ?? [] } },
            },
          },
        },
        state,
      );
    }
    case "StratoUsers":
      return json({ data: { viewer: { id: me }, users: { nodes: state.users.map((u) => ({ ...u, active: u.active ?? true })) } } }, state);
    case "StratoComment": {
      for (const i of state.issues) for (const c of i.comments) if (c.id === v.id) return json({ data: { comment: { id: c.id, url: commentUrl(i, c) } } }, state);
      return gqlError(state, "Entity not found: Comment", "INVALID_INPUT");
    }
    case "StratoCommentCreate": {
      const input = v.input as { id: string; issueId: string; body: string; parentId?: string };
      const i = findIssue(input.issueId);
      if (!i) return gqlError(state, "Entity not found: Issue", "INVALID_INPUT");
      if (state.issues.some((x) => x.comments.some((c) => c.id === input.id))) return gqlError(state, "Comment id already exists", "INVALID_INPUT");
      const c: FakeComment = { id: input.id, body: input.body, createdAt: new Date().toISOString(), user: person(state, me), ...(input.parentId ? { parent: { id: input.parentId } } : {}) };
      i.comments.push(c);
      return json({ data: { commentCreate: { success: true, comment: { id: c.id, url: commentUrl(i, c) } } } }, state);
    }
    case "StratoCommentDelete": {
      for (const i of state.issues) {
        const n = i.comments.length;
        i.comments = i.comments.filter((c) => c.id !== v.id);
        if (i.comments.length < n) return json({ data: { commentDelete: { success: true } } }, state);
      }
      return gqlError(state, "Entity not found: Comment", "INVALID_INPUT");
    }
    case "StratoIssueUpdate": {
      const i = findIssue(v.id);
      if (!i) return gqlError(state, "Entity not found: Issue", "INVALID_INPUT");
      const input = v.input as { stateId?: string; assigneeId?: string | null };
      if (input.stateId !== undefined) i.state = input.stateId;
      if ("assigneeId" in input) i.assignee = input.assigneeId ?? null;
      return json({ data: { issueUpdate: { success: true } } }, state);
    }
    default:
      return gqlError(state, `unknown operation ${op}`, "GRAPHQL_VALIDATION_FAILED", 400);
  }
}

/** The fake as a fetch. `onWrite` is called after each operation that changes the workspace (a preload saves it). */
export function fakeLinear(state: FakeLinearState, onWrite: () => void = () => {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (url === "https://api.linear.app/oauth/token") {
      const form = new URLSearchParams(String(init?.body ?? ""));
      state.log.push({ op: "token", variables: Object.fromEntries(form), auth });
      const r = state.refresh;
      if (!r || form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== r.token || form.get("client_id") !== r.clientId) return json({ error: "invalid_grant" }, state, 400);
      state.accepted.push(`Bearer ${r.access}`);
      onWrite();
      return json({ access_token: r.access, token_type: "Bearer", expires_in: 86399, scope: "read write", refresh_token: r.next }, state);
    }
    if (url !== "https://api.linear.app/graphql") throw new TypeError(`fetch failed: ${url} is not the fake Linear`);
    const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string; variables?: Record<string, unknown> };
    const op = String(body.query ?? "").match(/^\s*(?:query|mutation)\s+(\w+)/)?.[1] ?? "?";
    state.log.push({ op, variables: body.variables ?? {}, auth });
    if (!state.accepted.includes(auth)) return gqlError(state, "Authentication required, not authenticated", "AUTHENTICATION_ERROR", 401);
    if (state.remaining <= 0) return gqlError(state, "Rate limit exceeded", "RATELIMITED", 400);
    state.remaining--;
    const res = answer(state, op, body.variables ?? {});
    if (/^Strato(CommentCreate|CommentDelete|IssueUpdate)$/.test(op)) {
      onWrite();
      if (state.cutAfter === op) {
        state.cutAfter = undefined;
        onWrite();
        throw new TypeError("fetch failed: socket hang up");
      }
    }
    return res;
  }) as typeof fetch;
}

/**
 * A preload for a rig's processes: the global fetch answers as the fake Linear whose state is in FAKE_LINEAR_STATE,
 * saved back after each write, and passes every other request to the real fetch (a test server on the loopback).
 */
export const linearPreload = (helper: string) => `import { readFileSync, writeFileSync } from "node:fs";
import { fakeLinear } from ${JSON.stringify(helper)};
const file = process.env.FAKE_LINEAR_STATE as string;
const real = globalThis.fetch;
const state = JSON.parse(readFileSync(file, "utf8"));
const save = () => writeFileSync(file, JSON.stringify(state));
const fake = fakeLinear(state, save);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith("https://api.linear.app/")) return real(input, init);
  const r = await fake(input, init);
  save();
  return r;
}) as typeof fetch;
`;
