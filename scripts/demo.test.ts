/**
 * `demo` (O2): a throwaway installation of fictional Acme topics, served without Slack, Claude or the real state.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { demoEnv, demoProfile, demoTopics, writeDemo } from "./commands/demo.ts";
import { normalizeSujets } from "./core/sujet.ts";
import { profileErrors } from "./core/setup.ts";
import { missingSettings, resolveSettings } from "./core/settings.ts";
import { CLI, cleanupRigs, cli, rig, SCRIPTS } from "./test-rig.ts";

afterEach(() => cleanupRigs());

describe("demo data", () => {
  test("the profile is valid, complete and in shadow mode", () => {
    const raw = demoProfile("en");
    expect(profileErrors(raw)).toEqual([]);
    const s = resolveSettings(raw);
    expect(missingSettings(s)).toEqual([]);
    expect(s.workers.shadow).toBe(true);
    expect(s.refresh.auto).toBe(false);
  });

  test("one topic per kind of card: a draft, a decision, one at work, one waiting", () => {
    const topics = normalizeSujets(demoTopics(Date.parse("2026-09-30T10:00:00Z"), "/r") as never, (iso) => iso.slice(0, 10));
    expect(topics.map((t) => `${t.letter}:${t.status}`)).toEqual(["A:gate", "B:gate", "C:working", "D:waiting"]);
    expect(topics[0].tasks?.[0]).toMatchObject({ kind: "draft", status: "open" });
    expect(topics[1].tasks?.[0]).toMatchObject({ kind: "decision", status: "open" });
    expect(JSON.stringify(topics)).not.toContain("\u2014");
  });

  test("the environment of its server points inside the demo folder and carries no token", () => {
    const env = demoEnv("/tmp/d", { PATH: "/usr/bin", HOME: "/home/alice", STRATO_SLACK_TOKEN: "xoxp-real", SLACK_MCP_XOXP_TOKEN: "xoxp-real", STRATO_STATE: "/home/alice/acme/.strato" });
    expect(env).toMatchObject({ PATH: "/tmp/d/bin:/usr/bin", HOME: "/tmp/d/home", STRATO_STATE: "/tmp/d/state", STRATO_WORKSPACE: "/tmp/d/ws", STRATO_SLACK_TOKEN: "", SLACK_MCP_XOXP_TOKEN: "", STRATO_UPDATE_CHECK: "off", STRATO_DEMO: "1" });
  });

  test("writeDemo: profile, topics, report, heartbeat and a stub claude, all inside its folder", () => {
    const r = rig();
    const dir = join(r.dir, "demo");
    const state = writeDemo(dir, "fr", Date.now(), 4242);
    expect(JSON.parse(readFileSync(join(state, "config.json"), "utf8")).ui.locale).toBe("fr");
    expect(JSON.parse(readFileSync(join(state, "sujets.json"), "utf8"))).toHaveLength(4);
    expect(existsSync(join(state, "reports", "A.md"))).toBe(true);
    expect(JSON.parse(readFileSync(join(state, "tick.json"), "utf8")).lastTick).toBeGreaterThan(0);
    expect(existsSync(join(dir, "home", ".claude", "sessions", "4242.json"))).toBe(true);
    expect(Bun.spawnSync([join(dir, "bin", "claude"), "agents", "--json"]).stdout.toString()).toContain('"status":"busy"');
  });
});

describe("demo command", () => {
  test("serves the fictional board with its banner, and --clean removes it", async () => {
    const r = rig();
    const env = { ...r.env, TMPDIR: r.dir };
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = probe.port as number;
    probe.stop(true);
    const p = Bun.spawn([process.execPath, CLI, "demo", "--port", String(port), "--locale", "en"], { cwd: SCRIPTS, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    try {
      let html = "";
      for (let i = 0; i < 100 && !html; i++) {
        await Bun.sleep(100);
        html = await fetch(`http://127.0.0.1:${port}/board`).then((x) => (x.ok ? x.text() : ""), () => "");
      }
      expect(html).toContain("data-demo");
      expect(html).toContain("Demo: fictional data");
      expect(html).toContain("Globex rate limit before Thursday");
      expect(html).toContain("data-shadow");
      expect(existsSync(join(r.dir, "strato-demo", "state", "sujets.json"))).toBe(true);
      // the real state of the rig is untouched
      expect(existsSync(join(r.state, "sujets.json"))).toBe(false);
    } finally {
      p.kill();
      await p.exited;
    }
    const clean = await cli(r, ["demo", "--clean"], { TMPDIR: r.dir });
    expect(clean.code).toBe(0);
    expect(existsSync(join(r.dir, "strato-demo"))).toBe(false);
  }, 30_000);
});
