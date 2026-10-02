/**
 * The pure side of `setup`: merging and validating a profile, reading what can be guessed from git remotes, commit
 * subjects and Slack answers, and the lines of `setup --check`. No disk, no network: commands/setup.ts does that.
 */
import { ACCOUNT_ID, PROVIDER_ID } from "../providers/api.ts";
import type { ProviderDescriptor, SettingSpec } from "../providers/sdk.ts";
import { locale, t } from "./i18n.ts";
import { providerDescriptors, textOf } from "./links.ts";
import { ACCOUNT_KEYS, DEFAULT_SETTINGS, TRACKER_LINK_FIELDS } from "./settings.ts";

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

// ------------------------------------------------------------------ profile: merge, diff, validate

/** `incoming` over `base`: objects merge key by key, everything else (arrays, null, scalars) is replaced. */
export function mergeProfile(base: unknown, incoming: unknown): unknown {
  if (!isObject(base) || !isObject(incoming)) return incoming === undefined ? base : incoming;
  const out: Raw = { ...base };
  for (const [k, v] of Object.entries(incoming)) out[k] = k in base ? mergeProfile(base[k], v) : v;
  return out;
}

/** Leaves of a JSON value by dotted path. An array or an empty object is one leaf. */
function leaves(v: unknown, prefix = "", out = new Map<string, string>()): Map<string, string> {
  if (isObject(v) && Object.keys(v).length) {
    for (const [k, x] of Object.entries(v)) leaves(x, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) out.set(prefix, JSON.stringify(v));
  return out;
}

/** What changes between two profiles, one line per field: `+ added`, `- removed`, `~ changed: old -> new`. */
export function profileDiff(before: unknown, after: unknown): string[] {
  const a = leaves(before);
  const b = leaves(after);
  const lines: string[] = [];
  for (const [k, v] of b) {
    if (!a.has(k)) lines.push(`+ ${k}: ${v}`);
    else if (a.get(k) !== v) lines.push(`~ ${k}: ${a.get(k)} -> ${v}`);
  }
  for (const [k, v] of a) if (!b.has(k)) lines.push(`- ${k}: ${v}`);
  return lines;
}

/** The shape of the optional sections when they are set (their default is null). */
const TRACKER_SHAPE = { kind: "linear", workspace: "", prefixes: [] as string[] };
const FORGE_SHAPE = { kind: "gitlab", host: "", repos: {}, aliases: {}, iidRanges: [] as unknown[], defaultRepo: "", integrationBranch: "", releaseBranch: "" };
/** Keys of the flat format older installations wrote at the root: still read, so still accepted. */
const LEGACY_ROOT = new Set(["team", "me", "subteams", "watchChannels", "ignoreChannels", "ignoreAuthors", "teammates", "slackAppId", "interval", "skipPermissions"]);
/** Enumerated values: anything else is a typo the code would silently ignore. */
const ENUMS: Record<string, string[]> = { "ui.locale": ["en", "fr"], "tracker.kind": ["linear"], "forge.kind": ["gitlab"] };

const kindOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

function checkAgainst(shape: unknown, v: unknown, path: string, out: string[]) {
  if (isObject(shape) && !Object.keys(shape).length) {
    // a free map (forge.repos, forge.aliases, policy): string values
    if (!isObject(v)) out.push(`${path}: expected an object, got ${kindOf(v)}`);
    else for (const [k, x] of Object.entries(v)) if (typeof x !== "string") out.push(`${path}.${k}: expected a string, got ${kindOf(x)}`);
    return;
  }
  if (isObject(shape)) {
    if (!isObject(v)) return void out.push(`${path}: expected an object, got ${kindOf(v)}`);
    for (const [k, x] of Object.entries(v)) {
      if (!(k in shape)) out.push(`${path}.${k}: unknown field (known: ${Object.keys(shape).join(", ")})`);
      else checkAgainst(shape[k], x, `${path}.${k}`, out);
    }
    return;
  }
  if (kindOf(shape) !== kindOf(v)) return void out.push(`${path}: expected ${kindOf(shape)}, got ${kindOf(v)}`);
  if (Array.isArray(shape) && Array.isArray(v) && path !== "forge.iidRanges") {
    v.forEach((x, i) => typeof x !== "string" && out.push(`${path}[${i}]: expected a string, got ${kindOf(x)}`));
  }
  if (path in ENUMS && !ENUMS[path].includes(v as string)) out.push(`${path}: "${v}" is not one of ${ENUMS[path].join(", ")}`);
}

/** What the caller knows of external providers: the descriptor the person trusted, and whether its folder changed since. */
export type ExternalProviders = Record<string, { descriptor?: ProviderDescriptor; changed?: boolean }>;

/**
 * What is wrong in a raw config.json, before it is written: unknown fields and wrong types, spelled out.
 * resolveSettings never fails, so a typo ("watchChannel") would otherwise be silently ignored.
 * The `providers` section is checked against the installed descriptors and, for external providers, the ones the
 * caller passes (the trust cache): validation never starts a process.
 */
export function profileErrors(raw: unknown, external: ExternalProviders = {}): string[] {
  if (!isObject(raw)) return [`config.json: expected an object, got ${kindOf(raw)}`];
  const out: string[] = [];
  const shapes: Raw = { ...DEFAULT_SETTINGS, tracker: TRACKER_SHAPE, forge: FORGE_SHAPE };
  for (const [k, v] of Object.entries(raw)) {
    if (LEGACY_ROOT.has(k)) continue;
    if (!(k in shapes)) out.push(`${k}: unknown field (known: ${Object.keys(shapes).join(", ")})`);
    else if ((k === "tracker" || k === "forge") && v === null) continue;
    else if (k === "providers") providersErrors(v, raw, external, out);
    else checkAgainst(shapes[k], v, k, out);
  }
  if (isObject(raw.forge)) {
    for (const [i, r] of (Array.isArray(raw.forge.iidRanges) ? raw.forge.iidRanges : []).entries()) {
      if (!isObject(r) || typeof r.from !== "number" || typeof r.repo !== "string") out.push(`forge.iidRanges[${i}]: expected { "from": number, "repo": string }`);
    }
  }
  return out;
}

// ------------------------------------------------------------------ the providers section

/** "a" or "b", in the person's language. */
const orList = (items: string[]) => new Intl.ListFormat(locale(), { type: "disjunction" }).format(items);
const quoted = (xs: string[]) => xs.map((x) => `"${x}"`);

/** Edit distance, for "did you mean". */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

/** The known name closest to a typo, when it is close enough to be the intended one. */
function closest(name: string, known: string[]): string | null {
  const best = known.map((k) => ({ k, d: distance(name, k) })).sort((x, y) => x.d - y.d)[0];
  return best && best.d <= Math.max(1, Math.floor(best.k.length / 4)) ? best.k : null;
}

/** A key name that looks like a secret: it never belongs in config.json. */
const SECRET_NAME = /token|secret|passw(or)?d|api[-_]?key|credential/i;

/** The JSON kind a setting type expects, or null when the value fits. */
function settingMismatch(spec: SettingSpec, v: unknown): string | null {
  const ok =
    spec.type === "string" ? typeof v === "string"
    : spec.type === "number" ? typeof v === "number"
    : spec.type === "boolean" ? typeof v === "boolean"
    : spec.type === "string[]" ? Array.isArray(v) && v.every((x) => typeof x === "string")
    : isObject(v) && Object.values(v).every((x) => typeof x === "string");
  return ok ? null : spec.type === "string[]" ? "array of strings" : spec.type === "map" ? "object of strings" : spec.type;
}

const RESERVED_TYPES: Record<(typeof ACCOUNT_KEYS)[number], "string" | "number" | "boolean"> = {
  auth: "string",
  secretsFile: "string",
  ingest: "string",
  enabled: "boolean",
  label: "string",
  pollInterval: "number",
  mcpServer: "string",
};

/** One account of the `providers` section against its provider's descriptor. */
function accountErrors(d: ProviderDescriptor, id: string, raw: Raw, path: string, tracked: boolean, out: string[]): void {
  const tool = textOf(d.label);
  const known = d.settings.map((x) => x.key);
  for (const [k, v] of Object.entries(raw)) {
    const at = `${path}.${k}`;
    if (k in RESERVED_TYPES) {
      const want = RESERVED_TYPES[k as keyof typeof RESERVED_TYPES];
      if (kindOf(v) !== want) out.push(t("cli.setup.provider.expected", { path: at, expected: want, got: kindOf(v) }));
      else if (k === "auth") {
        const methods = d.auth.map((m) => m.id);
        if (!(methods.includes(v as string) || (v === "none" && !methods.length))) out.push(t("cli.setup.provider.auth", { tool, auth: String(v), methods: orList(quoted(methods.length ? methods : ["none"])), path: at }));
      } else if (k === "ingest") {
        if (!["push", "poll", "off"].includes(v as string)) out.push(t("cli.setup.provider.ingest", { path: at }));
        else if (v === "push" && !d.capabilities.ingest.push) out.push(t("cli.setup.provider.noPush", { tool, path: at }));
      }
      continue;
    }
    const spec = d.settings.find((x) => x.key === k);
    if (!spec) {
      if (SECRET_NAME.test(k) || d.auth.some((m) => m.stores.some((x) => x.name.toLowerCase() === k.toLowerCase()))) out.push(t("cli.setup.provider.secret", { id: d.id, path: at }));
      else {
        const hint = closest(k, known);
        out.push(hint ? t("cli.setup.provider.settingHint", { tool, name: k, hint, path: at }) : t("cli.setup.provider.setting", { tool, name: k, known: known.join(", "), path: at }));
      }
      continue;
    }
    if (d.id === "linear" && id === "default" && tracked && (TRACKER_LINK_FIELDS as readonly string[]).includes(k)) {
      out.push(t("cli.setup.provider.trackerField", { path: at }));
      continue;
    }
    const expected = settingMismatch(spec, v);
    if (expected) out.push(t("cli.setup.provider.expected", { path: at, expected, got: kindOf(v) }));
  }
}

/** The `providers` section: tool names, sources, account names, and each account against its provider's settings. */
function providersErrors(v: unknown, root: Raw, external: ExternalProviders, out: string[]): void {
  if (!isObject(v)) return void out.push(t("cli.setup.provider.expected", { path: "providers", expected: "object", got: kindOf(v) }));
  const builtins = providerDescriptors();
  const tracked = isObject(root.tracker) && (root.tracker.kind === undefined || root.tracker.kind === "linear");
  for (const [id, entry] of Object.entries(v)) {
    const path = `providers.${id}`;
    if (!PROVIDER_ID.test(id)) {
      out.push(t("cli.setup.provider.name", { path }));
      continue;
    }
    if (!isObject(entry)) {
      out.push(t("cli.setup.provider.expected", { path, expected: "object", got: kindOf(entry) }));
      continue;
    }
    for (const k of Object.keys(entry)) if (k !== "source" && k !== "accounts") out.push(t("cli.setup.provider.field", { path: `${path}.${k}` }));
    const builtin = builtins.find((d) => d.id === id);
    const source = entry.source;
    if (source !== undefined) {
      const okSource = isObject(source) && (typeof source.module === "string" || (Array.isArray(source.exec) && source.exec.length > 0 && source.exec.every((x) => typeof x === "string"))) && (source.sha256 === undefined || typeof source.sha256 === "string");
      if (!okSource || builtin) out.push(t("cli.setup.provider.source", { path: `${path}.source` }));
      else if (external[id]?.changed) out.push(t("cli.setup.provider.changed", { id, path: `${path}.source` }));
      // an account added to a provider the profile already sources (setup --connect writes only the account)
    } else if (!builtin && !external[id]) out.push(t("cli.setup.provider.notBuiltin", { id, builtins: builtins.map((d) => d.id).join(", "), path }));
    if (entry.accounts === undefined) continue;
    if (!isObject(entry.accounts)) {
      out.push(t("cli.setup.provider.expected", { path: `${path}.accounts`, expected: "object", got: kindOf(entry.accounts) }));
      continue;
    }
    const d = builtin ?? external[id]?.descriptor ?? null;
    for (const [name, account] of Object.entries(entry.accounts)) {
      const at = `${path}.accounts.${name}`;
      if (id === "slack" && name === "default") out.push(t("cli.setup.provider.slackDefault", { path: at }));
      else if (name !== "default" && !ACCOUNT_ID.test(name)) out.push(t("cli.setup.provider.account", { path: at }));
      else if (!isObject(account)) out.push(t("cli.setup.provider.expected", { path: at, expected: "object", got: kindOf(account) }));
      else if (d) accountErrors(d, name, account, at, tracked, out);
      else if ((source !== undefined || external[id]) && !external[id]?.changed) out.push(t("cli.setup.provider.untrusted", { id, path: at }));
    }
  }
}

// ------------------------------------------------------------------ detection

export type Confidence = "high" | "medium" | "low";

/** One guessed field: its value, where it comes from, how sure, and the options when it is a choice to make. */
export interface Detected {
  value: unknown;
  source: string;
  confidence: Confidence;
  candidates?: unknown[];
}

/** `https://acme.slack.com/` (auth.test `url`) -> `acme`. */
export function slackWorkspaceFromUrl(url: string): string | null {
  const m = /^https?:\/\/([a-z0-9-]+)\.(?:[a-z0-9-]+\.)*slack\.com\/?/i.exec(url ?? "");
  return m ? m[1].toLowerCase() : null;
}

/** The first name of a Slack profile (users.info), for `owner.name`. */
export function firstNameOf(user: { real_name?: string; name?: string; profile?: { first_name?: string; real_name?: string; display_name?: string } } | undefined): string | null {
  const p = user?.profile ?? {};
  const full = p.first_name || p.real_name || user?.real_name || p.display_name || user?.name || "";
  return full.trim().split(/\s+/)[0] || null;
}

/** A Slack person as `slack.teammates` compares them: display name, else real name (same order as app/slack.ts nameOf). */
export function displayNameOf(user: { real_name?: string; name?: string; profile?: { real_name?: string; display_name?: string } } | undefined): string | null {
  return user?.profile?.display_name || user?.profile?.real_name || user?.real_name || user?.name || null;
}

export interface Remote {
  host: string;
  /** Project path on the forge: `acme/api`. */
  path: string;
  kind: "gitlab" | "github" | "other";
}

/** `git@gitlab.com:acme/api.git` or `https://gitlab.com/acme/api.git` -> host, path, forge kind. */
export function parseRemote(url: string): Remote | null {
  const u = url.trim();
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i.exec(u);
  if (!m || !m[2].includes("/")) return null;
  const host = m[1].toLowerCase();
  const kind = /gitlab/.test(host) ? "gitlab" : host === "github.com" ? "github" : "other";
  return { host, path: m[2], kind };
}

/** Uppercase codes that look like ticket ids and are not. */
const NOT_TICKETS = new Set(["UTF", "ISO", "SHA", "HTTP", "TLS", "SSL", "CVE", "RFC", "AES", "GPT", "MD", "ES", "UTC", "GMT", "COVID", "PR", "MR", "V"]);

/** Ticket prefixes read in commit subjects ("fix: x #ENG-12"): the ones seen at least `min` times, most frequent first. */
export function ticketPrefixes(texts: string[], min = 3): { prefix: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const t of texts) {
    for (const m of t.matchAll(/(?<![A-Za-z0-9-])([A-Z][A-Z0-9]{1,6})-\d{1,6}(?![A-Za-z0-9])/g)) {
      if (NOT_TICKETS.has(m[1])) continue;
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
  }
  return [...counts].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1]).map(([prefix, count]) => ({ prefix, count }));
}

/** The Linear workspace named in issue links (`linear.app/<workspace>/issue/…`), most frequent first. */
export function linearWorkspaces(texts: string[]): string[] {
  const counts = new Map<string, number>();
  for (const t of texts) for (const m of t.matchAll(/linear\.app\/([a-z0-9-]+)\/issue\//gi)) counts.set(m[1].toLowerCase(), (counts.get(m[1].toLowerCase()) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([w]) => w);
}

export interface SearchMatch {
  channel?: { id?: string; name?: string; is_im?: boolean; is_mpim?: boolean };
}

/** The channels where the person writes the most (search.messages from:me), DMs and group DMs excluded. */
export function topChannels(matches: SearchMatch[], max = 8): { id: string; name: string; messages: number }[] {
  const counts = new Map<string, { id: string; name: string; messages: number }>();
  for (const m of matches) {
    const c = m.channel;
    if (!c?.id || c.is_im || c.is_mpim || c.id.startsWith("D") || (c.name ?? "").startsWith("mpdm-")) continue;
    const hit = counts.get(c.id) ?? { id: c.id, name: c.name ? `#${c.name}` : c.id, messages: 0 };
    hit.messages++;
    counts.set(c.id, hit);
  }
  return [...counts.values()].sort((a, b) => b.messages - a.messages).slice(0, max);
}

/** `fr_FR.UTF-8` -> fr, anything else -> en: the two locales the board speaks. */
export const localeFromEnv = (lang: string | undefined): "en" | "fr" => (/^fr/i.test(lang ?? "") ? "fr" : "en");

/**
 * A partial config.json from the detected fields that are sure enough to propose as is (high and medium confidence,
 * a non-empty value). Low-confidence fields stay in `fields`, as questions for the interview.
 */
export function suggestedConfig(fields: Record<string, Detected>): Raw {
  const out: Raw = {};
  for (const [path, d] of Object.entries(fields)) {
    if (d.confidence === "low" || d.value === null || d.value === undefined || d.value === "") continue;
    if (Array.isArray(d.value) && !d.value.length) continue;
    if (isObject(d.value) && !Object.keys(d.value).length) continue;
    const parts = path.split(".");
    let at = out;
    for (const p of parts.slice(0, -1)) at = (at[p] = isObject(at[p]) ? at[p] : {}) as Raw;
    at[parts[parts.length - 1]] = d.value;
  }
  return out;
}

// ------------------------------------------------------------------ Slack app

/**
 * The link that opens Slack's "create an app" flow with the manifest already filled in (Slack's documented share link,
 * `new_app=1&manifest_yaml=`): no YAML copied by hand, so no broken indentation. Comment and blank lines are dropped
 * to keep the URL short; the manifest itself is unchanged.
 */
export function slackAppLink(manifestYaml: string): string {
  const yaml = manifestYaml
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#"))
    .join("\n");
  return `https://api.slack.com/apps?new_app=1&manifest_yaml=${encodeURIComponent(yaml)}`;
}

// ------------------------------------------------------------------ tokens

/** Where the one token Strato needs lives on the Slack app's pages. */
export const USER_TOKEN_WHERE = "your Slack app > OAuth & Permissions > User OAuth Token (xoxp-…)";

/**
 * A token of the wrong kind, named: the Slack app's pages show several tokens and secrets, and Slack would only
 * answer a bare `invalid_auth` or, for a bot token, read as a bot that sees nothing. Null for a user token.
 */
export function tokenKindProblem(token: string): string | null {
  if (token.startsWith("xoxp-")) return null;
  if (token.startsWith("xoxb-")) return `xoxb- is the Bot User OAuth Token: Strato needs the User OAuth Token (xoxp-…), on the same page`;
  if (token.startsWith("xapp-")) return `xapp- is the app-level token for Socket Mode (SLACK_APP_TOKEN or slack.appTokenFile), not the user token: copy ${USER_TOKEN_WHERE}`;
  return `not a Slack user token: copy ${USER_TOKEN_WHERE}`;
}

/** `KEY=value` set in an env file's text: the line replaced where it is, else appended; every other line kept. */
export function setEnvLine(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^\\s*(?:export\\s+)?${key}=.*$`, "m");
  if (re.test(content)) return content.replace(re, line);
  return `${content}${content && !content.endsWith("\n") ? "\n" : ""}${line}\n`;
}

// ------------------------------------------------------------------ cross-check against Slack

/** What Slack says about the ids of a profile, read with the token in use. */
export interface SlackFacts {
  team: string;
  me: string;
  /** Ids of the workspace's user groups, or null when they could not be read (scope, network). */
  groups: string[] | null;
  /** Channel id -> whether Slack knows it for this token. Ids not looked up are absent. */
  channels: Record<string, boolean>;
}

/**
 * The ids of a profile that do not exist in the token's workspace: a field type-checks but never triggers, often an
 * example value copied as is. Never blocking: a warning line per field and value.
 */
export function profileWarnings(slack: { team: string; me: string; subteams: string[]; watchChannels: string[]; ignoreChannels: string[] }, facts: SlackFacts): string[] {
  const out: string[] = [];
  const example = (v: string) => (/EXAMPLE/i.test(v) ? ": still the example value?" : "");
  if (slack.team && slack.team !== facts.team) out.push(`slack.team: "${slack.team}", but the token belongs to "${facts.team}"`);
  if (slack.me && slack.me !== facts.me) out.push(`slack.me: ${slack.me} is not you (the token is ${facts.me})${example(slack.me)}`);
  if (facts.groups) for (const g of slack.subteams) if (!facts.groups.includes(g)) out.push(`slack.subteams: ${g} not found in ${facts.team}${example(g)}`);
  for (const field of ["watchChannels", "ignoreChannels"] as const) {
    for (const c of slack[field]) if (facts.channels[c] === false) out.push(`slack.${field}: ${c} not found in ${facts.team}, or not visible to you${example(c)}`);
  }
  return out;
}

// ------------------------------------------------------------------ check

/** `claude agents --json` answered with a JSON array: this Claude Code can run and list background sessions. */
export function backgroundSessionsOk(code: number, output: string): boolean {
  if (code !== 0) return false;
  try {
    return Array.isArray(JSON.parse(output));
  } catch {
    return false;
  }
}

/** User-token scopes the code calls, and what breaks without them. */
export const SLACK_SCOPES: { scope: string; why: string }[] = [
  { scope: "search:read", why: "catch-up, watch, backlog" },
  { scope: "channels:history", why: "public threads" },
  { scope: "groups:history", why: "private threads" },
  { scope: "im:history", why: "DMs" },
  { scope: "mpim:history", why: "group DMs" },
  { scope: "channels:read", why: "channel names" },
  { scope: "groups:read", why: "private channel names" },
  { scope: "im:read", why: "DM membership" },
  { scope: "mpim:read", why: "group DM membership" },
  { scope: "users:read", why: "people's names" },
  { scope: "chat:write", why: "Send from the board" },
  { scope: "reactions:write", why: "the board's ✅" },
  { scope: "usergroups:read", why: "setup --detect finds your groups" },
];

export type CheckStatus = "ok" | "missing" | "warn" | "skip";

/** One prerequisite checked by `setup --check`. `blocking`: Strato cannot run without it. */
export interface CheckItem {
  name: string;
  status: CheckStatus;
  detail: string;
  blocking: boolean;
}

const MARK: Record<CheckStatus, string> = { ok: "ok  ", missing: "MISS", warn: "warn", skip: "--  " };

/**
 * A path as a person reads it in a terminal: relative to the current folder when inside it, `~` for the home folder,
 * else as is. Check lines repeat paths: the long absolute form buries what matters.
 */
export function shortPath(path: string, home: string, cwd: string): string {
  const under = (p: string, dir: string) => dir && dir !== "/" && (p === dir || p.startsWith(`${dir}/`));
  if (under(path, cwd)) return path === cwd ? "." : `./${path.slice(cwd.length + 1)}`;
  if (under(path, home)) return `~${path.slice(home.length)}`;
  return path;
}

/** Where a setup stands, as the "Next:" line needs it. */
export interface Progress {
  /** Names of the blocking prerequisites that are missing (bun, claude, slack). */
  blocked: string[];
  /** The profile still lacks a field Strato needs. */
  profileIncomplete: boolean;
}

/**
 * The one command to run next, by priority: a missing tool, then the Slack app and token, then the interview, then
 * the daily start. `cli` is how the reader calls Strato ("bun ./.claude/skills/strato/scripts/strato.ts").
 */
export function nextStep(p: Progress, cli: string): string {
  if (p.blocked.includes("bun")) return "install Bun 1.1 or later: https://bun.sh";
  if (p.blocked.includes("claude")) return "install or update Claude Code (background sessions needed): https://claude.com/claude-code";
  if (p.blocked.includes("slack")) return `${cli} setup --token (no Slack app yet: ${cli} setup --slack-app first)`;
  if (p.profileIncomplete) return 'claude -n strato "/strato setup"';
  return 'claude -n strato "/strato"';
}

/** The lines of `setup --check` and its exit code: 1 when a blocking prerequisite is missing, else 0. */
export function checkReport(configPath: string, configExists: boolean, missing: string[], items: CheckItem[], cli = "bun strato.ts"): { lines: string[]; code: number } {
  const lines = [
    `profile  ${configExists ? configPath : `${configPath} (not created yet)`}`,
    ...(missing.length ? missing.map((m) => `  to fill in: ${m}`) : ["  complete"]),
    "",
    ...items.map((i) => `${MARK[i.status]}  ${i.name.padEnd(9)} ${i.detail}${i.status === "missing" && i.blocking ? " [blocking]" : ""}`),
  ];
  const blocked = items.filter((i) => i.blocking && i.status === "missing");
  lines.push("", blocked.length ? `not ready: ${blocked.map((i) => i.name).join(", ")} missing` : missing.length ? "prerequisites ready, profile incomplete: run the setup interview (/strato setup)" : "ready");
  lines.push(`Next: ${nextStep({ blocked: blocked.map((i) => i.name), profileIncomplete: missing.length > 0 }, cli)}`);
  return { lines, code: blocked.length ? 1 : 0 };
}
