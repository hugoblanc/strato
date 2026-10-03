/**
 * The profile of an installation: everything that changes from one person or team to another, read from
 * `<state>/config.json`. The code holds no team value: it reads `settings()`.
 *
 * The file may be partial: every missing section takes its default value, field by field.
 * The legacy flat format (`team`, `me`, `subteams`… at the root) is still read, as the `slack` section.
 */

export interface SlackSettings {
  /** Workspace name as `auth.test` returns it: picks the right token when several are lying around on the machine. */
  team: string;
  /** Slack subdomain (`<workspace>.slack.com`): rebuilt permalinks, and which quoted links are readable. */
  workspace: string;
  /** Slack id of the person served (`U…`). */
  me: string;
  /** User groups (`S…`) whose mention counts as a mention of the person. */
  subteams: string[];
  /** The name of that group as people write it ("@support"): it means "someone from the team", not the person. */
  teamAlias: string;
  /** Channels where every message is a request (`C…`). */
  watchChannels: string[];
  ignoreChannels: string[];
  /** Display names (bots) whose messages outside a tracked topic go to the digest instead of being raised. */
  ignoreAuthors: string[];
  /** Display names of the teammates behind the group: if one of them answers in a thread, the topic no longer waits for the person. */
  teammates: string[];
  /** Id of the Slack app whose xapp- token opens the socket: used by the board's "re-enable events" link. */
  appId: string;
  /** `KEY=value` file to read `SLACK_APP_TOKEN` from when the environment does not provide it. `~` accepted. */
  appTokenFile: string;
  /** Interval of `watch` (fallback polling), in seconds. */
  pollInterval: number;
}

/** The issue tracker. Only Linear is wired: `kind` keeps room for others. */
export interface TrackerSettings {
  kind: "linear";
  /** URL segment of the Linear workspace: `https://linear.app/<workspace>/issue/<id>`. */
  workspace: string;
  /** Team prefixes recognized as tickets in links and texts ("ABC" for ABC-123). */
  prefixes: string[];
}

/** The forge and the path of a merge request (MR) to production. Only GitLab is wired. */
export interface ForgeSettings {
  kind: "gitlab";
  host: string;
  /** Short name used in cards -> project path ("api" -> "acme/api"). */
  repos: Record<string, string>;
  /** Other names of a repository ("monorepo" -> "web"). */
  aliases: Record<string, string>;
  /** Repository of a "!N" quoted without a repository, by number range (the first that fits, `from` included). */
  iidRanges: { from: number; repo: string }[];
  /** Repository of a bare "!N" when no range fits. */
  defaultRepo: string;
  /** Integration branch: an MR merged into it is in production once a release into `releaseBranch` follows. */
  integrationBranch: string;
  releaseBranch: string;
}

/** The sweep of stale cards (core/refresh.ts), and their relaunch with their session. */
export interface RefreshSettings {
  /** Relaunch the spotted cards automatically. False: the board flags them, the relaunch is a button or `refresh`. */
  auto: boolean;
  /** A gate or a wait with no news for this many days is flagged. */
  staleDays: number;
  /** A message that arrived after the card is a signal only past this delay: the master has that long to relay it. */
  graceMinutes: number;
  /** Period of the sweep inside the listener (`listen` or `watch`). */
  everyMinutes: number;
  /** Maximum sessions relaunched at once: each relaunch is a full turn that rereads the thread. */
  maxParallel: number;
}

/** The session collector (core/gc.ts): stop the sessions that have nothing left to do. */
export interface GcSettings {
  /** Period of the collection inside the listener (`listen` or `watch`). 0: never. */
  everyMinutes: number;
  /** A session idle for this many hours is stopped (its card stays, a message resumes it). 0: never. */
  idleHours: number;
}

export interface Settings {
  /** Who Strato serves: their first name appears in the prompts, the cards and the board. */
  owner: { name: string };
  /** Working folder of the topic sessions (cwd, CLAUDE.md, .mcp.json). Empty: derived from the skill's location. */
  workspace: string;
  slack: SlackSettings;
  tracker: TrackerSettings | null;
  forge: ForgeSettings | null;
  workers: {
    /** Start topic sessions with --dangerously-skip-permissions. False by default: a choice to make knowingly. */
    skipPermissions: boolean;
    /** Permission rules added to the base ones (common reads, Slack threads): read-only MCP tools, for instance. */
    allow: string[];
    /**
     * Shadow mode, for the first days: sessions prepare everything and post nothing, the board's Send and Go are off
     * and the server refuses them. `setup --live` turns it off.
     */
    shadow: boolean;
  };
  refresh: RefreshSettings;
  gc: GcSettings;
  /** Free variables of the policy templates (`{{name}}`), on top of those Strato provides. */
  policy: Record<string, string>;
  ui: {
    /** iTerm2 integration: board button, `dive`, sidebar panel. macOS only. */
    iterm: boolean;
    /** Port of the board and the panel on 127.0.0.1: one installation per port when several run on the same machine. */
    port: number;
    /** Open Slack links in the app (slack:// link) rather than in a browser tab that redirects. */
    slackApp: boolean;
    /** Language of what the person served reads (board, and the master's messages to them): "en" or "fr". */
    locale: "en" | "fr";
  };
}

export const DEFAULT_SETTINGS: Settings = {
  owner: { name: "the user" },
  workspace: "",
  slack: {
    team: "",
    workspace: "",
    me: "",
    subteams: [],
    teamAlias: "",
    watchChannels: [],
    ignoreChannels: [],
    ignoreAuthors: [],
    teammates: [],
    appId: "",
    appTokenFile: "",
    pollInterval: 60,
  },
  tracker: null,
  forge: null,
  workers: { skipPermissions: false, allow: [], shadow: false },
  refresh: { auto: true, staleDays: 3, graceMinutes: 20, everyMinutes: 30, maxParallel: 3 },
  gc: { everyMinutes: 60, idleHours: 12 },
  policy: {},
  ui: { iterm: false, port: 4343, slackApp: true, locale: "en" },
};

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

/** The keys of the legacy flat format, and their place in the `slack` section. */
const LEGACY_SLACK: Record<string, keyof SlackSettings> = {
  team: "team",
  me: "me",
  subteams: "subteams",
  watchChannels: "watchChannels",
  ignoreChannels: "ignoreChannels",
  ignoreAuthors: "ignoreAuthors",
  teammates: "teammates",
  slackAppId: "appId",
  interval: "pollInterval",
};

/** Default section completed with what the file gives, field by field; an explicit `null` stays null. */
function section<T extends object>(def: T, raw: unknown): T {
  return isObject(raw) ? ({ ...def, ...raw } as T) : def;
}

/** `config.json` as read (partial, possibly in the legacy format) -> complete profile. */
export function resolveSettings(raw: unknown): Settings {
  const r: Raw = isObject(raw) ? raw : {};
  const legacy: Raw = {};
  for (const [from, to] of Object.entries(LEGACY_SLACK)) if (from in r) legacy[to] = r[from];
  const optional = <T extends object>(v: unknown, def: T): T | null => (v === null || v === undefined ? null : section(def, v));
  return {
    owner: section(DEFAULT_SETTINGS.owner, r.owner),
    workspace: typeof r.workspace === "string" ? r.workspace : DEFAULT_SETTINGS.workspace,
    slack: section(DEFAULT_SETTINGS.slack, { ...legacy, ...(isObject(r.slack) ? r.slack : {}) }),
    tracker: optional(r.tracker, { kind: "linear", workspace: "", prefixes: [] } as TrackerSettings),
    forge: optional(r.forge, { kind: "gitlab", host: "gitlab.com", repos: {}, aliases: {}, iidRanges: [], defaultRepo: "", integrationBranch: "dev", releaseBranch: "main" } as ForgeSettings),
    workers: section(DEFAULT_SETTINGS.workers, { ...("skipPermissions" in r ? { skipPermissions: r.skipPermissions } : {}), ...(isObject(r.workers) ? r.workers : {}) }),
    refresh: section(DEFAULT_SETTINGS.refresh, r.refresh),
    gc: section(DEFAULT_SETTINGS.gc, r.gc),
    policy: section(DEFAULT_SETTINGS.policy, r.policy),
    ui: section(DEFAULT_SETTINGS.ui, r.ui),
  };
}

/** What is missing for Strato to run, spelled out, for `doctor`. */
export function missingSettings(s: Settings): string[] {
  const out: string[] = [];
  if (!s.slack.team) out.push("slack.team (workspace name returned by auth.test)");
  if (!s.slack.workspace) out.push("slack.workspace (subdomain <workspace>.slack.com)");
  if (!s.slack.me) out.push("slack.me (your Slack id U…)");
  if (s.owner.name === DEFAULT_SETTINGS.owner.name) out.push("owner.name (your first name, read in the prompts and on the board)");
  if (s.tracker && (!s.tracker.workspace || !s.tracker.prefixes.length)) out.push("tracker.workspace and tracker.prefixes");
  if (s.forge && !Object.keys(s.forge.repos).length) out.push("forge.repos");
  return out;
}

let active: Settings = DEFAULT_SETTINGS;

/** The profile in force. Pure modules read it; the entry point sets it once at startup. */
export function settings(): Settings {
  return active;
}

export function useSettings(s: Settings): void {
  active = s;
}

/**
 * French elision before a vowel or h: « d'Alice », « qu'Alice », but « de Marie ». Only French policy templates use
 * the elided forms.
 */
export function elides(name: string): boolean {
  return /^[aeiouyhàâäéèêëîïôöûüAEIOUYHÀÂÉÈÊÎÔÛ]/.test(name);
}

/** The forms of the first name the texts need, ready to insert (`d_owner`, `qu_owner`: French elided forms). */
export function ownerForms(name = settings().owner.name): { owner: string; d_owner: string; qu_owner: string } {
  const e = elides(name);
  return { owner: name, d_owner: `${e ? "d'" : "de "}${name}`, qu_owner: `${e ? "qu'" : "que "}${name}` };
}
