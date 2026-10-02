/**
 * The Linear provider (docs/design/providers.md, sections 12.2 and 15, linear): its pure model, then the provider and
 * its writes against a fake Linear (test-linear.ts: a fetch answering Strato's GraphQL operations, no network), each
 * scenario in its own process on a rig, since the state folder is fixed when app/env.ts is imported.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyItem, NO_RULES } from "./core/triage.ts";
import { identityOf, issueContext, linearDeepLink, type LinearIssue, notificationItem, pickAssignee, pickState, readCursor, stableUuid, threadedComments, ticketOfNative } from "./providers/linear/model.ts";
import { cleanupRigs, type Rig, rig, run, SCRIPTS } from "./test-rig.ts";

afterEach(cleanupRigs);

const issue = { id: "iss-12", identifier: "ENG-12", title: "Checkout fails", url: "https://linear.app/acme/issue/ENG-12/checkout-fails", team: { key: "ENG", name: "Engineering" }, state: { name: "In Progress" } };
const bob = { id: "u-bob", name: "Bob Stone", displayName: "bob" };
const comment = { id: "c1", body: "@alice can you look?", url: "https://linear.app/acme/issue/ENG-12/checkout-fails#comment-c1", createdAt: "2026-09-30T08:05:00.000Z", user: bob };
const note = (type: string, o: Record<string, unknown> = {}) => ({ id: "n1", type, createdAt: "2026-09-30T08:06:00.000Z", actor: bob, issue, comment, ...o });

describe("the Linear model", () => {
  test("each notification type becomes the item triage reads, or nothing", () => {
    const mention = notificationItem(note("issueCommentMention"), "u-alice");
    expect(mention).toMatchObject({ thread: "ENG-12", id: "ENG-12/comment/c1", event: "comment", mentionsMe: true, reason: "mentioned", text: "@alice can you look?", title: "Checkout fails", link: comment.url, author: { id: "u-bob", name: "bob", isMe: false, isBot: false }, conversation: { id: "ENG", label: "Linear ENG", kind: "ticket" } });
    expect(notificationItem(note("issueNewComment"), "u-alice")).toMatchObject({ id: "ENG-12/comment/c1", mentionsMe: false, reason: "subscribed" });
    expect(notificationItem(note("issueAssignedToYou", { comment: null }), "u-alice")).toMatchObject({ id: "ENG-12/event/n1", event: "assigned", mentionsMe: true, text: "assigned to you", link: issue.url });
    expect(notificationItem(note("issueStatusChanged", { comment: null }), "u-alice")).toMatchObject({ event: "status", text: "status: In Progress" });
    expect(notificationItem(note("issueMention", { comment: null }), "u-alice")).toMatchObject({ event: "created", mentionsMe: true });
    for (const skipped of ["issueEmojiReaction", "issueCommentReaction", "issueUnassignedFromYou", "projectUpdateCreated"]) expect(notificationItem(note(skipped), "u-alice")).toBeNull();
    // an integration writes as a bot; the person's own comment is theirs
    expect(notificationItem(note("issueNewComment", { comment: { ...comment, user: null, botActor: { name: "GitHub" } } }), "u-alice")?.author).toEqual({ id: "", name: "GitHub", isMe: false, isBot: true });
    expect(notificationItem(note("issueNewComment"), "u-bob")?.author.isMe).toBe(true);
  });

  test("the triage of tickets: assigned or mentioned raises, a followed ticket is a thread, a bot or a status goes aside", () => {
    const kind = (type: string, o: Record<string, unknown> = {}) => {
      const it = notificationItem(note(type, o), "u-alice");
      return it ? classifyItem(it, "linear:ENG-12", NO_RULES, new Set(), new Set()) : "skipped";
    };
    expect(kind("issueAssignedToYou", { comment: null })).toBe("mention");
    expect(kind("issueCommentMention")).toBe("mention");
    expect(kind("issueNewComment")).toBe("fil");
    expect(kind("issueStatusChanged", { comment: null })).toBeNull();
    expect(kind("issueNewComment", { comment: { ...comment, user: null, botActor: { name: "GitHub" } } })).toBe("bot");
    expect(kind("issueAssignedToYou", { comment: null, actor: null, botActor: { name: "Triage rotation" } })).toBe("mention");
  });

  test("an issue for a session: its fields, the description first, then the comments threaded", () => {
    const full: LinearIssue = {
      ...issue,
      description: "The checkout returns a 500.",
      createdAt: "2026-09-30T08:00:00.000Z",
      priorityLabel: "High",
      assignee: null,
      creator: bob,
      labels: { nodes: [{ name: "bug" }, { name: "checkout" }] },
      comments: {
        nodes: [
          { id: "c3", body: "A second thread.", createdAt: "2026-09-30T08:09:00.000Z", user: bob },
          { id: "c2", body: "Same on staging.", createdAt: "2026-09-30T08:07:00.000Z", user: { id: "u-carol", name: "Carol Smith", displayName: "carol" }, parent: { id: "c1" } },
          comment,
        ],
      },
    };
    const r = issueContext(full, 200);
    expect(r.fields).toEqual({ status: "In Progress", assignee: "none", labels: "bug, checkout", priority: "High" });
    expect(r.items.map((i) => [i.id, i.author])).toEqual([
      ["ENG-12", "bob"],
      ["ENG-12/comment/c1", "bob"],
      ["ENG-12/comment/c2", "carol (reply)"],
      ["ENG-12/comment/c3", "bob"],
    ]);
    expect(r).toMatchObject({ thread: "ENG-12", title: "Checkout fails", conversation: { id: "ENG", kind: "ticket" }, complete: true });
    // a cap keeps the newest comments, and says it stopped
    expect(issueContext(full, 1).items.map((i) => i.id)).toEqual(["ENG-12", "ENG-12/comment/c3"]);
    expect(issueContext(full, 1).complete).toBe(false);
    expect(threadedComments([]).length).toBe(0);
  });

  test("identity, cursors, targets, values, ids and deep links", () => {
    expect(identityOf({ viewer: bob, organization: { name: "Acme", urlKey: "acme" } })).toEqual({ me: "u-bob", name: "bob", workspace: "Acme", tenant: "acme" });
    expect(identityOf({ viewer: null })).toBeNull();
    expect(readCursor(JSON.stringify({ n: "2026-09-30T08:00:00.000Z", w: "2026-09-30T08:00:00.000Z" }))).not.toBeNull();
    expect(readCursor("1759219200")).toBeNull();
    expect(readCursor(JSON.stringify({ n: "x", w: "y" }))).toBeNull();
    expect(ticketOfNative("ENG-12")).toEqual({ issue: "ENG-12", comment: null });
    expect(ticketOfNative("ENG-12/comment/c0000001")).toEqual({ issue: "ENG-12", comment: "c0000001" });
    expect(ticketOfNative("ENG-12; rm -rf")).toBeNull();
    const users = [{ ...bob, email: "bob@acme.example" }, { id: "u-bob2", name: "Bob Stone", displayName: "bobby", email: "bob2@acme.example" }, { id: "u-gone", name: "Gone", displayName: "gone", email: "gone@acme.example", active: false }];
    expect(pickAssignee("me", users, "u-alice")).toEqual({ id: "u-alice" });
    expect(pickAssignee("none", users, "u-alice")).toEqual({ id: null });
    expect(pickAssignee("BOB@acme.example", users, "u-alice")).toEqual({ id: "u-bob" });
    expect(pickAssignee("@bob", users, "u-alice")).toEqual({ id: "u-bob" });
    expect(pickAssignee("Bob Stone", users, "u-alice")).toMatchObject({ error: expect.stringContaining("several") });
    expect(pickAssignee("gone", users, "u-alice")).toMatchObject({ error: expect.stringContaining("no Linear user") });
    expect(pickState("in progress", [{ id: "s1", name: "In Progress" }])).toEqual({ id: "s1", name: "In Progress" });
    expect(pickState("Shipped", [{ id: "s1", name: "In Progress" }])).toBeNull();
    // the same Go gives the same id, another attempt another one; always a UUID v4 shape
    const a = stableUuid("linear:ENG-12#t1#3f9a1c0be27d#1");
    expect(a).toBe(stableUuid("linear:ENG-12#t1#3f9a1c0be27d#1"));
    expect(a).not.toBe(stableUuid("linear:ENG-12#t1#3f9a1c0be27d#2"));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const account = { provider: "linear", id: "default", label: "acme", auth: "api-key", ingest: "poll" as const, settings: {} };
    expect(linearDeepLink(issue.url, account)).toBeNull();
    expect(linearDeepLink(`${issue.url}#comment-c1`, { ...account, settings: { desktopApp: true } })).toBe("linear://linear.app/acme/issue/ENG-12/checkout-fails#comment-c1");
    expect(linearDeepLink("https://evil.example/acme/issue/ENG-12", { ...account, settings: { desktopApp: true } })).toBeNull();
  });
});

// ------------------------------------------------------------------ the provider against the fake Linear

const config = (r: Rig, raw: unknown) => writeFileSync(join(r.state, "config.json"), JSON.stringify(raw));

/** A profile with Slack, the tracker section and a connected Linear account whose secrets are in the rig. */
function linearRig(account: Record<string, unknown> = { auth: "api-key" }, secrets = "LINEAR_API_KEY=lin_api_acme_good\n", extra: Record<string, unknown> = {}): Rig {
  const r = rig();
  const file = join(r.dir, "linear.env");
  writeFileSync(file, secrets, { mode: 0o600 });
  config(r, { owner: { name: "Alice" }, slack: { team: "Acme", workspace: "acme", me: "UALICE" }, tracker: { kind: "linear", workspace: "acme", prefixes: ["ENG", "OPS"] }, providers: { linear: { accounts: { default: { secretsFile: file, ...account } } } }, ...extra });
  return r;
}

/**
 * Runs a script with the registry, the Linear provider and its writes, and a fake Linear (`state`, from `fake`), in the
 * rig's state: its result, and the fake's state after it.
 */
async function script(r: Rig, fake: string, body: string): Promise<{ result: any; state: any }> {
  const path = join(r.dir, `s${Math.random().toString(36).slice(2, 8)}.ts`);
  writeFileSync(
    path,
    [
      `import * as registry from ${JSON.stringify(join(SCRIPTS, "providers/registry.ts"))};`,
      `import { linearProvider as linear } from ${JSON.stringify(join(SCRIPTS, "providers/linear/index.ts"))};`,
      `import { linearWrites as writes } from ${JSON.stringify(join(SCRIPTS, "providers/linear/act.ts"))};`,
      `import { acmeLinear, fakeLinear, T0 } from ${JSON.stringify(join(SCRIPTS, "test-linear.ts"))};`,
      `const state = (() => { ${fake} })();`,
      "const entry = registry.accountOf(\"linear\", \"default\");",
      "const ctx = (identity = null) => registry.accountContext(entry, { fetchImpl: fakeLinear(state), identity });",
      `const result = await (async () => { ${body} })();`,
      `process.stdout.write(JSON.stringify({ result, state }));`,
    ].join("\n"),
  );
  const res = await run(r, [path]);
  if (res.code !== 0) throw new Error(res.err || res.out);
  return JSON.parse(res.out);
}

const ME = `{ me: "u-alice", name: "alice", workspace: "Acme", tenant: "acme" }`;
const catching = (expr: string) => `try { return await ${expr}; } catch (e) { return { thrown: e }; }`;

describe("reading Linear", () => {
  test("an API key goes as is, an OAuth token with Bearer, renewed once when Linear refuses it, both tokens stored again", async () => {
    const r = linearRig();
    const key = await script(r, "return acmeLinear();", "return await linear.connect(ctx());");
    expect(key.result).toEqual({ me: "u-alice", name: "alice", workspace: "Acme", tenant: "acme" });
    expect(key.state.log.map((l: any) => [l.op, l.auth])).toEqual([["StratoViewer", "lin_api_acme_good"]]);

    const o = linearRig({ auth: "oauth-pkce", clientId: "client-acme" }, "LINEAR_ACCESS_TOKEN=tok-expired\nLINEAR_REFRESH_TOKEN=ref-1\n");
    const oauth = await script(o, `return acmeLinear({ refresh: { token: "ref-1", clientId: "client-acme", access: "tok-new", next: "ref-2" } });`, "return await linear.connect(ctx());");
    expect(oauth.result.me).toBe("u-alice");
    expect(oauth.state.log.map((l: any) => [l.op, l.auth])).toEqual([
      ["StratoViewer", "Bearer tok-expired"],
      ["token", ""],
      ["StratoViewer", "Bearer tok-new"],
    ]);
    expect(oauth.state.log[1].variables).toEqual({ grant_type: "refresh_token", refresh_token: "ref-1", client_id: "client-acme" });
    const file = join(o.dir, "linear.env");
    expect(readFileSync(file, "utf8")).toContain("LINEAR_ACCESS_TOKEN=tok-new");
    expect(readFileSync(file, "utf8")).toContain("LINEAR_REFRESH_TOKEN=ref-2");
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // a key Linear refuses, a refresh token it no longer takes, another workspace: fatal, the account needs setup again
    const bad = await script(linearRig({ auth: "api-key" }, "LINEAR_API_KEY=lin_api_revoked\n"), "return acmeLinear();", catching("linear.connect(ctx())"));
    expect(bad.result.thrown).toMatchObject({ code: "invalid_auth", fatal: true });
    const stale = await script(linearRig({ auth: "oauth-pkce", clientId: "client-acme" }, "LINEAR_ACCESS_TOKEN=tok-expired\nLINEAR_REFRESH_TOKEN=ref-0\n"), `return acmeLinear({ refresh: { token: "ref-1", clientId: "client-acme", access: "tok-new", next: "ref-2" } });`, catching("linear.connect(ctx())"));
    expect(stale.result.thrown).toMatchObject({ code: "invalid_auth", fatal: true });
    const other = linearRig({ auth: "api-key", workspace: "globex" }, "LINEAR_API_KEY=lin_api_acme_good\n", { tracker: null });
    expect((await script(other, "return acmeLinear();", catching("linear.connect(ctx())"))).result.thrown).toMatchObject({ code: "wrong_workspace", fatal: true });
  }, 30_000);

  test("the rate limit: RATELIMITED waits for the reset Linear announced, and no request goes out until then", async () => {
    const r = linearRig();
    const out = await script(
      r,
      "return acmeLinear({ remaining: 0, reset: Date.now() + 600_000 });",
      `const first = await linear.connect(ctx()).catch((e) => e);
       const second = await linear.connect(ctx()).catch((e) => e);
       return { first, second };`,
    );
    expect(out.result.first).toMatchObject({ code: "rate_limited", retryable: true, fatal: false });
    expect(out.result.first.retryAfterMs).toBeGreaterThan(500_000);
    expect(out.result.second).toMatchObject({ code: "rate_limited", retryable: true });
    expect(out.state.log).toHaveLength(1);
  }, 20_000);

  test("poll: the notifications and the new issues of the watched teams since the cursor, oldest first; a capped pass keeps the oldest time read", async () => {
    const r = linearRig({ auth: "api-key", watchTeams: ["OPS"] });
    const fake = `const s = acmeLinear();
      const at = (m) => new Date(Date.parse(T0) + m * 60_000).toISOString();
      s.notifications = [
        { id: "n1", type: "issueCommentMention", createdAt: at(5), issue: "ENG-12", actor: "u-bob", comment: "c0000001-0000-4000-8000-000000000001" },
        { id: "n2", type: "issueNewComment", createdAt: at(6), issue: "ENG-12", actor: "u-carol", comment: "c0000002-0000-4000-8000-000000000002" },
        { id: "n3", type: "issueAssignedToYou", createdAt: at(7), issue: "OPS-40", actor: "u-carol" },
        { id: "n4", type: "issueEmojiReaction", createdAt: at(8), issue: "ENG-12", actor: "u-bob" },
        { id: "n5", type: "issueStatusChanged", createdAt: at(1), issue: "ENG-12", actor: "u-bob" },
      ];
      return s;`;
    const out = await script(
      r,
      fake,
      `const since = Date.parse(T0) + 2 * 60_000;
       const full = await linear.poll(ctx(${ME}), null, { since, maxItems: 100 });
       const again = await linear.poll(ctx(${ME}), full.cursor, { since, maxItems: 100 });
       const capped = await linear.poll(ctx(${ME}), null, { since, maxItems: 2 });
       return { full, again, capped };`,
    );
    const { full, again, capped } = out.result;
    expect(full.items.map((i: any) => [i.id, i.event, i.reason])).toEqual([
      ["ENG-12/comment/c0000001-0000-4000-8000-000000000001", "comment", "mentioned"],
      ["ENG-12/comment/c0000002-0000-4000-8000-000000000002", "comment", "subscribed"],
      ["OPS-40/event/n3", "assigned", "assigned"],
    ]);
    expect(full.complete).toBe(true);
    const cursor = JSON.parse(full.cursor.value);
    expect(cursor.n).toBe("2026-09-30T08:08:00.000Z");
    // the watched team's issues: OPS-40 was created before the window, nothing new there; the cursor never goes back
    expect(Date.parse(cursor.w)).toBeGreaterThanOrEqual(Date.parse("2026-09-30T08:02:00.000Z"));
    // the next pass reads from a minute before the cursor: nothing new, the core's seen drops repeats
    expect(again.items).toEqual([]);
    // capped at two notifications: the oldest read is the newest-but-one, the backlog older than it is dropped
    expect(capped.complete).toBe(false);
    expect(JSON.parse(capped.cursor.value).n).toBe("2026-09-30T08:07:00.000Z");
    const ops = out.state.log.filter((l: any) => l.op === "StratoWatched");
    expect(ops[0].variables).toMatchObject({ teams: ["OPS"] });
  }, 20_000);

  test("a new issue of a watched team is a canal item; replies, participation and context read the issue", async () => {
    const r = linearRig({ auth: "api-key", watchTeams: ["OPS"] });
    const out = await script(
      r,
      `const s = acmeLinear(); s.issues[1].createdAt = new Date(Date.parse(T0) + 30 * 60_000).toISOString(); s.issues[0].assignee = "u-alice"; return s;`,
      `const created = await linear.poll(ctx(${ME}), null, { since: Date.parse(T0) + 10 * 60_000, maxItems: 50 });
       const replies = await linear.replies(ctx(${ME}), "ENG-12", { since: Date.parse(T0) + 5.5 * 60_000, max: 10 });
       const mine = await linear.participated(ctx(${ME}), 7);
       const read = await linear.context(ctx(${ME}), "ENG-12/comment/c0000001", { max: 200 });
       const missing = await linear.context(ctx(${ME}), "ENG-404", { max: 200 }).catch((e) => e);
       return { created: created.items, replies, mine, read, missing };`,
    );
    const { created, replies, mine, read, missing } = out.result;
    expect(created.map((i: any) => [i.id, i.event, i.reason, i.conversation.id])).toEqual([["OPS-40/event/created", "created", "watched", "OPS"]]);
    expect(classifyItem(created[0], "linear:OPS-40", { ...NO_RULES, watch: ["OPS"] }, new Set(), new Set())).toBe("canal");
    expect(replies.map((i: any) => [i.id, i.author.name])).toEqual([["ENG-12/comment/c0000002-0000-4000-8000-000000000002", "carol"]]);
    expect(mine).toEqual(["ENG-12"]);
    expect(read.fields).toMatchObject({ status: "Todo", assignee: "alice", labels: "bug", priority: "High" });
    expect(read.items.map((i: any) => i.author)).toEqual(["bob", "bob", "carol (reply)"]);
    expect(missing).toMatchObject({ code: "not_found", retryable: false, fatal: false });
  }, 20_000);
});

describe("writing to Linear, behind the gate", () => {
  const act = (input: string) => `await writes.act(ctx(${ME}), ${input})`;
  const target = `{ scope: "ticket", native: "ENG-12", label: "ENG-12" }`;

  test("a comment carries an id derived from the Go: a replay after a cut connection finds it, Undo deletes it, a resend gets a new id", async () => {
    const r = linearRig();
    const out = await script(
      r,
      `const s = acmeLinear(); s.cutAfter = "StratoCommentCreate"; return s;`,
      `const go = { action: { kind: "comment", target: ${target}, text: "Looking at it now." }, idempotencyKey: "linear:ENG-12#t1#3f9a1c0be27d#1", dryRun: false };
       const cut = ${act("go")};
       const replay = ${act("go")};
       const undo = await writes.undo(ctx(${ME}), replay.undo.token);
       const resend = ${act('{ ...go, idempotencyKey: "linear:ENG-12#t1#3f9a1c0be27d#2" }')};
       const reply = ${act('{ action: { kind: "comment", target: { scope: "ticket", native: "ENG-12/comment/c0000001", label: "ENG-12" }, text: "Fixed." }, idempotencyKey: "linear:ENG-12#t2#aaaaaaaaaaaa#1", dryRun: false }')};
       const dry = ${act("{ ...go, idempotencyKey: \"x\", dryRun: true }")};
       return { cut, replay, undo, resend, reply, dry };`,
    );
    const { cut, replay, undo, resend, reply, dry } = out.result;
    expect(cut).toMatchObject({ ok: false, error: { code: "network", outcome: "unknown" } });
    expect(replay).toMatchObject({ ok: true, ref: expect.stringMatching(/^ENG-12\/comment\/[0-9a-f-]{36}$/), link: expect.stringMatching(/^https:\/\/linear\.app\/acme\/issue\/ENG-12\/slug#comment-/) });
    expect(replay.undo.token).toMatch(/^comment:/);
    expect(undo).toMatchObject({ ok: true });
    expect(resend.ok).toBe(true);
    expect(resend.ref).not.toBe(replay.ref);
    expect(dry).toMatchObject({ ok: true, dry: expect.stringContaining("comment on ENG-12") });
    expect(reply).toMatchObject({ ok: true, ref: expect.stringMatching(/^ENG-12\/comment\//) });
    const creates = out.state.log.filter((l: any) => l.op === "StratoCommentCreate");
    expect(creates).toHaveLength(4);
    expect(creates[0].variables.input.id).toBe(creates[1].variables.input.id);
    expect(creates[2].variables.input.id).not.toBe(creates[0].variables.input.id);
    expect(creates[3].variables.input.parentId).toBe("c0000001-0000-4000-8000-000000000001");
    const eng12 = out.state.issues[0].comments.map((c: any) => c.body);
    // the cut comment was created once, deleted by Undo; the resend and the reply are there
    expect(eng12.filter((b: string) => b === "Looking at it now.")).toHaveLength(1);
    expect(eng12).toContain("Fixed.");
  }, 20_000);

  test("a status and an assignee by name, each put back by Undo; an unknown status or person writes nothing", async () => {
    const r = linearRig();
    const out = await script(
      r,
      "return acmeLinear();",
      `const status = ${act(`{ action: { kind: "setStatus", target: ${target}, status: "in progress" }, idempotencyKey: "k1", dryRun: false }`)};
       const afterStatus = state.issues[0].state;
       const undoStatus = await writes.undo(ctx(${ME}), status.undo.token);
       const assign = ${act(`{ action: { kind: "assign", target: ${target}, assignee: "bob@acme.example" }, idempotencyKey: "k2", dryRun: false }`)};
       const afterAssign = state.issues[0].assignee;
       const undoAssign = await writes.undo(ctx(${ME}), assign.undo.token);
       const me = ${act(`{ action: { kind: "assign", target: ${target}, assignee: "me" }, idempotencyKey: "k3", dryRun: false }`)};
       const unknownStatus = ${act(`{ action: { kind: "setStatus", target: ${target}, status: "Shipped" }, idempotencyKey: "k4", dryRun: false }`)};
       const unknownPerson = ${act(`{ action: { kind: "assign", target: ${target}, assignee: "mallory" }, idempotencyKey: "k5", dryRun: false }`)};
       const missing = ${act(`{ action: { kind: "setStatus", target: { scope: "ticket", native: "ENG-404", label: "ENG-404" }, status: "Done" }, idempotencyKey: "k6", dryRun: false }`)};
       const react = ${act(`{ action: { kind: "react", target: ${target}, emoji: "+1" }, idempotencyKey: "k7", dryRun: false }`)};
       return { status, afterStatus, undoStatus, assign, afterAssign, undoAssign, me, unknownStatus, unknownPerson, missing, react };`,
    );
    const x = out.result;
    expect(x.status).toMatchObject({ ok: true, ref: "ENG-12", link: "https://linear.app/acme/issue/ENG-12/slug", undo: { token: "state:iss-12:st-todo" } });
    expect(x.afterStatus).toBe("st-progress");
    expect(x.undoStatus.ok).toBe(true);
    expect(x.assign.undo.token).toBe("assignee:iss-12:-");
    expect(x.afterAssign).toBe("u-bob");
    expect(x.undoAssign.ok).toBe(true);
    expect(x.me.ok).toBe(true);
    expect(out.state.issues[0]).toMatchObject({ state: "st-todo", assignee: "u-alice" });
    expect(x.unknownStatus).toMatchObject({ ok: false, error: { code: "not_found", outcome: "none", message: expect.stringContaining("Todo, In Progress, Done") } });
    expect(x.unknownPerson).toMatchObject({ ok: false, error: { code: "not_found", outcome: "none" } });
    expect(x.missing).toMatchObject({ ok: false, error: { outcome: "none" } });
    expect(x.react).toMatchObject({ ok: false, error: { code: "unsupported", outcome: "none" } });
    expect(out.state.log.filter((l: any) => l.op === "StratoIssueUpdate")).toHaveLength(5);
  }, 20_000);
});
