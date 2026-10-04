import { describe, expect, test } from "bun:test";
import { compareSemver, groupChanges, parseSemver } from "./core/version.ts";

describe("semver", () => {
  test("parses x.y.z, with a v prefix or a pre-release tag", () => {
    expect(parseSemver("0.1.0")).toEqual({ major: 0, minor: 1, patch: 0 });
    expect(parseSemver("v2.10.3")).toEqual({ major: 2, minor: 10, patch: 3 });
    expect(parseSemver("1.2.3-beta.1")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver(null)).toBeNull();
  });
  test("compares numerically, not as text", () => {
    expect(compareSemver("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareSemver("1.2.3", "v1.2.3")).toBe(0);
    expect(compareSemver("2.0.0", "1.99.99")).toBeGreaterThan(0);
  });
  test("an unreadable version sorts before a readable one", () => {
    expect(compareSemver(null, "0.0.1")).toBeLessThan(0);
    expect(compareSemver("0.0.1", "garbage")).toBeGreaterThan(0);
    expect(compareSemver(null, undefined)).toBe(0);
  });
});

describe("groupChanges", () => {
  test("features, fixes and the rest, prefix and scope removed, order kept", () => {
    const g = groupChanges([
      "feat(strato): board shows the version",
      "fix: decision tasks keep their buttons",
      "docs(strato): README and MIT license",
      "feat: update from the board",
      "test(update): throwaway repos",
      "chore: bump",
      "refactor(core)!: split the model",
      "style: format",
      "perf(board): fewer redraws",
      "Merge the old way",
    ]);
    expect(g.features.map((c) => c.text)).toEqual(["board shows the version", "update from the board"]);
    expect(g.features[0].scope).toBe("strato");
    expect(g.features[1].scope).toBeUndefined();
    expect(g.fixes.map((c) => c.text)).toEqual(["decision tasks keep their buttons"]);
    expect(g.other.map((c) => c.text)).toEqual(["README and MIT license", "throwaway repos", "bump", "split the model", "format", "fewer redraws", "Merge the old way"]);
  });
  test("keeps the sha of a commit, and the type is case-insensitive", () => {
    const g = groupChanges([{ sha: "abc1234", subject: "Fix(board): pill colour" }]);
    expect(g.fixes).toEqual([{ sha: "abc1234", text: "pill colour", scope: "board" }]);
  });
  test("a subject without a conventional prefix stays whole in other", () => {
    expect(groupChanges(["Update README: typo"]).other[0].text).toBe("Update README: typo");
    expect(groupChanges(["wip"]).other[0].text).toBe("wip");
  });
});
