/**
 * Roles for people who are not developers (core/roles.ts, docs/design/providers.md sections 14 and 15, roles): the
 * role a profile resolves to, the fragments each role adds to the prompts, the template of a ticket opened by id, the
 * settings each role proposes and what triage does with them, and doctor's role line.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, type Config } from "./chat/slack-model.ts";
import { DEFAULT_ROLE, isRole, type Role, ROLE_PROPOSALS, ROLES, roleOf, roleSections, speaksCode, ticketTemplateOf } from "./core/roles.ts";
import { profileErrors } from "./core/setup.ts";
import { resolveSettings, type Settings, useSettings } from "./core/settings.ts";
import { cardStyle, EMBEDDED_ROLES, followUpMessage, POLICY_TEMPLATES, refreshMessage, roleRule, roleVars, shadowedPolicyNames, ticketPrompt, usePolicyDirs, workerPrompt } from "./policy/prompts.ts";
import { cleanupRigs, cli, rig, SCRIPTS } from "./test-rig.ts";
import { TEST_SETTINGS } from "./test-setup.ts";

afterEach(() => {
  cleanupRigs();
  useSettings(TEST_SETTINGS);
  usePolicyDirs([]);
});


const NON_DEV = ROLES.filter((r) => r !== "developer") as Exclude<Role, "developer">[];
/** The test profile with another role, forge and locale. */
const withRole = (role: string | undefined, o: { forge?: boolean; locale?: "en" | "fr" } = {}): Settings => {
  const s: Settings = { ...TEST_SETTINGS, owner: role === undefined ? { name: "Alice" } : { name: "Alice", role }, forge: o.forge === false ? null : TEST_SETTINGS.forge, ui: { ...TEST_SETTINGS.ui, locale: o.locale ?? "en" } };
  useSettings(s);
  return s;
};

const KEY = "C0ACME0001:1759219200.000100";
const T = { from: "Bob", channel: "#acme-requests", text: "can you check?", permalink: "https://acme.slack.com/archives/C0ACME0001/p1759219200000100" };
const everyPrompt = () => [
  workerPrompt("Checkout", KEY, T, "/s/strato.ts", "/r.md", ["Bob"]),
  ticketPrompt("Checkout", "linear:ENG-12", "ENG-12", "https://linear.app/acme/issue/ENG-12", "/s/strato.ts", "/r.md"),
  followUpMessage("suite", T, "/s/strato.ts", KEY, ["Bob"]),
  followUpMessage("suite", { ...T, from: "Carol" }, "/s/strato.ts", KEY, ["Bob"]),
  followUpMessage("moi", T, "/s/strato.ts", KEY),
  refreshMessage(["stale"], "/s/strato.ts", KEY),
];

describe("role resolution", () => {
  test("developer when owner.role is absent, in the current and the legacy flat format", () => {
    expect(DEFAULT_ROLE).toBe("developer");
    expect(roleOf(resolveSettings({ owner: { name: "Alice" } }))).toBe("developer");
    expect(roleOf(resolveSettings({ team: "Acme", me: "U1" }))).toBe("developer");
    expect(roleOf(resolveSettings({}))).toBe("developer");
  });

  test("a shipped role is kept; anything else reads as developer, and validation refuses it", () => {
    for (const r of ROLES) {
      expect(roleOf(resolveSettings({ owner: { name: "Alice", role: r } }))).toBe(r);
      expect(profileErrors({ owner: { name: "Alice", role: r } })).toEqual([]);
    }
    expect(isRole("sales")).toBe(false);
    expect(roleOf(resolveSettings({ owner: { role: "sales" } }))).toBe("developer");
    expect(profileErrors({ owner: { role: "sales" } })).toEqual([`owner.role: "sales" is not one of ${ROLES.join(", ")}`]);
    expect(profileErrors({ owner: { role: 3 } })[0]).toContain("owner.role: expected string");
  });

  test("a ticket opened by id is implemented by a developer and handled by every other role", () => {
    expect(ticketTemplateOf("developer")).toBe("ticket");
    for (const r of NON_DEV) expect(ticketTemplateOf(r)).toBe("worker");
  });

  test("code words: always for a developer, for another role only with a forge", () => {
    expect(speaksCode(withRole(undefined, { forge: false }))).toBe(true);
    expect(speaksCode(withRole("support", { forge: false }))).toBe(false);
    expect(speaksCode(withRole("support"))).toBe(true);
  });

  test("a role file's sections: rules and tone, case-insensitive headings, the rest ignored", () => {
    expect(roleSections("# Title\nintro\n## Rules\n- a\n- b\n\n## tone\nwarm\n## other\nx")).toEqual({ rules: "- a\n- b", tone: "warm" });
    expect(roleSections("nothing")).toEqual({ rules: "", tone: "" });
  });
});

describe("prompts per role", () => {
  test("the developer role renders exactly the prompts of a profile without a role", () => {
    withRole(undefined);
    const before = everyPrompt();
    withRole("developer");
    expect(everyPrompt()).toEqual(before);
    expect(roleVars()).toEqual({ role_rules: "", role_tone: "" });
    expect(roleRule("worker")).toBe("");
  });

  test("every shipped role renders every template, with its rules in the worker and ticket prompts and its tone in the card rules", () => {
    for (const r of NON_DEV) {
      withRole(r);
      const v = roleVars();
      expect(v.role_rules, r).toContain("Alice");
      expect(v.role_tone, r).not.toBe("");
      const [worker, ticket, ...rest] = everyPrompt();
      for (const p of [worker, ticket, ...rest]) expect(p, r).not.toMatch(/\{\{|\}\}/);
      expect(worker).toContain(v.role_rules);
      expect(ticket).toContain(v.role_rules);
      expect(worker).toContain(`- Tone of every draft: ${v.role_tone}`);
      expect(cardStyle()).toContain(v.role_tone);
      // the shipped templates read the fragments: nothing appended twice by the code
      expect(roleRule("worker")).toBe("");
      expect(worker.split(v.role_rules).length).toBe(2);
    }
  });

  test("every role file is embedded, and the embedded copy is the file on disk", () => {
    for (const r of NON_DEV) expect(EMBEDDED_ROLES[r]).toBe(readFileSync(join(SCRIPTS, "policy/defaults/roles", `${r}.md`), "utf8"));
    expect(EMBEDDED_ROLES.developer).toBeUndefined();
    for (const text of Object.values(EMBEDDED_ROLES)) expect(text).not.toContain("\u2014");
  });

  test("a role file in <state>/policy/roles/ wins over the shipped one, and may name the owner", () => {
    const dir = mkdtempSync(join(tmpdir(), "strato-roles-"));
    mkdirSync(join(dir, "roles"));
    writeFileSync(join(dir, "roles", "support.md"), "## rules\n{{owner}} answers customers of the Acme store first.\n## tone\nInformal.\n");
    usePolicyDirs([dir]);
    withRole("support");
    expect(roleVars()).toEqual({ role_rules: "Alice answers customers of the Acme store first.", role_tone: "Informal." });
    expect(workerPrompt("x", KEY, T, "/s/strato.ts", "/r.md")).toContain("Alice answers customers of the Acme store first.");
    // a developer may add rules of their own the same way
    writeFileSync(join(dir, "roles", "developer.md"), "## rules\nAlways run the linter.\n");
    withRole("developer");
    expect(workerPrompt("x", KEY, T, "/s/strato.ts", "/r.md")).toContain("Always run the linter.");
  });

  test("an unknown variable in a role file is an error, as in a template", () => {
    const dir = mkdtempSync(join(tmpdir(), "strato-roles-"));
    mkdirSync(join(dir, "roles"));
    writeFileSync(join(dir, "roles", "manager.md"), "## rules\n{{boss}} decides.\n");
    usePolicyDirs([dir]);
    withRole("manager");
    expect(() => workerPrompt("x", KEY, T, "/s/strato.ts", "/r.md")).toThrow("roles/manager.md: unknown variable {{boss}}");
  });

  test("an override written before roles still gets the role's rules and tone, appended by the code", () => {
    const dir = mkdtempSync(join(tmpdir(), "strato-roles-"));
    writeFileSync(join(dir, "worker.md"), "Old worker for {{owner}}: {{text}}");
    writeFileSync(join(dir, "card-style.md"), "Old card rules.");
    usePolicyDirs([dir]);
    withRole("support");
    const v = roleVars();
    const p = workerPrompt("x", KEY, T, "/s/strato.ts", "/r.md");
    expect(p.startsWith("Old worker for Alice")).toBe(true);
    expect(p).toContain(`\n\n${v.role_rules}\n\nTone of every draft: ${v.role_tone}\n\nSecurity:`);
    // the developer role appends nothing to an override
    withRole("developer");
    expect(workerPrompt("x", KEY, T, "/s/strato.ts", "/r.md")).not.toContain("Tone of every draft");
  });

  test("a policy variable named like a role fragment does not replace it", () => {
    useSettings({ ...TEST_SETTINGS, owner: { name: "Alice", role: "support" }, policy: { role_rules: "hijacked", role_tone: "hijacked" } });
    expect(shadowedPolicyNames({ role_rules: "x", role_tone: "y", mine: "z" })).toEqual(["role_rules", "role_tone"]);
    expect(workerPrompt("x", KEY, T, "/s/strato.ts", "/r.md")).not.toContain("hijacked");
    expect(POLICY_TEMPLATES).toContain("worker");
  });

  test("policy-default roles/<role> prints a role's shipped fragments", async () => {
    const r = rig();
    const res = await cli(r, ["policy-default", "roles/support"]);
    expect(res.code).toBe(0);
    expect(res.out).toBe(EMBEDDED_ROLES.support as string);
    expect((await cli(r, ["policy-default", "roles/developer"])).code).not.toBe(0);
  });
});

describe("triage emphasis per role", () => {
  const cfg = (o: Partial<Config> = {}): Config => ({ team: "Acme", workspace: "acme", me: "U0ALICE0001", subteams: ["S0ACMEOPS"], watchChannels: [], ignoreChannels: [], ignoreAuthors: [], teammates: [], ...o }) as Config;
  const msg = (channel: string, text: string, user = "U0DANA0001") => ({ channel: { id: channel, name: channel }, ts: "1759219200.000100", user, text, permalink: `https://acme.slack.com/archives/${channel}/p1759219200000100` }) as never;
  const none = new Set<string>();
  /** The settings a role proposes, accepted with fictional values: the customer channel, the alert bot. */
  const applied = (role: Role): Config => {
    const set = ROLE_PROPOSALS[role].map((p) => p.setting);
    return cfg({ watchChannels: set.includes("slack.watchChannels") ? ["C0ACMECUS01"] : [], ignoreAuthors: set.includes("slack.ignoreAuthors") ? ["Acme Alerts"] : [] });
  };

  test("each proposal gives the kinds the interview describes", () => {
    // support and account manager: a customer's message in the shared channel is a request, without a mention
    for (const r of ["support", "account-manager"] as const) expect(classify(msg("C0ACMECUS01", "the export fails"), applied(r), none, none, "Dana"), r).toBe("canal");
    // without the proposal, the same message raises nothing
    expect(classify(msg("C0ACMECUS01", "the export fails"), cfg(), none, none, "Dana")).toBeNull();
    // operations: the alert bot goes to the digest, even when it mentions the person's group
    expect(classify(msg("C0ACMEINC01", "<!subteam^S0ACMEOPS> disk at 91%", "U0ALERTS01"), applied("operations"), none, none, "Acme Alerts")).toBe("bot");
    expect(classify(msg("C0ACMEINC01", "<!subteam^S0ACMEOPS> disk at 91%", "U0ALERTS01"), cfg(), none, none, "Acme Alerts")).toBe("mention");
    // manager and developer propose nothing: today's rules
    expect(ROLE_PROPOSALS.manager).toEqual([]);
    expect(ROLE_PROPOSALS.developer).toEqual([]);
    expect(classify(msg("C0ACMECUS01", "the export fails"), applied("manager"), none, none, "Dana")).toBeNull();
  });
});

describe("doctor and open per role", () => {
  test("doctor prints nothing about the role of a developer, and warns on a role it does not know", async () => {
    const r = rig();
    expect((await cli(r, ["doctor"])).out).not.toContain("role");
    writeFileSync(join(r.state, "config.json"), JSON.stringify({ owner: { name: "Alice", role: "sales" }, slack: { team: "Acme", workspace: "acme", me: "UALICE" } }));
    expect((await cli(r, ["doctor"])).out).toContain('owner.role "sales" is not a role Strato knows');
  });

  test("open <ticket>: the implementation prompt for a developer, the worker prompt for another role", async () => {
    for (const [role, expected, absent] of [
      [undefined, "implement the ticket up to a merge request", "Triggering message"],
      ["support", "Triggering message", "implement the ticket"],
    ] as const) {
      const r = rig();
      writeFileSync(join(r.state, "config.json"), JSON.stringify({ owner: { name: "Alice", ...(role ? { role } : {}) }, slack: { team: "Acme", workspace: "acme", me: "UALICE" }, tracker: { kind: "linear", workspace: "acme", prefixes: ["ENG"] } }));
      const res = await cli(r, ["open", "linear:ENG-12"]);
      expect(res.code, res.err).toBe(0);
      const spawned = existsSync(join(r.dir, "spawns.log")) ? readFileSync(join(r.dir, "spawns.log"), "utf8") : "";
      expect(spawned, String(role)).toContain(expected);
      expect(spawned, String(role)).not.toContain(absent);
    }
  });
});
