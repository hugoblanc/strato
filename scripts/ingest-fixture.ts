/**
 * The fixture of the Slack ingest replays (ingest-golden.test.ts, provider-ingest.test.ts): a fake Slack and a fake
 * WebSocket loaded with `--preload`, one batch of search matches, thread replies and socket events, the topics they
 * land on, and how to run a listener on them until a line shows up.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI, lines, type Rig, rig, SCRIPTS } from "./test-rig.ts";

/** Slack and its WebSocket replaced in the process: the fixture answers every call, the socket delivers its events once. */
export const FAKE_SLACK = `import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync(process.env.FAKE_SLACK_FIXTURE, "utf8"));
// the clock starts at the fixture's time: the 3-day purge of seen.json and the time windows read it
const realNow = Date.now.bind(Date);
const shift = Number(process.env.FAKE_NOW_MS) - realNow();
Date.now = () => realNow() + shift;
const real = globalThis.fetch;
const page = (matches) => ({ ok: true, messages: { matches, paging: { pages: 1 } } });
globalThis.fetch = (async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "slack.com") return real(input, init);
  const method = url.pathname.replace("/api/", "");
  const p = Object.fromEntries(url.searchParams);
  if (init?.body instanceof URLSearchParams) Object.assign(p, Object.fromEntries(init.body));
  let reply = { ok: true };
  if (method === "auth.test") reply = { ok: true, team: "Acme", user_id: "UALICE", team_id: "T0ACME0000", url: "https://acme.slack.com/" };
  else if (method === "users.info") reply = fx.users[p.user] ? { ok: true, user: { profile: { display_name: fx.users[p.user] } } } : { ok: false, error: "user_not_found" };
  else if (method === "conversations.info") {
    const c = fx.channels[p.channel];
    reply = c && !c.notMine ? { ok: true, channel: { id: p.channel, ...c } } : { ok: false, error: "channel_not_found" };
  } else if (method === "search.messages") reply = page(p.query.startsWith("from:") ? fx.participated : fx.search);
  else if (method === "conversations.replies") reply = { ok: true, messages: fx.replies[p.channel + ":" + p.ts] ?? [] };
  else if (method === "apps.connections.open") reply = { ok: true, url: "wss://socket.invalid/acme" };
  return new Response(JSON.stringify(reply), { headers: { "Content-Type": "application/json" } });
});
let opened = 0;
class FakeWs {
  constructor() {
    this.n = ++opened;
    setTimeout(() => this.start(), 20);
  }
  addEventListener() {}
  start() {
    this.onopen?.({});
    if (this.n !== 1) return;
    fx.socket.forEach((event, i) => this.onmessage?.({ data: JSON.stringify({ envelope_id: "env-" + i, type: "events_api", payload: { event } }) }));
  }
  send() {}
  ping() {}
  close() {
    this.onclose?.({});
  }
  terminate() {}
}
globalThis.WebSocket = FakeWs;
`;

const link = (channel: string, ts: string, thread?: string) => `https://acme.slack.com/archives/${channel}/p${ts.replace(".", "")}${thread ? `?thread_ts=${thread}&cid=${channel}` : ""}`;
const ROOT = "1790000000.000100";
const OTHER_ROOT = "1789990000.000100";
const KEY = `C0ACME0001:${ROOT}`;

export const FIXTURE = {
  users: { UBOB: "Bob", UCAROL: "Carol Smith", UHEIDI: "Heidi", UDAVE: "Dave", UALICE: "Alice Martin", UIVAN: "Ivan", UJUDY: "Judy", UERIN: "Erin", UGRACE: "Grace", UOSCAR: "Oscar", UPETER: "Peter" },
  channels: {
    C0ACME0001: { name: "acme-support" },
    C0ACME0003: { name: "acme-eng" },
    C0ACME0007: { name: "acme-sales" },
    C0ACME0008: { name: "random" },
    C0ACMEREQ01: { name: "acme-requests" },
    C0ACMENOISE: { name: "noise" },
    D0ACME0002: { is_im: true },
    D0FOREIGN01: { notMine: true },
  },
  search: [
    { ts: "1790000100.000100", user: "UBOB", text: "<@UALICE> can you look at the Initech invoice?", channel: { id: "C0ACME0007", name: "acme-sales" }, permalink: link("C0ACME0007", "1790000100.000100") },
    { ts: "1790000110.000100", user: "UCAROL", text: "Refund request for Globex\norder 4412, amount 120 EUR", channel: { id: "C0ACMEREQ01", name: "acme-requests" }, permalink: link("C0ACMEREQ01", "1790000110.000100") },
    { ts: "1790000120.000100", user: "UHEIDI", text: "<@UDAVE> can you take this one?", channel: { id: "C0ACMEREQ01", name: "acme-requests" }, permalink: link("C0ACMEREQ01", "1790000120.000100") },
    { ts: "1790000130.000100", user: "UBOB", text: "quick question [urgent] « see »", channel: { id: "D0ACME0001", is_im: true }, permalink: link("D0ACME0001", "1790000130.000100") },
    { ts: "1790000140.000100", user: "UBOB", text: "any news?", channel: { id: "C0ACME0001", name: "acme-support" }, permalink: link("C0ACME0001", "1790000140.000100", ROOT) },
    { ts: "1790000150.000100", user: "UALICE", text: "Done, the invoice is fixed", channel: { id: "C0ACME0001", name: "acme-support" }, permalink: link("C0ACME0001", "1790000150.000100", ROOT) },
    { ts: "1790000160.000100", username: "Acme Bot", text: "Deploy finished", channel: { id: "C0ACMEREQ01", name: "acme-requests" }, permalink: link("C0ACMEREQ01", "1790000160.000100") },
    { ts: "1790000170.000100", user: "UIVAN", text: "lunch?", channel: { id: "C0ACME0008", name: "random" }, permalink: link("C0ACME0008", "1790000170.000100") },
    { ts: "1790000180.000100", user: "UJUDY", text: "", attachments: [{ fallback: "Alert: payout failed", pretext: "for <@UALICE>" }], channel: { id: "C0ACME0007", name: "acme-sales" }, permalink: link("C0ACME0007", "1790000180.000100") },
    { ts: "1790000190.000100", user: "UERIN", text: "I pushed the fix, <https://example.com/x|see the diff> &amp; <#C0ACME0002|acme-eng>", channel: { id: "C0ACME0003", name: "acme-eng" }, permalink: link("C0ACME0003", "1790000190.000100", OTHER_ROOT) },
    { ts: "1790000200.000100", user: "UBOB", text: "<@UDAVE> lunch?", channel: { id: "C0ACMEMPIM1", is_mpim: true, name: "mpdm-bob--dave--alice-1" }, permalink: link("C0ACMEMPIM1", "1790000200.000100") },
    { ts: "1790000210.000100", user: "UBOB", text: "hello both", channel: { id: "C0ACMEMPIM1", is_mpim: true, name: "mpdm-bob--dave--alice-1" }, permalink: link("C0ACMEMPIM1", "1790000210.000100") },
    { ts: "1790000220.000100", user: "UGRACE", text: "<!subteam^SACME|@acme-eng> please review", channel: { id: "C0ACME0007", name: "acme-sales" }, permalink: link("C0ACME0007", "1790000220.000100") },
    { ts: "1790000230.000100", user: "UBOB", text: "<@UALICE> fyi", channel: { id: "C0ACMENOISE", name: "noise" }, permalink: link("C0ACMENOISE", "1790000230.000100") },
  ],
  participated: [{ ts: "1789990050.000100", user: "UALICE", text: "looking", channel: { id: "C0ACME0003", name: "acme-eng" }, permalink: link("C0ACME0003", "1789990050.000100", OTHER_ROOT) }],
  replies: {
    [KEY]: [
      { ts: ROOT, user: "UPETER", text: "the Initech invoice is wrong" },
      { ts: "1790000140.000100", user: "UBOB", text: "any news?" },
      { ts: "1790000145.000100", user: "UCAROL", text: "I am on it" },
    ],
  },
  socket: [
    { type: "message", ts: "1790000300.000100", channel: "D0ACME0002", channel_type: "im", user: "UOSCAR", text: "are you around?" },
    { type: "message", ts: "1790000310.000100", channel: "D0FOREIGN01", channel_type: "im", user: "UOSCAR", text: "not for Alice" },
    {
      type: "message",
      subtype: "message_changed",
      channel: "C0ACME0007",
      channel_type: "channel",
      message: { type: "message", ts: "1790000100.000200", user: "UBOB", text: "<@UALICE> can you check?" },
      previous_message: { type: "message", ts: "1790000100.000200", user: "UBOB", text: "can you check?" },
    },
    { type: "message", ts: "1790000320.000100", thread_ts: ROOT, channel: "C0ACME0001", channel_type: "channel", user: "UDAVE", text: "Dave here, looking" },
    { type: "message", subtype: "channel_join", ts: "1790000330.000100", channel: "C0ACMEREQ01", channel_type: "channel", user: "UNIAJ", text: "joined" },
    { type: "message", ts: "1790000110.000100", channel: "C0ACMEREQ01", channel_type: "channel", user: "UCAROL", text: "Refund request for Globex\norder 4412, amount 120 EUR" },
    { type: "message", subtype: "bot_message", ts: "1790000340.000100", channel: "C0ACMEREQ01", channel_type: "channel", username: "Acme Bot", text: "Nightly report" },
    { type: "message", ts: "1790000350.000100", channel: "D0ACME0002", channel_type: "im", user: "UOSCAR", text: "last socket message" },
  ],
};

const AT = "2026-09-21T08:00:00Z";
const TOPIC = {
  key: KEY,
  threads: [KEY],
  letter: "A",
  title: "Initech invoice",
  channel: "#acme-support",
  permalink: link("C0ACME0001", ROOT),
  asker: "Peter",
  sessionId: "sess-acme-0",
  shortId: "s0",
  name: "A · #acme-support · Peter · Initech invoice",
  status: "waiting",
  gate: "none",
  waiting: "Bob",
  next: "",
  summary: "",
  tasks: [{ id: "t1", kind: "draft", ask: "Reply to Peter", draft: "Done, the invoice is fixed", draftTo: "#acme-support", createdAt: AT, updatedAt: AT, status: "open", origin: "task" }],
  createdAt: AT,
  updatedAt: AT,
  history: [],
};
const OTHER = { ...TOPIC, key: "C0ACME0007:1789000000.000100", threads: ["C0ACME0007:1789000000.000100"], letter: "B", title: "Sales pipeline", channel: "#acme-sales", sessionId: null, shortId: null, tasks: [] };

export function goldenRig(): Rig {
  const r = rig();
  writeFileSync(
    join(r.state, "config.json"),
    JSON.stringify({
      owner: { name: "Alice" },
      slack: { team: "Acme", workspace: "acme", me: "UALICE", subteams: ["SACME"], watchChannels: ["C0ACMEREQ01"], ignoreChannels: ["C0ACMENOISE"], ignoreAuthors: ["Acme Bot"], teammates: ["Bob", "Carol Smith", "Dave"] },
      refresh: { auto: false },
      gc: { everyMinutes: 0 },
    }),
  );
  writeFileSync(join(r.state, "sujets.json"), JSON.stringify([TOPIC, OTHER]));
  writeFileSync(join(r.state, "tick.json"), JSON.stringify({ lastTick: 1790000000, syncedTo: 1790000000 }));
  writeFileSync(join(r.dir, "fixture.json"), JSON.stringify(FIXTURE));
  writeFileSync(join(r.dir, "fake-slack.ts"), FAKE_SLACK);
  return r;
}

/** The fake clock: a few minutes after the fixture's messages. */
export const NOW_MS = 1_790_000_400_000;
export const ENV = (r: Rig) => ({ ...r.env, STRATO_SLACK_TOKEN: "xoxp-acme-fake", SLACK_APP_TOKEN: "xapp-acme-fake", FAKE_SLACK_FIXTURE: join(r.dir, "fixture.json"), FAKE_NOW_MS: String(NOW_MS) });

/** Runs a command with the fake Slack until `done` holds on its stdout (or the command ends), then stops it. */
export async function runUntil(r: Rig, args: string[], done: (out: string) => boolean, timeoutMs = 20_000, preloads: string[] = []): Promise<string> {
  const p = Bun.spawn([process.execPath, "--preload", join(r.dir, "fake-slack.ts"), ...preloads.flatMap((x) => ["--preload", x]), CLI, ...args], { cwd: SCRIPTS, env: ENV(r), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let out = "";
  const reader = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of p.stdout) out += decoder.decode(chunk);
  })();
  const started = Date.now();
  let exited = false;
  void p.exited.then(() => (exited = true));
  while (!exited && !done(out) && Date.now() - started < timeoutMs) await Bun.sleep(50);
  // what follows the awaited line in the same pass (dedup, a closing line) is written within a few ms
  if (!exited) await Bun.sleep(400);
  p.kill();
  await p.exited;
  await reader;
  return out;
}

/** events.ndjson without the time of each line. */
export const events = (r: Rig) =>
  lines(join(r.state, "events.ndjson")).map((l) => {
    const { at: _, ...rest } = JSON.parse(l);
    return JSON.stringify(rest);
  });
export const seen = (r: Rig) => (JSON.parse(readFileSync(join(r.state, "seen.json"), "utf8")) as string[]).sort();
export const stdout = (out: string) => out.split("\n").filter(Boolean);
