/**
 * The board's words per role (core/i18n.ts roleT, core/roles.ts speaksCode): block titles, empty states and task
 * labels follow the person's job, and a role other than developer sees no delivery words without a forge.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type BoardInput, boardView, buildBoard, gateLabel, taskKindLabel } from "./board.ts";
import { DICTIONARIES, roleT } from "./core/i18n.ts";
import { isRole, ROLE_PROPOSALS, ROLES } from "./core/roles.ts";
import { type Settings, useSettings } from "./core/settings.ts";
import type { Sujet } from "./core/sujet.ts";
import { TEST_SETTINGS } from "./test-setup.ts";

afterEach(() => useSettings(TEST_SETTINGS));

/** The test profile with another role, forge and locale. */
const withRole = (role: string | undefined, o: { forge?: boolean; locale?: "en" | "fr" } = {}): Settings => {
  const s: Settings = { ...TEST_SETTINGS, owner: role === undefined ? { name: "Alice" } : { name: "Alice", role }, forge: o.forge === false ? null : TEST_SETTINGS.forge, ui: { ...TEST_SETTINGS.ui, locale: o.locale ?? "en" } };
  useSettings(s);
  return s;
};

describe("board words per role", () => {
  const draftTopic = (key: string, letter: string, gate: string): Sujet =>
    ({
      key,
      threads: [key],
      letter,
      title: `Topic ${letter}`,
      channel: "#acme-requests",
      permalink: "https://acme.slack.com/archives/C0ACMEREQ01/p1790000000000100",
      asker: "Bob",
      sessionId: null,
      shortId: null,
      name: `acme · Bob · ${letter}`,
      status: "gate",
      gate,
      waiting: "",
      next: "",
      summary: "",
      createdAt: "2026-09-21T08:00:00Z",
      updatedAt: "2026-09-21T08:00:00Z",
      history: [],
      tasks: [{ id: "t1", kind: gate === "draft" ? "draft" : "decision", ask: "a request", proposal: "a proposal", action: "post the draft", draft: gate === "draft" ? "Hello." : "", draftTo: gate === "draft" ? "#acme-requests" : "", createdAt: "2026-09-21T08:00:00Z", updatedAt: "2026-09-21T08:00:00Z", status: "open", origin: "task" }],
    }) as never;
  const input = (sujets: Sujet[]): BoardInput => ({
    sujets,
    events: [],
    live: new Map(),
    running: new Map(),
    sessions: [{ sessionId: "sess-x", name: "acme-api", status: "idle", kind: "interactive", cwd: "/Users/alice/dev/acme", branch: "feat/export", startedAt: "2026-09-21T09:00:00Z", context: null }],
    otherSessions: 0,
    now: new Date("2026-09-21T12:00:00Z"),
    timeOf: (iso: string) => iso.slice(11, 16),
    lastTick: "2026-09-21T11:58:00Z",
  });
  const render = (sujets: Sujet[]) => boardView(buildBoard(input(sujets)), { timeOf: (iso: string) => iso.slice(11, 16), now: Date.parse("2026-09-21T12:00:00Z"), readAt: "12:00" });
  const both = [draftTopic("C0ACMEREQ01:1790000000.000100", "A", "draft"), draftTopic("C0ACMEREQ01:1790001000.000100", "B", "decision")];

  test("block titles and empty states follow the role, in English and in French", () => {
    withRole("developer");
    expect(render(both)).toContain("Just a go");
    expect(render([])).toContain("Nothing is waiting on you.");
    withRole("support");
    expect(render(both)).toContain("Answers ready to send");
    expect(render([])).toContain("No customer is waiting on your answer.");
    withRole("manager");
    const m = render(both);
    expect(m).toContain("Ready to approve");
    expect(m).toContain("Your calls");
    withRole("manager", { locale: "fr" });
    expect(render(both)).toContain("Tes arbitrages");
    withRole("support", { locale: "fr" });
    expect(render(both)).toContain("Réponses prêtes à partir");
  });

  test("a role changes only the words it names; the rest is the shared wording", () => {
    withRole("operations");
    expect(taskKindLabel("draft")).toBe("review the update");
    expect(gateLabel("draft")).toBe("review the update");
    expect(gateLabel("decision")).toBe("decide");
    expect(roleT("board.bloc.decision.title")).toBe("A decision");
    withRole("developer");
    expect(taskKindLabel("draft")).toBe("review the draft");
  });

  test("without a forge, another role's board names no merge request, branch or production", () => {
    withRole("support", { forge: false });
    const html = render(both);
    expect(html).toContain("Slack, closed topics, tickets)");
    expect(html).not.toContain("merge requests");
    expect(html).not.toContain("feat/export");
    expect(gateLabel("merge")).toBe("your go");
    expect(gateLabel("release")).toBe("your go");
    // with a forge, the same role sees delivery words again
    withRole("support");
    expect(render(both)).toContain("feat/export");
    expect(gateLabel("merge")).toBe("go merge");
  });

  test("a developer without a forge keeps today's wording", () => {
    withRole(undefined, { forge: false });
    const html = render(both);
    expect(html).toContain("tickets, merge requests");
    expect(html).toContain("feat/export");
    expect(gateLabel("release")).toBe("go prod");
  });

  test("every role's strings exist in both locales, with a name, a description and the sentence of each proposal", () => {
    for (const r of ROLES) {
      expect(DICTIONARIES.en[`role.${r}.name`]).toBeTruthy();
      expect(DICTIONARIES.fr[`role.${r}.what`]).toBeTruthy();
      for (const p of ROLE_PROPOSALS[r]) {
        expect(DICTIONARIES.en[p.says]).toContain(p.setting);
        expect(DICTIONARIES.fr[p.says]).toContain(p.setting);
      }
    }
    // every role key names a shipped role and a key the board already has
    for (const k of Object.keys(DICTIONARIES.en).filter((x) => x.startsWith("role."))) {
      const [, r, ...rest] = k.split(".");
      expect(isRole(r), k).toBe(true);
      const base = rest.join(".");
      if (base.startsWith("board.")) expect(base in DICTIONARIES.en, k).toBe(true);
    }
  });
});
