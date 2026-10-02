/**
 * The profile of an installation: everything that changes from one person or team to another, read from
 * `<state>/config.json`. The code holds no team value: it reads `settings()`.
 *
 * The file may be partial: every missing section takes its default value, field by field.
 * The legacy flat format (`team`, `me`, `subteams`… at the root) is still read, as the `slack` section.
 * The `slack` and `tracker` sections are the default Slack and Linear accounts; other accounts live under `providers`
 * (`resolveAccounts`, docs/design/providers.md section 6).
 */
import { effectiveCapabilities } from "../providers/api.ts";
import type { Account, ProviderDescriptor } from "../providers/sdk.ts";

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
  /** `KEY=value` file holding `SLACK_USER_TOKEN`, the user token (xoxp-), tried first. Written by `setup --token`. `~` accepted. */
  userTokenFile: string;
  /** Interval of `watch` (fallback polling), in seconds. */
  pollInterval: number;
  /**
   * Client id of the Slack app the person signs in through with OAuth (`setup --connect slack --auth oauth-pkce`):
   * usually one internal app a team shares. Not a secret: PKCE needs no client secret.
   */
  clientId: string;
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

/** Where an external provider's code is (`module` or `exec`), and the hash of its folder the person trusted. */
export interface ProviderSource {
  module?: string;
  exec?: string[];
  sha256?: string;
}

/** One tool in the `providers` section: its code when it is not built in, and its named accounts. */
export interface ProviderSection {
  source?: ProviderSource;
  /** Account name -> its fields: the reserved keys of `ACCOUNT_KEYS`, every other one a setting of the provider. */
  accounts: Record<string, Record<string, unknown>>;
}

export interface Settings {
  /**
   * Who Strato serves: their first name appears in the prompts, the cards and the board. `role` is their job
   * (core/roles.ts): what sessions are told, the board's words, the interview's proposals. Developer when absent.
   */
  owner: { name: string; role?: string };
  /** Working folder of the topic sessions (cwd, CLAUDE.md, .mcp.json). Empty: derived from the skill's location. */
  workspace: string;
  slack: SlackSettings;
  tracker: TrackerSettings | null;
  forge: ForgeSettings | null;
  /** Accounts beyond the default Slack (`slack`) and Linear (`tracker`) ones, by provider id. */
  providers: Record<string, ProviderSection>;
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
    /**
     * Fixed port of the OAuth callback on the loopback (`setup --connect … --auth oauth-pkce`), the one written in the
     * OAuth application's redirect URL. 0: `port` + 10. Never the board's own port.
     */
    oauthPort: number;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  owner: { name: "the user", role: "developer" },
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
    userTokenFile: "",
    pollInterval: 60,
    clientId: "",
  },
  tracker: null,
  forge: null,
  providers: {},
  workers: { skipPermissions: false, allow: [], shadow: false },
  refresh: { auto: true, staleDays: 3, graceMinutes: 20, everyMinutes: 30, maxParallel: 3 },
  gc: { everyMinutes: 60, idleHours: 12 },
  policy: {},
  ui: { iterm: false, port: 4343, slackApp: true, locale: "en", oauthPort: 0 },
};

/** The OAuth callback port in force: `ui.oauthPort`, else the board's port + 10 (4353 by default). */
export const oauthPortOf = (s: Settings): number => (s.ui.oauthPort > 0 ? s.ui.oauthPort : s.ui.port + 10);

/**
 * What a new installation's config.json starts from: the defaults, but in shadow mode. The resolved default stays
 * `shadow: false`, so an existing profile without the key keeps behaving as before; only a profile created by Strato
 * (first run, or `setup --write` with no config.json yet) starts by posting nothing until `setup --live`.
 */
export const NEW_INSTALL_PROFILE = { workers: { shadow: true } } as const;

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
    providers: providersSection(r.providers),
    workers: section(DEFAULT_SETTINGS.workers, { ...("skipPermissions" in r ? { skipPermissions: r.skipPermissions } : {}), ...(isObject(r.workers) ? r.workers : {}) }),
    refresh: section(DEFAULT_SETTINGS.refresh, r.refresh),
    gc: section(DEFAULT_SETTINGS.gc, r.gc),
    policy: section(DEFAULT_SETTINGS.policy, r.policy),
    ui: section(DEFAULT_SETTINGS.ui, r.ui),
  };
}

/** The `providers` section as read: objects only, each with its accounts (objects only too). */
function providersSection(raw: unknown): Record<string, ProviderSection> {
  if (!isObject(raw)) return {};
  const out: Record<string, ProviderSection> = {};
  for (const [id, v] of Object.entries(raw)) {
    if (!isObject(v)) continue;
    const accounts = isObject(v.accounts) ? Object.fromEntries(Object.entries(v.accounts).filter(([, a]) => isObject(a))) : {};
    out[id] = { ...(isObject(v.source) ? { source: v.source as ProviderSource } : {}), accounts: accounts as Record<string, Raw> };
  }
  return out;
}

// ------------------------------------------------------------------ accounts

/** Keys of an account handled by the core; every other key is a setting of the provider. */
export const ACCOUNT_KEYS = ["auth", "secretsFile", "ingest", "enabled", "label", "pollInterval", "mcpServer"] as const;
/** Settings of the default Linear account that only the `tracker` section sets when it exists. */
export const TRACKER_LINK_FIELDS = ["workspace", "prefixes"] as const;

/** An account as the core runs it: what the provider sees (`account`), and what only the core reads. */
export interface ResolvedAccount {
  account: Account;
  /** `KEY=value` file of its secrets. The default Slack account keeps `slack.userTokenFile` and its search order. */
  secretsFile: string;
  /** Seconds between polls. */
  pollInterval: number;
  /** The matching MCP server of the workspace's `.mcp.json`, for the session permissions. */
  mcpServer: string | null;
  /** Where it is configured: the legacy `slack` or `tracker` section, or `providers`. */
  from: "slack" | "tracker" | "providers";
}

/** What account resolution reads from a descriptor, when the provider is known. */
export type AccountDescriptor = Pick<ProviderDescriptor, "auth" | "capabilities"> & Partial<Pick<ProviderDescriptor, "mcp">>;

const ingestModes = ["push", "poll", "off"] as const;

/** Push when the auth method allows it, else poll; a provider not known yet is polled. */
function defaultIngest(d: AccountDescriptor | undefined, auth: string): Account["ingest"] {
  if (!d) return "poll";
  const c = effectiveCapabilities(d, auth);
  return c.ingest.push ? "push" : c.ingest.poll ? "poll" : "off";
}

/** One account of the `providers` section, its reserved keys read, its other keys kept as settings. */
function accountFrom(provider: string, id: string, raw: Raw, base: Raw, d: AccountDescriptor | undefined, from: ResolvedAccount["from"], defaults: { auth?: string; ingest?: Account["ingest"] } = {}): ResolvedAccount {
  const settingsOf: Raw = { ...base };
  for (const [k, v] of Object.entries(raw)) if (!(ACCOUNT_KEYS as readonly string[]).includes(k)) settingsOf[k] = v;
  const auth = typeof raw.auth === "string" ? raw.auth : (defaults.auth ?? d?.auth[0]?.id ?? "none");
  const ingest = ingestModes.includes(raw.ingest as Account["ingest"]) ? (raw.ingest as Account["ingest"]) : (defaults.ingest ?? defaultIngest(d, auth));
  const named = [settingsOf.team, settingsOf.workspace].find((x): x is string => typeof x === "string" && x !== "");
  return {
    account: { provider, id, label: typeof raw.label === "string" && raw.label ? raw.label : (named ?? id), auth, ingest, settings: settingsOf },
    secretsFile: typeof raw.secretsFile === "string" && raw.secretsFile ? raw.secretsFile : `~/.config/strato/${provider}-${id}.env`,
    pollInterval: typeof raw.pollInterval === "number" && raw.pollInterval > 0 ? raw.pollInterval : 60,
    mcpServer: typeof raw.mcpServer === "string" && raw.mcpServer ? raw.mcpServer : (d?.mcp?.server ?? null),
    from,
  };
}

/**
 * Every account of a profile, in a stable order: the default Slack account (the `slack` section or the legacy flat
 * keys), the named Slack accounts, the default Linear account, then the other providers in file order.
 * - `providers.slack.accounts.default` is ignored (validation refuses it): the default Slack account lives in `slack`.
 * - With a `tracker` section, the default Linear account takes `workspace` and `prefixes` from it, and its other fields
 *   from `providers.linear.accounts.default`; without the latter it is a links-only account (no auth, no ingest), which
 *   is the behavior of a tracker section.
 * - An account with `enabled: false` is left out.
 * `descriptors` gives the default auth method and ingest mode; an unknown provider's account is kept, polled.
 */
export function resolveAccounts(s: Settings, descriptors: Record<string, AccountDescriptor> = {}): ResolvedAccount[] {
  const out: ResolvedAccount[] = [];
  const enabled = (raw: Raw) => raw.enabled !== false;
  const slackD = descriptors.slack;
  out.push({
    account: { provider: "slack", id: "default", label: s.slack.team || s.slack.workspace || "default", auth: slackD?.auth[0]?.id ?? "user-token", ingest: slackD ? defaultIngest(slackD, slackD.auth[0]?.id ?? "") : "push", settings: { ...s.slack } },
    secretsFile: s.slack.userTokenFile,
    pollInterval: s.slack.pollInterval,
    mcpServer: slackD?.mcp?.server ?? null,
    from: "slack",
  });
  const section = (id: string) => s.providers[id]?.accounts ?? {};
  for (const [id, raw] of Object.entries(section("slack"))) if (id !== "default" && enabled(raw)) out.push(accountFrom("slack", id, raw, {}, slackD, "providers"));
  const linear = section("linear");
  const tracked = s.tracker?.kind === "linear";
  for (const [id, raw] of Object.entries(linear)) {
    if (!enabled(raw) || (id === "default" && tracked)) continue;
    out.push(accountFrom("linear", id, raw, {}, descriptors.linear, "providers"));
  }
  if (tracked && s.tracker) {
    const own = linear.default;
    const raw: Raw = own ? Object.fromEntries(Object.entries(own).filter(([k]) => !(TRACKER_LINK_FIELDS as readonly string[]).includes(k))) : {};
    if (!own || enabled(own)) {
      const links = { workspace: s.tracker.workspace, prefixes: s.tracker.prefixes };
      const resolved = accountFrom("linear", "default", raw, links, descriptors.linear, "tracker", own ? {} : { auth: "none", ingest: "off" });
      // the default Linear account goes first among the Linear accounts
      const at = out.findIndex((a) => a.account.provider === "linear");
      out.splice(at < 0 ? out.length : at, 0, resolved);
    }
  }
  for (const [provider, p] of Object.entries(s.providers)) {
    if (provider === "slack" || provider === "linear") continue;
    for (const [id, raw] of Object.entries(p.accounts)) if (enabled(raw)) out.push(accountFrom(provider, id, raw, {}, descriptors[provider], "providers"));
  }
  return out;
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
