/**
 * The `providers` section of config.json: the accounts resolved from every format (legacy flat, current, new, and
 * mixes), and the validation messages of `setup --write` (docs/design/providers.md, section 6).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { profileErrors } from "./core/setup.ts";
import { resolveAccounts, resolveSettings, useProviders, useSettings } from "./lib.ts";
import { BUILTIN_DESCRIPTORS } from "./providers/builtin.ts";
import { LINEAR_DESCRIPTOR } from "./providers/linear/model.ts";
import { TEST_SETTINGS } from "./test-setup.ts";

afterEach(() => {
  useSettings(TEST_SETTINGS);
  useProviders([...BUILTIN_DESCRIPTORS]);
});

const descriptors = Object.fromEntries(BUILTIN_DESCRIPTORS.map((d) => [d.id, d]));
const ids = (raw: unknown) => resolveAccounts(resolveSettings(raw), descriptors).map((a) => `${a.account.provider}@${a.account.id}`);

describe("accounts from every config.json format", () => {
  const slack = { team: "Acme", workspace: "acme", me: "UALICE", subteams: ["SACME"], watchChannels: ["C0ACMEREQ01"], userTokenFile: "~/.config/strato/acme.env" };

  test("the legacy flat format and the current format resolve to the same accounts", () => {
    const flat = resolveAccounts(resolveSettings({ team: "Acme", me: "UALICE", subteams: ["SACME"], watchChannels: ["C0ACMEREQ01"], slack: { workspace: "acme", userTokenFile: "~/.config/strato/acme.env" } }), descriptors);
    const current = resolveAccounts(resolveSettings({ slack }), descriptors);
    expect(flat).toEqual(current);
    expect(current).toEqual([
      {
        account: { provider: "slack", id: "default", label: "Acme", auth: "user-token", ingest: "push", settings: { ...resolveSettings({ slack }).slack } },
        secretsFile: "~/.config/strato/acme.env",
        pollInterval: 60,
        mcpServer: "slack",
        from: "slack",
      },
    ]);
  });

  test("an empty profile still has its default Slack account, and no other", () => {
    expect(ids({})).toEqual(["slack@default"]);
    expect(resolveSettings({}).providers).toEqual({});
  });

  test("a tracker section is a links-only Linear account: no auth, no ingest", () => {
    const [, linear] = resolveAccounts(resolveSettings({ slack, tracker: { kind: "linear", workspace: "acme", prefixes: ["ENG"] } }), descriptors);
    expect(linear).toMatchObject({ account: { provider: "linear", id: "default", auth: "none", ingest: "off", settings: { workspace: "acme", prefixes: ["ENG"] } }, from: "tracker" });
    expect(ids({ slack, tracker: null })).toEqual(["slack@default"]);
  });

  test("the new format: named accounts, the providers' first auth method and their ingest by default", () => {
    const raw = {
      slack,
      tracker: { kind: "linear", workspace: "acme", prefixes: ["ENG", "OPS"] },
      providers: {
        linear: { accounts: { default: { auth: "api-key", secretsFile: "~/.config/strato/linear-default.env", watchTeams: ["ENG"], ignoreAuthors: ["Deploy Bot"] } } },
        slack: { accounts: { partners: { team: "Acme Partners", workspace: "acme-partners", me: "UALICEP01", ingest: "poll" } } },
        tickets: { source: { exec: ["python3", "provider.py"], sha256: "41aa" }, accounts: { default: { baseUrl: "https://tickets.example" } } },
      },
    };
    const all = resolveAccounts(resolveSettings(raw), descriptors);
    expect(all.map((a) => `${a.account.provider}@${a.account.id}`)).toEqual(["slack@default", "slack@partners", "linear@default", "tickets@default"]);
    expect(all[1]).toMatchObject({ account: { label: "Acme Partners", auth: "user-token", ingest: "poll", settings: { workspace: "acme-partners", me: "UALICEP01" } }, secretsFile: "~/.config/strato/slack-partners.env", from: "providers" });
    // the tracker gives the link fields, providers.linear.accounts.default the rest
    expect(all[2]).toMatchObject({ account: { auth: "api-key", ingest: "poll", settings: { workspace: "acme", prefixes: ["ENG", "OPS"], watchTeams: ["ENG"], ignoreAuthors: ["Deploy Bot"] } }, secretsFile: "~/.config/strato/linear-default.env", mcpServer: "linear", from: "tracker" });
    expect(all[3]).toMatchObject({ account: { provider: "tickets", auth: "none", ingest: "poll", settings: { baseUrl: "https://tickets.example" } }, mcpServer: null });
  });

  test("mixes: flat keys with a providers section; Linear from providers alone; disabled and default Slack accounts left out", () => {
    expect(ids({ team: "Acme", me: "UALICE", providers: { slack: { accounts: { partners: { workspace: "acme-partners" } } } } })).toEqual(["slack@default", "slack@partners"]);
    const linearOnly = resolveAccounts(resolveSettings({ providers: { linear: { accounts: { default: { workspace: "acme", prefixes: ["ENG"] } } } } }), descriptors);
    expect(linearOnly[1]).toMatchObject({ account: { provider: "linear", auth: "api-key", ingest: "poll", settings: { workspace: "acme", prefixes: ["ENG"] } }, from: "providers" });
    expect(ids({ providers: { slack: { accounts: { default: { workspace: "other" }, off: { enabled: false } } } } })).toEqual(["slack@default"]);
    expect(resolveAccounts(resolveSettings({ slack: { workspace: "acme" }, providers: { slack: { accounts: { default: { workspace: "other" } } } } }))[0].account.settings.workspace).toBe("acme");
    // the tracker wins over link fields repeated under providers
    const both = resolveAccounts(resolveSettings({ tracker: { workspace: "acme", prefixes: ["ENG"] }, providers: { linear: { accounts: { default: { workspace: "other", prefixes: ["X"] } } } } }), descriptors);
    expect(both[1].account.settings).toMatchObject({ workspace: "acme", prefixes: ["ENG"] });
  });

  test("a malformed providers section is read as far as it goes, never thrown", () => {
    expect(resolveSettings({ providers: [] }).providers).toEqual({});
    expect(resolveSettings({ providers: { x: 1, y: { accounts: { a: 1, b: {} } } } }).providers).toEqual({ y: { accounts: { b: {} } } });
  });
});

describe("validation of the providers section", () => {
  const err = (providers: unknown, extra: Record<string, unknown> = {}, external = {}) => profileErrors({ slack: { team: "Acme" }, tracker: { kind: "linear", workspace: "acme", prefixes: ["ENG"] }, ...extra, providers }, external);
  const en = () => useSettings(resolveSettings({ ...TEST_SETTINGS, ui: { locale: "en" } }));

  test("today's profiles, flat or current, gain no error", () => {
    expect(profileErrors({ team: "Acme", me: "U1", subteams: [], slack: { workspace: "acme" } })).toEqual([]);
    expect(profileErrors(JSON.parse(JSON.stringify({ ...TEST_SETTINGS, providers: undefined })))).toEqual([]);
    expect(err({})).toEqual([]);
  });

  test("the design's example profile is valid once its external providers are trusted", () => {
    en();
    const tickets = { ...LINEAR_DESCRIPTOR, id: "tickets", settings: [{ key: "baseUrl", type: "string" as const, label: { en: "Base URL" } }] };
    const maildir = { ...LINEAR_DESCRIPTOR, id: "maildir", auth: [], settings: [{ key: "path", type: "string" as const, label: { en: "Path" } }] };
    const providers = {
      linear: { accounts: { default: { auth: "api-key", secretsFile: "~/.config/strato/linear-default.env", watchTeams: ["PLAT"], ignoreAuthors: ["Deploy Bot"] } } },
      slack: { accounts: { partners: { auth: "user-token", secretsFile: "~/.config/strato/slack-partners.env", team: "Acme Partners", workspace: "acme-partners", me: "U0ALICE0P01", ingest: "poll" } } },
      maildir: { source: { module: "~/.config/strato/providers/maildir/provider.ts", sha256: "9f2c" }, accounts: { default: { auth: "none", path: "~/Mail/acme" } } },
      tickets: { source: { exec: ["python3", "~/.config/strato/providers/tickets/provider.py"], sha256: "41aa" }, accounts: { default: { auth: "api-key", baseUrl: "https://tickets.example" } } },
    };
    expect(err(providers, {}, { tickets: { descriptor: tickets }, maildir: { descriptor: maildir } })).toEqual([]);
  });

  test("every message of the design, in plain words, the path last", () => {
    en();
    expect(err({ slack: { accounts: { default: { workspace: "other" } } } })).toEqual(['Your main Slack workspace is set in the "slack" section; give this other one a name, such as "partners" (providers.slack.accounts.default)']);
    expect(err({ linear: { accounts: { default: { auth: "oauth" } } } })).toEqual(['Linear does not connect with "oauth"; choose "api-key" or "oauth-pkce" (providers.linear.accounts.default.auth)']);
    expect(err({ linear: { accounts: { Work: {} } } })).toEqual(['An account name uses lowercase letters, digits and dashes, such as "work" (providers.linear.accounts.Work)']);
    expect(err({ linear: { accounts: { default: { watchTeam: ["ENG"] } } } })).toEqual(['Linear has no setting "watchTeam"; did you mean "watchTeams"? (providers.linear.accounts.default.watchTeam)']);
    expect(err({ tickets: { accounts: { default: {} } } })).toEqual(['"tickets" is not a built-in tool (built in: slack, linear); an external provider needs source.module or source.exec (providers.tickets)']);
    expect(err({ tickets: { source: { exec: ["./t"] }, accounts: { default: { baseUrl: "https://tickets.example" } } } })).toEqual([
      'Trust the provider "tickets" first, so Strato knows its settings: strato provider trust tickets, or the board\'s Connect page (providers.tickets.accounts.default)',
    ]);
    expect(err({ linear: { accounts: { default: { apiKey: "lin_api_x" } } } })).toEqual([
      "A secret never goes in config.json; strato setup --connect linear, or the board's Connect page, stores it in a file only you can read (providers.linear.accounts.default.apiKey)",
    ]);
    expect(err({ maildir: { source: { module: "./m.ts", sha256: "9f2c" }, accounts: { default: {} } } }, {}, { maildir: { changed: true } })).toEqual([
      'The provider "maildir" changed since you trusted it; read it, then trust it again with strato provider trust maildir or on the Connect page (providers.maildir.source)',
    ]);
  });

  test("the other checks: names, sources, reserved keys, types, and the tracker's fields", () => {
    en();
    expect(err({ Tickets: {} })).toEqual(['A tool name uses lowercase letters, digits and dashes, and starts with a letter, such as "tickets" (providers.Tickets)']);
    expect(err({ slack: { source: { module: "x.ts" } } })).toEqual(['An external provider\'s source is {"module": path} or {"exec": [command, …]}, with the "sha256" you trusted; a built-in tool has none (providers.slack.source)']);
    expect(err({ slack: { account: {} } })).toEqual(['A tool\'s entry holds "source" and "accounts" only (providers.slack.account)']);
    expect(err({ slack: { accounts: { partners: { ingest: "socket" } } } })).toEqual(['An account reads its tool with "push", "poll" or "off" (providers.slack.accounts.partners.ingest)']);
    expect(err({ linear: { accounts: { default: { ingest: "push" } } } })).toEqual(['Linear cannot push new items; use "poll" or "off" (providers.linear.accounts.default.ingest)']);
    expect(err({ linear: { accounts: { default: { pollInterval: "60", watchTeams: "ENG" } } } })).toEqual([
      "Expected number here, got string (providers.linear.accounts.default.pollInterval)",
      "Expected array of strings here, got string (providers.linear.accounts.default.watchTeams)",
    ]);
    expect(err({ linear: { accounts: { default: { workspace: "other" } } } })).toEqual(['The Linear workspace and ticket prefixes come from the "tracker" section; set them there, not here (providers.linear.accounts.default.workspace)']);
    expect(err({ linear: { accounts: { default: { workspace: "acme", prefixes: ["ENG"] } } } }, { tracker: null })).toEqual([]);
    expect(err({ linear: { accounts: { default: { colour: "red" } } } })).toEqual(['Linear has no setting "colour"; its settings are workspace, prefixes, clientId, watchTeams, ignoreTeams, ignoreAuthors (providers.linear.accounts.default.colour)']);
    expect(err([])).toEqual(["Expected object here, got array (providers)"]);
  });

  test("the messages exist in French", () => {
    useSettings(resolveSettings({ ...TEST_SETTINGS, ui: { locale: "fr" } }));
    expect(err({ linear: { accounts: { default: { auth: "oauth" } } } })).toEqual(['Linear ne se connecte pas avec « oauth » ; choisis "api-key" ou "oauth-pkce" (providers.linear.accounts.default.auth)']);
  });
});
