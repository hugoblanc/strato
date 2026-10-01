/**
 * The guided setup: the pure helpers (core/setup.ts), `setup --check | --detect | --write | --live` on throwaway states,
 * and shadow mode (board, server, prompts). Slack is faked by a preload: no network, nothing posted.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_SETTINGS } from "./test-setup.ts";
import { actionCard, type BoardLine } from "./board.ts";
import { checkReport, mergeProfile, tokenKindProblem, nextStep, shortPath, slackAppLink, parseRemote, profileDiff, profileErrors, SLACK_SCOPES, slackWorkspaceFromUrl, suggestedConfig, ticketPrefixes, topChannels } from "./core/setup.ts";
import { missingSettings, resolveSettings, useSettings } from "./core/settings.ts";
import { workerPrompt } from "./policy/prompts.ts";
import { CLI, cleanupRigs, cli, KEY, LINK, lines, postBoard, readSujets, type Rig, rig, run, startServe, sujet, writeSujets } from "./test-rig.ts";

afterEach(() => {
  cleanupRigs();
  useSettings(TEST_SETTINGS);
});

/** Fake Slack: answers the read methods `setup` calls, logs every method, refuses usergroups.list without the scope. */
const FAKE_SLACK = `import { appendFileSync } from "node:fs";
const real = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith("https://slack.com/api/")) return real(input, init);
  const u = new URL(url);
  const method = u.pathname.slice("/api/".length);
  appendFileSync(process.env.FAKE_SLACK_LOG as string, method + "\\n");
  if (process.env.FAKE_SLACK_DOWN) throw new TypeError("fetch failed");
  const user = u.searchParams.get("user");
  const people: Record<string, unknown> = {
    UALICE: { id: "UALICE", real_name: "Alice Martin", profile: { first_name: "Alice", display_name: "alice" } },
    UBOB: { id: "UBOB", real_name: "Bob Stone", profile: { display_name: "Bob" } },
    UCAROL: { id: "UCAROL", real_name: "Carol Diaz", profile: { display_name: "" , real_name: "Carol Diaz" } },
  };
  const body =
    method === "auth.test" ? { ok: true, team: "Acme", user_id: "UALICE", url: "https://acme.slack.com/" }
    : method === "users.info" ? { ok: true, user: people[user ?? ""] }
    : method === "usergroups.list" ? (process.env.FAKE_NO_GROUPS ? { ok: false, error: "missing_scope" } : { ok: true, usergroups: [{ id: "SPLAT", handle: "platform", name: "Platform", users: ["UALICE", "UBOB", "UCAROL"] }, { id: "SOTHER", handle: "sales", name: "Sales", users: ["UDAN"] }] })
    : method === "search.messages" ? { ok: true, messages: { paging: { pages: 1 }, matches: [
        { channel: { id: "CPLAT", name: "platform" } }, { channel: { id: "CPLAT", name: "platform" } }, { channel: { id: "CINC", name: "incidents" } },
        { channel: { id: "D123", name: "UBOB", is_im: true } } ] } }
    : method === "chat.postMessage" ? { ok: true, ts: "1759219400.000300" }
    : method === "conversations.replies" ? { ok: true, messages: [{ ts: "1759219200.000100" }] }
    : { ok: true };
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", ...(method === "auth.test" ? { "x-oauth-scopes": "search:read,channels:history,users:read,chat:write" } : {}) } });
}) as typeof fetch;
`;

function withSlack(r: Rig, extra: Record<string, string> = {}) {
  writeFileSync(join(r.dir, "fake-slack.ts"), FAKE_SLACK);
  return { preload: join(r.dir, "fake-slack.ts"), env: { STRATO_SLACK_TOKEN: "xoxp-acme-fake-0000", FAKE_SLACK_LOG: join(r.dir, "slack.log"), ...extra } };
}
const setupWith = (r: Rig, args: string[], slack: { preload: string; env: Record<string, string> }) => run(r, ["--preload", slack.preload, CLI, "setup", ...args], slack.env);
const config = (r: Rig) => JSON.parse(readFileSync(join(r.state, "config.json"), "utf8"));
const writeConfig = (r: Rig, c: unknown) => writeFileSync(join(r.state, "config.json"), JSON.stringify(c));

describe("profile helpers", () => {
  test("merge: objects key by key, arrays and null replaced", () => {
    expect(mergeProfile({ owner: { name: "Alice" }, slack: { me: "U1", subteams: ["S1"] }, tracker: null }, { slack: { subteams: ["S2"], team: "Acme" }, tracker: { workspace: "acme" } })).toEqual({
      owner: { name: "Alice" },
      slack: { me: "U1", subteams: ["S2"], team: "Acme" },
      tracker: { workspace: "acme" },
    });
    expect(mergeProfile({ forge: { host: "x" } }, { forge: null })).toEqual({ forge: null });
  });

  test("diff: one line per added, changed or removed field", () => {
    expect(profileDiff({ owner: { name: "the user" }, slack: { me: "" }, ui: { port: 4343 } }, { owner: { name: "Alice" }, slack: { me: "", subteams: ["S1"] } })).toEqual([
      '~ owner.name: "the user" -> "Alice"',
      '+ slack.subteams: ["S1"]',
      "- ui.port: 4343",
    ]);
    expect(profileDiff({ a: 1 }, { a: 1 })).toEqual([]);
  });

  test("validation: typos, wrong types and bad enums are named; the legacy flat format passes", () => {
    expect(profileErrors({ owner: { name: "Alice" }, slack: { watchChannel: ["C1"], subteams: "S1" }, ui: { locale: "de" }, workers: { shadow: "yes" } })).toEqual([
      "slack.watchChannel: unknown field (known: team, workspace, me, subteams, teamAlias, watchChannels, ignoreChannels, ignoreAuthors, teammates, appId, appTokenFile, pollInterval)",
      "slack.subteams: expected array, got string",
      'ui.locale: "de" is not one of en, fr',
      "workers.shadow: expected boolean, got string",
    ]);
    expect(profileErrors({ team: "Acme", me: "U1", skipPermissions: true, tracker: null, forge: { repos: { api: "acme/api" }, iidRanges: [{ from: 500, repo: "api" }] }, policy: { tone: "dry" } })).toEqual([]);
    expect(profileErrors({ forge: { iidRanges: [{ from: "500" }] } })).toEqual(['forge.iidRanges[0]: expected { "from": number, "repo": string }']);
    expect(profileErrors({ colour: 1 })[0]).toStartWith("colour: unknown field");
    expect(profileErrors([])).toEqual(["config.json: expected an object, got array"]);
  });

  test("what can be read from Slack answers, remotes and commits", () => {
    expect(slackWorkspaceFromUrl("https://acme.slack.com/")).toBe("acme");
    expect(slackWorkspaceFromUrl("https://acme-corp.enterprise.slack.com/")).toBe("acme-corp");
    expect(slackWorkspaceFromUrl("nope")).toBeNull();
    expect(parseRemote("git@gitlab.com:acme/platform/api.git")).toEqual({ host: "gitlab.com", path: "acme/platform/api", kind: "gitlab" });
    expect(parseRemote("https://github.com/acme/web")).toEqual({ host: "github.com", path: "acme/web", kind: "github" });
    expect(parseRemote("ssh://git@git.acme.io:2222/acme/api.git")).toEqual({ host: "git.acme.io", path: "acme/api", kind: "other" });
    expect(parseRemote("/local/path")).toBeNull();
    const subjects = ["fix(api): retry #ENG-12", "feat: ENG-40 export", "ENG-41 and OPS-2", "chore: bump UTF-8 and SHA-256", "ENG-7", "OPS-3"];
    expect(ticketPrefixes(subjects)).toEqual([{ prefix: "ENG", count: 4 }]);
    expect(ticketPrefixes(subjects, 2)).toEqual([
      { prefix: "ENG", count: 4 },
      { prefix: "OPS", count: 2 },
    ]);
    expect(topChannels([{ channel: { id: "C1", name: "a" } }, { channel: { id: "C2", name: "b" } }, { channel: { id: "C2", name: "b" } }, { channel: { id: "D1", is_im: true } }, { channel: { id: "G1", name: "mpdm-x-y" } }])).toEqual([
      { id: "C2", name: "#b", messages: 2 },
      { id: "C1", name: "#a", messages: 1 },
    ]);
  });

  test("suggested config keeps sure fields only, nested", () => {
    expect(
      suggestedConfig({
        "slack.me": { value: "U1", source: "auth.test", confidence: "high" },
        "owner.name": { value: "Alice", source: "users.info", confidence: "medium" },
        "slack.watchChannels": { value: [], source: "search", confidence: "low", candidates: [] },
        "ui.locale": { value: "fr", source: "LANG", confidence: "low" },
        "slack.teammates": { value: [], source: "group", confidence: "medium" },
      }),
    ).toEqual({ slack: { me: "U1" }, owner: { name: "Alice" } });
  });

  test("check report: exit 1 only for a missing blocking prerequisite", () => {
    const ok = checkReport("/s/config.json", true, [], [{ name: "bun", status: "ok", detail: "1.2", blocking: true }, { name: "ttyd", status: "skip", detail: "optional", blocking: false }]);
    expect(ok.code).toBe(0);
    expect(ok.lines.at(-2)).toBe("ready");
    expect(ok.lines.at(-1)).toBe('Next: claude -n strato "/strato"');
    const ko = checkReport("/s/config.json", false, ["slack.me (…)"], [{ name: "slack", status: "missing", detail: "no token", blocking: true }]);
    expect(ko.code).toBe(1);
    expect(ko.lines).toContain("MISS  slack     no token [blocking]");
    expect(ko.lines).toContain("  to fill in: slack.me (…)");
    expect(ko.lines.at(-1)).toStartWith("Next: bun strato.ts setup --slack-app");
  });

  test("Next: one command, by priority (O25)", () => {
    const cli = "bun ./strato.ts";
    expect(nextStep({ blocked: ["slack", "claude"], profileIncomplete: true }, cli)).toContain("install or update Claude Code");
    expect(nextStep({ blocked: ["bun"], profileIncomplete: false }, cli)).toContain("https://bun.sh");
    expect(nextStep({ blocked: ["slack"], profileIncomplete: true }, cli)).toStartWith("bun ./strato.ts setup --slack-app");
    expect(nextStep({ blocked: [], profileIncomplete: true }, cli)).toBe('claude -n strato "/strato setup"');
    expect(nextStep({ blocked: [], profileIncomplete: false }, cli)).toBe('claude -n strato "/strato"');
  });

  test("paths as a person reads them: ./ under the current folder, ~ under home", () => {
    expect(shortPath("/home/alice/acme/.strato/config.json", "/home/alice", "/home/alice/acme")).toBe("./.strato/config.json");
    expect(shortPath("/home/alice/.config/strato", "/home/alice", "/tmp")).toBe("~/.config/strato");
    expect(shortPath("/home/alice/acme", "/home/alice", "/home/alice/acme")).toBe(".");
    expect(shortPath("/opt/strato", "/home/alice", "/")).toBe("/opt/strato");
    expect(shortPath("/home/alicette/x", "/home/alice", "/tmp")).toBe("/home/alicette/x");
  });
});

describe("setup --slack-app (O10)", () => {
  test("the link opens Slack's app creation with the manifest, comments dropped, every scope kept", () => {
    const yaml = readFileSync(join(import.meta.dir, "..", "examples", "slack-app-manifest.yaml"), "utf8");
    const link = slackAppLink(yaml);
    expect(link.startsWith("https://api.slack.com/apps?new_app=1&manifest_yaml=")).toBe(true);
    const decoded = new URL(link).searchParams.get("manifest_yaml") ?? "";
    expect(decoded).not.toContain("# ");
    expect(decoded).toContain('background_color: "#1b1406"');
    for (const { scope } of SLACK_SCOPES) expect(decoded).toContain(`- ${scope}`);
    expect(decoded.split("\n")).toEqual(yaml.split("\n").filter((l) => l.trim() && !l.trimStart().startsWith("#")));
  });

  test("SETUP.md and README.md carry the link of the current manifest", () => {
    const root = join(import.meta.dir, "..");
    const link = slackAppLink(readFileSync(join(root, "examples", "slack-app-manifest.yaml"), "utf8"));
    expect(readFileSync(join(root, "SETUP.md"), "utf8")).toContain(`](${link})`);
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain(`](${link})`);
  });

  test("--print shows the link and what to copy after, without opening anything", async () => {
    const res = await cli(rig(), ["setup", "--slack-app", "--print"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("User OAuth Token (xoxp-…)");
    expect(res.out).toContain("https://api.slack.com/apps?new_app=1&manifest_yaml=");
  }, 20_000);

  test("the check's missing token line points at it", async () => {
    expect((await cli(rig(), ["setup", "--check"])).out).toContain("setup --slack-app creates it in one click");
  }, 20_000);
});

describe("the shipped examples", () => {
  const examples = join(import.meta.dir, "..", "examples");

  test("the example profile is valid, complete, and starts in shadow mode", () => {
    const raw = JSON.parse(readFileSync(join(examples, "profile", "config.json"), "utf8"));
    expect(profileErrors(raw)).toEqual([]);
    const s = resolveSettings(raw);
    expect(missingSettings(s)).toEqual([]);
    expect(s.workers).toMatchObject({ shadow: true, skipPermissions: false });
  });

  test("the example local.md has the sections the interview writes", () => {
    const md = readFileSync(join(examples, "profile", "local.md"), "utf8");
    for (const h of ["## Who I am", "## My team", "## Ownership map", "## Never without my go", "## Notes"]) expect(md).toContain(h);
  });

  test("the Slack app manifest asks for every scope the code calls, and the four user events", () => {
    const manifest = readFileSync(join(examples, "slack-app-manifest.yaml"), "utf8");
    for (const { scope } of SLACK_SCOPES) expect(manifest).toContain(`- ${scope}\n`);
    for (const e of ["message.channels", "message.groups", "message.im", "message.mpim"]) expect(manifest).toContain(`- ${e}\n`);
    expect(manifest).toContain("socket_mode_enabled: true");
  });
});

describe("setup --check", () => {
  test("without a Slack token: the token is a blocking miss, exit 1, the rest is still listed", async () => {
    const r = rig();
    const res = await cli(r, ["setup", "--check"]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("MISS  slack");
    expect(res.out).toContain("[blocking]");
    expect(res.out).toContain("ok    bun");
    expect(res.out).toContain("ok    claude");
    expect(res.out).toContain("socket");
    expect(res.out).toContain("not ready: slack missing");
  }, 20_000);

  test("with a token: workspace and identity read by auth.test, missing scopes named, exit 0", async () => {
    const r = rig();
    const res = await setupWith(r, ["--check"], withSlack(r));
    expect(res.code).toBe(0);
    expect(res.out).toContain("workspace Acme (acme.slack.com) · you are UALICE · token xoxp-…0000");
    expect(res.out).toContain("reactions:write (the board's ✅)");
    expect(res.out).toContain("  complete");
    expect(lines(join(r.dir, "slack.log"))).toEqual(["auth.test"]);
  }, 20_000);

  test("which token, on which page; a token of the wrong kind is named (O11)", async () => {
    expect(tokenKindProblem("xoxp-1")).toBeNull();
    expect(tokenKindProblem("xoxb-1")).toContain("Bot User OAuth Token");
    expect(tokenKindProblem("xapp-1")).toContain("app-level token for Socket Mode");
    expect(tokenKindProblem("abc")).toContain("OAuth & Permissions > User OAuth Token");
    expect((await cli(rig(), ["setup", "--check"])).out).toContain("no user token. Copy your Slack app > OAuth & Permissions > User OAuth Token (xoxp-…) into STRATO_SLACK_TOKEN");
    const r = rig();
    const res = await setupWith(r, ["--check"], withSlack(r, { STRATO_SLACK_TOKEN: "xoxb-acme-fake-0000" }));
    expect(res.code).toBe(1);
    expect(res.out).toContain("MISS  slack     xoxb-…0000: xoxb- is the Bot User OAuth Token");
  }, 20_000);

  test("an empty profile lists what to fill in", async () => {
    const r = rig();
    writeConfig(r, {});
    const res = await setupWith(r, ["--check"], withSlack(r));
    expect(res.out).toContain("to fill in: owner.name");
    expect(res.out).toContain("profile incomplete");
  }, 20_000);
});

describe("setup --detect", () => {
  test("no token, no network: a partial JSON and the reason, never a crash", async () => {
    const r = rig();
    const res = await cli(r, ["setup", "--detect"]);
    expect(res.code).toBe(0);
    const d = JSON.parse(res.out);
    expect(d.notes.join("\n")).toContain("no user token found");
    expect(d.fields["slack.me"]).toBeUndefined();
    expect(d.fields["ui.locale"].confidence).toBe("low");
    expect(d.state).toBe(r.state);
  }, 20_000);

  test("a token but Slack unreachable: the network failure is a note", async () => {
    const r = rig();
    const res = await setupWith(r, ["--detect"], withSlack(r, { FAKE_SLACK_DOWN: "1" }));
    expect(res.code).toBe(0);
    expect(JSON.parse(res.out).notes.join("\n")).toContain("network: fetch failed");
  }, 20_000);

  test("Slack and git: identity, group, teammates, active channels, forge and ticket prefixes, each with its source", async () => {
    const r = rig();
    const ws = join(r.dir, "ws");
    const repo = join(ws, "api");
    mkdirSync(repo);
    const g = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { env: r.env });
    g("init", "-q", "-b", "main");
    g("remote", "add", "origin", "git@gitlab.com:acme/api.git");
    for (let i = 1; i <= 11; i++) g("commit", "-q", "--allow-empty", "-m", `fix: thing ENG-${i}`, "-m", "https://linear.app/acme/issue/ENG-1");
    writeFileSync(join(ws, ".mcp.json"), JSON.stringify({ mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } } }));
    const res = await setupWith(r, ["--detect"], withSlack(r));
    expect(res.code).toBe(0);
    const d = JSON.parse(res.out);
    expect(d.fields["slack.me"]).toEqual({ value: "UALICE", source: "auth.test", confidence: "high" });
    expect(d.fields["slack.workspace"].value).toBe("acme");
    expect(d.fields["owner.name"].value).toBe("Alice");
    expect(d.fields["slack.subteams"].value).toEqual(["SPLAT"]);
    expect(d.fields["slack.teamAlias"].value).toBe("@platform");
    expect(d.fields["slack.teammates"].value).toEqual(["Bob", "Carol Diaz"]);
    expect(d.fields["slack.watchChannels"].candidates).toEqual([
      { id: "CPLAT", name: "#platform", messages: 2 },
      { id: "CINC", name: "#incidents", messages: 1 },
    ]);
    expect(d.fields["forge.repos"].value).toEqual({ api: "acme/api" });
    expect(d.fields["tracker.kind"].source).toContain(".mcp.json");
    expect(d.fields["tracker.workspace"].value).toBe("acme");
    expect(d.fields["tracker.prefixes"].value).toEqual(["ENG"]);
    expect(d.suggested).toMatchObject({ owner: { name: "Alice" }, slack: { team: "Acme", me: "UALICE", teamAlias: "@platform" }, forge: { kind: "gitlab", host: "gitlab.com", defaultRepo: "api" }, tracker: { kind: "linear", workspace: "acme", prefixes: ["ENG"] } });
    // read only: no write method was called
    expect(lines(join(r.dir, "slack.log")).filter((m) => !["auth.test", "users.info", "usergroups.list", "search.messages"].includes(m))).toEqual([]);
  }, 30_000);

  test("a token without usergroups:read: groups are a note, the rest is found", async () => {
    const r = rig();
    const d = JSON.parse((await setupWith(r, ["--detect"], withSlack(r, { FAKE_NO_GROUPS: "1" }))).out);
    expect(d.notes.join("\n")).toContain("usergroups.list failed (missing_scope): the token lacks usergroups:read");
    expect(d.fields["slack.me"].value).toBe("UALICE");
    expect(d.fields["slack.subteams"]).toBeUndefined();
  }, 20_000);
});

describe("doctor and the Slack token (O5)", () => {
  const doctorWith = (r: Rig, slack: { preload: string; env: Record<string, string> }) => run(r, ["--preload", slack.preload, CLI, "doctor"], slack.env);

  test("a new profile without slack.team uses the token Slack accepts, and says what to fill in", async () => {
    const r = rig();
    writeConfig(r, { owner: { name: "Alice" } });
    const res = await doctorWith(r, withSlack(r));
    expect(res.code).toBe(0);
    expect(res.out).toContain('slack    : Acme · user UALICE · to fix in config.json, slack.team is not set: "Acme", slack.me is empty: "UALICE"');
    expect(res.out.trim().split("\n").at(-1)).toBe('Next: claude -n strato "/strato setup"');
  }, 20_000);

  test("no token at all: where to put one", async () => {
    const res = await cli(rig(), ["doctor"]);
    expect(res.code).toBe(78);
    expect(res.out).toContain("no Slack user token found: copy your Slack app > OAuth & Permissions > User OAuth Token (xoxp-…) into STRATO_SLACK_TOKEN");
    expect(res.out).toContain('see SETUP.md, "Connect Slack"');
    expect(res.out.trim().split("\n").at(-1)).toMatch(/^Next: bun .*strato\.ts setup --slack-app/);
  }, 20_000);

  test("a token of another workspace: named, masked, with its workspace", async () => {
    const r = rig();
    writeConfig(r, { owner: { name: "Alice" }, slack: { team: "Globex", workspace: "globex", me: "UALICE" } });
    const res = await doctorWith(r, withSlack(r));
    expect(res.code).toBe(78);
    expect(res.out).toContain('1 Slack token(s) found, none usable for workspace "Globex" (slack.team): xoxp-…0000: workspace "Acme"');
  }, 20_000);
});

describe("setup --write and --live", () => {
  test("creates .strato/ in the workspace when no state folder exists", async () => {
    const r = rig();
    const file = join(r.dir, "profile.json");
    writeFileSync(file, JSON.stringify({ owner: { name: "Alice" }, slack: { team: "Acme", workspace: "acme", me: "UALICE" }, workers: { shadow: true } }));
    // AIGUILLEUR_STATE too: ingest.test.ts sets it in the shared test process
    const res = await cli(r, ["setup", "--write", file], { STRATO_STATE: "", AIGUILLEUR_STATE: "" });
    expect(res.code).toBe(0);
    const created = join(r.dir, "ws", ".strato", "config.json");
    expect(existsSync(created)).toBe(true);
    expect(JSON.parse(readFileSync(created, "utf8")).workers.shadow).toBe(true);
    expect(res.out).toContain("created");
    expect(res.out).toContain("profile complete");
    expect(res.out).toContain("shadow mode: on");
  }, 20_000);

  test("a created profile starts in shadow mode unless it says otherwise (O1)", async () => {
    const r = rig();
    const file = join(r.dir, "profile.json");
    writeFileSync(file, JSON.stringify({ owner: { name: "Alice" }, slack: { team: "Acme", workspace: "acme", me: "UALICE" } }));
    const created = join(r.dir, "ws", ".strato", "config.json");
    const res = await cli(r, ["setup", "--write", file], { STRATO_STATE: "", AIGUILLEUR_STATE: "" });
    expect(res.code).toBe(0);
    expect(JSON.parse(readFileSync(created, "utf8")).workers).toEqual({ shadow: true });
    expect(res.out).toContain("+ workers.shadow: true");
    expect(res.out).toContain("shadow mode: on");

    const r2 = rig();
    writeFileSync(file, JSON.stringify({ owner: { name: "Alice" }, workers: { shadow: false } }));
    expect((await cli(r2, ["setup", "--write", file], { STRATO_STATE: "", AIGUILLEUR_STATE: "" })).code).toBe(0);
    expect(JSON.parse(readFileSync(join(r2.dir, "ws", ".strato", "config.json"), "utf8")).workers).toEqual({ shadow: false });
  }, 20_000);

  test("the first run writes a profile in shadow mode; an existing one without the key stays live (O1)", async () => {
    const r = rig();
    const fresh = join(r.dir, "fresh-state");
    await cli(r, ["doctor"], { STRATO_STATE: fresh });
    expect(JSON.parse(readFileSync(join(fresh, "config.json"), "utf8")).workers.shadow).toBe(true);
    await cli(r, ["doctor"]);
    expect(config(r).workers).toBeUndefined();
    expect(resolveSettings(config(r)).workers.shadow).toBe(false);
  }, 20_000);

  test("an existing profile is merged, never overwritten without --force, and the diff is shown", async () => {
    const r = rig();
    const file = join(r.dir, "profile.json");
    writeFileSync(file, JSON.stringify({ slack: { subteams: ["SPLAT"], me: "UALICE2" } }));
    const merged = await cli(r, ["setup", "--write", file]);
    expect(merged.code).toBe(0);
    expect(merged.out).toContain("merged into");
    expect(merged.out).toContain('~ slack.me: "UALICE" -> "UALICE2"');
    expect(merged.out).toContain('+ slack.subteams: ["SPLAT"]');
    expect(config(r)).toEqual({ owner: { name: "Alice" }, slack: { team: "Acme", workspace: "acme", me: "UALICE2", subteams: ["SPLAT"] } });

    const forced = await cli(r, ["setup", "--write", file, "--force"]);
    expect(forced.out).toContain("replaced (--force)");
    expect(forced.out).toContain('- owner.name: "Alice"');
    expect(config(r)).toEqual({ slack: { subteams: ["SPLAT"], me: "UALICE2" } });
    expect(forced.out).toContain("to fill in: slack.team");
  }, 20_000);

  test("an invalid file is refused and nothing is written", async () => {
    const r = rig();
    const before = readFileSync(join(r.state, "config.json"), "utf8");
    const file = join(r.dir, "bad.json");
    writeFileSync(file, JSON.stringify({ slack: { watchChannel: ["C1"] } }));
    const res = await cli(r, ["setup", "--write", file]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("slack.watchChannel: unknown field");
    writeFileSync(join(r.dir, "broken.json"), "{ nope");
    expect((await cli(r, ["setup", "--write", join(r.dir, "broken.json")])).code).toBe(1);
    expect(readFileSync(join(r.state, "config.json"), "utf8")).toBe(before);
  }, 20_000);

  test("--live turns shadow mode off and keeps the rest", async () => {
    const r = rig();
    writeConfig(r, { ...config(r), workers: { shadow: true, allow: ["Read"] } });
    const res = await cli(r, ["setup", "--live"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("~ workers.shadow: true -> false");
    expect(config(r).workers).toEqual({ shadow: false, allow: ["Read"] });
  }, 20_000);

  test("no option: usage, exit 64", async () => {
    expect((await cli(rig(), ["setup"])).code).toBe(64);
  }, 20_000);
});

describe("shadow mode", () => {
  const T = "2026-09-30T08:00:00Z";
  const task = (o: Record<string, unknown>) => ({ kind: "draft", ask: "Bob asks", proposal: "", action: "post the draft", draft: "", draftTo: LINK, createdAt: T, updatedAt: T, status: "open", origin: "task", ...o });
  const topic = () => sujet({ status: "gate", gate: "draft", tasks: [task({ id: "t1", draft: "First answer." }), task({ id: "t2", kind: "action", ask: "Merge?", action: "merge api!12", draft: "", draftTo: "" })] });

  test("the server refuses Send, Go and ✅ with 409; setup --live lifts it without a restart", async () => {
    const r = rig();
    writeConfig(r, { ...config(r), workers: { shadow: true } });
    writeSujets(r, [topic()]);
    const slack = withSlack(r);
    const serve = await startServe(r, slack);
    try {
      const post = await postBoard(serve.port, "/api/post-draft", { key: KEY, taskId: "t1", text: "First answer.", draft: "First answer.", draftTo: LINK });
      expect(post.status).toBe(409);
      expect(((await post.json()) as { code: string }).code).toBe("shadow");
      const go = await postBoard(serve.port, "/api/send", { key: KEY, text: "go", taskId: "t2" });
      expect(go.status).toBe(409);
      expect(((await go.json()) as { error: string }).error).toContain("shadow mode: nothing is posted");
      expect((await postBoard(serve.port, "/api/check", { key: KEY })).status).toBe(409);
      const page = await (await fetch(`http://127.0.0.1:${serve.port}/board`)).text();
      expect(page).toContain("Shadow mode: nothing is posted");
      expect(page).not.toContain("data-post ");
      expect(lines(join(r.dir, "slack.log"))).not.toContain("chat.postMessage");
      expect(readSujets(r)[0].tasks.every((x: { status: string }) => x.status === "open")).toBe(true);

      expect((await cli(r, ["setup", "--live"])).code).toBe(0);
      const live = await postBoard(serve.port, "/api/post-draft", { key: KEY, taskId: "t1", text: "First answer.", draft: "First answer.", draftTo: LINK });
      expect(live.status).toBe(200);
      expect(lines(join(r.dir, "slack.log"))).toContain("chat.postMessage");
    } finally {
      await serve.stop();
    }
  }, 30_000);

  test("the board shows the task's button off, without data-post or data-go", () => {
    useSettings(resolveSettings({ ...TEST_SETTINGS, workers: { shadow: true } }));
    const html = actionCard({ sujet: topic() } as unknown as BoardLine);
    expect(html).toContain("data-shadow");
    expect(html).not.toMatch(/data-post[ >]/);
    expect(html).not.toContain("data-go=");
    expect(html).toContain('data-postable="0"');
  });

  test("the session prompt says to prepare without posting, only while shadow mode is on", () => {
    const t = { from: "Bob", channel: "#platform", text: "can you check?", permalink: LINK };
    useSettings(resolveSettings({ ...TEST_SETTINGS, workers: { shadow: true } }));
    expect(workerPrompt("Check", KEY, t, "strato.ts", "/r.md")).toContain("Shadow mode is on: prepare everything");
    useSettings(TEST_SETTINGS);
    expect(workerPrompt("Check", KEY, t, "strato.ts", "/r.md")).not.toContain("Shadow mode");
  });
});
