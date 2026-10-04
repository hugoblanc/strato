import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { sessionsToStop } from "./core/gc.ts";
import { DEFAULT_SETTINGS } from "./core/settings.ts";
import type { Sujet } from "./core/sujet.ts";
import { cleanupRigs, cli, lines, rig, sujet as rigSujet, writeSujets } from "./test-rig.ts";

afterEach(cleanupRigs);

const H = 3_600_000;
const NOW = Date.parse("2026-10-01T12:00:00Z");
const card = (over: Partial<Sujet>): Sujet => rigSujet(over as Record<string, unknown>) as unknown as Sujet;
const rows = (...r: [string, string, string?][]) => new Map(r.map(([sessionId, id, status]) => [sessionId, { sessionId, id, status }]));

describe("sessionsToStop", () => {
  test("the session of a closed topic is stopped, the one of a recent open topic is not", () => {
    const sujets = [card({ key: "C1:1", letter: "A", sessionId: "s-a", status: "closed" }), card({ key: "C2:1", letter: "B", sessionId: "s-b", status: "gate" })];
    const stops = sessionsToStop(sujets, rows(["s-a", "a1", "idle"], ["s-b", "b1", "idle"]), () => NOW - H, NOW, 12);
    expect(stops).toEqual([{ key: "C1:1", letter: "A", id: "a1", reason: "topic closed" }]);
  });
  test("idle for idleHours: stopped, its card stays; never without a declaration, nor in a 'closed only' pass", () => {
    const sujets = [card({ key: "C1:1", letter: "A", sessionId: "s-a", status: "waiting" }), card({ key: "C2:1", letter: "B", sessionId: "s-b", status: "waiting" })];
    const r = rows(["s-a", "a1", "idle"], ["s-b", "b1", "idle"]);
    const at = (sid: string) => (sid === "s-a" ? NOW - 13 * H : null);
    expect(sessionsToStop(sujets, r, at, NOW, 12)).toEqual([{ key: "C1:1", letter: "A", id: "a1", reason: "idle for 13 h" }]);
    expect(sessionsToStop(sujets, r, at, NOW, 12, true)).toEqual([]);
    expect(sessionsToStop(sujets, r, at, NOW, 0)).toEqual([]);
  });
  test("never a session that is working, waiting for a permission, already stopped or without a topic", () => {
    const sujets = [card({ key: "C1:1", sessionId: "s-a", status: "closed" }), card({ key: "C2:1", sessionId: "s-b", status: "closed" }), card({ key: "C3:1", sessionId: "s-c", status: "closed" })];
    expect(sessionsToStop(sujets, rows(["s-a", "a1", "busy"], ["s-b", "b1", "waiting"], ["s-other", "o1", "idle"]), () => 0, NOW, 12)).toEqual([]);
  });
});

test("profile: hourly collection, idle sessions stopped after 12 h", () => {
  expect(DEFAULT_SETTINGS.gc).toEqual({ everyMinutes: 60, idleHours: 12 });
});

describe("gc command, on a throwaway state", () => {
  test("--dry lists without stopping anything; gc stops the closed topic's session and logs it", async () => {
    const r = rig();
    writeSujets(r, [rigSujet({ status: "closed" }), rigSujet({ key: "C0ACME0002:1.2", threads: ["C0ACME0002:1.2"], letter: "B", sessionId: "sess-b", shortId: "sb" })]);
    writeFileSync(join(r.dir, "agents.json"), JSON.stringify([{ id: "s0", sessionId: "sess-acme-0", status: "idle" }, { id: "sb", sessionId: "sess-b", status: "idle" }]));
    const dry = await cli(r, ["gc", "--dry"]);
    expect(dry.out.trim()).toBe("A · s0 · topic closed");
    const run = await cli(r, ["gc"]);
    expect(run.out.trim()).toBe("A · stopped · topic closed");
    const events = lines(join(r.state, "events.ndjson")).map((l) => JSON.parse(l));
    expect(events.find((e) => e.type === "gc-stop")).toMatchObject({ key: "C0ACME0001:1759219200.000100", reason: "topic closed", origin: "cli", ok: true });
  });
});
