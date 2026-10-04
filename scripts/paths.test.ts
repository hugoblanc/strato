import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envValue, findStateRoot, resolveStateDir } from "./core/paths.ts";
import { cleanupRigs, rig, run, SCRIPTS } from "./test-rig.ts";

const WS = "/w";
const has = (...paths: string[]) => (p: string) => paths.includes(p);

describe("state folder", () => {
  test("STRATO_STATE wins, then the legacy AIGUILLEUR_STATE", () => {
    expect(resolveStateDir({ STRATO_STATE: "/a", AIGUILLEUR_STATE: "/b" }, WS, has())).toBe("/a");
    expect(resolveStateDir({ AIGUILLEUR_STATE: "/b" }, WS, has())).toBe("/b");
  });
  test(".strato wins over .aiguilleur when both exist", () => {
    expect(resolveStateDir({}, WS, has("/w/.strato", "/w/.aiguilleur"))).toBe("/w/.strato");
  });
  test("an installation that only has .aiguilleur keeps it", () => {
    expect(resolveStateDir({}, WS, has("/w/.aiguilleur"))).toBe("/w/.aiguilleur");
  });
  test("a new installation gets .strato", () => {
    expect(resolveStateDir({}, WS, has())).toBe("/w/.strato");
  });
  test("an empty variable does not count", () => {
    expect(resolveStateDir({ STRATO_STATE: "" }, WS, has("/w/.aiguilleur"))).toBe("/w/.aiguilleur");
  });
});

describe("environment variables", () => {
  test("STRATO_<name> first, AIGUILLEUR_<name> as fallback", () => {
    expect(envValue({ STRATO_WORKSPACE: "/s", AIGUILLEUR_WORKSPACE: "/a" }, "WORKSPACE")).toBe("/s");
    expect(envValue({ AIGUILLEUR_WORKSPACE: "/a" }, "WORKSPACE")).toBe("/a");
    expect(envValue({}, "WORKSPACE")).toBeUndefined();
    expect(envValue({ STRATO_WORKSPACE: "", AIGUILLEUR_WORKSPACE: "/a" }, "WORKSPACE")).toBe("/a");
  });

  test("a real process through the legacy alias: legacy variables only, legacy .aiguilleur folder found from the workspace", async () => {
    const r = rig();
    const ws = mkdtempSync(join(tmpdir(), "strato-ws-"));
    try {
      mkdirSync(join(ws, ".aiguilleur"));
      const env = { ...r.env, STRATO_STATE: "", STRATO_WORKSPACE: "", AIGUILLEUR_STATE: "", AIGUILLEUR_WORKSPACE: ws };
      const res = await run(r, [join(SCRIPTS, "aiguilleur.ts"), "doctor"], env);
      expect(res.out).toContain(join(ws, ".aiguilleur"));
    } finally {
      rmSync(ws, { recursive: true, force: true });
      cleanupRigs();
    }
  });
});

describe("findStateRoot", () => {
  test("finds the project from any of its subfolders, the way git finds .git", () => {
    const dirs = new Set(["/work/acme/.aiguilleur"]);
    const exists = (p: string) => dirs.has(p);
    expect(findStateRoot("/work/acme/api/.claude/worktrees/eng-12", exists)).toBe("/work/acme");
    expect(findStateRoot("/work/acme", exists)).toBe("/work/acme");
    expect(findStateRoot("/work/other", exists)).toBeNull();
  });
  test(".strato and the legacy .aiguilleur both mark a project", () => {
    expect(findStateRoot("/a/b/c", (p) => p === "/a/.strato")).toBe("/a");
  });
});
