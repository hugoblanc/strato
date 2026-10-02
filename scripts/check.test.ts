import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkable } from "./core/sujet.ts";
import { cleanupRigs, KEY, postBoard, readSujets, rig, startServe, sujet, writeSujets } from "./test-rig.ts";

afterEach(cleanupRigs);

describe("checkable", () => {
  const base = { status: "closed" as const, key: KEY, summary: "clos : Bob a confirmé, le payout est parti" };
  test("a resolved topic born from a Slack thread can receive ✅", () => {
    expect(checkable(base)).toBe(true);
    expect(checkable({ ...base, summary: "" })).toBe(true);
  });
  test("not an open topic, an already checked one, one born from a ticket, nor one closed because it was not for the person served", () => {
    expect(checkable({ ...base, status: "gate" as never })).toBe(false);
    expect(checkable({ ...base, checked: "2026-10-01T08:00:00Z" })).toBe(false);
    expect(checkable({ ...base, key: "linear:ENG-12" })).toBe(false);
    for (const summary of ["pas pour Alice : Bob porte", "pris par Bob", "clos : passé à Carol", "Pris par l'équipe"]) expect(checkable({ ...base, summary })).toBe(false);
    // the English default policy writes these
    for (const summary of ["not for Alice: Bob owns it", "taken by Bob", "closed: handed over to Carol", "duplicate of topic B"]) expect(checkable({ ...base, summary })).toBe(false);
    expect(checkable({ ...base, summary: "closed: Bob confirmed the payout went out" })).toBe(true);
  });
  test("only a tool with a settled marker shows the button: not a named Linear account's ticket, nor an unknown tool's key", () => {
    expect(checkable({ ...base, key: "linear@partners:ENG-12" })).toBe(false);
    expect(checkable({ ...base, key: "github:acme/api%2342" })).toBe(false);
    expect(checkable({ ...base, key: "slack@partners:C0ACME0002:1759219200.000300" })).toBe(true);
  });
});

/** Slack remplacé dans le processus serve : chaque appel est noté, reactions.add répond selon FAKE_REACTION. */
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

describe("POST /api/check", () => {
  async function boardWith(reaction = "ok") {
    const r = rig();
    writeSujets(r, [sujet({ status: "closed", summary: "clos : réglé" }), sujet({ key: "C0ACME0002:1.2", threads: ["C0ACME0002:1.2"], letter: "B", status: "closed", summary: "pris par Bob" })]);
    writeFileSync(join(r.dir, "fake-slack.ts"), FAKE_SLACK);
    const serve = await startServe(r, { preload: join(r.dir, "fake-slack.ts"), env: { STRATO_SLACK_TOKEN: "xoxp-acme-factice", FAKE_SLACK_LOG: join(r.dir, "slack.log"), FAKE_REACTION: reaction } });
    return { r, serve };
  }
  test("puts ✅ on the thread's original message and notes it in the topic; a second click is refused", async () => {
    const { r, serve } = await boardWith();
    try {
      expect((await postBoard(serve.port, "/api/check", { key: KEY })).status).toBe(200);
      const [channel, ts] = KEY.split(":");
      expect(readFileSync(join(r.dir, "slack.log"), "utf8")).toContain(`reactions.add channel=${channel}&timestamp=${ts}&name=white_check_mark`);
      expect(readSujets(r).find((s) => s.key === KEY)?.checked).toBeTruthy();
      expect((await postBoard(serve.port, "/api/check", { key: KEY })).status).toBe(409);
    } finally {
      await serve.stop();
    }
  });
  test("refused for a topic taken by someone else; already checked by hand in Slack counts as done", async () => {
    const { r, serve } = await boardWith("already");
    try {
      expect((await postBoard(serve.port, "/api/check", { key: "C0ACME0002:1.2" })).status).toBe(409);
      expect((await postBoard(serve.port, "/api/check", { key: KEY })).status).toBe(200);
      expect(readSujets(r).find((s) => s.key === KEY)?.checked).toBeTruthy();
    } finally {
      await serve.stop();
    }
  });
});
