/**
 * The update from the board, on the server side: the version route, the guard of POST /api/update, the slot of the
 * top bar, and the line the master receives. The update itself is covered on throwaway repositories in update.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { boardPage, type VersionState, versionControl } from "./board.ts";
import { revueLine } from "./core/master.ts";
import { groupChanges } from "./core/version.ts";
import { cleanupRigs, rig, startServe } from "./test-rig.ts";

afterEach(cleanupRigs);

const PKG_VERSION = (JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8")) as { version: string }).version;

describe("serve: version and update routes", () => {
  test("GET /api/version answers with the installed version; POST /api/update is refused without the page's origin", async () => {
    const r = rig();
    const s = await startServe(r);
    try {
      const v = (await (await fetch(`http://127.0.0.1:${s.port}/api/version`)).json()) as VersionState;
      expect(v.local.version).toBe(PKG_VERSION);
      expect(v.local.sha).toMatch(/^[0-9a-f]{4,}$/);
      // checks are off in the rig: nothing fetched, nothing offered
      expect(v.check).toBeNull();
      expect(v.running).toBe(false);
      const noOrigin = await fetch(`http://127.0.0.1:${s.port}/api/update`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      expect(noOrigin.status).toBe(403);
      const foreign = await fetch(`http://127.0.0.1:${s.port}/api/update`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}" });
      expect(foreign.status).toBe(403);
      // the board page carries the version pill in its top bar
      const page = await (await fetch(`http://127.0.0.1:${s.port}/board`)).text();
      expect(page).toContain('id="version-slot"');
      expect(page).toContain(`v${PKG_VERSION}`);
      const slot = await (await fetch(`http://127.0.0.1:${s.port}/board/version`)).text();
      expect(slot).toContain("data-version");
    } finally {
      await s.stop();
    }
  });
});

const local = { version: "0.1.0", sha: "abc1234", branch: "main", upstream: "origin/main", dirty: [] };
const commits = [
  { sha: "f1", subject: "feat(board): update from the board" },
  { sha: "f2", subject: "fix(serve): restart on the same port" },
  { sha: "f3", subject: "docs: skill" },
  { sha: "f4", subject: "test: repos" },
];
const check = { checkedAt: "2026-10-01T08:00:00Z", available: true, upstream: "origin/main", target: "0.2.0", newer: true, commits, changes: groupChanges(commits) };

describe("versionControl", () => {
  test("without upstream: the pill only, sha in its tooltip", () => {
    const html = versionControl({ local: { ...local, upstream: null }, check: { ...check, available: false, reason: "noUpstream", commits: [], changes: groupChanges([]) }, running: false, failure: null });
    expect(html).toContain(">v0.1.0</span>");
    expect(html).toContain("abc1234");
    expect(html).not.toContain("data-update-menu");
  });
  test("an update: the button counts the commits, the panel lists features then fixes, the rest folded", () => {
    const html = versionControl({ local, check, running: false, failure: null });
    expect(html).toContain("Mise à jour · 4 nouveautés");
    expect(html).toContain("Strato v0.1.0 → v0.2.0");
    expect(html.indexOf("Nouveautés")).toBeLessThan(html.indexOf("Corrections"));
    expect(html).toContain("update from the board");
    expect(html).toContain("restart on the same port");
    expect(html).toContain("et 2 autres changements");
    expect(html).not.toContain(">skill<");
    expect(html).toContain("data-update-apply");
  });
  test("running: a busy state, no button", () => {
    const html = versionControl({ local, check, running: true, failure: null });
    expect(html).toContain("Mise à jour en cours…");
    expect(html).not.toContain("data-update-apply");
  });
  test("a refused update names the modified files; a failed check shows its output", () => {
    const dirty = versionControl({ local, check, running: false, failure: { ok: false, reason: "dirty", from: "abc1234def", files: ["SKILL.md", "scripts/board.ts"] } });
    expect(dirty).toContain("SKILL.md, scripts/board.ts");
    const broken = versionControl({ local, check, running: false, failure: { ok: false, reason: "checkFailed", from: "abc1234def", output: "1 fail\nboard.test.ts" } });
    expect(broken).toContain("revenue sur abc1234");
    expect(broken).toContain("1 fail");
  });
  test("the page puts the slot in the top bar", () => {
    expect(boardPage("", '<span data-version>v9.9.9</span>')).toContain('<div id="version-slot" class="ml-1 flex items-center gap-2"><span data-version>v9.9.9</span></div>');
  });
});

describe("the master's line", () => {
  test("an update asks to reread SKILL.md and re-arm the listener", () => {
    const line = revueLine({ id: "u1", kind: "update", from: "0.1.0 (abc1234)", to: "0.2.0 (def5678)", at: "2026-10-01T08:00:00Z" });
    expect(line).toStartWith("[strato] update · Alice updated Strato from the board, 0.1.0 (abc1234) -> 0.2.0 (def5678) · id=u1");
    expect(line).toContain("reread SKILL.md in full");
    expect(line).toContain("re-arm the listener");
    expect(line).toContain('revue-done u1 "');
  });
});
