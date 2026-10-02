/**
 * The compiled distribution: how Strato calls itself in each mode, the SKILL.md written by install-skill, the embedded
 * policy, and the update of a binary from GitHub releases (API mocked, binaries are throwaway files).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRelease, checkRelease, type GithubRelease, parseSha256Sums, releaseCommits, releaseSha, replaceBinary, rollbackBinary, sha256Hex } from "./app/release.ts";
import { commandForEntry, selfArgv, selfCommand, shellWord } from "./app/self.ts";
import { releaseNotes } from "./build/release-notes.ts";
import { installSkill, refreshSkills, skillCommand, skillTarget } from "./commands/install-skill.ts";
import { assetName, releaseTarget } from "./core/build-info.ts";
import { isGeneratedSkill, renderSkill, SKILL_MARKER } from "./core/skill.ts";
import { EMBEDDED_DEFAULTS, POLICY_TEMPLATES } from "./policy/prompts.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "strato-binary-"));
  dirs.push(d);
  return d;
};

const DEV = { compiled: false, execPath: "/Users/a/.bun/bin/bun", script: "/Users/a/strato/scripts/strato.ts" };
const BIN = { compiled: true, execPath: "/Users/a/.local/bin/strato", script: "/$bunfs/root/strato.ts" };

describe("selfCommand", () => {
  test("development: bun from the PATH and the script, as existing hooks and permissions spell it", () => {
    expect(selfCommand(DEV)).toBe("bun /Users/a/strato/scripts/strato.ts");
    expect(selfArgv(DEV)).toEqual(["/Users/a/.bun/bin/bun", "/Users/a/strato/scripts/strato.ts"]);
  });
  test("compiled: the binary alone, never the virtual path of the code", () => {
    expect(selfCommand(BIN)).toBe("/Users/a/.local/bin/strato");
    expect(selfArgv(BIN)).toEqual(["/Users/a/.local/bin/strato"]);
    expect(selfCommand(BIN)).not.toContain("$bunfs");
  });
  test("a path with a space is quoted for the shell", () => {
    expect(selfCommand({ ...BIN, execPath: "/Users/a b/bin/strato" })).toBe("'/Users/a b/bin/strato'");
    expect(shellWord("it's")).toBe(`'it'\\''s'`);
  });
  test("commandForEntry: a .ts entry is run by bun, a binary as is", () => {
    expect(commandForEntry("/s/strato.ts")).toBe("bun /s/strato.ts");
    expect(commandForEntry("/opt/bin/strato")).toBe("/opt/bin/strato");
    // a path under the home folder stays one the shell expands
    expect(commandForEntry("~/.local/bin/strato")).toBe("~/.local/bin/strato");
    expect(commandForEntry("~/my tools/strato.ts")).toBe("bun ~/'my tools/strato.ts'");
    expect(commandForEntry("C:/strato/strato-windows-x64.exe")).toBe("C:/strato/strato-windows-x64.exe");
  });
});

describe("release targets", () => {
  test("platform and arch map to the asset names install.sh and the update download", () => {
    expect(releaseTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(releaseTarget("linux", "x64")).toBe("linux-x64");
    expect(releaseTarget("win32", "x64")).toBe("windows-x64");
    expect(releaseTarget("freebsd", "x64")).toBeNull();
    expect(releaseTarget("linux", "ia32")).toBeNull();
    expect(assetName("darwin-arm64")).toBe("strato-darwin-arm64");
    expect(assetName("windows-x64")).toBe("strato-windows-x64.exe");
  });
});

describe("embedded policy", () => {
  test("every default template is embedded, identical to its file", () => {
    for (const n of POLICY_TEMPLATES) expect(EMBEDDED_DEFAULTS[n]).toBe(readFileSync(join(import.meta.dir, "policy/defaults", `${n}.md`), "utf8"));
  });
});

const TEMPLATE = readFileSync(join(import.meta.dir, "..", "SKILL.md"), "utf8");

describe("SKILL.md template", () => {
  test("the repository's SKILL.md writes every command with $STRATO and explains it in one block", () => {
    expect(TEMPLATE).not.toContain("bun $S");
    expect(TEMPLATE).not.toMatch(/\$S\b/);
    expect(TEMPLATE).toContain("<!-- strato:command -->");
    expect(TEMPLATE).toContain("<!-- /strato:command -->");
    expect(TEMPLATE).toContain("$STRATO doctor");
  });
  test("rendered for a binary: the command filled in everywhere, the block replaced, the marker after the front matter", () => {
    const out = renderSkill(TEMPLATE, "strato", "1.2.3");
    expect(out).not.toContain("$STRATO");
    expect(out).not.toContain("strato:command");
    expect(out).toContain("| `strato doctor` |");
    expect(out).toContain("as a binary (version 1.2.3), and its command is `strato`");
    expect(out.startsWith("---\nname: strato\n")).toBe(true);
    const fmEnd = out.indexOf("\n---\n", 4);
    expect(out.indexOf(SKILL_MARKER)).toBeGreaterThan(fmEnd);
    expect(isGeneratedSkill(out)).toBe(true);
    expect(isGeneratedSkill(TEMPLATE)).toBe(false);
  });
  test("rendered from a development clone: says so, with the bun command", () => {
    const out = renderSkill(TEMPLATE, "bun /c/scripts/strato.ts", "0.1.0", false);
    expect(out).toContain("from a development clone");
    expect(out).toContain("`bun /c/scripts/strato.ts listen`");
  });
});

describe("install-skill", () => {
  const opts = (target: string) => ({ target, command: "/x/bin/strato", version: "0.2.0", compiled: true, template: TEMPLATE });

  test("global by default, or <project>/.claude/skills/strato/SKILL.md", () => {
    expect(skillTarget(null, { CLAUDE_CONFIG_DIR: "/cfg" })).toBe("/cfg/skills/strato/SKILL.md");
    expect(skillTarget("/p")).toBe("/p/.claude/skills/strato/SKILL.md");
  });
  test("writes a new skill, then rewrites its own without --force", () => {
    const d = tmp();
    const target = skillTarget(d);
    expect(installSkill(opts(target))).toEqual({ ok: true, path: target, replaced: "new" });
    expect(readFileSync(target, "utf8")).toContain("`/x/bin/strato doctor`");
    expect(installSkill({ ...opts(target), version: "0.3.0" })).toMatchObject({ ok: true, replaced: "generated" });
    expect(readFileSync(target, "utf8")).toContain("(v0.3.0)");
  });
  test("a SKILL.md it did not write is kept, unless --force", () => {
    const d = tmp();
    const target = skillTarget(d);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "hand written\n");
    expect(installSkill(opts(target))).toMatchObject({ ok: false, reason: "foreign" });
    expect(readFileSync(target, "utf8")).toBe("hand written\n");
    expect(installSkill({ ...opts(target), force: true })).toMatchObject({ ok: true, replaced: "forced" });
  });
  test("a development clone is never written into, even with --force", () => {
    const d = tmp();
    const target = skillTarget(d);
    mkdirSync(join(target, "..", "scripts"), { recursive: true });
    writeFileSync(join(target, "..", "scripts", "strato.ts"), "");
    writeFileSync(target, TEMPLATE);
    expect(installSkill({ ...opts(target), force: true })).toMatchObject({ ok: false, reason: "clone" });
    expect(readFileSync(target, "utf8")).toBe(TEMPLATE);
  });
  test("a linked skill folder: refused, then with --force the link (not its target) becomes a real folder", () => {
    const d = tmp();
    const clone = join(d, "elsewhere");
    mkdirSync(clone);
    writeFileSync(join(clone, "SKILL.md"), "the clone's\n");
    const target = skillTarget(join(d, "proj"));
    mkdirSync(join(target, "..", ".."), { recursive: true });
    symlinkSync(clone, join(target, ".."));
    expect(installSkill(opts(target))).toMatchObject({ ok: false, reason: "symlink" });
    expect(installSkill({ ...opts(target), force: true })).toMatchObject({ ok: true });
    expect(lstatSync(join(target, "..")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(clone, "SKILL.md"), "utf8")).toBe("the clone's\n");
  });
  test("--refresh rewrites the registered skills that still carry the marker, and only those", () => {
    const d = tmp();
    const a = skillTarget(join(d, "a"));
    const b = skillTarget(join(d, "b"));
    installSkill(opts(a));
    installSkill(opts(b));
    writeFileSync(b, "edited by hand\n");
    const registry = join(d, "skills.json");
    writeFileSync(registry, JSON.stringify([a, b, join(d, "gone", "SKILL.md")]));
    expect(refreshSkills("strato", "9.9.9", true, registry)).toEqual([a]);
    expect(readFileSync(a, "utf8")).toContain("(v9.9.9)");
    // the skill keeps its own command (/x/bin/strato), not the refreshing process's
    expect(readFileSync(a, "utf8")).toContain("`/x/bin/strato doctor`");
    expect(readFileSync(b, "utf8")).toBe("edited by hand\n");
  });
  test("the command: `strato` when the PATH's strato is this binary, else its path; bun in development", () => {
    const d = tmp();
    const bin = join(d, "strato");
    writeFileSync(bin, "");
    expect(skillCommand({ ...BIN, execPath: bin }, () => bin)).toBe("strato");
    expect(skillCommand({ ...BIN, execPath: bin }, () => "/usr/local/bin/strato")).toBe(bin);
    expect(skillCommand({ ...BIN, execPath: bin }, () => null)).toBe(bin);
    expect(skillCommand(DEV, () => null)).toBe("bun /Users/a/strato/scripts/strato.ts");
  });
});

describe("release notes", () => {
  const commits = [
    { sha: "a1b2c3d", subject: "feat(board): a button" },
    { sha: "b2c3d4e", subject: "fix: the restart" },
    { sha: "c3d4e5f", subject: "docs: readme" },
    { sha: "d4e5f6a", subject: "feat: plain feature" },
  ];
  test("features then fixes, the rest counted, the commit at the end", () => {
    const body = releaseNotes(commits, "0123456789abcdef0123456789abcdef01234567", "v0.1.0");
    expect(body).toContain("## What's new");
    expect(body).toContain("- **board**: a button (a1b2c3d)");
    expect(body).toContain("And 1 other change (docs, tests, internals) since v0.1.0.");
    expect(body.indexOf("### Features")).toBeLessThan(body.indexOf("### Fixes"));
    expect(releaseSha(body)).toBe("0123456789abcdef0123456789abcdef01234567");
  });
  test("round trip: the board reads back what the release says", () => {
    const back = releaseCommits(releaseNotes(commits, "abcdef1", null));
    expect(back).toEqual([
      { sha: "a1b2c3d", subject: "feat(board): a button" },
      { sha: "d4e5f6a", subject: "feat: plain feature" },
      { sha: "b2c3d4e", subject: "fix: the restart" },
    ]);
  });
  test("a hand-written body still yields its bullets", () => {
    expect(releaseCommits("Some intro\n\n- fix(x): y\n* plain line")).toEqual([
      { sha: "", subject: "fix(x): y" },
      { sha: "", subject: "plain line" },
    ]);
  });
});

describe("SHA256SUMS", () => {
  test("parses the sha256sum format, text and binary mode", () => {
    const h = "a".repeat(64);
    const sums = parseSha256Sums(`${h}  strato-linux-x64\n${"B".repeat(64)} *strato-windows-x64.exe\ngarbage\n`);
    expect(sums.get("strato-linux-x64")).toBe(h);
    expect(sums.get("strato-windows-x64.exe")).toBe("b".repeat(64));
    expect(sums.size).toBe(2);
  });
  test("sha256Hex matches the known digest of 'abc'", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("replaceBinary", () => {
  test("swaps in place, keeps the old file as .previous, executable; rollback puts it back", async () => {
    const d = tmp();
    const bin = join(d, "strato");
    writeFileSync(bin, "old", { mode: 0o755 });
    const r = await replaceBinary(bin, new TextEncoder().encode("new"));
    expect(r).toEqual({ ok: true, previous: `${bin}.previous` });
    expect(readFileSync(bin, "utf8")).toBe("new");
    expect(readFileSync(`${bin}.previous`, "utf8")).toBe("old");
    expect(lstatSync(bin).mode & 0o111).toBeTruthy();
    expect(rollbackBinary(bin)).toBe(true);
    expect(readFileSync(bin, "utf8")).toBe("old");
    expect(rollbackBinary(bin)).toBe(false);
  });
  test("a new binary that fails its check never replaces the old one, and leaves no temp file", async () => {
    const d = tmp();
    const bin = join(d, "strato");
    writeFileSync(bin, "old", { mode: 0o755 });
    const r = await replaceBinary(bin, new TextEncoder().encode("broken"), async () => ({ ok: false, output: "exec format error" }));
    expect(r).toEqual({ ok: false, stage: "verify", output: "exec format error" });
    expect(readFileSync(bin, "utf8")).toBe("old");
    expect(existsSync(`${bin}.previous`)).toBe(false);
    expect(readdirSync(d)).toEqual(["strato"]);
  });
  test("Windows order: rename the running file aside, then the new one in", async () => {
    const d = tmp();
    const bin = join(d, "strato.exe");
    writeFileSync(bin, "old");
    writeFileSync(`${bin}.previous`, "older");
    expect((await replaceBinary(bin, new TextEncoder().encode("new"), undefined, "win32")).ok).toBe(true);
    expect(readFileSync(bin, "utf8")).toBe("new");
    expect(readFileSync(`${bin}.previous`, "utf8")).toBe("old");
  });
});

/** A fake GitHub: the latest-release route and the asset downloads, from a map url -> body. */
function fakeGithub(release: GithubRelease | number, files: Record<string, Uint8Array | string> = {}) {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    if (url.endsWith("/releases/latest")) return typeof release === "number" ? new Response("{}", { status: release }) : Response.json(release);
    const body = files[url];
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
  };
  return { fetch: f, calls };
}

const NEW_BIN = new TextEncoder().encode("#!/bin/sh\necho strato 0.2.0\n");
const URL_BIN = "https://dl/strato-darwin-arm64";
const URL_SUMS = "https://dl/SHA256SUMS";
const release = (body = releaseNotes([{ sha: "abc1234", subject: "feat: new thing" }], "fedcba9", "v0.1.0")): GithubRelease => ({
  tag_name: "v0.2.0",
  body,
  assets: [
    { name: "strato-darwin-arm64", browser_download_url: URL_BIN },
    { name: "SHA256SUMS", browser_download_url: URL_SUMS },
  ],
});
const base = { target: "darwin-arm64" as const, current: "0.1.0", currentSha: "1111111", refreshSkills: false };

describe("checkRelease", () => {
  test("a newer release: available, with its what's new", async () => {
    const gh = fakeGithub(release());
    const c = await checkRelease({ ...base, fetch: gh.fetch });
    expect(gh.calls).toEqual(["https://api.github.com/repos/hugoblanc/strato/releases/latest"]);
    expect(c).toMatchObject({ available: true, newer: true, target: "0.2.0", upstream: "github:hugoblanc/strato" });
    expect(c.changes.features.map((x) => x.text)).toEqual(["new thing"]);
  });
  test("the same version: nothing offered", async () => {
    const c = await checkRelease({ ...base, current: "0.2.0", fetch: fakeGithub(release()).fetch });
    expect(c).toMatchObject({ available: false, newer: false, commits: [] });
  });
  test("no binary for this platform: not offered, and says why", async () => {
    const c = await checkRelease({ ...base, target: "linux-arm64", fetch: fakeGithub(release()).fetch });
    expect(c).toMatchObject({ available: false, newer: true, reason: "noAsset" });
  });
  test("no release yet, or GitHub down: fetchFailed, never a throw", async () => {
    expect(await checkRelease({ ...base, fetch: fakeGithub(404).fetch })).toMatchObject({ reason: "fetchFailed", error: expect.stringContaining("no release published yet") });
    const down = async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    };
    expect(await checkRelease({ ...base, fetch: down })).toMatchObject({ reason: "fetchFailed", error: "getaddrinfo ENOTFOUND" });
  });
});

describe("applyRelease", () => {
  const setup = () => {
    const d = tmp();
    const bin = join(d, "strato");
    writeFileSync(bin, "old binary", { mode: 0o755 });
    return { d, bin };
  };
  test("downloads, checks the SHA-256, checks the new binary starts, swaps it in", async () => {
    const { bin } = setup();
    const gh = fakeGithub(release(), { [URL_BIN]: NEW_BIN, [URL_SUMS]: `${sha256Hex(NEW_BIN)}  strato-darwin-arm64\n` });
    const verified: string[] = [];
    const r = await applyRelease({ ...base, fetch: gh.fetch, execPath: bin, verify: async (p, v) => (verified.push(v), { ok: readFileSync(p, "utf8").includes(v), output: "" }) });
    expect(r).toMatchObject({ ok: true, from: "1111111", to: "fedcba9", fromVersion: "0.1.0", toVersion: "0.2.0" });
    expect(verified).toEqual(["0.2.0"]);
    expect(readFileSync(bin, "utf8")).toBe(new TextDecoder().decode(NEW_BIN));
    expect(readFileSync(`${bin}.previous`, "utf8")).toBe("old binary");
  });
  test("a checksum mismatch touches nothing", async () => {
    const { bin } = setup();
    const gh = fakeGithub(release(), { [URL_BIN]: NEW_BIN, [URL_SUMS]: `${"0".repeat(64)}  strato-darwin-arm64\n` });
    const r = await applyRelease({ ...base, fetch: gh.fetch, execPath: bin, verify: async () => ({ ok: true, output: "" }) });
    expect(r).toMatchObject({ ok: false, reason: "checksumFailed" });
    expect(readFileSync(bin, "utf8")).toBe("old binary");
    expect(existsSync(`${bin}.previous`)).toBe(false);
  });
  test("an asset missing from SHA256SUMS is refused like a mismatch", async () => {
    const { bin } = setup();
    const gh = fakeGithub(release(), { [URL_BIN]: NEW_BIN, [URL_SUMS]: `${sha256Hex(NEW_BIN)}  strato-linux-x64\n` });
    expect(await applyRelease({ ...base, fetch: gh.fetch, execPath: bin })).toMatchObject({ ok: false, reason: "checksumFailed" });
  });
  test("a new binary that does not start: checkFailed, the old one stays", async () => {
    const { bin } = setup();
    const gh = fakeGithub(release(), { [URL_BIN]: NEW_BIN, [URL_SUMS]: `${sha256Hex(NEW_BIN)}  strato-darwin-arm64\n` });
    const r = await applyRelease({ ...base, fetch: gh.fetch, execPath: bin, verify: async () => ({ ok: false, output: "bad CPU type" }) });
    expect(r).toMatchObject({ ok: false, reason: "checkFailed", output: "bad CPU type" });
    expect(readFileSync(bin, "utf8")).toBe("old binary");
  });
  test("a failed download, a missing asset, an up-to-date install", async () => {
    const { bin } = setup();
    expect(await applyRelease({ ...base, fetch: fakeGithub(release(), {}).fetch, execPath: bin })).toMatchObject({ ok: false, reason: "downloadFailed" });
    expect(await applyRelease({ ...base, target: "linux-x64", fetch: fakeGithub(release()).fetch, execPath: bin })).toMatchObject({ ok: false, reason: "noAsset" });
    const same = await applyRelease({ ...base, current: "0.2.0", fetch: fakeGithub(release()).fetch, execPath: bin });
    expect(same.ok && same.from === same.to).toBe(true);
    expect(readFileSync(bin, "utf8")).toBe("old binary");
  });
  test("the real verify runs the new binary's `version`", async () => {
    const { bin } = setup();
    const gh = fakeGithub(release(), { [URL_BIN]: NEW_BIN, [URL_SUMS]: `${sha256Hex(NEW_BIN)}  strato-darwin-arm64\n` });
    expect(await applyRelease({ ...base, fetch: gh.fetch, execPath: bin })).toMatchObject({ ok: true, toVersion: "0.2.0" });
  });
});

describe("board: binary update failures", () => {
  test("each binary failure has its own sentence in the update panel", async () => {
    const { versionControl } = await import("./board.ts");
    const { groupChanges } = await import("./core/version.ts");
    const commits = [{ sha: "a", subject: "feat: x" }];
    const check = { checkedAt: "2026-10-01T08:00:00Z", available: true, upstream: "github:hugoblanc/strato", target: "0.2.0", newer: true, commits, changes: groupChanges(commits) };
    const local = { version: "0.1.0", sha: "1111111", branch: "release", upstream: "github:hugoblanc/strato", dirty: [] };
    for (const [reason, words] of [
      // the shared test profile reads the board in French (test-setup.ts)
      ["checksumFailed", "ne correspond pas à SHA256SUMS"],
      ["downloadFailed", "pas pu être téléchargée"],
      ["noAsset", "pas de binaire pour cette plateforme"],
      ["replaceFailed", "reste sur 1111111"],
    ] as const) {
      const html = versionControl({ local, check, running: false, failure: { ok: false, reason, from: "1111111" } });
      expect(html).toContain(`data-update-failure="${reason}"`);
      expect(html).toContain(words);
    }
  });
});
