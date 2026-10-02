/**
 * What the conformance harness does not reach: GitHub's 403 that is a rate limit, a 403 on one repository, the
 * mentions hidden in code, and the destinations a person types. Run with `bun test` in this folder.
 */
import { describe, expect, test } from "bun:test";
import type { AccountContext, ActInput, Item } from "./strato-provider.d.ts";
import provider from "./provider.ts";

type Answer = { status?: number; headers?: Record<string, string>; body?: unknown };

/** An account context whose fetch answers from `routes`, by method and path with its query. */
function fakeCtx(routes: Record<string, Answer>, settings: Record<string, unknown> = {}): AccountContext {
  return {
    account: { provider: "github", id: "default", label: "GitHub", auth: "fine-grained-pat", ingest: "poll", settings },
    identity: { me: "alice", name: "Alice", workspace: "github.com" },
    secret: () => "github_pat_test",
    setSecret: () => {},
    fetch: (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      const a = routes[`${init?.method ?? "GET"} ${u.pathname}${u.search}`];
      if (!a) return new Response("{}", { status: 599 });
      return new Response(a.body === undefined ? "" : JSON.stringify(a.body), { status: a.status ?? 200, headers: a.headers });
    }) as typeof fetch,
    log: () => {},
    store: { read: (_n, fallback) => fallback, write: () => {} },
    signal: new AbortController().signal,
    locale: "en",
  };
}

const comment: ActInput = {
  action: { kind: "comment", target: { scope: "ticket", native: "acme/api#12", label: "acme/api#12" }, text: "On it." },
  idempotencyKey: "t#1#abcdef012345#1",
  dryRun: false,
};
const POST = "POST /repos/acme/api/issues/12/comments";

describe("act", () => {
  test("a 403 with an exhausted rate limit is a retryable rate limit, nothing written", async () => {
    const reset = Math.floor(Date.now() / 1000) + 120;
    const r = await provider.act!(fakeCtx({ [POST]: { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }, body: { message: "API rate limit exceeded" } } }), comment);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ code: "rate_limited", retryable: true, fatal: false, outcome: "none" });
    expect(r.error.retryAfterMs).toBeGreaterThan(60_000);
  });

  test("a 403 on one repository is not fatal for the account", async () => {
    const r = await provider.act!(fakeCtx({ [POST]: { status: 403, body: { message: "Resource not accessible by personal access token" } } }), comment);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ code: "forbidden", fatal: false, retryable: false, outcome: "none" });
    expect(r.error.message).toContain("Resource not accessible");
  });

  test("a 5xx leaves the outcome unknown", async () => {
    const r = await provider.act!(fakeCtx({ [POST]: { status: 502, body: { message: "Bad gateway" } } }), comment);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ retryable: true, outcome: "unknown" });
  });

  test("a target that is not owner/repo#number never reaches GitHub", async () => {
    const bad = { ...comment, action: { ...comment.action, target: { scope: "ticket" as const, native: "acme/../x#1", label: "" } } };
    const r = await provider.act!(fakeCtx({}), bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: "bad_target", outcome: "none" });
  });
});

describe("poll", () => {
  const issue = { number: 3, title: "Flaky test", user: { login: "bob" }, html_url: "https://github.com/acme/api/issues/3", repository_url: "https://api.github.com/repos/acme/api", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-09-21T10:00:00Z" };
  const timeline = [
    { event: "commented", id: 11, user: { login: "bob" }, body: "@acme/platform please look", created_at: "2026-09-21T10:00:00Z", html_url: "https://github.com/acme/api/issues/3#issuecomment-11" },
    { event: "commented", id: 12, user: { login: "bob" }, body: "run `@alice-bot deploy` then\n```\n@alice\n```\n@carol ok?", created_at: "2026-09-21T10:01:00Z", html_url: "https://github.com/acme/api/issues/3#issuecomment-12" },
    { event: "commented", id: 13, user: { login: "bob" }, body: "thanks @Alice.", created_at: "2026-09-21T10:02:00Z", html_url: "https://github.com/acme/api/issues/3#issuecomment-13" },
  ];
  const since = Date.parse("2026-09-21T09:00:00Z");
  const q = (qualifier: string) => `GET /search/issues?${new URLSearchParams({ q: `${qualifier} updated:>=2026-09-21T09:00:00Z`, sort: "updated", order: "desc", per_page: "100" })}`;
  const ctx = fakeCtx(
    {
      [q("involves:@me")]: { body: { total_count: 1, items: [issue] } },
      [q("review-requested:@me")]: { body: { total_count: 0, items: [] } },
      "GET /repos/acme/api/issues/3/timeline?per_page=100&page=1": { body: timeline },
    },
    { teams: ["acme/platform"] },
  );

  test("a team mention is the person's, a mention in code is not, and logins compare without case", async () => {
    const r = await provider.poll!(ctx, null, { since, maxItems: 50 });
    const by = (id: string) => r.items.find((i) => i.id === id) as Item;
    expect(by("acme/api#3/c11")).toMatchObject({ mentionsMe: true, targetsOther: false, reason: "mentioned" });
    expect(by("acme/api#3/c12")).toMatchObject({ mentionsMe: false, targetsOther: true });
    expect(by("acme/api#3/c13")).toMatchObject({ mentionsMe: true });
    expect(r.complete).toBe(true);
  });

  test("a capped pass keeps the newest and says so", async () => {
    const r = await provider.poll!(ctx, null, { since, maxItems: 1 });
    expect(r.items.map((i) => i.id)).toEqual(["acme/api#3/c13"]);
    expect(r.complete).toBe(false);
    expect(r.cursor.at).toBe(Date.parse("2026-09-21T10:02:00Z"));
  });
});

describe("context", () => {
  const issue = { number: 3, title: "Flaky test", user: { login: "bob" }, html_url: "https://github.com/acme/api/issues/3", repository_url: "https://api.github.com/repos/acme/api", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-09-21T10:00:00Z" };
  /** A timeline of `pages` pages, one comment each, page n written at minute n. */
  const paged = (pages: number) => {
    const routes: Record<string, Answer> = { "GET /repos/acme/api/issues/3": { body: issue } };
    for (let n = 1; n <= pages; n++) {
      const link = n === 1 ? `<https://api.github.com/repositories/1/issues/3/timeline?per_page=100&page=${pages}>; rel="last"` : "";
      routes[`GET /repos/acme/api/issues/3/timeline?per_page=100&page=${n}`] = { headers: link ? { link } : {}, body: [{ event: "commented", id: n, user: { login: "bob" }, body: `page ${n}`, created_at: `2026-09-21T10:0${n}:00Z` }] };
    }
    return fakeCtx(routes);
  };

  test("a long timeline keeps its newest pages, never page 1 across a gap, and says it is not complete", async () => {
    const five = await provider.context!(paged(5), "acme/api#3", { max: 50 });
    expect(five.items.map((i) => i.id)).toEqual(["acme/api#3/body", "acme/api#3/c3", "acme/api#3/c4", "acme/api#3/c5"]);
    expect(five.complete).toBe(false);
    const four = await provider.context!(paged(4), "acme/api#3", { max: 50 });
    expect(four.items.map((i) => i.id)).toEqual(["acme/api#3/body", "acme/api#3/c1", "acme/api#3/c2", "acme/api#3/c3", "acme/api#3/c4"]);
    expect(four.complete).toBe(true);
  });
});

describe("parseTarget", () => {
  const topic = { thread: "acme/api#12", conversation: { id: "acme/api", label: "acme/api" } };
  const account = fakeCtx({}).account;
  const native = (s: string) => {
    const t = provider.parseTarget!(s, topic, account);
    return "native" in t ? t.native : null;
  };

  test("ids, keys, links and bare numbers in the topic's repository", () => {
    expect(native("acme/web#7")).toBe("acme/web#7");
    expect(native("github:acme/web#7")).toBe("acme/web#7");
    expect(native("https://github.com/acme/web/pull/7/files")).toBe("acme/web#7");
    expect(native("https://github.com/acme/web/issues/7#issuecomment-5")).toBe("acme/web#7");
    expect(native("#31")).toBe("acme/api#31");
  });

  test("anything else is an error, never a guess", () => {
    expect(native("acme/web")).toBeNull();
    expect(native("https://example.com/acme/web/issues/7")).toBeNull();
    expect(native("acme/..#7")).toBeNull();
  });
});
