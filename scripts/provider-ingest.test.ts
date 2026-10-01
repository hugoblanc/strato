/**
 * Ingest through providers with fake tools next to Slack (docs/design/providers.md, section 15, ingest): two sources
 * feed the same triage, a tool that fails never holds the others back, the cursor contract of section 4.8, the
 * catch-up of tracked threads, hostile strings kept on one line, and a named Slack account read with its own token.
 * The state folder is fixed when app/env.ts is imported, so each scenario runs in its own process on a rig.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { events, goldenRig, runUntil, stdout } from "./ingest-fixture.ts";
import { cleanupRigs, lines, type Rig, rig, run, SCRIPTS, sujet, writeSujets } from "./test-rig.ts";

afterEach(cleanupRigs);

const config = (r: Rig, raw: unknown) => writeFileSync(join(r.state, "config.json"), JSON.stringify(raw));
const PROFILE = {
  owner: { name: "Alice" },
  slack: { team: "Acme", workspace: "acme", me: "UALICE" },
  providers: { tickets: { accounts: { default: { me: "u-alice", watchTeams: ["PLAT"], ignoreAuthors: ["Deploy Bot"] } } } },
  refresh: { auto: false },
  gc: { everyMinutes: 0 },
};
const imports = [
  `import * as registry from ${JSON.stringify(join(SCRIPTS, "providers/registry.ts"))};`,
  `import * as ingest from ${JSON.stringify(join(SCRIPTS, "app/ingest.ts"))};`,
  `import { fakeProvider, ticketItem } from ${JSON.stringify(join(SCRIPTS, "test-provider.ts"))};`,
  `import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";`,
  `import { join } from "node:path";`,
];

/** Runs a script with the registry, the ingest engine and the fake provider imported, in the rig's state: its lines and its result. */
async function script(r: Rig, body: string, extra: Record<string, string> = {}): Promise<{ lines: string[]; result: any; err: string }> {
  const path = join(r.dir, `s${Math.random().toString(36).slice(2, 8)}.ts`);
  writeFileSync(path, [...imports, `const result = await (async () => { ${body} })();`, `process.stdout.write("@@result " + JSON.stringify(result ?? null) + "\\n");`].join("\n"));
  const res = await run(r, [path], extra);
  if (res.code !== 0) throw new Error(res.err || res.out);
  const all = res.out.split("\n").filter(Boolean);
  const last = all.find((l) => l.startsWith("@@result ")) ?? "@@result null";
  return { lines: all.filter((l) => !l.startsWith("@@result ")), result: JSON.parse(last.slice("@@result ".length)), err: res.err };
}

/** The account's cursor written before the scenario: its first pass then reads instead of marking history as read. */
function cursorFor(r: Rig, folder: string, value: string, at: number): void {
  mkdirSync(join(r.state, "providers", folder), { recursive: true });
  writeFileSync(join(r.state, "providers", folder, "ingest.json"), JSON.stringify({ cursor: { value, at } }));
}

/** The topic a ticket opened; B carries the conversation it came from, as `open --msg` writes it. */
const ticketTopics = (r: Rig) =>
  writeSujets(r, [
    sujet({ key: "tickets:PLAT-12", threads: ["tickets:PLAT-12"], letter: "A", title: "Checkout fails", channel: "Tickets PLAT", permalink: "https://tickets.example/t/PLAT-12" }),
    sujet({ key: "tickets:PLAT-20", threads: ["tickets:PLAT-20"], letter: "B", title: "Invoice export", channel: "Tickets PLAT", permalink: "https://tickets.example/t/PLAT-20", conversation: "tickets:PLAT", sessionId: null, shortId: null }),
  ]);

/** A source of the fake account, connected, with its cursor. */
const SOURCE = `
  const entry = registry.accountOf("tickets", "default");
  const src = ingest.sourceOf(entry, await fake.connect(registry.accountContext(entry)), ingest.accountSeen(entry.account));
  const run = { src, cursor: ingest.readCursor(entry.account) };
`;

describe("two sources, one triage", () => {
  test("Slack messages and a ticket tool's items come out as the same lines, and the log tells them apart", async () => {
    const r = rig();
    config(r, PROFILE);
    ticketTopics(r);
    cursorFor(r, "tickets-default", "c0", 1_790_000_000_000);
    const out = await script(
      r,
      `
      const fake = fakeProvider({ id: "tickets", label: "Tickets", polls: [{ items: [
        ticketItem(),
        ticketItem({ thread: "PLAT-13", id: "PLAT-13", event: "created", title: "Refund for Globex", text: "order 4412" }),
        ticketItem({ thread: "OPS-1", id: "OPS-1/assigned", event: "assigned", conversation: { id: "OPS", label: "Tickets OPS", kind: "ticket" }, mentionsMe: true, text: "assigned to you" }),
        ticketItem({ thread: "PLAT-14", id: "PLAT-14/status", event: "status", text: "Done" }),
        ticketItem({ thread: "PLAT-15", id: "PLAT-15", event: "created", author: { id: "u-deploy", name: "Deploy Bot", isMe: false, isBot: true }, text: "nightly export" }),
      ], cursor: { value: "c1", at: 1790000200000 }, complete: true }] });
      registry.addProvider(fake);
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        const body = url.pathname.endsWith("users.info") ? { ok: true, user: { profile: { display_name: url.searchParams.get("user") === "UBOB" ? "Bob" : "Alice Martin" } } } : { ok: true };
        return Response.json(body);
      };
      await ingest.processMatches([{ ts: "1790000150.000100", user: "UBOB", text: "<@UALICE> can you check the refund?", channel: { id: "C0ACME0007", name: "acme-sales" }, permalink: "https://acme.slack.com/archives/C0ACME0007/p1790000150000100" }], { me: "UALICE", subteams: [], watchChannels: [], ignoreChannels: [], ignoreAuthors: [] }, new Set(), new Set());
      ${SOURCE}
      await ingest.pollPass(run);
      return { cursor: run.cursor, onDisk: ingest.readCursor(entry.account), seen: Object.keys(JSON.parse(readFileSync(join(registry.accountDir(entry.account), "seen.json"), "utf8"))).sort() };
    `,
    );
    const [slack, suite, canal, mention, ...rest] = out.lines;
    expect(rest).toEqual([]);
    expect(slack).toStartWith("[strato] mention · #acme-sales · Bob · key=C0ACME0007:1790000150.000100 · msg=");
    expect(suite).toMatch(/^\[strato\] suite · Tickets PLAT · Bob · key=tickets:PLAT-12 · msg=[0-9a-f]{12} · topic A s0 \(waiting\) · « the checkout fails again » · https:\/\/tickets\.example\/t\/PLAT-12$/);
    expect(canal).toMatch(/^\[strato\] canal · Tickets PLAT · Bob · key=tickets:PLAT-13 · msg=[0-9a-f]{12} · open topics in this channel: B « Invoice export » · « Refund for Globex: order 4412 » · https:\/\/tickets\.example\/t\/PLAT-13$/);
    expect(mention).toStartWith("[strato] mention · Tickets OPS · Bob · key=tickets:OPS-1 · msg=");
    const log = events(r).map((l) => JSON.parse(l));
    expect(log.map((e) => `${e.type} ${e.kind} ${e.key}`)).toEqual(["slack mention C0ACME0007:1790000150.000100", "item suite tickets:PLAT-12", "item canal tickets:PLAT-13", "item mention tickets:OPS-1", "info bot tickets:PLAT-15"]);
    expect(log[0]).not.toHaveProperty("conversation");
    expect(log[1].conversation).toBe("tickets:PLAT");
    expect(out.result.cursor).toEqual({ value: "c1", at: 1_790_000_200_000 });
    expect(out.result.onDisk).toEqual(out.result.cursor);
    // every item handled, the status change on an untracked ticket included, is remembered by its key
    expect(out.result.seen).toEqual(["tickets:OPS-1/assigned", "tickets:PLAT-12/comment/1", "tickets:PLAT-13", "tickets:PLAT-14/status", "tickets:PLAT-15"]);
  });

  test("open --msg opens a topic on an item's key when its link was not kept, with the conversation it came from", async () => {
    const r = rig();
    config(r, PROFILE);
    cursorFor(r, "tickets-default", "c0", 1_790_000_000_000);
    const out = await script(
      r,
      `
      registry.addProvider(fakeProvider({ id: "tickets", label: "Tickets", polls: [{ items: [ticketItem({ thread: "OPS-7", id: "OPS-7/assigned", event: "assigned", conversation: { id: "OPS", label: "Tickets OPS", kind: "ticket" }, mentionsMe: true, link: "https://elsewhere.example/OPS-7" })], cursor: { value: "c1", at: 1 }, complete: true }] }));
      const fake = registry.accountOf("tickets", "default").provider;
      ${SOURCE}
      await ingest.pollPass(run);
    `,
    );
    expect(out.lines).toHaveLength(1);
    const msg = out.lines[0].match(/msg=([0-9a-f]{12})/)?.[1] as string;
    expect(out.lines[0]).toEndWith(" · -");
    const opened = await run(r, [join(SCRIPTS, "strato.ts"), "open", "--msg", msg, "--title", "OPS-7 assigned"]);
    expect(opened.code).toBe(0);
    const topics = JSON.parse(readFileSync(join(r.state, "sujets.json"), "utf8"));
    expect(topics[0]).toMatchObject({ key: "tickets:OPS-7", conversation: "tickets:OPS", channel: "Tickets OPS", asker: "Bob" });
  });
});

describe("the cursor contract", () => {
  test("first pass marks history read, a failed pass moves nothing, a capped pass keeps its cursor, a replay is absorbed", async () => {
    const r = rig();
    config(r, PROFILE);
    const out = await script(
      r,
      `
      const created = (n) => ticketItem({ thread: "PLAT-" + n, id: "PLAT-" + n, event: "created", text: "ticket " + n });
      const fake = fakeProvider({ id: "tickets", label: "Tickets", polls: [
        { items: [created(30)], cursor: { value: "c1", at: 1 }, complete: true },
        { error: { code: "unavailable", message: "Tickets API down" } },
        { items: [created(30), created(31)], cursor: { value: "c2", at: 2 }, complete: false },
        { items: [created(31)], cursor: { value: "c3", at: 3 }, complete: true },
      ] });
      registry.addProvider(fake);
      ${SOURCE}
      const passes = [];
      for (let i = 0; i < 4; i++) {
        let threw = null;
        try { await ingest.pollPass(run); } catch (e) { threw = e.code; }
        passes.push({ threw, cursor: run.cursor?.value ?? null, onDisk: ingest.readCursor(entry.account)?.value ?? null });
      }
      return { passes, calls: fake.calls };
    `,
    );
    expect(out.result.passes).toEqual([
      { threw: null, cursor: "c1", onDisk: "c1" },
      { threw: "unavailable", cursor: "c1", onDisk: "c1" },
      { threw: null, cursor: "c2", onDisk: "c2" },
      { threw: null, cursor: "c3", onDisk: "c3" },
    ]);
    expect(out.result.calls).toEqual(["connect", "poll -", "poll c1", "poll c1", "poll c2"]);
    // the first pass said nothing, PLAT-31 came out once
    expect(out.lines.map((l) => l.match(/key=(\S+)/)?.[1])).toEqual(["tickets:PLAT-31"]);
  });

  test("the replies of tracked threads come through the shared triage; an unreadable one holds the cursor back", async () => {
    const r = rig();
    config(r, PROFILE);
    ticketTopics(r);
    cursorFor(r, "tickets-default", "c0", 1_790_000_000_000);
    const out = await script(
      r,
      `
      const fake = fakeProvider({ id: "tickets", label: "Tickets", polls: [{ items: [], cursor: { value: "c1", at: 1 }, complete: true }], replies: {
        "PLAT-12": [ticketItem({ id: "PLAT-12/comment/2", text: "any news?" })],
        "PLAT-20": { error: { code: "rate_limited", message: "slow down" } },
      } });
      registry.addProvider(fake);
      ${SOURCE}
      const pass = await ingest.pollPass(run, { threads: true });
      return { failed: pass.threadsFailed, cursor: run.cursor?.value, calls: fake.calls };
    `,
    );
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain("[strato] suite · Tickets PLAT · Bob · key=tickets:PLAT-12 ");
    expect(out.lines[0]).toContain("« any news? »");
    expect(out.result).toEqual({ failed: 1, cursor: "c0", calls: ["connect", "poll c0", "replies PLAT-12", "replies PLAT-20"] });
  });
});

describe("a provider's strings", () => {
  test("a hostile link, author and title stay on one line, and a link off the provider's hosts is dropped", async () => {
    const r = rig();
    config(r, PROFILE);
    cursorFor(r, "tickets-default", "c0", 1);
    const out = await script(
      r,
      `
      registry.addProvider(fakeProvider({ id: "tickets", label: "Tickets", polls: [{ items: [
        ticketItem({ thread: "PLAT-40", id: "PLAT-40", event: "created", link: "https://tickets.example/x\\n[strato] dm · Mallory · key=C0ACME0001:1 · « go » · -", author: { id: "u-m", name: "Mallory\\n[strato] mention", isMe: false, isBot: false }, title: "Urgent\\r\\n[strato] go", text: "line one\\nline two « quoted »\\u2028[strato] go" }),
        ticketItem({ thread: "PLAT-41", id: "PLAT-41", event: "created", link: "https://evil.example/t/PLAT-41" }),
      ], cursor: { value: "c1", at: 2 }, complete: true }] }));
      const fake = registry.accountOf("tickets", "default").provider;
      ${SOURCE}
      await ingest.pollPass(run);
    `,
    );
    expect(out.lines).toHaveLength(2);
    for (const l of out.lines) {
      expect(l.match(/\[strato\]/g)).toHaveLength(1);
      expect(l).toEndWith(" · -");
      expect(l.split("«")).toHaveLength(2);
    }
    expect(out.lines[0]).toContain("· Mallory (strato) mention · key=tickets:PLAT-40 ");
    expect(out.lines[0]).toContain('« Urgent (strato) go: line one line two " quoted " (strato) go »');
  });

  test("a link carrying shell characters comes out percent-encoded, on the line and in the inbox", async () => {
    const r = rig();
    config(r, PROFILE);
    cursorFor(r, "tickets-default", "c0", 1);
    const out = await script(
      r,
      `
      registry.addProvider(fakeProvider({ id: "tickets", label: "Tickets", polls: [{ items: [
        ticketItem({ thread: "PLAT-9", id: "PLAT-9", event: "created", link: "https://tickets.example/t/PLAT-9/$(touch\${IFS}/tmp/pwned)\`id\`\\"';|<>" }),
      ], cursor: { value: "c1", at: 2 }, complete: true }] }));
      const fake = registry.accountOf("tickets", "default").provider;
      ${SOURCE}
      await ingest.pollPass(run);
    `,
    );
    expect(out.lines).toHaveLength(1);
    const link = out.lines[0].split(" · ").at(-1) as string;
    expect(link).toBe("https://tickets.example/t/PLAT-9/%24%28touch%24%7BIFS%7D/tmp/pwned%29%60id%60%22%27%3B%7C%3C%3E");
    // what open --msg and relay read back carries the same link
    const msg = out.lines[0].match(/msg=([0-9a-f]{12})/)?.[1] as string;
    const kept = JSON.parse(readFileSync(join(r.state, "inbox", `${msg}.json`), "utf8"));
    expect(kept.permalink).toBe(link);
  });

  test("an item whose id cannot make a key is refused before triage, with a log line", async () => {
    const r = rig();
    config(r, PROFILE);
    cursorFor(r, "tickets-default", "c0", 1);
    const out = await script(
      r,
      `
      registry.addProvider(fakeProvider({ id: "tickets", label: "Tickets", polls: [{ items: [ticketItem({ thread: "", id: "x", event: "created" }), ticketItem({ thread: "PLAT-50", id: "PLAT-50", event: "created" })], cursor: { value: "c1", at: 2 }, complete: true }] }));
      const fake = registry.accountOf("tickets", "default").provider;
      ${SOURCE}
      await ingest.pollPass(run);
    `,
    );
    expect(out.lines.map((l) => l.match(/key=(\S+)/)?.[1])).toEqual(["tickets:PLAT-50"]);
    expect(out.err).toContain("[tickets] warn: item refused");
  });
});

describe("an edit", () => {
  test("a tool that reports the same edit on every overlapping poll raises it once", async () => {
    const r = rig();
    config(r, PROFILE);
    cursorFor(r, "tickets-default", "c0", 1);
    const out = await script(
      r,
      `
      const edit = ticketItem({ thread: "OPS-3", id: "OPS-3/comment/1", conversation: { id: "OPS", label: "Tickets OPS", kind: "ticket" }, mentionsMe: true, text: "@alice can you look?", edited: { before: { mentionsMe: false, targetsOther: false } } });
      registry.addProvider(fakeProvider({ id: "tickets", label: "Tickets", polls: (n) => ({ items: [edit], cursor: { value: "c" + (n + 1), at: n + 2 }, complete: true }) }));
      const fake = registry.accountOf("tickets", "default").provider;
      ${SOURCE}
      for (let i = 0; i < 3; i++) await ingest.pollPass(run);
      return Object.keys(JSON.parse(readFileSync(join(registry.accountDir(entry.account), "seen.json"), "utf8"))).sort();
    `,
    );
    expect(out.lines.map((l) => l.match(/^\[strato\] (\S+) .* key=(\S+)/)?.slice(1).join(" "))).toEqual(["mention tickets:OPS-3"]);
    expect(out.result).toEqual(["tickets:OPS-3/comment/1", "tickets:OPS-3/comment/1#edit"]);
  });

  test("the default Slack account remembers an edit for the run, and its seen.json keeps the shape older versions read", async () => {
    const r = rig();
    config(r, PROFILE);
    const out = await script(
      r,
      `
      const s = ingest.legacySeen(new Set(["C0ACME0001:1000000000.000100"]));
      s.add("C0ACME0001:1000000000.000100#edit");
      const remembered = s.has("C0ACME0001:1000000000.000100#edit");
      s.save();
      return { remembered, file: JSON.parse(readFileSync(join(process.env.STRATO_STATE, "seen.json"), "utf8")) };
    `,
    );
    expect(out.result).toEqual({ remembered: true, file: [] });
  });
});

describe("an account's own state", () => {
  test("its seen.json forgets what was handled more than three days ago", async () => {
    const r = rig();
    config(r, PROFILE);
    mkdirSync(join(r.state, "providers", "tickets-default"), { recursive: true });
    const now = Date.now();
    writeFileSync(join(r.state, "providers", "tickets-default", "seen.json"), JSON.stringify({ "tickets:OLD": now - 4 * 86_400_000, "tickets:NEW": now - 3_600_000 }));
    const out = await script(
      r,
      `
      const s = ingest.accountSeen({ provider: "tickets", id: "default" });
      const before = [s.has("tickets:OLD"), s.has("tickets:NEW")];
      s.add("tickets:NOW");
      s.save();
      return { before, after: Object.keys(JSON.parse(readFileSync(join(registry.accountDir({ provider: "tickets", id: "default" }), "seen.json"), "utf8"))).sort() };
    `,
    );
    expect(out.result).toEqual({ before: [true, true], after: ["tickets:NEW", "tickets:NOW"] });
    // the default Slack account's seen.json is untouched
    expect(existsSync(join(r.state, "seen.json"))).toBe(false);
  });
});

describe("one tool down never stops the others", () => {
  test("a failing poll retries silently and a revoked account stops, while a working one keeps delivering", async () => {
    const r = rig();
    config(r, { ...PROFILE, providers: { ...PROFILE.providers, broken: { accounts: { default: {} } }, dead: { accounts: { default: {} } } } });
    cursorFor(r, "tickets-default", "c0", 1);
    const out = await script(
      r,
      `
      const tickets = fakeProvider({ id: "tickets", label: "Tickets", polls: (n) => ({ items: [ticketItem({ thread: "PLAT-" + (100 + n), id: "PLAT-" + (100 + n), event: "created" })], cursor: { value: "c" + (n + 1), at: n + 1 }, complete: true }) });
      const broken = fakeProvider({ id: "broken", label: "Broken", polls: [{ error: { code: "unavailable", message: "Broken API down" } }] });
      const dead = fakeProvider({ id: "dead", label: "Dead", connectError: { code: "invalid_auth", message: "key revoked" } });
      for (const p of [tickets, broken, dead]) registry.addProvider(p);
      const stop = new AbortController();
      const loops = ingest.ingestAccounts().map((e) => ingest.runAccount(e, { mode: "watch", stop: stop.signal, intervalSec: 0.1 }));
      await Bun.sleep(1200);
      stop.abort();
      await Promise.all(loops);
      return { accounts: ingest.ingestAccounts().map((e) => e.account.provider), tickets: tickets.calls.length, broken: broken.calls.length, dead: dead.calls };
    `,
    );
    expect(out.result.accounts).toEqual(["tickets", "broken", "dead"]);
    expect(out.lines.filter((l) => l.includes("key=tickets:PLAT-1")).length).toBeGreaterThanOrEqual(3);
    expect(out.lines.filter((l) => l.startsWith("[strato] Broken"))).toEqual(["[strato] Broken: Broken API down · retrying silently, one line when it is back"]);
    expect(out.lines.filter((l) => l.startsWith("[strato] Dead"))).toEqual(["[strato] Dead: key revoked, listening to this account stopped"]);
    expect(out.result.broken).toBeGreaterThan(2);
    expect(out.result.dead).toEqual(["connect"]);
  });

  test("a push tool delivers as it goes and reconnects after a cut; one that will not push is polled instead", async () => {
    const r = rig();
    config(r, { ...PROFILE, providers: { chat: { accounts: { default: { me: "u-alice", watchTeams: ["PLAT"] } } }, mute: { accounts: { default: { watchTeams: ["PLAT"] } } } } });
    cursorFor(r, "chat-default", "c0", 1);
    cursorFor(r, "mute-default", "c0", 1);
    const out = await script(
      r,
      `
      const created = (n) => ticketItem({ thread: "PLAT-" + n, id: "PLAT-" + n, event: "created", text: "ticket " + n });
      const chat = fakeProvider({ id: "chat", label: "Chat", polls: [{ items: [], cursor: { value: "c1", at: 1 }, complete: true }], pushes: [
        { batches: [[], [created(400)]], end: "cut", refused: "socket closed" },
        { batches: [[created(401)]], end: "hold" },
      ] });
      const mute = fakeProvider({ id: "mute", label: "Mute", polls: (n) => ({ items: [created(500 + n)], cursor: { value: "c" + (n + 1), at: n + 1 }, complete: true }), pushes: [{ batches: [], end: "fatal", refused: "no app-level token" }] });
      registry.addProvider(chat);
      registry.addProvider(mute);
      const stop = new AbortController();
      const loops = ingest.ingestAccounts().map((e) => ingest.runAccount(e, { mode: "listen", stop: stop.signal, intervalSec: 0.1, resyncMs: 60_000 }));
      await Bun.sleep(1800);
      stop.abort();
      await Promise.all(loops);
      return { chat: chat.calls, mute: mute.calls.filter((c) => c === "subscribe").length };
    `,
    );
    expect(out.lines.filter((l) => l.includes("key=chat:PLAT-40")).map((l) => l.match(/key=(\S+)/)?.[1])).toEqual(["chat:PLAT-400", "chat:PLAT-401"]);
    expect(out.lines).toContain("[strato] Chat: socket closed · retrying silently, one line when it is back");
    expect(out.lines).toContain("[strato] Chat back after « socket closed »");
    expect(out.result.chat).toEqual(["connect", "poll c0", "subscribe", "subscribe"]);
    expect(out.lines).toContain("[strato] Mute: no app-level token · polled instead");
    expect(out.lines.filter((l) => l.includes("key=mute:PLAT-5")).length).toBeGreaterThanOrEqual(3);
    expect(out.result.mute).toBe(1);
  });

  for (const mode of ["listen", "watch"] as const) {
    test(`${mode}: a connection that throws, an identity that is not one and a malformed one never take the others down`, async () => {
      const r = rig();
      config(r, { ...PROFILE, providers: { tickets: { accounts: { default: { me: "u-alice", watchTeams: ["PLAT"] } } }, crash: { accounts: { default: { watchTeams: ["PLAT"] } } }, garbled: { accounts: { default: { watchTeams: ["PLAT"] } } }, hollow: { accounts: { default: {} } } } });
      for (const f of ["tickets-default", "crash-default", "garbled-default"]) cursorFor(r, f, "c0", 1);
      const out = await script(
        r,
        `
        const created = (base) => (n) => ({ items: [ticketItem({ thread: "PLAT-" + (base + n), id: "PLAT-" + (base + n), event: "created" })], cursor: { value: "c" + (n + 1), at: n + 2 }, complete: true });
        const tickets = fakeProvider({ id: "tickets", label: "Tickets", polls: created(600) });
        const crash = fakeProvider({ id: "crash", label: "Crash", polls: created(700), pushes: [{ batches: [], end: "cut", throws: "socket library crashed" }] });
        const garbled = fakeProvider({ id: "garbled", label: "Garbled", polls: created(800), identity: { groups: 5, me: 7 } });
        const hollow = fakeProvider({ id: "hollow", label: "Hollow", identity: null });
        for (const p of [tickets, crash, garbled, hollow]) registry.addProvider(p);
        const stop = new AbortController();
        const loops = ingest.ingestAccounts().map((e) => ingest.runAccount(e, { mode: "${mode}", stop: stop.signal, intervalSec: 0.1, resyncMs: 60_000 }));
        await Bun.sleep(1600);
        stop.abort();
        await Promise.all(loops);
        return { crash: crash.calls.filter((c) => c === "subscribe").length, hollow: hollow.calls };
      `,
      );
      const keys = (prefix: string) => out.lines.filter((l) => l.includes(`key=${prefix}`)).length;
      expect(keys("tickets:PLAT-6")).toBeGreaterThanOrEqual(3);
      expect(keys("garbled:PLAT-8")).toBeGreaterThanOrEqual(mode === "watch" ? 3 : 1);
      expect(out.lines.filter((l) => l.startsWith("[strato] Hollow"))).toEqual(["[strato] Hollow: connect returned something that is not an identity · retrying silently, one line when it is back"]);
      expect(out.result.hollow).toEqual(["connect"]);
      if (mode === "listen") {
        // the connection is retried with its delay, said once, and the startup catch-up still read the tool
        expect(out.lines.filter((l) => l.startsWith("[strato] Crash"))).toEqual(["[strato] Crash: socket library crashed · retrying silently, one line when it is back"]);
        expect(out.result.crash).toBeGreaterThanOrEqual(2);
        expect(keys("crash:PLAT-7")).toBe(1);
      } else {
        expect(keys("crash:PLAT-7")).toBeGreaterThanOrEqual(3);
        expect(out.result.crash).toBe(0);
      }
      expect(out.err).not.toContain("TypeError");
    });

    test(`strato ${mode}: a tool whose connection throws or whose identity is malformed leaves the process and the other tools running`, async () => {
      const r = rig();
      config(r, { ...PROFILE, providers: { tickets: { accounts: { default: { me: "u-alice", watchTeams: ["PLAT"], pollInterval: 1 } } }, crash: { accounts: { default: { watchTeams: ["PLAT"], pollInterval: 1 } } }, garbled: { accounts: { default: { pollInterval: 1 } } } } });
      cursorFor(r, "tickets-default", "c0", 1);
      const preload = join(r.dir, "fake-providers.ts");
      writeFileSync(
        preload,
        [
          `import { addProvider } from ${JSON.stringify(join(SCRIPTS, "providers/registry.ts"))};`,
          `import { fakeProvider, ticketItem } from ${JSON.stringify(join(SCRIPTS, "test-provider.ts"))};`,
          `addProvider(fakeProvider({ id: "tickets", label: "Tickets", polls: (n) => ({ items: [ticketItem({ thread: "PLAT-" + (900 + n), id: "PLAT-" + (900 + n), event: "created" })], cursor: { value: "c" + (n + 1), at: n + 2 }, complete: true }) }));`,
          `addProvider(fakeProvider({ id: "crash", label: "Crash", pushes: [{ batches: [], end: "cut", throws: "socket library crashed" }] }));`,
          `addProvider(fakeProvider({ id: "garbled", label: "Garbled", identity: { groups: 5 } }));`,
        ].join("\n"),
      );
      const p = Bun.spawn([process.execPath, "--preload", preload, join(SCRIPTS, "strato.ts"), mode, ...(mode === "watch" ? ["1"] : [])], { cwd: SCRIPTS, env: r.env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      let text = "";
      const reader = (async () => {
        for await (const chunk of p.stdout) text += new TextDecoder().decode(chunk);
      })();
      for (let i = 0; i < 200 && !text.includes("key=tickets:PLAT-902"); i++) await Bun.sleep(50);
      const alive = p.exitCode === null;
      p.kill();
      await p.exited;
      await reader;
      const err = await new Response(p.stderr).text();
      const lines = text.split("\n").filter(Boolean);
      expect(alive).toBe(true);
      expect(lines.filter((l) => l.includes("key=tickets:PLAT-90")).length).toBeGreaterThanOrEqual(3);
      if (mode === "listen") expect(lines).toContain("[strato] Crash: socket library crashed · retrying silently, one line when it is back");
      expect(lines.some((l) => l.startsWith("[strato] Garbled"))).toBe(false);
      expect(err).not.toContain("socket library crashed");
      expect(err).not.toContain("TypeError");
    }, 30_000);
  }

  test("listen: Slack's lines come out unchanged next to a ticket tool's, and a tool that fails says so once", async () => {
    const r = goldenRig();
    const raw = JSON.parse(readFileSync(join(r.state, "config.json"), "utf8"));
    config(r, { ...raw, providers: { tickets: { accounts: { default: { me: "u-alice", watchTeams: ["PLAT"], pollInterval: 1 } } }, broken: { accounts: { default: { pollInterval: 1 } } } } });
    cursorFor(r, "tickets-default", "c0", 1);
    const preload = join(r.dir, "fake-providers.ts");
    writeFileSync(
      preload,
      [
        `import { addProvider } from ${JSON.stringify(join(SCRIPTS, "providers/registry.ts"))};`,
        `import { fakeProvider, ticketItem } from ${JSON.stringify(join(SCRIPTS, "test-provider.ts"))};`,
        `addProvider(fakeProvider({ id: "tickets", label: "Tickets", polls: (n) => ({ items: [ticketItem({ thread: "PLAT-" + (200 + n), id: "PLAT-" + (200 + n), event: "created" })], cursor: { value: "c" + (n + 1), at: n + 1 }, complete: true }) }));`,
        `addProvider(fakeProvider({ id: "broken", label: "Broken", polls: [{ error: { code: "unavailable", message: "Broken API down" } }] }));`,
      ].join("\n"),
    );
    const out = stdout(await runUntil(r, ["listen"], (o) => o.includes("last socket message") && o.includes("key=tickets:PLAT-202"), 20_000, [preload]));
    const golden = JSON.parse(readFileSync(join(SCRIPTS, "ingest-golden.json"), "utf8")).listen.stdout as string[];
    // Slack's lines, in their order, with the other accounts' lines between them
    expect(out.filter((l) => golden.includes(l))).toEqual(golden);
    expect(out).toContain("[strato] listener armed · tickets, broken · each account in its own loop");
    expect(out.filter((l) => l.includes("key=tickets:PLAT-20")).length).toBeGreaterThanOrEqual(3);
    expect(out.filter((l) => l.startsWith("[strato] Broken"))).toEqual(["[strato] Broken: Broken API down · retrying silently, one line when it is back"]);
    expect(events(r).some((l) => l.includes('"type":"item"'))).toBe(true);
  }, 30_000);

  test("listen without a Slack token, next to a ticket tool: one line for Slack, the tool keeps delivering", async () => {
    const r = rig();
    config(r, { ...PROFILE, providers: { tickets: { accounts: { default: { me: "u-alice", watchTeams: ["PLAT"], pollInterval: 1 } } } } });
    cursorFor(r, "tickets-default", "c0", 1);
    const preload = join(r.dir, "fake-providers.ts");
    writeFileSync(
      preload,
      [
        `import { addProvider } from ${JSON.stringify(join(SCRIPTS, "providers/registry.ts"))};`,
        `import { fakeProvider, ticketItem } from ${JSON.stringify(join(SCRIPTS, "test-provider.ts"))};`,
        `addProvider(fakeProvider({ id: "tickets", label: "Tickets", polls: (n) => ({ items: [ticketItem({ thread: "PLAT-" + (300 + n), id: "PLAT-" + (300 + n), event: "created" })], cursor: { value: "c" + (n + 1), at: n + 1 }, complete: true }) }));`,
      ].join("\n"),
    );
    const p = Bun.spawn([process.execPath, "--preload", preload, join(SCRIPTS, "strato.ts"), "listen"], { cwd: SCRIPTS, env: r.env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    let text = "";
    const reader = (async () => {
      for await (const chunk of p.stdout) text += new TextDecoder().decode(chunk);
    })();
    for (let i = 0; i < 200 && !text.includes("key=tickets:PLAT-301"); i++) await Bun.sleep(50);
    p.kill();
    await p.exited;
    await reader;
    const out = text.split("\n").filter(Boolean);
    expect(out[0]).toStartWith("[strato] Slack: no Slack user token found");
    expect(out[0]).toEndWith(", listening to this account stopped");
    expect(out).toContain("[strato] listener armed · tickets · each account in its own loop");
    expect(out.filter((l) => l.includes("key=tickets:PLAT-30")).length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(readFileSync(join(r.state, "tick.json"), "utf8"))).toHaveProperty("lastTick");
  }, 30_000);
});

describe("a named Slack account", () => {
  test("is polled with its own token and fetch, and its keys name it", async () => {
    const r = rig();
    const secrets = join(r.dir, "home", "partners.env");
    writeFileSync(secrets, "SLACK_USER_TOKEN=xoxp-partners\n");
    config(r, { ...PROFILE, providers: { slack: { accounts: { partners: { team: "Acme Partners", workspace: "acme-partners", me: "UALICEP01", ingest: "poll", secretsFile: secrets } } } } });
    cursorFor(r, "slack-partners", "1790000000", 1_790_000_000_000);
    const out = await script(
      r,
      `
      const tokens = new Set();
      const fetchImpl = async (input, init) => {
        const url = new URL(String(input));
        tokens.add(new Headers(init?.headers).get("authorization"));
        const method = url.pathname.replace("/api/", "");
        const query = url.searchParams.get("query") ?? "";
        const body = method === "auth.test" ? { ok: true, team: "Acme Partners", user_id: "UALICEP01", team_id: "T0PART0000", url: "https://acme-partners.slack.com/" }
          : method === "users.info" ? { ok: true, user: { profile: { display_name: url.searchParams.get("user") === "UBOB" ? "Bob" : "Alice" } } }
          : method === "search.messages" ? { ok: true, messages: { paging: { pages: 1 }, matches: query.startsWith("from:") ? [] : [{ ts: "1790000100.000100", user: "UBOB", text: "<@UALICEP01> can you approve?", channel: { id: "C0PART0001", name: "partners-general" }, permalink: "https://acme-partners.slack.com/archives/C0PART0001/p1790000100000100" }] } }
          : { ok: true };
        return Response.json(body);
      };
      const stop = new AbortController();
      const entry = registry.accountOf("slack", "partners");
      const loop = ingest.runAccount(entry, { mode: "watch", stop: stop.signal, intervalSec: 60, fetchImpl });
      await Bun.sleep(800);
      stop.abort();
      await loop;
      return { tokens: [...tokens], cursor: ingest.readCursor(entry.account), seen: Object.keys(JSON.parse(readFileSync(join(registry.accountDir(entry.account), "seen.json"), "utf8"))) };
    `,
      { STRATO_SLACK_TOKEN: "xoxp-acme-default" },
    );
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toMatch(/^\[strato\] mention · #partners-general · Bob · key=slack@partners:C0PART0001:1790000100\.000100 · msg=[0-9a-f]{12} · « @Alice can you approve\? » · https:\/\/acme-partners\.slack\.com\/archives\/C0PART0001\/p1790000100000100$/);
    expect(out.result.tokens).toEqual(["Bearer xoxp-partners"]);
    expect(out.result.seen).toEqual(["slack@partners:C0PART0001:1790000100.000100"]);
    expect(Number(out.result.cursor.value)).toBeGreaterThan(1_790_000_000);
    // the default account's files are left alone
    expect(lines(join(r.state, "events.ndjson")).map((l) => JSON.parse(l).type)).toEqual(["slack"]);
    expect(existsSync(join(r.state, "seen.json"))).toBe(false);
  });
});
