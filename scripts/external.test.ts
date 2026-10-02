/**
 * External providers written as modules: loaded from disk only when config.json names them and the person trusted
 * their folder as it is; checked before anything runs; refused to a session caller. Each case runs real `strato`
 * processes (or a script) on a throwaway state folder, the provider's code in `<state>/providers/<id>/`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveSettings, useSettings } from "./core/settings.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { descriptorProblems, patternCost } from "./providers/check.ts";
import { fakeDescriptor } from "./test-provider.ts";
import { cleanupRigs, cli, type Rig, rig, run, SCRIPTS } from "./test-rig.ts";
import { TEST_SETTINGS } from "./test-setup.ts";

afterEach(cleanupRigs);

const BASE = { owner: { name: "Alice" }, slack: { team: "Acme", workspace: "acme", me: "UALICE" } };

/** A module provider, the fake ticket tool of test-provider.ts, written in the state's providers folder. */
function moduleProvider(r: Rig, extra = ""): string {
  const dir = join(r.state, "providers", "tickets");
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "lib", "words.ts"), `export const WORD = "ticket";\n`);
  writeFileSync(
    join(dir, "provider.ts"),
    [
      `import { fakeProvider } from ${JSON.stringify(join(SCRIPTS, "test-provider.ts"))};`,
      `import { WORD } from "./lib/words.ts";`,
      `const p = fakeProvider({ id: "tickets", label: "Tickets" });`,
      `export default { ...p, word: WORD${extra} };`,
    ].join("\n"),
  );
  return dir;
}

const config = (r: Rig, providers: unknown) => writeFileSync(join(r.state, "config.json"), JSON.stringify({ ...BASE, providers }));
const ticketsConfig = (source: Record<string, unknown> = { module: "provider.ts" }) => ({ tickets: { source, accounts: { default: { auth: "api-key", me: "u-alice" } } } });

/** Runs a script in the rig's state with the loader, the registry and the trust store imported; its stdout is JSON. */
async function script(r: Rig, body: string): Promise<any> {
  const path = join(r.dir, `s${Math.random().toString(36).slice(2, 8)}.ts`);
  writeFileSync(
    path,
    [
      `import * as external from ${JSON.stringify(join(SCRIPTS, "providers/external.ts"))};`,
      `import * as registry from ${JSON.stringify(join(SCRIPTS, "providers/registry.ts"))};`,
      `import * as trust from ${JSON.stringify(join(SCRIPTS, "providers/host/trust.ts"))};`,
      `import * as links from ${JSON.stringify(join(SCRIPTS, "core/links.ts"))};`,
      `import * as settings from ${JSON.stringify(join(SCRIPTS, "core/settings.ts"))};`,
      `const result = await (async () => { ${body} })();`,
      "process.stdout.write(JSON.stringify(result));",
    ].join("\n"),
  );
  const res = await run(r, [path]);
  if (res.code !== 0) throw new Error(res.err);
  return JSON.parse(res.out);
}

/** Trusts the configured provider as it is now, the way `provider trust` records it after a typed yes. */
const trustNow = (r: Rig, id = "tickets") =>
  script(
    r,
    `const source = settings.settings().providers[${JSON.stringify(id)}].source;
     const s = trust.trustOf(${JSON.stringify(id)}, source);
     const mod = await import(s.resolved.file);
     trust.writeTrust(${JSON.stringify(id)}, { sha256: s.sha256, source, descriptor: mod.default.descriptor, at: "2026-10-01T00:00:00Z" });
     return s.sha256;`,
  );

const problemOf = (r: Rig) => script(r, `await external.loadExternalProviders(); return registry.accounts().find((a) => a.account.provider === "tickets").problem;`);

describe("a module provider is loaded only once trusted as it is", () => {
  test("untrusted: listed with the command to run, its code never imported", async () => {
    const r = rig();
    const imported = join(r.dir, "imported");
    moduleProvider(r, `, sideEffect: (await import("node:fs")).writeFileSync(${JSON.stringify(imported)}, "x")`);
    config(r, ticketsConfig());
    expect(await problemOf(r)).toBe("tickets: not trusted yet; read it, then run strato provider trust tickets in your own terminal");
    const list = await cli(r, ["provider", "list"]);
    expect(list.out).toContain("tickets  module · ");
    expect(list.out).toContain("not trusted yet");
    expect((await cli(r, ["list"])).code).toBe(0);
    expect(existsSync(imported)).toBe(false);
  }, 30_000);

  test("trusted: loaded, its links and keys resolve, its accounts connect, and provider list says so", async () => {
    const r = rig();
    moduleProvider(r);
    config(r, ticketsConfig());
    expect(await trustNow(r)).toMatch(/^[0-9a-f]{64}$/);
    const out = await script(
      r,
      `await external.loadExternalProviders();
       const a = registry.accounts().find((x) => x.account.provider === "tickets");
       const identity = await a.provider.connect(registry.accountContext(a));
       return { problem: a.problem, link: links.parseLink("https://tickets.example/t/PLAT-12"), of: links.linkOfNative("tickets", "default", "PLAT-12"), identity, writes: "act" in a.provider };`,
    );
    expect(out).toEqual({ problem: null, link: { provider: "tickets", account: "default", thread: "PLAT-12" }, of: "https://tickets.example/t/PLAT-12", identity: { me: "u-alice", name: "Alice", workspace: "acme" }, writes: false });
    const list = await cli(r, ["provider", "list"]);
    expect(list.out).toContain("trusted and loaded");
  }, 30_000);

  test("a change anywhere in its folder (a sub-folder included) breaks the trust; its fixtures do not", async () => {
    const r = rig();
    const dir = moduleProvider(r);
    config(r, ticketsConfig());
    await trustNow(r);
    mkdirSync(join(dir, "fixtures"), { recursive: true });
    writeFileSync(join(dir, "fixtures", "sample.json"), "{}");
    expect(await problemOf(r)).toBeNull();
    writeFileSync(join(dir, "lib", "words.ts"), `export const WORD = "changed";\n`);
    expect(await problemOf(r)).toBe("tickets: changed since you trusted it; read it, then run strato provider trust tickets in your own terminal");
  }, 30_000);

  test("a source pointing elsewhere, or a sha256 in config.json that disagrees, is not the provider trusted", async () => {
    const r = rig();
    const dir = moduleProvider(r);
    config(r, ticketsConfig());
    await trustNow(r);
    config(r, ticketsConfig({ module: join(dir, "provider.ts") }));
    expect(await problemOf(r)).toContain("changed since you trusted it");
    config(r, ticketsConfig({ module: "provider.ts", sha256: "0000" }));
    expect(await problemOf(r)).toContain("changed since you trusted it");
  }, 30_000);

  test("a missing file and a broken module are reasons, never a failed command", async () => {
    const r = rig();
    config(r, ticketsConfig({ module: "nowhere.ts" }));
    expect(await problemOf(r)).toBe(`tickets: its code is not there (${join(r.state, "providers", "tickets", "nowhere.ts")})`);
    const dir = moduleProvider(r);
    config(r, ticketsConfig());
    await trustNow(r);
    writeFileSync(join(dir, "provider.ts"), `export default { descriptor: { id: "other" }, connect() {} };\n`);
    await trustNow(r).catch(() => null);
    const problem = await problemOf(r);
    expect(problem).toStartWith("tickets: could not be loaded: id: the provider says it is \"other\", but the profile names it \"tickets\"");
    // every command still runs
    expect((await cli(r, ["list"])).code).toBe(0);
  }, 30_000);
});

describe("a provider never shares an account's folder", () => {
  test("a provider named like another tool's account folder is refused", async () => {
    const r = rig();
    config(r, { slack: { accounts: { partners: { workspace: "acme-partners" } } }, "slack-partners": { source: { module: "provider.ts" }, accounts: { default: {} } } });
    const out = await script(r, `await external.loadExternalProviders(); return registry.accounts().find((a) => a.account.provider === "slack-partners").problem;`);
    expect(out).toBe("slack-partners: this name is also the folder of an account of another tool in <state>/providers/; give the provider another name");
  }, 30_000);
});

describe("an exec provider is loaded the same way", () => {
  test("trusted from its describe, it connects with the secret of its account's file, given at initialize", async () => {
    const r = rig();
    const dir = join(r.state, "providers", "tickets");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "provider.ts"), readFileSync(join(SCRIPTS, "test-exec-provider.ts"), "utf8").replace('from "./providers/sdk.ts"', `from ${JSON.stringify(join(SCRIPTS, "providers/sdk.ts"))}`));
    const secrets = join(r.dir, "tickets.env");
    writeFileSync(secrets, "TICKETS_API_KEY=tk-acme-file-000000\n");
    config(r, { tickets: { source: { exec: [process.execPath, "provider.ts"] }, accounts: { default: { auth: "api-key", secretsFile: secrets, me: "u-alice" } } } });
    expect(await problemOf(r)).toContain("not trusted yet");
    const out = await script(
      r,
      `const { describeExec } = await import(${JSON.stringify(join(SCRIPTS, "providers/host/exec.ts"))});
       const source = settings.settings().providers.tickets.source;
       const s = trust.trustOf("tickets", source);
       const d = await describeExec({ id: "tickets", argv: s.resolved.argv, cwd: s.resolved.cwd });
       trust.writeTrust("tickets", { sha256: s.sha256, source, descriptor: d.descriptor, at: "2026-10-01T00:00:00Z" });
       await external.loadExternalProviders();
       const a = registry.accounts().find((x) => x.account.provider === "tickets");
       const seen = [];
       const fetchImpl = async (input, init) => { seen.push(new Request(input, init).headers.get("authorization")); return new Response(JSON.stringify({ id: "u-alice", workspace: "acme" })); };
       const identity = await a.provider.connect(registry.accountContext(a, { fetchImpl }));
       await a.provider.stopAll?.();
       return { problem: a.problem, me: identity.me, seen, cwd: s.resolved.cwd, argv1: s.resolved.argv[1] };`,
    );
    expect(out).toEqual({ problem: null, me: "u-alice", seen: ["Bearer tk-acme-file-000000"], cwd: dir, argv1: join(dir, "provider.ts") });
    expect((await cli(r, ["provider", "list"])).out).toContain("tickets  exec · ");
  }, 30_000);
});

describe("the parts of a module that run inside the board", () => {
  test("its rendering is plain text escaped by Strato, and a pure function that throws reads as nothing to say", async () => {
    const r = rig();
    moduleProvider(r, `, render: { plain: (t) => t.toUpperCase(), html: () => "<script>alert(1)</script>" }, threadInfo: () => { throw new Error("boom"); }, parseTarget: () => { throw new Error("bad"); }`);
    config(r, ticketsConfig());
    await trustNow(r);
    const out = await script(
      r,
      `await external.loadExternalProviders();
       const p = links.pureOf("tickets");
       return { html: p.render.html("<b>hi</b>"), info: p.threadInfo("PLAT-12"), target: p.parseTarget("x", { thread: "PLAT-12", conversation: { id: "", label: "" } }, links.linkAccount("tickets", "default")) };`,
    );
    expect(out).toEqual({ html: "&lt;B&gt;HI&lt;/B&gt;", info: null, target: { error: { en: "tickets: bad" } } });
  }, 30_000);
});

describe("profile validation knows a trusted provider's settings", () => {
  test("setup --write checks an external account against the trusted descriptor, and asks for trust first", async () => {
    const r = rig();
    moduleProvider(r);
    config(r, ticketsConfig());
    const profile = join(r.dir, "p.json");
    writeFileSync(profile, JSON.stringify({ providers: { tickets: { accounts: { work: { watchTeam: ["OPS"] } } } } }));
    const before = await cli(r, ["setup", "--write", profile]);
    expect(before.err).toContain('Trust the provider "tickets" first');
    await trustNow(r);
    const after = await cli(r, ["setup", "--write", profile]);
    expect(after.err).toContain('Tickets has no setting "watchTeam"; did you mean "watchTeams"? (providers.tickets.accounts.work.watchTeam)');
    writeFileSync(profile, JSON.stringify({ providers: { tickets: { accounts: { work: { watchTeams: ["OPS"] } } } } }));
    const ok = await cli(r, ["setup", "--write", profile]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(readFileSync(join(r.state, "config.json"), "utf8")).providers.tickets.accounts.work).toEqual({ watchTeams: ["OPS"] });
  }, 30_000);
});

describe("provider commands and the caller", () => {
  test("a session never trusts a provider, and trusting needs the person's own terminal", async () => {
    const r = rig();
    moduleProvider(r);
    config(r, ticketsConfig());
    const session = await cli(r, ["provider", "trust", "tickets"], { STRATO_CALLER: "session" });
    expect(session.code).toBe(77);
    expect(session.err).toContain("A work session never trusts, writes nor runs provider code");
    const pipe = await cli(r, ["provider", "trust", "tickets"]);
    expect(pipe.code).toBe(64);
    expect(pipe.err).toContain("run it in your own terminal");
    expect(await problemOf(r)).toContain("not trusted yet");
  }, 30_000);

  test("provider types prints the SDK file as it is in the source", async () => {
    const r = rig();
    const res = await cli(r, ["provider", "types"]);
    expect(res.out).toBe(readFileSync(join(SCRIPTS, "providers", "sdk.ts"), "utf8"));
    expect((await cli(r, ["provider", "sdk"])).out).toBe(res.out);
  }, 30_000);

  test("work sessions are started with the caller marked", () => {
    const src = readFileSync(join(SCRIPTS, "app", "claude.ts"), "utf8");
    expect(src).toContain('STRATO_CALLER: "session"');
  }, 30_000);
});

describe("descriptor checks", () => {
  beforeEach(() => useSettings(resolveSettings({ ...TEST_SETTINGS, ui: { locale: "en" } })));
  afterEach(() => useSettings(TEST_SETTINGS));

  test("the fake ticket tool's descriptor has no problem", () => {
    expect(descriptorProblems(fakeDescriptor("tickets", "Tickets"), "tickets")).toEqual([]);
  }, 30_000);

  test("each kind of mistake is spelled out with its path", () => {
    const d = fakeDescriptor("tickets", "Tickets") as unknown as Record<string, any>;
    const bad = {
      ...d,
      id: "Tickets",
      label: { key: "provider.slack.label" },
      kinds: ["crm"],
      capabilities: { ...d.capabilities, ingest: { push: true, poll: false }, actions: ["comment"], undo: ["delete"], idempotent: [] },
      auth: [{ ...d.auth[0], kind: "cookie", docs: "http://tickets.example", steps: [{ kind: "paste", secret: "OTHER", say: { en: "x" } }] }],
      settings: [{ key: "watch", type: "string[]", label: { en: "Watched" }, triage: "watch" }],
      links: { parse: [{ host: "https://tickets.example", pattern: "^/t/([A-Z+", thread: "$1" }], of: [{ match: "^(.*)$", url: "http://tickets.example/$1" }] },
      hosts: ["tickets.example/x"],
      done: { kind: "react", emoji: "white_check_mark" },
    };
    expect(descriptorProblems(bad, "tickets")).toEqual([
      "id: a provider id is lowercase letters, digits and dashes, starts with a letter, 2 to 31 characters",
      'label: an external provider gives its texts as {"en": "…"}, English required, French optional',
      'kinds: "crm" is not one of "chat", "tracker", "mail", "forge"',
      "capabilities.ingest: a provider that pushes also polls, to catch up after a silent cut (ingest.poll: true)",
      'capabilities.undo: "delete" is not among the declared actions',
      "undoMs: undoable actions need undoMs, the undo window in milliseconds",
      'auth[0].kind: "cookie" is not one of "user-token", "api-key", "app-password", "oauth2"',
      "auth[0].docs: expected an https link",
      'auth[0].steps[0].secret: the secret "OTHER" is not declared in this method\'s stores',
      "settings[0].ask: a setting with a triage role needs an ask text, the question the interview asks",
      "links.parse[0].host: a host name, without scheme nor path, such as tickets.example",
      expect.stringMatching(/^links\.parse\[0\]\.pattern: not a valid regular expression/),
      "links.of[0].url: expected an https link",
      "hosts[0]: a host name, without scheme nor path, such as tickets.example",
      "done: the done marker is a reaction, and react must be among the actions",
    ]);
  }, 30_000);

  test("a link pattern that stalls on a long input is refused", () => {
    let clock = 0;
    const d = { ...fakeDescriptor("tickets", "Tickets"), links: { parse: [{ host: "tickets.example", pattern: "^/t/(a+)+$", thread: "$1" }], of: [] } };
    // the injected clock says each measure took 80 ms
    expect(descriptorProblems(d, "tickets", { now: () => (clock += 80) })).toEqual(["links.parse[0].pattern: took 80 ms on a 2 KiB input, and a link pattern must answer within 50 ms"]);
    expect(patternCost(/^\/t\/([A-Z]+-\d+)/)).toBeLessThan(50);
  }, 30_000);
});
