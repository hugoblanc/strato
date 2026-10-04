import { afterEach, describe, expect, test } from "bun:test";
import { TEST_SETTINGS } from "./test-setup.ts";
import {
  citations,
  DEFAULT_SETTINGS,
  linearIssueId,
  missingSettings,
  mrRefs,
  mrStage,
  type MrState,
  ownerForms,
  permalinkOfKey,
  resolveSettings,
  sujetKey,
  ticketUrl,
  useSettings,
} from "./lib.ts";

afterEach(() => useSettings(TEST_SETTINGS));

describe("reading config.json", () => {
  test("an empty file gives the default profile, without tracker or forge", () => {
    const s = resolveSettings({});
    expect(s).toEqual(DEFAULT_SETTINGS);
    expect(s.tracker).toBeNull();
    expect(s.forge).toBeNull();
    expect(s.workers.skipPermissions).toBe(false);
  });

  test("the old flat format becomes the slack section, skipPermissions moves into workers", () => {
    const s = resolveSettings({ team: "Acme", me: "U1", subteams: ["S1"], watchChannels: ["C1"], ignoreChannels: [], teammates: ["Bob"], skipPermissions: true, slackAppId: "A1", interval: 30 });
    expect(s.slack).toMatchObject({ team: "Acme", me: "U1", subteams: ["S1"], watchChannels: ["C1"], teammates: ["Bob"], appId: "A1", pollInterval: 30 });
    expect(s.workers.skipPermissions).toBe(true);
  });

  test("a partial section keeps the defaults of the missing fields", () => {
    const s = resolveSettings({ slack: { me: "U2" }, forge: { repos: { api: "acme/api" } } });
    expect(s.slack.me).toBe("U2");
    expect(s.slack.pollInterval).toBe(60);
    expect(s.ui.port).toBe(4343);
    expect(s.forge).toMatchObject({ kind: "gitlab", host: "gitlab.com", integrationBranch: "dev", releaseBranch: "main", repos: { api: "acme/api" } });
  });

  test("the new format's section wins over a flat key left in the file", () => {
    expect(resolveSettings({ me: "U_OLD", slack: { me: "U_NEW" } }).slack.me).toBe("U_NEW");
  });

  test("doctor says what is missing", () => {
    expect(missingSettings(resolveSettings({}))).toEqual([
      "slack.team (workspace name returned by auth.test)",
      "slack.workspace (subdomain <workspace>.slack.com)",
      "slack.me (your Slack id U…)",
      "owner.name (your first name, read in the prompts and on the board)",
    ]);
    expect(missingSettings(TEST_SETTINGS)).toEqual([]);
  });

  test("first name elision", () => {
    expect(ownerForms("Alice")).toEqual({ owner: "Alice", d_owner: "d'Alice", qu_owner: "qu'Alice" });
    expect(ownerForms("Marie")).toEqual({ owner: "Marie", d_owner: "de Marie", qu_owner: "que Marie" });
    expect(ownerForms("Émile").d_owner).toBe("d'Émile");
  });
});

describe("an installation without a tracker", () => {
  test("no text is taken for a ticket, and a thread key stays readable", () => {
    useSettings(resolveSettings({ slack: { workspace: "acme" } }));
    expect(linearIssueId("voir OPS-12")).toBeNull();
    expect(sujetKey("OPS-12")).toBeNull();
    expect(sujetKey("linear:OPS-12")).toBe("linear:OPS-12");
    expect(ticketUrl("OPS-12")).toBeNull();
    expect(permalinkOfKey("linear:OPS-12")).toBeNull();
    expect(permalinkOfKey("C1:1790000000.000100")).toBe("https://acme.slack.com/archives/C1/p1790000000000100");
    expect(citations("OPS-12 et https://acme.slack.com/archives/C1/p1790000000000100").linear).toEqual([]);
  });

  test("the prefixes come from the profile", () => {
    useSettings(resolveSettings({ tracker: { workspace: "acme", prefixes: ["ENG"] } }));
    expect(linearIssueId("voir eng-7 et OPS-12")).toBe("ENG-7");
    expect(ticketUrl("ENG-7")).toBe("https://linear.app/acme/issue/ENG-7");
    expect(citations("ENG-7, OPS-12").linear).toEqual(["ENG-7"]);
  });
});

describe("an installation with another forge", () => {
  const forge = { kind: "gitlab" as const, host: "git.acme.io", repos: { api: "acme/api", web: "acme/web" }, aliases: { front: "web" }, iidRanges: [{ from: 500, repo: "web" }], defaultRepo: "api", integrationBranch: "develop", releaseBranch: "master" };

  test("without a forge, no topic has an MR", () => {
    useSettings(resolveSettings({}));
    expect(mrRefs({ mrs: "legacy!1042 | !2671" })).toEqual([]);
  });

  test("repos, aliases, links and number ranges come from the profile", () => {
    useSettings(resolveSettings({ forge }));
    expect(mrRefs({ mrs: "api!12 | front!7", summary: "voir https://git.acme.io/acme/web/-/merge_requests/33" })).toEqual([
      { repo: "web", iid: 33 },
      { repo: "api", iid: 12 },
      { repo: "web", iid: 7 },
    ]);
    expect(mrRefs({ next: "merger !612 puis !40" })).toEqual([
      { repo: "web", iid: 612 },
      { repo: "api", iid: 40 },
    ]);
    expect(mrRefs({ mrs: "legacy!1042" })).toEqual([]);
  });

  test("the integration and release branches come from the profile", () => {
    useSettings(resolveSettings({ forge }));
    const mr: MrState = { repo: "api", iid: 1, title: "", url: "", state: "merged", draft: false, target: "develop", mergedAt: "2026-09-20T10:00:00Z", mergeStatus: "", pipeline: null };
    expect(mrStage(mr, []).blocker).toBe("waiting for the develop → master release");
    expect(mrStage(mr, ["2026-09-21T10:00:00Z"]).stage).toBe("prod");
    expect(mrStage({ ...mr, target: "master" }, []).stage).toBe("prod");
  });
});
