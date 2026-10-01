/**
 * The `providers` section of config.json: the accounts resolved from every format (legacy flat, current, new, and
 * mixes) (docs/design/providers.md, section 6).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { resolveAccounts, resolveSettings, useProviders, useSettings } from "./lib.ts";
import { BUILTIN_DESCRIPTORS } from "./providers/builtin.ts";
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
