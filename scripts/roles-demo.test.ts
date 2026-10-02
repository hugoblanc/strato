/**
 * The demo of each role (`demo --role`) and `setup --role`: fictional topics of the person's job, served on a board in
 * that role's words, and the command that writes `owner.role` and prints what the role proposes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { demoProfile, demoTopics, writeDemo } from "./commands/demo.ts";
import { ROLES, roleOf } from "./core/roles.ts";
import { profileErrors } from "./core/setup.ts";
import { missingSettings, resolveSettings } from "./core/settings.ts";
import { normalizeSujets } from "./core/sujet.ts";
import { CLI, cleanupRigs, cli, rig, SCRIPTS } from "./test-rig.ts";

afterEach(() => cleanupRigs());

describe("demo per role", () => {
  const NOW = Date.parse("2026-09-30T10:00:00Z");

  test("every role's profile is valid, complete, in shadow mode, and carries its role and proposals", () => {
    for (const r of ROLES) {
      const raw = demoProfile("en", r);
      expect(profileErrors(raw), r).toEqual([]);
      const s = resolveSettings(raw);
      expect(missingSettings(s), r).toEqual([]);
      expect(s.workers.shadow).toBe(true);
      expect(roleOf(s)).toBe(r);
      expect(s.forge).toBeNull();
    }
    expect("role" in demoProfile("en").owner).toBe(false);
    expect(demoProfile("en", "support").slack.watchChannels).toContain("C0ACMECUS01");
    expect(demoProfile("en", "operations").slack).toMatchObject({ ignoreAuthors: ["Acme Alerts"] });
  });

  test("every role gets one topic per kind of card, of its own job, without code words", () => {
    const titles = new Set<string>();
    for (const r of ROLES) {
      const topics = normalizeSujets(demoTopics(NOW, "/r", r) as never, (iso) => iso.slice(0, 10));
      expect(topics.map((t) => `${t.letter}:${t.status}`), r).toEqual(["A:gate", "B:gate", "C:working", "D:waiting"]);
      expect(topics[0].tasks?.[0]).toMatchObject({ kind: "draft", status: "open" });
      expect(topics[1].tasks?.[0]).toMatchObject({ kind: "decision", status: "open" });
      const text = JSON.stringify(topics);
      expect(text).not.toContain("—");
      if (r !== "developer") expect(text, r).not.toMatch(/merge request|\bMR\b|![0-9]/);
      titles.add(topics[0].title);
    }
    expect(titles.size).toBe(ROLES.length);
    // the developer's demo is the one it always was
    expect(demoTopics(NOW, "/r")).toEqual(demoTopics(NOW, "/r", "developer"));
    // an account manager's promise has its reminder
    expect(normalizeSujets(demoTopics(NOW, "/r", "account-manager") as never, (iso) => iso.slice(0, 10))[0].due).toContain("send Globex the invite");
  });

  test("writeDemo writes the role's profile, topics and report", () => {
    const r = rig();
    const state = writeDemo(join(r.dir, "demo"), "fr", NOW, 4242, "operations");
    expect(JSON.parse(readFileSync(join(state, "config.json"), "utf8")).owner).toEqual({ name: "Alice", role: "operations" });
    expect(JSON.parse(readFileSync(join(state, "sujets.json"), "utf8"))[0].title).toBe("Status update for the API latency incident");
    expect(readFileSync(join(state, "reports", "A.md"), "utf8")).toContain("Runbook followed");
  });

  test("demo --role serves the role's board; an unknown role is refused", async () => {
    const r = rig();
    const env = { ...r.env, TMPDIR: r.dir };
    const bad = await cli(r, ["demo", "--role", "sales"], { TMPDIR: r.dir });
    expect(bad.code).toBe(64);
    expect(bad.err + bad.out).toContain("unknown role: sales");
    for (const [role, locale, title, block] of [
      ["support", "en", "Globex cannot export invoices", "Answers ready to send"],
      ["manager", "fr", "Who takes the on-call swap", "Tes arbitrages"],
    ] as const) {
      const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
      const port = probe.port as number;
      probe.stop(true);
      const p = Bun.spawn([process.execPath, CLI, "demo", "--port", String(port), "--locale", locale, "--role", role], { cwd: SCRIPTS, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      try {
        let html = "";
        for (let i = 0; i < 100 && !html; i++) {
          await Bun.sleep(100);
          html = await fetch(`http://127.0.0.1:${port}/board`).then((x) => (x.ok ? x.text() : ""), () => "");
        }
        expect(html, role).toContain(title);
        expect(html, role).toContain(block);
        expect(html, role).toContain("data-demo");
      } finally {
        p.kill();
        await p.exited;
      }
    }
  }, 60_000);
});

describe("setup --role", () => {
  test("lists the roles, writes one with its proposals, refuses an unknown one; doctor names it", async () => {
    const r = rig();
    const list = await cli(r, ["setup", "--role"]);
    expect(list.code).toBe(0);
    for (const x of ROLES) expect(list.out).toContain(x);
    expect(list.out).toContain("(current)");
    const bad = await cli(r, ["setup", "--role", "sales"]);
    expect(bad.code).toBe(64);
    const ok = await cli(r, ["setup", "--role", "support"]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('+ owner.role: "support"');
    expect(ok.out).toContain("slack.watchChannels");
    expect(ok.out).toContain("demo --role support");
    expect(JSON.parse(readFileSync(join(r.state, "config.json"), "utf8")).owner).toEqual({ name: "Alice", role: "support" });
    const doc = await cli(r, ["doctor"]);
    expect(doc.out).toMatch(/owner {4}: Alice · workspace .* · role support \(Strato's fragments\)/);
  });
});
