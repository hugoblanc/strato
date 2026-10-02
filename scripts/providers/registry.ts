/**
 * The registry: the built-in providers, the accounts of the profile resolved to provider instances, and what Strato
 * gives each account (its secrets, a fetch limited to its API hosts, its own folder, the map of its long keys).
 * External providers are added by providers/external.ts once trusted and loaded; until then, and when they cannot be,
 * their accounts are listed with the reason.
 *
 * Every provider it hands out is a view without `act` and `undo`: the writes are reachable through `actorOf` only,
 * which app/act.ts alone imports, behind the gate (docs/design/providers.md, section 8.2; act.test.ts checks it).
 */
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { envFileValue } from "../app/slack.ts";
import { F, readJson, writeJson } from "../app/env.ts";
import { writeSecret } from "../app/secrets.ts";
import { formatKey, parseKey } from "../core/keys.ts";
import { hostMatches, settingHost, useProviders } from "../core/links.ts";
import { locale, t } from "../core/i18n.ts";
import { type ResolvedAccount, resolveAccounts, type Settings, settings } from "../core/settings.ts";
import { apiSupported } from "./api.ts";
import { BUILTIN_PURE } from "./builtin.ts";
import { linearWrites } from "./linear/act.ts";
import { linearProvider } from "./linear/index.ts";
import type { Account, AccountContext, Identity, Provider, ProviderDescriptor } from "./sdk.ts";
import { slackWrites } from "./slack/act.ts";
import { slackProvider } from "./slack/index.ts";
import { envPrefix } from "./check.ts";
import { maskSecrets } from "../core/text.ts";

/** A provider as the registry hands it out: everything but its writes. */
export type ProviderView = Omit<Provider, "act" | "undo">;

/** A provider's writes: what app/act.ts calls, after the gate. */
export type ProviderWrites = Pick<Provider, "act" | "undo">;

/**
 * The members a view keeps: every member of the SDK's `Provider` but its writes, named one by one (a member added to
 * the SDK fails to compile here until it is placed). Anything else an object carries stays out, such as the exec
 * host's `rpc`, which would reach a process's `act` without the gate.
 */
const VIEW_MEMBERS: Record<keyof ProviderView, true> = { descriptor: true, connect: true, poll: true, subscribe: true, replies: true, complete: true, participated: true, context: true, parseTarget: true, render: true, threadInfo: true, setup: true, deepLink: true };

/** A provider without its writes, nor anything the SDK does not declare. */
function viewOf(p: Provider): ProviderView {
  const view: Record<string, unknown> = {};
  for (const k of Object.keys(VIEW_MEMBERS) as (keyof ProviderView)[]) if (p[k] !== undefined) view[k] = p[k];
  return view as unknown as ProviderView;
}

/** The built-in providers, whole: never exported. */
const BUILTIN_FULL: Readonly<Record<string, Provider>> = { slack: { ...slackProvider, ...slackWrites }, linear: { ...linearProvider, ...linearWrites } };

/** The built-in providers, by id, without their writes. */
export const BUILTIN: Readonly<Record<string, ProviderView>> = Object.fromEntries(Object.entries(BUILTIN_FULL).map(([id, p]) => [id, viewOf(p)]));

/** Providers added at runtime, by id, whole: the external stage's loader adds the trusted ones here, tests add fakes. */
const added: Record<string, Provider> = {};
const addedViews: Record<string, ProviderView> = {};

/**
 * Adds a provider that is not built in, and installs its descriptor and pure parts for keys, links and targets. A
 * built-in id is refused: a provider never replaces Slack or Linear.
 */
export function addProvider(p: Provider): void {
  if (BUILTIN[p.descriptor.id]) throw new Error(`${p.descriptor.id} is a built-in provider`);
  added[p.descriptor.id] = p;
  addedViews[p.descriptor.id] = viewOf(p);
  useProviders([...BUILTIN_PURE, ...Object.values(addedViews)]);
}

const providerById = (id: string): ProviderView | null => BUILTIN[id] ?? addedViews[id] ?? null;

/** Why an external provider cannot run, by id, as providers/external.ts found when loading it. */
const externalProblems: Record<string, string> = {};

/** Records why an external provider cannot run (null: it loaded). */
export function setExternalProblem(id: string, problem: string | null): void {
  if (problem) externalProblems[id] = problem;
  else delete externalProblems[id];
}

/** A provider by id, built in or added, without its writes; null when unknown. */
export const providerOf = (id: string): ProviderView | null => providerById(id);

/** Every provider Strato can connect, built in first, without their writes. */
export const providerViews = (): ProviderView[] => [...Object.values(BUILTIN), ...Object.values(addedViews)];

const descriptors = (): Record<string, ProviderDescriptor> => Object.fromEntries([...Object.entries(BUILTIN), ...Object.entries(addedViews)].map(([id, p]) => [id, p.descriptor]));

/** An account and the provider that serves it, or why none does. */
export interface AccountEntry extends ResolvedAccount {
  provider: ProviderView | null;
  problem: string | null;
}

/**
 * The writes of the provider that serves an account, or null. Only app/act.ts imports this function: every write goes
 * through the gate there (act.test.ts fails if anything else reaches it).
 */
export function actorOf(entry: AccountEntry): ProviderWrites | null {
  if (!entry.provider) return null;
  const full = BUILTIN_FULL[entry.account.provider] ?? added[entry.account.provider];
  return full ? { act: full.act, undo: full.undo } : null;
}

/** Every account of the profile, each with its provider instance, in the order of `resolveAccounts`. */
export function accounts(s: Settings = settings()): AccountEntry[] {
  return resolveAccounts(s, descriptors()).map((a) => {
    const known = providerById(a.account.provider);
    const source = s.providers[a.account.provider]?.source;
    const problem = known
      ? apiSupported(known.descriptor)
        ? null
        : `${a.account.provider}: written for another version of the provider interface`
      : source
        ? (externalProblems[a.account.provider] ?? t("cli.provider.load.notLoaded", { id: a.account.provider }))
        : `${a.account.provider}: not a built-in tool`;
    return { ...a, provider: problem ? null : known, problem };
  });
}

/** One account by provider and name, or null. */
export const accountOf = (provider: string, id: string, s: Settings = settings()): AccountEntry | null => accounts(s).find((a) => a.account.provider === provider && a.account.id === id) ?? null;

// ------------------------------------------------------------------ the account's folder

/** `<state>/providers/<provider>-<account>/`: the only folder an account's provider may write in. */
export const accountDir = (a: Pick<Account, "provider" | "id">) => join(F.providers, `${a.provider}-${a.id}`);

/** The files of an account's folder that the core writes: a provider's store cannot overwrite them. */
export const CORE_FILES = ["keys.json", "seen.json", "ingest.json"] as const;

/** A file name of the account's store: one plain name, never a path nor a file of the core; `.json` added when missing. */
function storeFile(a: Pick<Account, "provider" | "id">, name: string): string {
  const base = basename(name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(base) || base !== name) throw new Error(`store name refused: ${name}`);
  const file = base.endsWith(".json") ? base : `${base}.json`;
  if ((CORE_FILES as readonly string[]).includes(file)) throw new Error(`store name refused: ${name} is kept by Strato`);
  return join(accountDir(a), file);
}

// ------------------------------------------------------------------ long keys

/**
 * The key of a native id on an account. A native id too long for a key gets a `%h` key, and the mapping is kept in
 * the account's `keys.json`, so `nativeOfKey` finds it back before the provider is called: a provider never sees a key.
 */
export function keyFor(a: Pick<Account, "provider" | "id">, native: string): string | null {
  const key = formatKey(a.provider, a.id, native);
  const p = key ? parseKey(key) : null;
  if (key && p?.long) {
    mkdirSync(accountDir(a), { recursive: true });
    const file = join(accountDir(a), "keys.json");
    const map = readJson<Record<string, string>>(file, {});
    if (map[p.native] !== native) writeJson(file, { ...map, [p.native]: native });
  }
  return key;
}

/** A key -> its account and native id, the `%h` ones read back from the account's map; null when unknown. */
export function nativeOfKey(key: string, s: Settings = settings()): { entry: AccountEntry; native: string } | null {
  const p = parseKey(key);
  const entry = p ? accountOf(p.provider, p.account, s) : null;
  if (!p || !entry) return null;
  if (!p.long) return { entry, native: p.native };
  const native = readJson<Record<string, string>>(join(accountDir(entry.account), "keys.json"), {})[p.native];
  return native ? { entry, native } : null;
}

// ------------------------------------------------------------------ what a provider receives

/**
 * The secret names an account's auth method stores, with the environment variables also accepted. Those variables are
 * legacy sources of the default account: a named account reads its own secret file only, or it would pick up the
 * default account's token.
 */
function secretSpecs(entry: AccountEntry) {
  return entry.provider?.descriptor.auth.find((m) => m.id === entry.account.auth)?.stores ?? [];
}

/** The files an account's secrets are read from: its secret file, and for the default Slack account its app token file. */
function secretFiles(entry: AccountEntry): string[] {
  const s = entry.account.settings;
  const files = [entry.secretsFile];
  if (entry.account.provider === "slack" && entry.account.id === "default" && typeof s.appTokenFile === "string") files.push(s.appTokenFile);
  return files.filter(Boolean);
}

/**
 * The hosts an account's API calls may reach: `{settings.baseUrl}` stands for the host of that setting (a URL or a
 * bare host, `settingHost`). `unresolved`: the placeholders whose setting names no host, which a refusal names.
 */
function apiHostsOf(entry: AccountEntry): { hosts: string[]; unresolved: string[] } {
  const hosts: string[] = [];
  const unresolved: string[] = [];
  for (const h of entry.provider?.descriptor.apiHosts ?? []) {
    const m = h.match(/^\{settings\.([A-Za-z0-9_]+)\}$/);
    if (!m) {
      hosts.push(h);
      continue;
    }
    const host = settingHost(entry.account.settings[m[1]]);
    if (host) hosts.push(host);
    else unresolved.push(h);
  }
  return { hosts, unresolved };
}

/**
 * The global fetch, captured when the registry is loaded, before any external module: a module that patches the
 * global one does not reach the built-in providers' requests.
 */
const FETCH = globalThis.fetch;
/** The fetch every account context starts from: the captured one, or the conformance harness's fake tool. */
let baseFetch: typeof fetch = FETCH;

/**
 * Replaces the fetch of every account context of this process, the act path's included: the conformance harness
 * puts its fake tool here, so that nothing it runs reaches a network. Null puts the captured one back.
 */
export function useBaseFetch(f: typeof fetch | null): void {
  baseFetch = f ?? FETCH;
}

/**
 * What a provider receives for one account (docs/design/providers.md, section 4.11): never the state folder, other
 * accounts' secrets, the topics, nor a way to start a session. Tests pass a fake `fetchImpl`.
 * With `candidates`, the context is setup's `verify` step: the secrets are the ones the person just gave and nothing
 * else, a refreshed one stays in memory, and the store keeps nothing.
 */
export function accountContext(entry: AccountEntry, opts: { identity?: Identity | null; signal?: AbortSignal; fetchImpl?: typeof fetch; log?: (line: string) => void; candidates?: Record<string, string> } = {}): AccountContext {
  const specs = secretSpecs(entry);
  const declared = (name: string) => specs.find((x) => x.name === name);
  const known: string[] = Object.values(opts.candidates ?? {});
  const candidates = opts.candidates;
  const secret = (name: string): string | null => {
    const spec = declared(name);
    if (!spec) return null;
    if (candidates) return candidates[name] || null;
    // the default account only; an external provider only its own STRATO_<ID>_ variables, never the rest of the environment
    const external = Boolean(settings().providers[entry.account.provider]?.source);
    const env = entry.account.id === "default" ? (spec.env ?? []).filter((v) => !external || v.startsWith(envPrefix(entry.account.provider))) : [];
    const value = secretFiles(entry).map((file) => envFileValue(file, name)).find(Boolean) ?? env.map((v) => process.env[v]).find(Boolean) ?? null;
    if (value) known.push(value);
    return value;
  };
  const signal = opts.signal ?? new AbortController().signal;
  const base = opts.fetchImpl ?? baseFetch;
  const { hosts, unresolved } = apiHostsOf(entry);
  const label = `${entry.account.provider}${entry.account.id === "default" ? "" : `@${entry.account.id}`}`;
  const limitedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "https:" || !hosts.some((h) => hostMatches(h, url.hostname))) {
      const why = unresolved.map((placeholder) => t("provider.fetch.unresolved", { placeholder }));
      throw new Error([t("provider.fetch.notApiHost", { label, host: url.hostname }), ...why].join("; "));
    }
    const timeout = AbortSignal.timeout(25_000);
    try {
      return await base(input, { ...init, signal: AbortSignal.any([signal, timeout, ...(init?.signal ? [init.signal] : [])]) });
    } catch (e) {
      throw new Error(maskSecrets(`${label}: ${(e as Error).message}`, known));
    }
  }) as typeof fetch;
  return {
    account: entry.account,
    identity: opts.identity ?? null,
    secret,
    setSecret(name, value) {
      if (!declared(name)) throw new Error(`${label}: ${name} is not a secret of this account`);
      if (candidates) candidates[name] = value;
      else writeSecret(entry.secretsFile, name, value);
      known.push(value);
    },
    fetch: limitedFetch,
    log(level, message) {
      if (level === "debug") return;
      (opts.log ?? ((line: string) => process.stderr.write(`${line}\n`)))(`[${label}] ${level}: ${maskSecrets(message, known)}`);
    },
    store: {
      read: <T>(name: string, fallback: T) => (candidates ? fallback : readJson<T>(storeFile(entry.account, name), fallback)),
      write(name, value) {
        if (candidates) return;
        mkdirSync(accountDir(entry.account), { recursive: true });
        writeJson(storeFile(entry.account, name), value);
      },
    },
    signal,
    locale: locale(),
    ...(candidates ? { verifying: true } : {}),
  };
}
