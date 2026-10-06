/**
 * Closing as settled: `close <topic> --settled` and the board's "Settled ✅" (POST /api/close with `settled`) close the
 * topic, then put ✅ on its original message through the act path. Already there counts as done, shadow mode and a
 * ticket only close, and the history says what became of the reaction. Slack is a fake in the process (preload).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupRigs, CLI, KEY, lines, postBoard, readSujets, type Rig, rig, run, startServe, sujet, writeSujets } from "./test-rig.ts";

afterEach(cleanupRigs);

/** Slack replaced in the process: each call is logged; reactions.add answers already_reacted on FAKE_REACTION=already. */
const FAKE_SLACK = `import { appendFileSync } from "node:fs";
const real = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith("https://slack.com/api/")) return real(input, init);
  const method = url.slice("https://slack.com/api/".length).split("?")[0];
  const body = init?.body instanceof URLSearchParams ? init.body.toString() : "";
  appendFileSync(process.env.FAKE_SLACK_LOG as string, method + " " + body + "\\n");
  const reply = method === "auth.test" ? { ok: true, team: "Acme", user_id: "UALICE", url: "https://acme.slack.com/" }
    : method === "reactions.add" ? (process.env.FAKE_REACTION === "already" ? { ok: false, error: "already_reacted" } : { ok: true })
    : { ok: true };
  return new Response(JSON.stringify(reply), { headers: { "Content-Type": "application/json" } });
}) as typeof fetch;
`;

const TICKET = "linear:ENG-12";
const [CHANNEL, TS] = KEY.split(":");
const REACTION = `reactions.add channel=${CHANNEL}&timestamp=${TS}&name=white_check_mark`;

/** A rig with two open topics: A born from a Slack message (with a later reply in its thread), B from a ticket. */
function setup(o: { shadow?: boolean } = {}): Rig {
  const r = rig();
  writeFileSync(join(r.state, "config.json"), JSON.stringify({ owner: { name: "Alice" }, slack: { team: "Acme", workspace: "acme", me: "UALICE" }, ...(o.shadow ? { workers: { shadow: true } } : {}) }));
  writeSujets(r, [sujet({ threads: [KEY, `${CHANNEL}:1759219300.000200`], status: "waiting" }), sujet({ key: TICKET, threads: [TICKET], letter: "B", channel: "ENG-12", permalink: "https://linear.app/acme/issue/ENG-12", sessionId: "sess-acme-1", shortId: "s1", status: "waiting" })]);
  writeFileSync(join(r.dir, "fake-slack.ts"), FAKE_SLACK);
  return r;
}
const env = (r: Rig, reaction = "ok") => ({ STRATO_SLACK_TOKEN: "xoxp-acme-factice", FAKE_SLACK_LOG: join(r.dir, "slack.log"), FAKE_REACTION: reaction });
const closeCli = (r: Rig, args: string[], reaction = "ok") => run(r, ["--preload", join(r.dir, "fake-slack.ts"), CLI, "close", ...args], env(r, reaction));
const reactions = (r: Rig) => lines(join(r.dir, "slack.log")).filter((l) => l.startsWith("reactions.add "));
const events = (r: Rig) => lines(join(r.state, "events.ndjson")).map((l) => JSON.parse(l) as Record<string, unknown>);
const topic = (r: Rig, key = KEY) => readSujets(r).find((s) => s.key === key);

describe("close --settled", () => {
  test("closes, then puts ✅ on the topic's original message (not the last reply), through the act path", async () => {
    const r = setup();
    const res = await closeCli(r, ["A", "--settled"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("closed · A");
    expect(res.out).toContain("✅ · Topic A closed, ✅ added to its original message.");
    expect(reactions(r)).toEqual([REACTION]);
    expect(topic(r)?.status).toBe("closed");
    expect(topic(r)?.checked).toBeTruthy();
    expect(events(r).find((e) => e.type === "act")).toMatchObject({ by: "master", key: KEY, task: null, kinds: ["react"], ok: true });
    expect(events(r).find((e) => e.type === "close")).toMatchObject({ by: "master", key: KEY, settled: true, react: true, reaction: "posted" });
  }, 30_000);

  test("the flag may come first; without it the close is silent", async () => {
    const r = setup();
    expect((await closeCli(r, ["--settled", "A"])).code).toBe(0);
    expect(reactions(r)).toHaveLength(1);
    const q = setup();
    const res = await closeCli(q, ["A"]);
    expect(res.code).toBe(0);
    expect(res.out).not.toContain("✅");
    expect(reactions(q)).toEqual([]);
    expect(topic(q)?.status).toBe("closed");
    expect(topic(q)?.checked).toBeUndefined();
    expect(events(q).find((e) => e.type === "close")).toMatchObject({ settled: false, react: false, reaction: "skipped" });
  }, 30_000);

  test("idempotent: ✅ already added by hand (already_reacted) counts as done, and a second close does not react again", async () => {
    const r = setup();
    const res = await closeCli(r, ["A", "--settled"], "already");
    expect(res.code).toBe(0);
    expect(res.out).toContain("✅ ·");
    expect(topic(r)?.checked).toBeTruthy();
    const again = await closeCli(r, ["A", "--settled"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("✅ was already on its original message");
    expect(reactions(r)).toHaveLength(1);
    expect(events(r).filter((e) => e.type === "close").map((e) => e.reaction)).toEqual(["posted", "already"]);
  }, 30_000);

  test("shadow mode: the topic closes, nothing is posted, the output and the log say so", async () => {
    const r = setup({ shadow: true });
    const res = await closeCli(r, ["A", "--settled"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("no ✅ · Topic A closed. Shadow mode: no ✅ posted.");
    expect(reactions(r)).toEqual([]);
    expect(topic(r)?.status).toBe("closed");
    expect(topic(r)?.checked).toBeUndefined();
    expect(events(r).find((e) => e.type === "act-refused")).toMatchObject({ key: KEY, reason: "shadow" });
    expect(events(r).find((e) => e.type === "close")).toMatchObject({ settled: true, react: false, reaction: "shadow" });
  }, 30_000);

  test("a topic born from a ticket only closes: no reaction anywhere", async () => {
    const r = setup();
    const res = await closeCli(r, ["B", "--settled"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("has no settled marker: nothing posted");
    expect(lines(join(r.dir, "slack.log"))).toEqual([]);
    expect(topic(r, TICKET)?.status).toBe("closed");
    expect(events(r).find((e) => e.type === "close")).toMatchObject({ key: TICKET, react: false, reaction: "none" });
  }, 30_000);

  test("a reaction the tool refuses leaves the topic closed and says why", async () => {
    const r = setup();
    // no token: the Slack account is not usable, the gate refuses before any call
    const res = await run(r, ["--preload", join(r.dir, "fake-slack.ts"), CLI, "close", "A", "--settled"], { ...env(r), STRATO_SLACK_TOKEN: "" });
    expect(res.code).toBe(0);
    expect(res.out).toContain("no ✅ · Topic A closed, but ✅ not added:");
    expect(reactions(r)).toEqual([]);
    expect(topic(r)?.status).toBe("closed");
    expect(events(r).find((e) => e.type === "close")).toMatchObject({ react: false, reaction: "failed" });
  }, 30_000);
});

describe("POST /api/close", () => {
  test("Settled ✅: closes and reacts on the original message; Close without ✅ posts nothing", async () => {
    const r = setup();
    const serve = await startServe(r, { preload: join(r.dir, "fake-slack.ts"), env: env(r) });
    try {
      const res = await postBoard(serve.port, "/api/close", { key: KEY, settled: true });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, reaction: "posted", note: "Topic A closed, ✅ added to its original message." });
      expect(reactions(r)).toEqual([REACTION]);
      expect(topic(r)?.checked).toBeTruthy();
      const quiet = await postBoard(serve.port, "/api/close", { key: TICKET });
      expect(await quiet.json()).toMatchObject({ ok: true, reaction: "skipped" });
      expect(reactions(r)).toHaveLength(1);
      const closes = events(r).filter((e) => e.type === "board-close");
      expect(closes).toEqual([expect.objectContaining({ by: "board", key: KEY, settled: true, react: true }), expect.objectContaining({ by: "board", key: TICKET, settled: false, react: false })]);
    } finally {
      await serve.stop();
    }
  }, 30_000);

  test("Settled ✅ in shadow mode: the topic closes, the answer says nothing was posted", async () => {
    const r = setup({ shadow: true });
    const serve = await startServe(r, { preload: join(r.dir, "fake-slack.ts"), env: env(r) });
    try {
      const res = await postBoard(serve.port, "/api/close", { key: KEY, settled: true });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, reaction: "shadow", note: "Topic A closed. Shadow mode: no ✅ posted." });
      expect(reactions(r)).toEqual([]);
      expect(topic(r)?.status).toBe("closed");
    } finally {
      await serve.stop();
    }
  }, 30_000);
});
