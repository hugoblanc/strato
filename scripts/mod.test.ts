/**
 * Strato's mod: the files embedded in the binary, the declaration a session writes and how the board reads it, and the
 * inbox's protocol (post, acknowledgement, fallback). The mod's own hooks are tested by `claude plugin test`
 * (mod/strato-state/tests), run below when the claude CLI is on the PATH.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acksPath, deliverThroughInbox, ensureModFolder, inboxMessages, inboxPath, MOD_FILES, modDir, modFolderState, modStatePath, postToInbox, readModState, waitForAck, withdrawFromInbox } from "./app/mod.ts";
import { firstSpawnArgs, resumeArgs } from "./claude/model.ts";
import { declaredView, MOD_FRESH_MS, type ModState, modUsable, parseModState } from "./claude/mod-state.ts";

const SOURCE = join(import.meta.dir, "mod", "strato-state");
const SID = "0b5e2c1d-acme-4a1e-9c3f-000000000001";
const dirs: string[] = [];
const stateDir = () => {
  const d = mkdtempSync(join(tmpdir(), "strato-mod-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = Date.parse("2026-10-06T09:00:00Z");
function declaration(over: Partial<ModState> = {}): ModState {
  return {
    source: "mod",
    v: 1,
    sessionId: SID,
    status: "working",
    since: NOW - 30_000,
    step: { tool: "Bash", input: { command: "sleep 20", description: "Wait for the Acme export" }, at: NOW - 5_000 },
    stepAt: NOW - 5_000,
    trail: [
      { tool: "Read", input: { file_path: "/acme/report.md" }, at: NOW - 20_000 },
      { tool: "ToolSearch", input: {}, at: NOW - 10_000 },
      { tool: "Bash", input: { command: "sleep 20", description: "Wait for the Acme export" }, at: NOW - 5_000 },
    ],
    lastText: "Ann, the export is ready.",
    lastTextAt: NOW - 60_000,
    agents: [],
    waiting: null,
    beat: NOW - 2_000,
    turnId: "t1",
    error: false,
    ...over,
  };
}
const writeDeclaration = (state: string, m: ModState | string) => {
  mkdirSync(join(state, "live"), { recursive: true });
  writeFileSync(modStatePath(state, SID), typeof m === "string" ? m : JSON.stringify(m));
};

describe("embedded mod files", () => {
  test("the binary's copy is the source folder, byte for byte", () => {
    expect(Object.keys(MOD_FILES).sort()).toEqual([".claude-plugin/plugin.json", "hooks/hooks.json", "hooks/register.js"]);
    for (const [p, text] of Object.entries(MOD_FILES)) expect(text).toBe(readFileSync(join(SOURCE, p), "utf8"));
    expect(JSON.parse(MOD_FILES["hooks/hooks.json"])).toEqual({ modules: ["./register.js"] });
    expect(JSON.parse(MOD_FILES[".claude-plugin/plugin.json"]).name).toBe("strato-state");
  });

  test("the folder is written once, left alone while unchanged, rewritten when the content changes", () => {
    const state = stateDir();
    expect(modFolderState(state)).toBe("missing");
    const dir = ensureModFolder(state);
    expect(dir).toBe(join(state, "mod", "strato-state"));
    expect(modFolderState(state)).toBe("ok");
    const file = join(dir, "hooks", "register.js");
    const before = statSync(file).mtimeMs;
    Bun.sleepSync(20);
    ensureModFolder(state);
    expect(statSync(file).mtimeMs).toBe(before);
    const next = { ...MOD_FILES, "hooks/register.js": `${MOD_FILES["hooks/register.js"]}\n// next release\n` };
    expect(modFolderState(state, next)).toBe("stale");
    ensureModFolder(state, next);
    expect(readFileSync(file, "utf8")).toContain("next release");
    // a file deleted by hand comes back even though the hash did not move
    rmSync(file);
    ensureModFolder(state, next);
    expect(readFileSync(file, "utf8")).toContain("next release");
  });

  const claude = Bun.which("claude");
  test.skipIf(!claude)("claude plugin validate accepts the mod", () => {
    const state = stateDir();
    const r = Bun.spawnSync([claude as string, "plugin", "validate", ensureModFolder(state)], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    const text = `${r.stdout.toString()}${r.stderr.toString()}`;
    expect(text).toContain("Validation passed");
    expect(r.exitCode).toBe(0);
  }, 70_000);

  test.skipIf(!claude)("the mod's own hook tests pass under claude plugin test", () => {
    const r = Bun.spawnSync([claude as string, "plugin", "test", SOURCE], { stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    const text = `${r.stdout.toString()}${r.stderr.toString()}`;
    expect(text).toContain(" 0 fail");
    expect(r.exitCode).toBe(0);
  }, 130_000);
});

describe("spawn and resume arguments", () => {
  test("a resume passes the session id and the message, and no option at all", () => {
    const args = resumeArgs(SID, "--plugin-dir looks like a flag but is the message");
    expect(args).toEqual(["--resume", SID, "--plugin-dir looks like a flag but is the message"]);
    expect(args.slice(0, 2).filter((a) => a.startsWith("-"))).toEqual(["--resume"]);
  });
  test("the first spawn loads the mod's folder; without it, the arguments are those of before", () => {
    const base = { name: "acme · Ann · A", settings: "{}", prompt: "go", skipPermissions: false };
    expect(firstSpawnArgs({ ...base, modDir: "/acme/state/mod/strato-state" })).toEqual(["--plugin-dir", "/acme/state/mod/strato-state", "-n", "acme · Ann · A", "--settings", "{}", "go"]);
    expect(firstSpawnArgs({ ...base, modDir: null })).toEqual(["-n", "acme · Ann · A", "--settings", "{}", "go"]);
    expect(firstSpawnArgs({ ...base, skipPermissions: true, modDir: null })[0]).toBe("--dangerously-skip-permissions");
  });
});

describe("the declaration a session writes", () => {
  test("parsed when whole, refused when cut or of another version", () => {
    const m = declaration();
    expect(parseModState(JSON.stringify(m))?.status).toBe("working");
    expect(parseModState(JSON.stringify(m).slice(0, 80))).toBeNull();
    expect(parseModState("")).toBeNull();
    expect(parseModState(JSON.stringify({ ...m, v: 2 }))).toBeNull();
    expect(parseModState(JSON.stringify({ ...m, status: "dreaming" }))).toBeNull();
  });

  test("usable while its beat is fresh, or when it says the session ended", () => {
    expect(modUsable(declaration(), NOW)).toBe(true);
    expect(modUsable(declaration({ beat: NOW - MOD_FRESH_MS - 1 }), NOW)).toBe(false);
    expect(modUsable(declaration({ status: "ended", beat: NOW - 3_600_000 }), NOW)).toBe(true);
    expect(modUsable(null, NOW)).toBe(false);
  });

  test("in the board's terms: status words, the current step's label, the last word, the sub-agents", () => {
    const d = declaredView(
      declaration({
        agents: [
          { id: "agent-zoe", type: "general-purpose", description: "Read the Acme thread", model: "haiku", parentId: null, status: "running", since: NOW - 8_000, lastAt: NOW - 1_000, step: { tool: "Grep", input: { pattern: "invoice" }, at: NOW - 1_000 } },
          { id: "agent-ann", type: "Explore", description: null, model: null, parentId: "agent-zoe", status: "done", since: NOW - 7_000, lastAt: NOW - 3_000, step: null },
        ],
      }),
    );
    expect(d.running).toBe("busy");
    expect(d.attention).toBeNull();
    // plumbing tools make no step; Bash says its own description
    expect(d.trail.map((s) => s.text)).toEqual([expect.stringContaining("report.md"), "Wait for the Acme export"]);
    expect(d.lastAgent?.text).toBe("Ann, the export is ready.");
    expect(d.agents.length).toBe(1);
    expect(d.agents[0].label).toBe("Read the Acme thread");
    expect(d.agents[0].step?.text).toContain("invoice");
    expect(d.agents[0].children.map((a) => a.label)).toEqual(["Explore"]);
  });

  test("waiting, idle, an error, and an end translate to the hooks' attention labels", () => {
    expect(declaredView(declaration({ status: "waiting" }))).toMatchObject({ running: "waiting", attention: "attend une autorisation" });
    expect(declaredView(declaration({ status: "idle" }))).toMatchObject({ running: "idle", attention: "tour terminé" });
    expect(declaredView(declaration({ status: "idle", error: true })).attention).toBe("tour terminé en erreur");
    const ended = declaredView(declaration({ status: "ended", agents: [{ id: "a1", type: "Explore", description: "x", model: null, parentId: null, status: "running", since: NOW, lastAt: NOW, step: null }] }));
    expect(ended).toMatchObject({ running: null, attention: "arrêtée" });
    expect(ended.agents[0].status).toBe("stopped");
  });
});

describe("reading a session's declaration from disk", () => {
  test("missing: null, so the board reads Claude Code's files", () => {
    expect(readModState(stateDir(), SID, NOW)).toBeNull();
  });
  test("fresh: read; stale: null", () => {
    const state = stateDir();
    writeDeclaration(state, declaration());
    expect(readModState(state, SID, NOW)?.status).toBe("working");
    expect(readModState(state, SID, NOW + MOD_FRESH_MS)).toBeNull();
  });
  test("ended: read whatever its age", () => {
    const state = stateDir();
    writeDeclaration(state, declaration({ status: "ended", beat: NOW - 86_400_000 }));
    expect(readModState(state, SID, NOW)?.status).toBe("ended");
  });
  test("caught halfway through a write: the previous whole declaration stands, none before it means null", () => {
    const state = stateDir();
    writeDeclaration(state, JSON.stringify(declaration()).slice(0, 50));
    expect(readModState(state, SID, NOW)).toBeNull();
    writeDeclaration(state, declaration({ status: "idle" }));
    expect(readModState(state, SID, NOW)?.status).toBe("idle");
    Bun.sleepSync(20);
    writeDeclaration(state, JSON.stringify(declaration({ status: "working" })).slice(0, 50));
    expect(readModState(state, SID, NOW)?.status).toBe("idle");
  });
});

/** Plays the mod's side of the inbox: acknowledges each new message with `state` after `delayMs`. */
function fakeMod(state: string, ackState: "queued" | "submitted", delayMs = 50): () => void {
  let stopped = false;
  void (async () => {
    while (!stopped) {
      await Bun.sleep(delayMs);
      const messages = inboxMessages(state, SID);
      if (!messages.length) continue;
      writeFileSync(acksPath(state, SID), messages.map((m) => `${JSON.stringify({ id: m.id, state: ackState, at: Date.now() })}\n`).join(""));
    }
  })();
  return () => {
    stopped = true;
  };
}

describe("the inbox", () => {
  test("a post appends one JSON line with an id; messages acknowledged as submitted leave at the next post", () => {
    const state = stateDir();
    const a = postToInbox(state, SID, "Zoé: go for Acme");
    const b = postToInbox(state, SID, "Ann: wait");
    expect(inboxMessages(state, SID).map((m) => m.id)).toEqual([a, b]);
    expect(readFileSync(inboxPath(state, SID), "utf8").trim().split("\n").length).toBe(2);
    writeFileSync(acksPath(state, SID), `${JSON.stringify({ id: a, state: "submitted", at: NOW })}\n${JSON.stringify({ id: b, state: "queued", at: NOW })}\n`);
    const c = postToInbox(state, SID, "third");
    // b was only queued: it stays until the session takes it
    expect(inboxMessages(state, SID).map((m) => m.id)).toEqual([b, c]);
  });

  test("waits for the acknowledgement: submitted, queued, or nothing past the timeout", async () => {
    const state = stateDir();
    const id = postToInbox(state, SID, "hello");
    expect(await waitForAck(state, SID, id, 120, 20)).toBeNull();
    writeFileSync(acksPath(state, SID), `${JSON.stringify({ id, state: "queued", at: NOW })}\n`);
    expect(await waitForAck(state, SID, id, 120, 20)).toBe("queued");
    writeFileSync(acksPath(state, SID), `${JSON.stringify({ id, state: "queued", at: NOW })}\n${JSON.stringify({ id, state: "submitted", at: NOW })}\n${JSON.stringify({ id, state: "queued", at: NOW })}\n`);
    expect(await waitForAck(state, SID, id, 120, 20)).toBe("submitted");
  });

  test("a message not acknowledged is withdrawn; one acknowledged meanwhile is not", () => {
    const state = stateDir();
    const a = postToInbox(state, SID, "a");
    const b = postToInbox(state, SID, "b");
    expect(withdrawFromInbox(state, SID, a)).toBe(true);
    expect(inboxMessages(state, SID).map((m) => m.id)).toEqual([b]);
    writeFileSync(acksPath(state, SID), `${JSON.stringify({ id: b, state: "submitted", at: NOW })}\n`);
    expect(withdrawFromInbox(state, SID, b)).toBe(false);
    expect(inboxMessages(state, SID).map((m) => m.id)).toEqual([b]);
  });

  test("no fresh declaration: nothing is written, the caller uses its other routes", async () => {
    const state = stateDir();
    expect(await deliverThroughInbox(state, SID, "hello")).toEqual({ via: "none", reason: "no-mod" });
    writeDeclaration(state, declaration({ beat: Date.now() - MOD_FRESH_MS - 5_000 }));
    expect(await deliverThroughInbox(state, SID, "hello")).toEqual({ via: "none", reason: "no-mod" });
    writeDeclaration(state, declaration({ status: "ended", beat: Date.now() }));
    expect(await deliverThroughInbox(state, SID, "hello")).toEqual({ via: "none", reason: "no-mod" });
    expect(inboxMessages(state, SID)).toEqual([]);
  });

  test("a fresh declaration: the message goes through the inbox and its acknowledgement is the answer", async () => {
    for (const ack of ["submitted", "queued"] as const) {
      const state = stateDir();
      writeDeclaration(state, declaration({ beat: Date.now() }));
      const stop = fakeMod(state, ack);
      expect(await deliverThroughInbox(state, SID, "hello", { timeoutMs: 3_000, pollMs: 20 })).toEqual({ via: "inbox", ack });
      stop();
    }
  });

  test("a mod that does not answer: the message is taken back and the caller falls back", async () => {
    const state = stateDir();
    writeDeclaration(state, declaration({ beat: Date.now() }));
    expect(await deliverThroughInbox(state, SID, "hello", { timeoutMs: 150, pollMs: 20 })).toEqual({ via: "none", reason: "unacknowledged" });
    expect(inboxMessages(state, SID)).toEqual([]);
  });
});

test("modDir is under the state folder", () => {
  expect(modDir("/acme/state")).toBe("/acme/state/mod/strato-state");
});
