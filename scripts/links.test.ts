/**
 * Links as data (core/links.ts): the descriptors' patterns give the same keys as the former Slack and Linear code,
 * exact hosts win over wildcards, `of` and `parse` round-trip, and a link is only ever built on the provider's hosts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  checkedLink,
  citations,
  claimTicketId,
  formatKey,
  hostOwner,
  keyFromPermalink,
  linkOfNative,
  parseLink,
  permalinkOfKey,
  providerLabel,
  resolveSettings,
  sujetKey,
  useProviders,
  useSettings,
} from "./lib.ts";
import { BUILTIN_DESCRIPTORS } from "./providers/builtin.ts";
import type { ProviderDescriptor } from "./providers/sdk.ts";
import { SLACK_DESCRIPTOR } from "./providers/slack/model.ts";
import { TEST_SETTINGS } from "./test-setup.ts";

afterEach(() => {
  useSettings(TEST_SETTINGS);
  useProviders([...BUILTIN_DESCRIPTORS]);
});

/** A tracker of the test universe, declared here only: links on its own host, ids with its prefixes. */
const FAKE: ProviderDescriptor = {
  ...SLACK_DESCRIPTOR,
  id: "tickets",
  label: { en: "Tickets", fr: "Tickets FR" },
  kinds: ["tracker"],
  links: {
    parse: [{ host: "{settings.host}", pattern: "^/t/(T-\\d+)(?:#c(\\d+))?", thread: "$1", item: "$1/c$2" }],
    of: [
      { match: "^(T-\\d+)$", url: "https://{settings.host}/t/$1" },
      { match: "^(T-\\d+)/c(\\d+)$", url: "https://{settings.host}/t/$1#c$2" },
      { match: "^evil$", url: "https://evil.example/x" },
    ],
  },
  hosts: ["tickets.example", "*.tickets.example"],
  ticketIds: { prefixesFrom: "prefixes" },
  settings: [
    { key: "host", type: "string", label: { en: "Host" } },
    { key: "prefixes", type: "string[]", label: { en: "Prefixes" } },
  ],
  mcp: undefined,
};

const withFake = (accounts: Record<string, Record<string, unknown>>, extra: Record<string, unknown> = {}) => {
  useProviders([...BUILTIN_DESCRIPTORS, FAKE]);
  useSettings(resolveSettings({ ...TEST_SETTINGS, ...extra, providers: { tickets: { source: { module: "x.ts" }, accounts } } }));
};

describe("Slack links as data", () => {
  // every link shape parsePermalink accepts gives the same key through the descriptor's patterns
  const links = [
    "https://acme.slack.com/archives/C0ACME0001/p1759219200000100",
    "https://acme.slack.com/archives/C0ACME0001/p1759219260000200?thread_ts=1759219200.000100&cid=C0ACME0001",
    "https://acme.slack.com/archives/C0ACME0001/p1759219260000200?cid=C0ACME0001&thread_ts=1759219200.000100",
    "https://acme.slack.com/archives/D0ACME0001/p1759219200000100",
    "https://other-team.slack.com/archives/C0ACME0001/p1759219200000100",
    "https://acme.enterprise.slack.com/archives/C0ACME0001/p1759219200000100",
    "http://acme.slack.com/archives/C0ACME0001/p1759219200000100",
    "acme.slack.com/archives/C0ACME0001/p1759219200000100",
    "see https://acme.slack.com/archives/C0ACME0001/p1759219200000100.",
    "  https://acme.slack.com/archives/C0ACME0001/p1759219200000100  ",
    "https://slack.com/archives/C0ACME0001/p1759219200000100",
    "/archives/C0ACME0001/p1759219200000100",
    "see https://example.com/x and https://acme.slack.com/archives/C0ACME0001/p1759219200000100",
    "ticket https://linear.app/acme/issue/OPS-7 and slack https://acme.slack.com/archives/C0ACME0001/p1759219200000100",
    "see **https://acme.slack.com/archives/C0ACME0001/p1759219200000100** now",
    "https://acme.slack.com/archives/C0ACME0001/p1759219200000100,https://acme.slack.com/archives/C0ACME0002/p1759219200000200",
  ];
  test.each(links)("%s", (link) => {
    expect(keyFromPermalink(link)).not.toBeNull();
    expect(sujetKey(link)).toBe(keyFromPermalink(link));
  });

  test("a reply's link names the reply as the item, and its root as the thread", () => {
    expect(parseLink(links[1])).toEqual({ provider: "slack", account: "default", thread: "C0ACME0001:1759219200.000100", item: "C0ACME0001:1759219260.000200" });
    expect(parseLink(links[0])).toEqual({ provider: "slack", account: "default", thread: "C0ACME0001:1759219200.000100" });
  });

  test("a key gives back its link, and the link gives back the key", () => {
    const key = "C0ACME0001:1759219200.000100";
    const url = permalinkOfKey(key) as string;
    expect(url).toBe("https://acme.slack.com/archives/C0ACME0001/p1759219200000100");
    expect(sujetKey(url)).toBe(key);
    expect(linkOfNative("slack", "default", "C0ACME0001")).toBe("https://acme.slack.com/archives/C0ACME0001");
  });

  test("without a workspace, links still parse but none is built", () => {
    useSettings(resolveSettings({ slack: { me: "UME" } }));
    expect(sujetKey(links[0])).toBe("C0ACME0001:1759219200.000100");
    expect(permalinkOfKey("C0ACME0001:1759219200.000100")).toBeNull();
  });

  test("not a Slack link: no key", () => {
    for (const x of ["https://acme.slack.com/client/T0ACME0000/C0ACME0001", "https://example.com/archives/C0ACME0001/p1759219200000100", "/archives/x", "x".repeat(3000)]) expect(parseLink(x)).toBeNull();
  });

  test("transcript citations resolve through the evaluator", () => {
    expect(citations("voir https://acme.slack.com/archives/C0ACME0001/p1759219200000100, merci").slack).toEqual([
      { key: "C0ACME0001:1759219200.000100", url: "https://acme.slack.com/archives/C0ACME0001/p1759219200000100", workspace: "acme" },
    ]);
  });

  test("citations stop at Markdown emphasis and at a comma between two links", () => {
    const one = "https://acme.slack.com/archives/C0ACME0001/p1759219200000100";
    const two = "https://acme.slack.com/archives/C0ACME0002/p1759219200000200";
    expect(citations(`see **${one}** now`).slack).toEqual([{ key: "C0ACME0001:1759219200.000100", url: one, workspace: "acme" }]);
    expect(citations(`${one},${two}`).slack.map((c) => [c.key, c.url])).toEqual([
      ["C0ACME0001:1759219200.000100", one],
      ["C0ACME0002:1759219200.000200", two],
    ]);
  });

  test("in a long text, every link is still cited", () => {
    const one = "https://acme.slack.com/archives/C0ACME0001/p1759219200000100";
    expect(citations(`${"x ".repeat(3000)}${one}`).slack.map((c) => c.key)).toEqual(["C0ACME0001:1759219200.000100"]);
  });
});

describe("accounts and hosts", () => {
  test("a named Slack account's exact host wins over the default account's wildcard", () => {
    useSettings(resolveSettings({ ...TEST_SETTINGS, providers: { slack: { accounts: { partners: { workspace: "acme-partners" } } } } }));
    expect(sujetKey("https://acme-partners.slack.com/archives/C0ACME0002/p1759219200000300")).toBe("slack@partners:C0ACME0002:1759219200.000300");
    expect(sujetKey("https://acme.slack.com/archives/C0ACME0002/p1759219200000300")).toBe("C0ACME0002:1759219200.000300");
    expect(sujetKey("https://elsewhere.slack.com/archives/C0ACME0002/p1759219200000300")).toBe("C0ACME0002:1759219200.000300");
    expect(permalinkOfKey("slack@partners:C0ACME0002:1759219200.000300")).toBe("https://acme-partners.slack.com/archives/C0ACME0002/p1759219200000300");
  });

  test("the board opens the hosts of configured accounts only: Slack always, the tracker when there is one", () => {
    expect(hostOwner("acme.slack.com")).toEqual({ provider: "slack", account: "default" });
    expect(hostOwner("slack.com")).toEqual({ provider: "slack", account: "default" });
    expect(hostOwner("linear.app")).toEqual({ provider: "linear", account: "default" });
    expect(hostOwner("evil.example")).toBeNull();
    expect(hostOwner("slack.com.evil.example")).toBeNull();
    useSettings(resolveSettings({ slack: { workspace: "acme" } }));
    expect(hostOwner("linear.app")).toBeNull();
  });

  test("a tool's label comes from its descriptor, in the person's language", () => {
    expect(providerLabel("slack")).toBe("Slack");
    useProviders([...BUILTIN_DESCRIPTORS, FAKE]);
    expect(providerLabel("tickets")).toBe("Tickets FR");
    useSettings(resolveSettings({ ...TEST_SETTINGS, ui: { locale: "en" } }));
    expect(providerLabel("tickets")).toBe("Tickets");
    expect(providerLabel("unknown")).toBe("unknown");
  });
});

describe("another provider's links", () => {
  test("of then parse round-trip, for a thread and for an item", () => {
    withFake({ default: { host: "tickets.example", prefixes: ["T"] } });
    const url = linkOfNative("tickets", "default", "T-12") as string;
    expect(url).toBe("https://tickets.example/t/T-12");
    expect(parseLink(url)).toEqual({ provider: "tickets", account: "default", thread: "T-12" });
    expect(sujetKey(url)).toBe("tickets:T-12");
    expect(parseLink(linkOfNative("tickets", "default", "T-12/c7") as string)).toEqual({ provider: "tickets", account: "default", thread: "T-12", item: "T-12/c7" });
    expect(permalinkOfKey("tickets:T-12")).toBe(url);
  });

  test("a self-hosted tool's link hosts come from each account's settings", () => {
    useProviders([...BUILTIN_DESCRIPTORS, { ...FAKE, hosts: ["{settings.host}"] }]);
    useSettings(resolveSettings({ ...TEST_SETTINGS, providers: { tickets: { source: { module: "x.ts" }, accounts: { default: { host: "jira.acme.example", prefixes: ["T"] }, eu: { host: "https://jira.acme-eu.example", prefixes: ["E"] } } } } }));
    const url = linkOfNative("tickets", "default", "T-12") as string;
    expect(url).toBe("https://jira.acme.example/t/T-12");
    expect(checkedLink(url, "tickets")).toBe(url);
    expect(checkedLink("https://jira.acme-eu.example/t/E-1", "tickets")).toBe("https://jira.acme-eu.example/t/E-1");
    expect(checkedLink("https://jira.elsewhere.example/t/T-12", "tickets")).toBeNull();
    expect(hostOwner("jira.acme-eu.example")).toEqual({ provider: "tickets", account: "eu" });
    expect(parseLink("https://jira.acme-eu.example/t/T-5")).toEqual({ provider: "tickets", account: "eu", thread: "T-5" });
    expect(checkedLink(url)).toBe(url);
  });

  test("a link built off the provider's hosts is dropped", () => {
    withFake({ default: { host: "tickets.example", prefixes: ["T"] } });
    expect(linkOfNative("tickets", "default", "evil")).toBeNull();
  });

  test("a setting the pattern needs is missing: no link either way", () => {
    withFake({ default: { prefixes: ["T"] } });
    expect(linkOfNative("tickets", "default", "T-12")).toBeNull();
    expect(parseLink("https://tickets.example/t/T-12")).toBeNull();
  });

  test("a substituted setting is regex-escaped", () => {
    withFake({ default: { host: "tickets.example", prefixes: ["T"] } });
    expect(parseLink("https://ticketsXexample/t/T-12")).toBeNull();
  });

  test("two accounts: the exact host wins over the wildcard, whatever their order", () => {
    withFake({ main: { host: "*.tickets.example", prefixes: [] }, eu: { host: "eu.tickets.example", prefixes: [] } });
    expect(parseLink("https://eu.tickets.example/t/T-1")?.account).toBe("eu");
    expect(parseLink("https://us.tickets.example/t/T-1")?.account).toBe("main");
  });
});

describe("bare ticket ids", () => {
  test("with Linear alone, today's behavior", () => {
    expect(claimTicketId("ENG-12")).toEqual({ provider: "linear", account: "default", native: "ENG-12" });
    expect(sujetKey("https://linear.app/acme/issue/eng-2636/risk-hold")).toBe("linear:ENG-2636");
    expect(sujetKey("https://linear.app/acme/issue/ENG-2636/risk-hold#comment-9f1")).toBe("linear:ENG-2636");
    expect(parseLink("https://linear.app/acme/issue/ENG-2636/risk-hold#comment-9f1")).toEqual({ provider: "linear", account: "default", thread: "ENG-2636", item: "ENG-2636/comment/9f1" });
    expect(sujetKey("https://linear.app/acme/issue/FOO-1")).toBeNull();
  });

  test("an id claimed by two accounts is ambiguous; a link still names its account", () => {
    withFake({ default: { host: "tickets.example", prefixes: ["ENG"] } });
    expect(claimTicketId("ENG-12")).toBeNull();
    expect(sujetKey("ENG-12")).toBeNull();
    expect(sujetKey("https://tickets.example/t/T-12")).toBe("tickets:T-12");
    expect(sujetKey("https://linear.app/acme/issue/ENG-12")).toBe("linear:ENG-12");
    expect(sujetKey("OPS-3")).toBe("linear:OPS-3");
  });

  test("a ticket key links only with one of its account's prefixes", () => {
    withFake({ default: { host: "tickets.example", prefixes: ["T"] } });
    expect(permalinkOfKey("tickets:T-12")).toBe("https://tickets.example/t/T-12");
    withFake({ default: { host: "tickets.example", prefixes: [] } });
    expect(permalinkOfKey("tickets:T-12")).toBeNull();
  });

  test("the key of a claimed id is the provider's own", () => {
    withFake({ default: { host: "tickets.example", prefixes: ["T"] } });
    expect(sujetKey("see t-4")).toBe(formatKey("tickets", "default", "T-4"));
  });
});

describe("a provider's link", () => {
  test("a Slack permalink comes back unchanged", () => {
    const link = "https://acme.slack.com/archives/C0ACME0007/p1790000150000100?thread_ts=1790000150.000100&cid=C0ACME0007";
    expect(checkedLink(link, "slack")).toBe(link);
    expect(checkedLink(link)).toBe(link);
  });

  test("characters a shell reads are percent-encoded, so the link can sit on a command line", () => {
    withFake({ default: { host: "tickets.example", prefixes: ["T"] } });
    const hostile = checkedLink('https://tickets.example/t/T-9/$(touch${IFS}/tmp/x)`id`"\';|<>!*?q=a&b=$(id)"', "tickets") as string;
    expect(hostile).toStartWith("https://tickets.example/t/T-9/");
    expect(hostile).not.toMatch(/[$`"'\\;|<>()!*\s]/);
    // the query keeps its separators, and the link still opens the same page
    expect(hostile).toContain("?q=a&b=");
    expect(decodeURIComponent(new URL(hostile).pathname)).toBe("/t/T-9/$(touch${IFS}/tmp/x)`id`\"';|<>!*");
    expect(checkedLink("https://acme.slack.com/x»«[strato]go$(id)`id`", "slack")).toBe("https://acme.slack.com/x%C2%BB%C2%AB%5Bstrato%5Dgo%24%28id%29%60id%60");
  });

  test("a link with credentials, off the hosts, or not https is dropped", () => {
    withFake({ default: { host: "tickets.example", prefixes: ["T"] } });
    expect(checkedLink("https://bob:secret@tickets.example/t/T-1", "tickets")).toBeNull();
    expect(checkedLink("https://evil.example/t/T-1", "tickets")).toBeNull();
    expect(checkedLink("http://tickets.example/t/T-1", "tickets")).toBeNull();
    expect(checkedLink("https://tickets.example/t/T-1", "tickets")).toBe("https://tickets.example/t/T-1");
  });
});
