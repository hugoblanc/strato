/**
 * Setup per provider (docs/design/providers.md, section 11): the pure side of connecting, and `setup --providers |
 * --connect`, `doctor`, `--check` and `--detect` on throwaway states. Slack and the authorization server (oauth.test.ts)
 * are fakes: no network, nothing posted.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountLine, chooseMethod, connectPatch, detectedSettings, providerListLines } from "./core/connect.ts";
import { oauthPortOf, resolveSettings } from "./core/settings.ts";
import { profileErrors } from "./core/setup.ts";
import { LINEAR_DESCRIPTOR } from "./providers/linear/model.ts";
import { approve, fakeAuthServer, freePort } from "./oauth-fake.ts";
import { authorizeUrlOf, redirectUriOf } from "./core/oauth.ts";
import type { OAuthStep } from "./providers/sdk.ts";
import { SLACK_APP_LINK, SLACK_AUTH, SLACK_DESCRIPTOR, SLACK_TEAM_APP_LINK } from "./providers/slack/model.ts";
import { CLI, cleanupRigs, cli, type Rig, rig, run, SCRIPTS } from "./test-rig.ts";

afterEach(() => cleanupRigs());

describe("connecting, the pure side", () => {
  test("the OAuth callback port: ui.oauthPort, else the board's port + 10", () => {
    expect(oauthPortOf(resolveSettings({}))).toBe(4353);
    expect(oauthPortOf(resolveSettings({ ui: { port: 5000 } }))).toBe(5010);
    expect(oauthPortOf(resolveSettings({ ui: { oauthPort: 7777 } }))).toBe(7777);
  });

  test("the method asked, else the provider's default; an unknown one names the others", () => {
    expect((chooseMethod(SLACK_DESCRIPTOR, undefined) as { id: string }).id).toBe("user-token");
    expect((chooseMethod(SLACK_DESCRIPTOR, "oauth-pkce") as { id: string }).id).toBe("oauth-pkce");
    expect((chooseMethod(SLACK_DESCRIPTOR, "oauth") as { error: string }).error).toContain("user-token, paste-token, oauth-pkce");
  });

  test("Slack's three official methods; the team app is polled, never pushed", () => {
    expect(SLACK_DESCRIPTOR.auth.map((m) => [m.id, m.kind])).toEqual([
      ["user-token", "user-token"],
      ["paste-token", "user-token"],
      ["oauth-pkce", "oauth2"],
    ]);
    expect(SLACK_DESCRIPTOR.auth[0].steps[0]).toEqual({ kind: "open", url: SLACK_APP_LINK, say: { key: "provider.slack.auth.userToken.open" } });
    expect(SLACK_DESCRIPTOR.auth[2].limits).toEqual({ ingest: { push: false } });
    for (const m of [...SLACK_DESCRIPTOR.auth, ...LINEAR_DESCRIPTOR.auth]) {
      for (const s of m.steps) if (s.kind === "paste" || s.kind === "oauth") expect(m.stores.map((x) => x.name)).toContain(s.secret);
    }
  });

  test("Slack's OAuth link: user scopes joined by commas, a localhost redirect", () => {
    const slack = SLACK_AUTH.find((m) => m.id === "oauth-pkce")?.steps[0] as OAuthStep;
    const url = new URL(authorizeUrlOf(slack, { clientId: "123.456", redirectUri: redirectUriOf(slack, 4353), state: "st", challenge: "ch" }));
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: "code", client_id: "123.456", redirect_uri: "http://localhost:4353/oauth/callback", state: "st", code_challenge: "ch", code_challenge_method: "S256" });
    expect(url.searchParams.get("user_scope")).toBe("search:read,channels:history,groups:history,im:history,mpim:history,channels:read,groups:read,im:read,mpim:read,users:read,chat:write,reactions:write,usergroups:read");
    expect(url.searchParams.has("scope")).toBe(false);
    expect(redirectUriOf({}, 4353)).toBe("http://127.0.0.1:4353/oauth/callback");
  });

  test("what goes into config.json: the default Slack account in its section, any other under providers, never a secret", () => {
    const settings = detectedSettings({ team: { value: "Acme", source: "auth.test", confidence: "high" }, workspace: { value: "acme", source: "url", confidence: "high" }, me: { value: "UALICE", source: "auth.test", confidence: "high" }, groups: { value: ["S1"], source: "x", confidence: "high" }, teamAlias: { value: "@x", source: "x", confidence: "low" } }, SLACK_DESCRIPTOR.settings.map((s) => s.key));
    expect(settings).toEqual({ team: "Acme", workspace: "acme", me: "UALICE" });
    const main = connectPatch({ provider: "slack", account: "default", method: "paste-token", settings, slackFile: { path: "~/.config/strato/acme.env", appToken: true } });
    expect(main).toEqual({ slack: { userTokenFile: "~/.config/strato/acme.env", team: "Acme", workspace: "acme", me: "UALICE", appTokenFile: "~/.config/strato/acme.env" } });
    const named = connectPatch({ provider: "slack", account: "partners", method: "oauth-pkce", settings, clientId: "123.456" });
    expect(named).toEqual({ providers: { slack: { accounts: { partners: { auth: "oauth-pkce", team: "Acme", workspace: "acme", me: "UALICE", clientId: "123.456" } } } } });
    expect(profileErrors(main)).toEqual([]);
    expect(profileErrors(named)).toEqual([]);
  });

  test("the list of tools and the doctor line of an account", () => {
    const lines = providerListLines([{ descriptor: SLACK_DESCRIPTOR, accounts: [{ id: "default", label: "Acme", linksOnly: false }], refusal: null }], "strato");
    expect(lines[0]).toContain("strato setup --connect <tool> [--account <name>] [--auth <method>]");
    expect(lines.find((l) => l.startsWith("slack · "))).toContain("default (Acme)");
    expect(lines.filter((l) => /^ {2}(user-token|paste-token|oauth-pkce) /.test(l))).toHaveLength(3);
    const line = accountLine({ provider: "slack", id: "partners", label: "Acme Partners", ingest: "poll" }, SLACK_DESCRIPTOR.auth[1], 60, { ok: false, reason: "invalid_auth", fix: "strato setup --connect slack --account partners" });
    expect(line).toStartWith("slack    : Acme Partners (partners) · ");
    expect(line).toContain("strato setup --connect slack --account partners");
  });
});

// ------------------------------------------------------------------ the command line

/** Fake Slack: auth.test by token (the partners workspace for a token naming it), app tokens, and the OAuth exchange forwarded to FAKE_AUTH. */
const FAKE_SLACK = `import { appendFileSync } from "node:fs";
const real = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith("https://slack.com/api/")) return real(input, init);
  const method = new URL(url).pathname.slice("/api/".length);
  appendFileSync(process.env.FAKE_SLACK_LOG as string, method + "\\n");
  if (method === "oauth.v2.access") return real(process.env.FAKE_AUTH + "/api/oauth.v2.access", { method: "POST", body: init?.body as BodyInit, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  const auth = new Headers(init?.headers).get("authorization") ?? "";
  const token = auth.replace(/^Bearer /, "");
  appendFileSync(process.env.FAKE_SLACK_LOG as string, "token " + token.slice(0, 12) + "\\n");
  const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "Content-Type": "application/json", "x-oauth-scopes": "search:read,channels:history,users:read,chat:write" } });
  if (method === "apps.connections.open") return json(token.startsWith("xapp-") ? { ok: true, url: "wss://example.invalid" } : { ok: false, error: "invalid_auth" });
  if (!token.startsWith("xoxp-")) return json({ ok: false, error: "invalid_auth" });
  const partners = token.includes("partners");
  if (method === "auth.test") return json(partners ? { ok: true, team: "Acme Partners", team_id: "T0ACMEP000", user_id: "UALICEP01", url: "https://acme-partners.slack.com/" } : { ok: true, team: "Acme", team_id: "T0ACME0000", user_id: "UALICE", url: "https://acme.slack.com/" });
  if (method === "users.info") return json({ ok: true, user: { id: "UALICE", real_name: "Alice Martin", profile: { display_name: "alice" } } });
  return json({ ok: true });
}) as typeof fetch;
`;

/** The person's own terminal, as far as Strato checks it: stdin says it is a TTY. */
const FAKE_TTY = `Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });\n`;

function preloads(r: Rig): string[] {
  writeFileSync(join(r.dir, "fake-slack.ts"), FAKE_SLACK);
  writeFileSync(join(r.dir, "fake-tty.ts"), FAKE_TTY);
  return ["--preload", join(r.dir, "fake-slack.ts"), "--preload", join(r.dir, "fake-tty.ts")];
}
const slackEnv = (r: Rig, extra: Record<string, string> = {}) => ({ ...r.env, FAKE_SLACK_LOG: join(r.dir, "slack.log"), STRATO_SLACK_TOKEN: "", SLACK_MCP_XOXP_TOKEN: "", SLACK_APP_TOKEN: "", ...extra });
const config = (r: Rig) => JSON.parse(readFileSync(join(r.state, "config.json"), "utf8"));
const writeConfig = (r: Rig, c: unknown) => writeFileSync(join(r.state, "config.json"), JSON.stringify(c));
const strato = (r: Rig, ...rest: string[]) => join(r.dir, "home", ".config", "strato", ...rest);

/** `setup --connect …` in a terminal-like process, the lines of `stdin` typed one after the other. */
async function connect(r: Rig, args: string[], stdin: string, extra: Record<string, string> = {}) {
  const p = Bun.spawn([process.execPath, ...preloads(r), CLI, "setup", "--connect", ...args], { cwd: SCRIPTS, env: slackEnv(r, extra), stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

describe("setup --providers", () => {
  test("every tool, its accounts and its auth methods with their trade-off; Linear says why it cannot connect yet", async () => {
    const r = rig();
    writeConfig(r, { ...config(r), tracker: { kind: "linear", workspace: "acme", prefixes: ["ENG"] } });
    const res = await cli(r, ["setup", "--providers"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("setup --connect <tool> [--account <name>] [--auth <method>]");
    expect(res.out).toContain("slack · Slack (chat) · accounts: default (Acme)");
    expect(res.out).toMatch(/\n {2}user-token +User token of your own Slack app \(default\): /);
    expect(res.out).toMatch(/\n {2}paste-token +A user token you already have: /);
    expect(res.out).toMatch(/\n {2}oauth-pkce +Sign in through your team's Slack app/);
    expect(res.out).toContain("linear · Linear (tracker) · accounts: default (links and ticket ids only)");
    expect(res.out).toContain("Linear is recognized in links and ticket ids in this version");
  }, 20_000);
});

describe("setup --connect", () => {
  test("from a pipe or a session: refused before anything is asked, and the command to run in a terminal", async () => {
    const r = rig();
    const res = await cli(r, ["setup", "--connect", "slack", "--auth", "paste-token"]);
    expect(res.code).toBe(64);
    expect(res.err).toContain("run it in your own terminal");
    expect(res.err).toContain("setup --connect slack --auth paste-token");
    expect(existsSync(strato(r))).toBe(false);
  }, 20_000);

  test("a user token pasted for the main workspace: verified, stored 600, the slack section filled as setup --token does", async () => {
    const r = rig();
    writeConfig(r, { owner: { name: "Alice" } });
    const res = await connect(r, ["slack", "--auth", "paste-token"], "xoxp-acme-fake-0000\n\n");
    expect(res.code).toBe(0);
    expect(res.out).toContain("connected to Slack (default account) as alice (UALICE) on Acme");
    expect(res.out).toContain("SLACK_USER_TOKEN stored in ~/.config/strato/acme.env (readable by you only)");
    expect(res.out + res.err).not.toContain("xoxp-acme-fake-0000");
    expect(readFileSync(strato(r, "acme.env"), "utf8")).toBe("SLACK_USER_TOKEN=xoxp-acme-fake-0000\n");
    expect(statSync(strato(r, "acme.env")).mode & 0o777).toBe(0o600);
    expect(statSync(strato(r)).mode & 0o777).toBe(0o700);
    expect(config(r).slack).toEqual({ userTokenFile: "~/.config/strato/acme.env", team: "Acme", workspace: "acme", me: "UALICE" });
    // the token now found by the usual search order: doctor is unchanged for a Slack-only profile
    const doctor = await run(r, [...preloads(r), CLI, "doctor"], slackEnv(r));
    expect(doctor.out).toContain("slack    : Acme · user UALICE");
    const lines = doctor.out.split("\n");
    expect(lines[lines.findIndex((l) => l.startsWith("socket   :")) + 1]).toStartWith("claude   :");
  }, 30_000);

  test("the own-app method: the manifest link shown (not opened with --print), then the user and app tokens", async () => {
    const r = rig();
    const res = await connect(r, ["slack", "--auth", "user-token", "--print"], "xoxp-acme-fake-0000\nxapp-1-acme-fake-1111\n");
    expect(res.code).toBe(0);
    expect(res.out).toContain(SLACK_APP_LINK);
    expect(readFileSync(strato(r, "acme.env"), "utf8")).toBe("SLACK_USER_TOKEN=xoxp-acme-fake-0000\nSLACK_APP_TOKEN=xapp-1-acme-fake-1111\n");
    expect(config(r).slack.appTokenFile).toBe("~/.config/strato/acme.env");
    expect(readFileSync(join(r.dir, "slack.log"), "utf8")).toContain("apps.connections.open");
  }, 30_000);

  test("without --auth the methods are offered, the default first; a number picks one", async () => {
    const r = rig();
    const res = await connect(r, ["slack"], "2\nxoxp-acme-fake-0000\n\n");
    expect(res.code).toBe(0);
    expect(res.out).toContain("How do you want to connect Slack?");
    expect(res.out).toMatch(/1\. user-token .*\(default\)/);
    expect(existsSync(strato(r, "acme.env"))).toBe(true);
    const picked = await connect(rig(), [], "slack\n2\nxoxp-acme-fake-0000\n\n");
    expect(picked.code).toBe(0);
    expect(picked.out).toContain("Which tool do you want to connect?");
  }, 30_000);

  test("a second workspace is a named account: its own secret file, its section under providers, a doctor line", async () => {
    const r = rig();
    const res = await connect(r, ["slack", "--account", "partners", "--auth", "paste-token"], "xoxp-partners-fake-2222\n\n");
    expect(res.code).toBe(0);
    expect(res.out).toContain("on Acme Partners");
    expect(readFileSync(strato(r, "slack-partners.env"), "utf8")).toBe("SLACK_USER_TOKEN=xoxp-partners-fake-2222\n");
    expect(config(r).providers).toEqual({ slack: { accounts: { partners: { auth: "paste-token", team: "Acme Partners", workspace: "acme-partners", me: "UALICEP01" } } } });
    expect(config(r).slack).toEqual({ team: "Acme", workspace: "acme", me: "UALICE" });
    const doctor = await run(r, [...preloads(r), CLI, "doctor"], slackEnv(r, { STRATO_SLACK_TOKEN: "xoxp-acme-fake-0000" }));
    expect(doctor.out).toContain("slack    : Acme Partners (partners) · A user token you already have · real time · you are UALICEP01 on Acme Partners");
    const check = await run(r, [...preloads(r), CLI, "setup", "--check"], slackEnv(r, { STRATO_SLACK_TOKEN: "xoxp-acme-fake-0000" }));
    expect(check.out).toContain("ok    slack@partners you are UALICEP01 on Acme Partners");
    const detect = await run(r, [...preloads(r), CLI, "setup", "--detect"], slackEnv(r, { STRATO_SLACK_TOKEN: "xoxp-acme-fake-0000" }));
    expect(JSON.parse(detect.out).fields["providers.slack.accounts.partners.workspace"]).toEqual({ value: "acme-partners", source: "auth.test url", confidence: "high" });
  }, 40_000);

  test("a named account that cannot connect: doctor names it and the command that fixes it", async () => {
    const r = rig();
    writeConfig(r, { ...config(r), providers: { slack: { accounts: { partners: { auth: "paste-token", team: "Acme Partners" } } } } });
    const doctor = await run(r, [...preloads(r), CLI, "doctor"], slackEnv(r, { STRATO_SLACK_TOKEN: "xoxp-acme-fake-0000" }));
    expect(doctor.out).toContain("slack    : Acme Partners (partners) · A user token you already have · real time · not connected: ");
    expect(doctor.out).toContain("setup --connect slack --account partners)");
  }, 30_000);

  test("refused, nothing stored: a bot token, a token of another workspace, an unknown method, a bad account name, Linear", async () => {
    const r = rig();
    const bot = await connect(r, ["slack", "--auth", "paste-token"], "xoxb-acme-fake-0000\n\n");
    expect(bot.code).toBe(1);
    expect(bot.err).toContain("Slack refused the connection, nothing stored: xoxb- is the Bot User OAuth Token");
    writeConfig(r, { slack: { team: "Globex" } });
    const other = await connect(r, ["slack", "--auth", "paste-token"], "xoxp-acme-fake-0000\n\n");
    expect(other.err).toContain('its token belongs to the workspace "Acme", not "Globex"');
    const app = await connect(r, ["slack", "--account", "partners", "--auth", "paste-token"], "xoxp-partners-fake-2222\nxoxp-oops\n");
    expect(app.err).toContain("an App-Level Token starts with xapp-");
    expect(existsSync(strato(r))).toBe(false);
    expect(config(r)).toEqual({ slack: { team: "Globex" } });
    expect((await connect(r, ["slack", "--auth", "oauth"], "")).err).toContain('Slack does not connect with "oauth"; choose one of user-token, paste-token, oauth-pkce');
    expect((await connect(r, ["slack", "--account", "Work"], "")).code).toBe(64);
    expect((await connect(r, ["nope"], "")).err).toContain("nope is not a tool Strato can connect");
    expect((await connect(r, ["linear"], "")).err).toContain("Linear is recognized in links and ticket ids");
  }, 40_000);

  test("OAuth with PKCE end to end: the browser approves on a fake authorization server, the token is stored, the client id kept", async () => {
    const r = rig();
    const port = freePort();
    writeConfig(r, { owner: { name: "Alice" }, ui: { oauthPort: port } });
    const fake = fakeAuthServer({ shape: "slack" });
    try {
      const p = Bun.spawn([process.execPath, ...preloads(r), CLI, "setup", "--connect", "slack", "--auth", "oauth-pkce", "--client-id", "123.456", "--print"], {
        cwd: SCRIPTS,
        env: slackEnv(r, { FAKE_AUTH: fake.url }),
        stdin: new Blob([""]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const reader = p.stdout.getReader();
      let printed = "";
      let link: string | undefined;
      while (!link) {
        const chunk = await reader.read();
        if (chunk.done) break;
        printed += new TextDecoder().decode(chunk.value);
        link = printed.split("\n").find((l) => l.startsWith("https://slack.com/oauth/v2/authorize?") && printed.endsWith("\n"));
      }
      expect(link).toBeDefined();
      const page = await approve(link as string, fake);
      expect(await page.text()).toContain("Strato is connected");
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) printed += new TextDecoder().decode(chunk.value);
      const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
      expect(err).toBe("");
      expect(code).toBe(0);
      const asked = fake.seen.authorize[0];
      expect(asked.get("client_id")).toBe("123.456");
      expect(asked.get("redirect_uri")).toBe(`http://localhost:${port}/oauth/callback`);
      expect(asked.get("user_scope")).toContain("search:read");
      expect(fake.seen.token[0].has("client_secret")).toBe(false);
      expect(printed).toContain("connected to Slack (default account) as alice (UALICE) on Acme");
      expect(printed).not.toContain("xoxp-oauth-fake-7777");
      expect(readFileSync(strato(r, "acme.env"), "utf8")).toBe("SLACK_USER_TOKEN=xoxp-oauth-fake-7777\n");
      expect(config(r).slack).toEqual({ userTokenFile: "~/.config/strato/acme.env", team: "Acme", workspace: "acme", me: "UALICE", clientId: "123.456" });
      // the verify step read Slack with the token the exchange returned
      expect(readFileSync(join(r.dir, "slack.log"), "utf8")).toContain("token xoxp-oauth-f");
    } finally {
      fake.stop();
    }
  }, 40_000);

  test("OAuth without a client id says where to find it and how a team creates its app; never on the board's port", async () => {
    const r = rig();
    const none = await connect(r, ["slack", "--auth", "oauth-pkce"], "");
    expect(none.code).toBe(64);
    expect(none.err).toContain("client id of your team's Slack app");
    expect(none.err).toContain("setup --slack-app --team");
    writeConfig(r, { ...config(r), ui: { port: 4999, oauthPort: 4999 } });
    const board = await connect(r, ["slack", "--auth", "oauth-pkce", "--client-id", "123.456"], "");
    expect(board.code).toBe(1);
    expect(board.err).toContain("the OAuth callback cannot use port 4999, the board's own");
  }, 30_000);
});

describe("setup --slack-app --team", () => {
  test("the team app's manifest: PKCE on, the default callback, no Socket Mode, every scope of the per-person app", async () => {
    const team = readFileSync(join(SCRIPTS, "..", "examples", "slack-team-app-manifest.yaml"), "utf8");
    const own = readFileSync(join(SCRIPTS, "..", "examples", "slack-app-manifest.yaml"), "utf8");
    expect(team).toContain("pkce_enabled: true");
    expect(team).toContain("- http://localhost:4353/oauth/callback");
    expect(team).toContain("socket_mode_enabled: false");
    expect(team).not.toContain("event_subscriptions");
    const scopes = (yaml: string) => [...yaml.matchAll(/^ {6}- ([a-z:]+)$/gm)].map((m) => m[1]);
    expect(scopes(team)).toEqual(scopes(own));
    const res = await cli(rig(), ["setup", "--slack-app", "--team", "--print"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("Keep it internal");
    expect(res.out).toContain("setup --connect slack --auth oauth-pkce --client-id <client id>");
    expect(res.out).toContain(SLACK_TEAM_APP_LINK);
    // SETUP.md embeds the link: editing the manifest means updating it there
    expect(readFileSync(join(SCRIPTS, "..", "SETUP.md"), "utf8")).toContain(SLACK_TEAM_APP_LINK);
  }, 20_000);
});
