/**
 * Golden replay of the Slack ingest: one fixture batch (search matches, thread replies, socket events) goes through
 * `listen`, `watch` and `backlog` in real processes, against a fake Slack and a fake WebSocket, and the stdout lines,
 * the events.ndjson lines and seen.json must stay byte for byte what they were before ingest went through providers
 * (docs/design/providers.md, section 15, ingest). The expected values were recorded on the code before that change.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { events, goldenRig, runUntil, seen, stdout } from "./ingest-fixture.ts";
import { cleanupRigs } from "./test-rig.ts";

afterEach(cleanupRigs);

type Golden = Record<"listen" | "watch" | "backlog", { stdout: string[]; events: string[]; seen: string[] }>;
const GOLDEN_FILE = join(import.meta.dir, "ingest-golden.json");
/** `STRATO_GOLDEN_RECORD=1 bun test ingest-golden` rewrites the expected values: only for an intended change of the lines. */
const RECORD = process.env.STRATO_GOLDEN_RECORD === "1";
const GOLDEN: Golden = RECORD ? { listen: { stdout: [], events: [], seen: [] }, watch: { stdout: [], events: [], seen: [] }, backlog: { stdout: [], events: [], seen: [] } } : JSON.parse(readFileSync(GOLDEN_FILE, "utf8"));
afterAll(() => {
  if (RECORD) writeFileSync(GOLDEN_FILE, `${JSON.stringify(GOLDEN, null, 2)}\n`);
});
/** Compares with the recorded values, or records them. */
function check(name: keyof Golden, got: { stdout: string[]; events: string[]; seen: string[] }): void {
  if (RECORD) GOLDEN[name] = got;
  else expect(got).toEqual(GOLDEN[name]);
}

const L = {
  mention: "[strato] mention · #acme-sales · Bob · key=C0ACME0007:1790000100.000100 · msg=",
  canal: "[strato] canal · #acme-requests · Carol Smith · key=C0ACMEREQ01:1790000110.000100 · msg=",
  dm: "[strato] dm · DM · Bob · key=D0ACME0001:1790000130.000100 · msg=",
};

describe("golden replay of the Slack ingest", () => {
  test("listen: startup catch-up, thread catch-up and socket events", async () => {
    const r = goldenRig();
    const out = await runUntil(r, ["listen"], (o) => o.includes("last socket message"));
    check("listen", { stdout: stdout(out), events: events(r), seen: seen(r) });
  }, 30_000);

  test("watch: one polling pass", async () => {
    const r = goldenRig();
    const out = await runUntil(r, ["watch", "1"], (o) => o.includes("please review"));
    check("watch", { stdout: stdout(out), events: events(r), seen: seen(r) });
  }, 30_000);

  test("backlog: the relevant messages over the period, nothing written to the log", async () => {
    const r = goldenRig();
    const out = await runUntil(r, ["backlog", "--since", "12h"], () => false);
    check("backlog", { stdout: stdout(out), events: events(r), seen: [] });
  }, 30_000);

  test.skipIf(RECORD)("the replay covers every kind of line", () => {
    const all = GOLDEN.listen.stdout.join("\n");
    for (const kind of ["mention", "canal", "dm", "suite", "moi", "fil"]) expect(all).toContain(`[strato] ${kind} · `);
    expect(GOLDEN.listen.events.join("\n")).toContain('"kind":"tiers"');
    expect(GOLDEN.listen.events.join("\n")).toContain('"kind":"bot"');
    expect(all).toContain(L.mention);
    expect(all).toContain(L.canal);
    expect(all).toContain(L.dm);
  });
});

