/**
 * Shared test profile: a realistic installation, so that the links, tickets and MRs of the fixtures resolve.
 * Tests of the default policy and of an empty profile set their own profile.
 *
 * Every fixture lives in one fictional universe, keep new ones inside it:
 * - company "Acme", Slack workspace acme.slack.com (team name "Acme", team id T0ACME0000, app id A0ACME00001);
 * - the person Strato serves is "Alice" (Slack id UME in the profile, "Alice Martin" as a display name);
 * - teammates behind the group @acme-eng: Bob, Carol (Carol Smith), Dave, Erin;
 * - other colleagues who ask or answer: Grace (compliance), Heidi, Ivan, Judy, Mallory, Niaj, Oscar, Trent, Zoé
 *   (Zoé Laurent, kept accented for accent-insensitive search), plus external askers Peter and Gary;
 * - channels #acme-requests, #acme-support, #acme-compliance, #acme-exec, #acme-risk, #acme-helpdesk, #sales;
 *   ids C0ACME0001… and 11-character ones such as C0ACMEREQ01, DMs D0ACME0001…, users U0GRACE0001…;
 * - Linear workspace "acme", prefixes ENG and OPS (ENG-12, OPS-262);
 * - GitLab repos acme/api ("api", the default) and acme/web ("web", alias "monorepo", MR numbers from 2000);
 * - fictional companies and vendors in the stories: Initech, Globex, Umbrella, Hooli, Vigil.
 */
import { resolveSettings, useSettings } from "./core/settings.ts";

export const TEST_SETTINGS = resolveSettings({
  owner: { name: "Alice" },
  workspace: "/Users/alice/dev/acme",
  slack: { team: "Acme", workspace: "acme", me: "UME", subteams: ["SGRP"], teamAlias: "@acme-eng", teammates: ["Bob", "Carol Smith", "Dave", "Erin"] },
  tracker: { kind: "linear", workspace: "acme", prefixes: ["ENG", "OPS"] },
  forge: {
    kind: "gitlab",
    host: "gitlab.com",
    repos: { api: "acme/api", web: "acme/web" },
    aliases: { monorepo: "web" },
    iidRanges: [{ from: 2000, repo: "web" }],
    defaultRepo: "api",
  },
  // the fixtures predate the English default: they read the French board; i18n.test.ts covers English
  ui: { iterm: true, locale: "fr" },
});

useSettings(TEST_SETTINGS);
