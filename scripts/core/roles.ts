/**
 * The person's job (`owner.role`, docs/design/providers.md section 14). A role changes what sessions are told (the
 * fragments of `policy/roles/<role>.md`), how the board names things, what the setup interview proposes, and the demo.
 * It never changes triage rules, the gate, shadow mode, the CLI, or the master protocol.
 * Developer is the default: a profile without `owner.role` behaves exactly as before roles existed.
 */
import type { PolicyTemplate } from "../policy/prompts.ts";
import { type Settings, settings } from "./settings.ts";

/** The roles Strato ships, the default first. Each one serves people whose requests reach them through a built-in tool. */
export const ROLES = ["developer", "support", "operations", "account-manager", "manager"] as const;
export type Role = (typeof ROLES)[number];
export const DEFAULT_ROLE: Role = "developer";

export const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);

/** The role of a profile: `owner.role` when it names a shipped role, else developer (validation refuses anything else). */
export const roleOf = (s: Settings = settings()): Role => (isRole(s.owner.role) ? s.owner.role : DEFAULT_ROLE);

/**
 * Whether the board speaks of code delivery (merge requests, branches, production): for the developer role, whatever
 * the profile says, as before roles existed; for every other role, only once a forge is configured.
 */
export const speaksCode = (s: Settings = settings()): boolean => roleOf(s) === "developer" || s.forge !== null;

/**
 * The template of a topic opened from a ticket id alone (`open PLAT-12`): the implementation flow up to a merge request
 * for a developer; for every other role a ticket is a request to handle, so the worker flow.
 */
export const ticketTemplateOf = (role: Role): PolicyTemplate => (role === "developer" ? "ticket" : "worker");

/** One setting the interview proposes for a role, with the sentence (an i18n key) that says what it changes. */
export interface RoleProposal {
  /** The dotted path in config.json. */
  setting: "slack.watchChannels" | "slack.ignoreAuthors";
  /** The sentence the person reads before accepting: the setting and its consequence. */
  says: "role.support.propose.watchChannels" | "role.operations.propose.ignoreAuthors" | "role.account-manager.propose.watchChannels";
}

/**
 * The default triage emphasis of each role: settings proposed by the interview (and `setup --role`), which the person
 * accepts or not. Triage code is the same for everyone; these only fill the settings it already reads.
 */
export const ROLE_PROPOSALS: Record<Role, RoleProposal[]> = {
  developer: [],
  support: [{ setting: "slack.watchChannels", says: "role.support.propose.watchChannels" }],
  operations: [{ setting: "slack.ignoreAuthors", says: "role.operations.propose.ignoreAuthors" }],
  "account-manager": [{ setting: "slack.watchChannels", says: "role.account-manager.propose.watchChannels" }],
  manager: [],
};

/**
 * The fragments of a role file (`## rules` and `## tone`), each trimmed; a section that is absent is empty. Headings
 * are matched case-insensitively, so a French override may write `## Rules`; any other section is ignored.
 */
export function roleSections(text: string): { rules: string; tone: string } {
  const out = { rules: "", tone: "" };
  let current: "rules" | "tone" | null = null;
  const lines: Record<"rules" | "tone", string[]> = { rules: [], tone: [] };
  for (const line of text.split("\n")) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      const name = h[1].toLowerCase();
      current = name === "rules" || name === "tone" ? name : null;
      continue;
    }
    if (current) lines[current].push(line);
  }
  out.rules = lines.rules.join("\n").trim();
  out.tone = lines.tone.join("\n").trim();
  return out;
}
