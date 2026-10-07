/**
 * Strato's mod through real `strato.ts` processes on a temporary state folder, with the fake `claude` of test-rig.ts:
 * the first spawn loads the mod's folder, a resume never passes an option, and a message to a session that declares
 * itself goes through its inbox, or falls back to the old routes when the mod does not answer.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acksPath, inboxMessages, modStatePath } from "./app/mod.ts";
import { buildBoard, focusView } from "./board.ts";
import { cleanupRigs, cli, inProcess, LINK, lines, type Rig, rig, sujet, writeSujets } from "./test-rig.ts";

afterEach(cleanupRigs);

const spawns = (r: Rig) => (existsSync(join(r.dir, "spawns.log")) ? readFileSync(join(r.dir, "spawns.log"), "utf8").split("\n---\n").filter((x) => x.trim()) : []);

function declare(r: Rig, sessionId: string, over: Record<string, unknown> = {}) {
  mkdirSync(join(r.state, "live"), { recursive: true });
  const now = Date.now();
  writeFileSync(modStatePath(r.state, sessionId), JSON.stringify({ source: "mod", v: 1, sessionId, status: "idle", since: now - 1_000, step: null, stepAt: 0, trail: [], lastText: "", lastTextAt: 0, agents: [], waiting: null, beat: now, turnId: null, error: false, ...over }));
}

describe("spawn and resume", () => {
  test("the first spawn loads the mod's folder, written under the state; the resume passes no option", async () => {
    const r = rig();
    const open = await cli(r, ["open", LINK, "--title", "Acme quote", "--from", "Ann", "--channel", "#acme"]);
    expect(open.code).toBe(0);
    const dir = join(r.state, "mod", "strato-state");
    expect(spawns(r)[0]).toContain(`--plugin-dir ${dir} -n `);
    expect(existsSync(join(dir, "hooks", "register.js"))).toBe(true);
    expect(existsSync(join(dir, ".claude-plugin", "plugin.json"))).toBe(true);
    // the session stops: the next message resumes it, bare
    writeFileSync(join(r.dir, "agents.json"), "[]");
    const sent = await cli(r, ["send", "A", "Zoé answered"]);
    expect(sent.code).toBe(0);
    const resume = spawns(r)[1];
    expect(resume.startsWith("--resume sess-acme-1 ")).toBe(true);
    expect(resume).not.toContain("--plugin-dir");
    expect(resume).not.toContain("--settings");
    expect(lines(join(r.dir, "kinds.log"))).toEqual(["--plugin-dir", "--resume"]);
  }, 30_000);

  test("workers.mod false: no mod folder, no --plugin-dir", async () => {
    const r = rig();
    const cfg = JSON.parse(readFileSync(join(r.state, "config.json"), "utf8"));
    writeFileSync(join(r.state, "config.json"), JSON.stringify({ ...cfg, workers: { mod: false } }));
    expect((await cli(r, ["open", LINK, "--title", "Acme quote", "--from", "Ann", "--channel", "#acme"])).code).toBe(0);
    expect(spawns(r)[0]).not.toContain("--plugin-dir");
    expect(existsSync(join(r.state, "mod"))).toBe(false);
  }, 30_000);
});

describe("delivery through the inbox", () => {
  const deliver = (r: Rig, ackTimeoutMs: number) => inProcess(r, { d: "app/deliver.ts" }, `return await d.deliverToSujet("A", "[Ann, from the board] go", "board", { ackTimeoutMs: ${ackTimeoutMs} });`);

  test("a session that declares itself takes the message from its inbox; nothing is relayed or resumed", async () => {
    const r = rig();
    writeSujets(r, [sujet()]);
    declare(r, "sess-acme-0");
    let stop = false;
    const mod = (async () => {
      while (!stop) {
        await Bun.sleep(50);
        const pending = inboxMessages(r.state, "sess-acme-0");
        if (pending.length) writeFileSync(acksPath(r.state, "sess-acme-0"), pending.map((m) => `${JSON.stringify({ id: m.id, state: "submitted", at: Date.now() })}\n`).join(""));
      }
    })();
    const res = await deliver(r, 5_000);
    stop = true;
    await mod;
    expect(res.ok).toBe(true);
    expect(res.via).toBe("inbox");
    expect(inboxMessages(r.state, "sess-acme-0")[0].text).toBe("[Ann, from the board] go");
    expect(spawns(r)).toEqual([]);
  }, 30_000);

  test("a mod that does not acknowledge: the message is withdrawn and goes the old way, with a note", async () => {
    const r = rig();
    writeSujets(r, [sujet()]);
    declare(r, "sess-acme-0");
    const res = await deliver(r, 300);
    expect(res.ok).toBe(true);
    // agents.json is empty: the session counts as stopped, and is resumed bare
    expect(res.via).toBe("resume");
    expect(res.note).toContain("20 s");
    expect(inboxMessages(r.state, "sess-acme-0")).toEqual([]);
    expect(spawns(r)[0].startsWith("--resume sess-acme-0 [Ann, from the board] go")).toBe(true);
  }, 30_000);

  test("a slash command the session does not have: refused by the mod, and said; nothing else is sent", async () => {
    const r = rig();
    writeSujets(r, [sujet()]);
    declare(r, "sess-acme-0");
    let stop = false;
    const mod = (async () => {
      while (!stop) {
        await Bun.sleep(50);
        const pending = inboxMessages(r.state, "sess-acme-0");
        if (pending.length) writeFileSync(acksPath(r.state, "sess-acme-0"), pending.map((m) => `${JSON.stringify({ id: m.id, state: "refused", at: Date.now() })}\n`).join(""));
      }
    })();
    const res = await inProcess(r, { d: "app/deliver.ts" }, `return await d.deliverToSujet("A", "/nope now", "board", { ackTimeoutMs: 5000 });`);
    stop = true;
    await mod;
    expect(res.ok).toBe(false);
    expect(res.error).toContain("/nope");
    expect(spawns(r)).toEqual([]);
  }, 30_000);

  test("a slash command to a live session without the mod: refused, never relayed as text", async () => {
    const r = rig();
    writeSujets(r, [sujet()]);
    writeFileSync(join(r.dir, "agents.json"), JSON.stringify([{ id: "s1", sessionId: "sess-acme-0", status: "idle", name: "acme" }]));
    const res = await inProcess(r, { d: "app/deliver.ts" }, `return await d.deliverToSujet("A", "/compact", "board", { ackTimeoutMs: 300 });`);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
    expect(res.error).toContain("terminal");
    expect(spawns(r)).toEqual([]);
  }, 30_000);

  test("no declaration: the old routes, untouched", async () => {
    const r = rig();
    writeSujets(r, [sujet()]);
    const res = await deliver(r, 300);
    expect(res.via).toBe("resume");
    expect(res.note).not.toContain("20 s");
    expect(existsSync(join(r.state, "mailbox"))).toBe(false);
  }, 30_000);
});

describe("the board says where a session's state comes from", () => {
  const base = { events: [], live: new Map(), running: new Map([["sess-acme-0", "busy"]]), sessions: [], otherSessions: 0, now: new Date("2026-09-30T09:00:00Z"), timeOf: (iso: string) => iso.slice(11, 16) };
  const ctx = { timeOf: (iso: string) => iso.slice(11, 16), readAt: "09:00" };
  test("declared by the session, on hover of its status", () => {
    const s = sujet({ status: "working" }) as never;
    const html = focusView(buildBoard({ ...base, sujets: [s], sources: new Map([["sess-acme-0", "mod"]]), trail: new Map([["sess-acme-0", [{ text: "Wait for the Acme export", at: null }]]]) }), ctx, "C0ACME0001:1759219200.000100");
    expect(html).toContain("état déclaré par la session");
    expect(html).toContain("Wait for the Acme export");
  });
  test("reconstructed from Claude Code's files otherwise", () => {
    const s = sujet({ status: "working" }) as never;
    const html = focusView(buildBoard({ ...base, sujets: [s], sources: new Map([["sess-acme-0", "reconstructed"]]) }), ctx, "C0ACME0001:1759219200.000100");
    expect(html).toContain("état reconstitué depuis les fichiers de Claude Code");
    expect(html).not.toContain("état déclaré par la session");
  });
});
