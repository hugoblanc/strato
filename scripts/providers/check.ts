/**
 * What is wrong in a descriptor that comes from outside Strato (an external provider's module or process), spelled out
 * for its author. Pure. The loader refuses a provider with any problem, `provider trust` shows them, and the
 * conformance harness reports them as its first check (docs/design/providers.md, section 13.5). Timing the link
 * patterns on long inputs is for trust and the harness: the loader, which runs at every command, skips it.
 */
import { t } from "../core/i18n.ts";
import { LINK_INPUT_MAX } from "../core/links.ts";
import { apiSupported, PROVIDER_API, PROVIDER_ID } from "./api.ts";
import type { ActionKind, ProviderDescriptor } from "./sdk.ts";

export const KINDS = ["chat", "tracker", "mail", "forge"] as const;
export const ACTION_KINDS: readonly ActionKind[] = ["post", "reply", "comment", "react", "delete", "setStatus", "assign", "create"];
/** The official kinds of sign-in (section 11.2): never a cookie or a token read out of another application. */
export const AUTH_KINDS = ["user-token", "api-key", "app-password", "oauth2"] as const;
const SETTING_TYPES = ["string", "string[]", "number", "boolean", "map"] as const;
const TRIAGE_ROLES = ["me", "groups", "groupAlias", "watch", "ignore", "ignoreAuthors", "teammates"] as const;
const STEP_KINDS = ["open", "paste", "oauth", "verify"] as const;
/** The longest a link pattern may take on a long input before it counts as a stall. */
export const PATTERN_BUDGET_MS = 50;

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const oneOf = (allowed: readonly string[]) => allowed.map((x) => `"${x}"`).join(", ");
/** A host name as a descriptor declares it: `tickets.example`, `*.slack.com`, `{settings.workspace}.slack.com`. */
const HOST = /^(\*\.)?([a-z0-9-]+|\{settings\.[A-Za-z0-9_]+\})(\.([a-z0-9-]+|\{settings\.[A-Za-z0-9_]+\}))*$/i;
const API_HOST = /^\{settings\.[A-Za-z0-9_]+\}$/;
/** A wildcard over one label (`*.com`, `*.{settings.tld}`) would claim the links of a whole top-level domain. */
const wideWildcard = (h: string) => h.startsWith("*.") && !h.slice(2).replace(/\{settings\.[A-Za-z0-9_]+\}/g, "x").includes(".");
const isHttps = (v: unknown) => typeof v === "string" && /^https:\/\/[^\s/]+/.test(v.replace(/\{settings\.[A-Za-z0-9_]+\}/g, "x"));

/** Inputs a pathological pattern stalls on: long runs of one character, and of a separator. */
const STALL_INPUTS = ["a".repeat(LINK_INPUT_MAX), `/${"a/".repeat(LINK_INPUT_MAX / 2 - 1)}`, `/${"1".repeat(LINK_INPUT_MAX - 2)}!`];

/** How long a pattern takes on the stall inputs, in ms; `now` is injected for tests. */
export function patternCost(pattern: RegExp, now: () => number = () => performance.now()): number {
  const start = now();
  for (const input of STALL_INPUTS) pattern.test(input);
  return now() - start;
}

/**
 * The problems of an external provider's descriptor, one sentence each, `[]` when there is none. `expectedId` is the
 * name the profile gives it: a provider never answers to another id.
 */
export function descriptorProblems(raw: unknown, expectedId?: string, opts: { now?: () => number; timing?: boolean } = {}): string[] {
  const out: string[] = [];
  const say = (key: Parameters<typeof t>[0], vars: Record<string, string | number>) => out.push(t(key, vars));
  const expected = (path: string, what: string) => say("cli.provider.check.expected", { path, expected: what });
  if (!isObject(raw)) return [t("cli.provider.check.expected", { path: "descriptor", expected: "object" })];
  const d = raw;

  if (typeof d.id !== "string" || !PROVIDER_ID.test(d.id)) say("cli.provider.check.id", { path: "id" });
  else if (expectedId && d.id !== expectedId) say("cli.provider.check.idMismatch", { path: "id", got: d.id, want: expectedId });
  text(d.label, "label");
  if (!isObject(d.api) || typeof d.api.min !== "number" || typeof d.api.max !== "number") expected("api", "{ min: number, max: number }");
  else if (!apiSupported(d as unknown as ProviderDescriptor)) say("cli.provider.check.api", { path: "api", min: d.api.min, max: d.api.max, api: PROVIDER_API });
  if (!isStrings(d.kinds) || !d.kinds.length) expected("kinds", `[${oneOf(KINDS)}]`);
  else for (const k of d.kinds) if (!(KINDS as readonly string[]).includes(k)) say("cli.provider.check.oneOf", { path: "kinds", value: k, allowed: oneOf(KINDS) });

  // capabilities
  const c = d.capabilities;
  let actions: string[] = [];
  if (!isObject(c)) expected("capabilities", "object");
  else {
    if (!isObject(c.ingest) || typeof c.ingest.push !== "boolean" || typeof c.ingest.poll !== "boolean") expected("capabilities.ingest", "{ push: boolean, poll: boolean }");
    else if (c.ingest.push && !c.ingest.poll) say("cli.provider.check.pushPoll", { path: "capabilities.ingest" });
    for (const k of ["participation", "context", "edits", "identity"]) if (typeof c[k] !== "boolean") expected(`capabilities.${k}`, "boolean");
    for (const k of ["actions", "undo", "idempotent"]) {
      const list = c[k];
      if (!isStrings(list)) {
        expected(`capabilities.${k}`, "string[]");
        continue;
      }
      for (const a of list) if (!(ACTION_KINDS as readonly string[]).includes(a)) say("cli.provider.check.oneOf", { path: `capabilities.${k}`, value: a, allowed: oneOf(ACTION_KINDS) });
      if (k === "actions") actions = list;
      else for (const a of list) if ((ACTION_KINDS as readonly string[]).includes(a) && !actions.includes(a)) say("cli.provider.check.subset", { path: `capabilities.${k}`, value: a });
    }
    if (isStrings(c.undo) && c.undo.length && typeof d.undoMs !== "number") say("cli.provider.check.undoMs", { path: "undoMs" });
  }

  // auth
  if (!Array.isArray(d.auth)) expected("auth", "array");
  else
    d.auth.forEach((m, i) => {
      const at = `auth[${i}]`;
      if (!isObject(m)) return expected(at, "object");
      if (typeof m.id !== "string" || !m.id) expected(`${at}.id`, "string");
      if (!(AUTH_KINDS as readonly unknown[]).includes(m.kind)) say("cli.provider.check.oneOf", { path: `${at}.kind`, value: String(m.kind), allowed: oneOf(AUTH_KINDS) });
      text(m.label, `${at}.label`);
      if (!isHttps(m.docs)) say("cli.provider.check.https", { path: `${at}.docs` });
      const stores = Array.isArray(m.stores) ? m.stores.filter(isObject) : null;
      if (!stores) expected(`${at}.stores`, "array");
      const names = new Set((stores ?? []).map((x) => x.name).filter((x): x is string => typeof x === "string"));
      if (!Array.isArray(m.steps)) return expected(`${at}.steps`, "array");
      m.steps.forEach((s, j) => {
        const sp = `${at}.steps[${j}]`;
        if (!isObject(s) || !(STEP_KINDS as readonly unknown[]).includes(s.kind)) return say("cli.provider.check.oneOf", { path: `${sp}.kind`, value: String(isObject(s) ? s.kind : s), allowed: oneOf(STEP_KINDS) });
        if (s.kind === "open" && !isHttps(s.url)) say("cli.provider.check.https", { path: `${sp}.url` });
        if (s.kind === "paste" && (typeof s.secret !== "string" || !names.has(s.secret))) say("cli.provider.check.secret", { path: `${sp}.secret`, name: String(s.secret) });
        if (s.kind === "oauth") {
          for (const k of ["authorizeUrl", "tokenUrl"]) if (!isHttps(s[k])) say("cli.provider.check.https", { path: `${sp}.${k}` });
          if (typeof s.secret !== "string" || !names.has(s.secret)) say("cli.provider.check.secret", { path: `${sp}.secret`, name: String(s.secret) });
        }
      });
    });

  // settings
  if (!Array.isArray(d.settings)) expected("settings", "array");
  else
    d.settings.forEach((s, i) => {
      const at = `settings[${i}]`;
      if (!isObject(s)) return expected(at, "object");
      if (typeof s.key !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(s.key)) expected(`${at}.key`, "string");
      if (!(SETTING_TYPES as readonly unknown[]).includes(s.type)) say("cli.provider.check.oneOf", { path: `${at}.type`, value: String(s.type), allowed: oneOf(SETTING_TYPES) });
      text(s.label, `${at}.label`);
      if (s.triage !== undefined) {
        if (!(TRIAGE_ROLES as readonly unknown[]).includes(s.triage)) say("cli.provider.check.oneOf", { path: `${at}.triage`, value: String(s.triage), allowed: oneOf(TRIAGE_ROLES) });
        else if (s.ask === undefined) say("cli.provider.check.ask", { path: `${at}.ask` });
      }
      if (s.ask !== undefined) text(s.ask, `${at}.ask`);
    });

  // vocabulary
  const v = d.vocabulary;
  if (!isObject(v)) expected("vocabulary", "object");
  else {
    for (const k of ["item", "thread", "conversation"]) text(v[k], `vocabulary.${k}`);
    if (typeof v.targetFormat !== "string" || !v.targetFormat) expected("vocabulary.targetFormat", "string");
  }

  // links and hosts
  const l = d.links;
  if (!isObject(l) || !Array.isArray(l.parse) || !Array.isArray(l.of)) expected("links", "{ parse: [], of: [] }");
  else {
    l.parse.forEach((p, i) => {
      const at = `links.parse[${i}]`;
      if (!isObject(p) || typeof p.host !== "string" || typeof p.pattern !== "string" || typeof p.thread !== "string") return expected(at, "{ host, pattern, thread }");
      if (!HOST.test(p.host)) say("cli.provider.check.host", { path: `${at}.host` });
      else if (wideWildcard(p.host)) say("cli.provider.check.wildcard", { path: `${at}.host` });
      pattern(p.pattern, `${at}.pattern`);
    });
    l.of.forEach((o, i) => {
      const at = `links.of[${i}]`;
      if (!isObject(o) || typeof o.match !== "string" || typeof o.url !== "string") return expected(at, "{ match, url }");
      pattern(o.match, `${at}.match`);
      if (!isHttps(o.url)) say("cli.provider.check.https", { path: `${at}.url` });
    });
  }
  for (const k of ["hosts", "apiHosts"]) {
    const list = d[k];
    if (!isStrings(list)) expected(k, "string[]");
    else
      list.forEach((h, i) => {
        if (!HOST.test(h) && !(k === "apiHosts" && API_HOST.test(h))) say("cli.provider.check.host", { path: `${k}[${i}]` });
        else if (wideWildcard(h)) say("cli.provider.check.wildcard", { path: `${k}[${i}]` });
      });
  }
  if (Array.isArray(d.apiHosts) && !d.apiHosts.length && Array.isArray(d.auth) && d.auth.length) say("cli.provider.check.empty", { path: "apiHosts" });

  // the rest
  for (const k of ["maxText", "undoMs"]) if (d[k] !== undefined && (typeof d[k] !== "number" || (d[k] as number) <= 0)) expected(k, "number > 0");
  if (d.done !== undefined && (!isObject(d.done) || d.done.kind !== "react" || typeof d.done.emoji !== "string" || !actions.includes("react"))) say("cli.provider.check.done", { path: "done" });
  if (d.ticketIds !== undefined && (!isObject(d.ticketIds) || typeof d.ticketIds.prefixesFrom !== "string")) expected("ticketIds", "{ prefixesFrom: string }");
  if (d.mcp !== undefined && (!isObject(d.mcp) || typeof d.mcp.server !== "string" || !isStrings(d.mcp.readTools) || !isStrings(d.mcp.writeTools))) expected("mcp", "{ server, readTools, writeTools }");
  return out;

  /** A text of an external provider: `{ en, fr? }`, English required; i18n keys are for built-in providers. */
  function text(x: unknown, path: string) {
    if (!isObject(x) || typeof x.en !== "string" || !x.en || (x.fr !== undefined && typeof x.fr !== "string")) say("cli.provider.check.english", { path });
  }

  /** A link pattern: it compiles, and it does not stall on a long input. */
  function pattern(source: string, path: string) {
    let re: RegExp;
    try {
      re = new RegExp(source.replace(/\{settings\.[A-Za-z0-9_]+\}/g, "x"));
    } catch (e) {
      return say("cli.provider.check.regex", { path, error: (e as Error).message });
    }
    if (opts.timing === false) return;
    const ms = patternCost(re, opts.now);
    if (ms > PATTERN_BUDGET_MS) say("cli.provider.check.slow", { path, ms: Math.round(ms), budget: PATTERN_BUDGET_MS });
  }
}
