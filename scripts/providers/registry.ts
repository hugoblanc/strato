/**
 * The registry: the built-in providers, the accounts of the profile resolved to provider instances, and what Strato
 * gives each account (its secrets, a fetch limited to its API hosts, its own folder, the map of its long keys).
 * Loading external providers comes with the external stage: until then their accounts are listed, with the reason
 * they cannot run.
 */
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { envFileValue } from "../app/slack.ts";
import { expandHome, F, readJson, writeJson } from "../app/env.ts";
import { formatKey, parseKey } from "../core/keys.ts";
import { hostMatches, useProviders } from "../core/links.ts";
import { locale } from "../core/i18n.ts";
import { type ResolvedAccount, resolveAccounts, type Settings, settings } from "../core/settings.ts";
import { setEnvLine } from "../core/setup.ts";
import { apiSupported } from "./api.ts";
import { BUILTIN_DESCRIPTORS } from "./builtin.ts";
import { linearProvider } from "./linear/index.ts";
import type { Account, AccountContext, Identity, Provider, ProviderDescriptor } from "./sdk.ts";
import { slackProvider } from "./slack/index.ts";

/** The built-in providers, by id. */
export const BUILTIN: Readonly<Record<string, Provider>> = { slack: slackProvider, linear: linearProvider };

/** Providers added at runtime, by id: the external stage's loader adds the trusted ones here, tests add fakes. */
const added: Record<string, Provider> = {};

/**
 * Adds a provider that is not built in, and installs its descriptor for keys and links. A built-in id is refused:
 * a provider never replaces Slack or Linear.
 */
export function addProvider(p: Provider): void {
  if (BUILTIN[p.descriptor.id]) throw new Error(`${p.descriptor.id} is a built-in provider`);
  added[p.descriptor.id] = p;
  useProviders([...BUILTIN_DESCRIPTORS, ...Object.values(added).map((x) => x.descriptor)]);
}

const providerById = (id: string): Provider | null => BUILTIN[id] ?? added[id] ?? null;

const descriptors = (): Record<string, ProviderDescriptor> => Object.fromEntries([...Object.entries(BUILTIN), ...Object.entries(added)].map(([id, p]) => [id, p.descriptor]));

/** An account and the provider that serves it, or why none does. */
export interface AccountEntry extends ResolvedAccount {
  provider: Provider | null;
  problem: string | null;
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
        ? `${a.account.provider}: external providers are not loaded by this version`
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

/** `KEY=value` written into a secret file: folder 700, file 600, written then renamed. */
function writeSecret(file: string, name: string, value: string): void {
  const path = expandHome(file);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let current = "";
  try {
    current = readFileSync(path, "utf8");
  } catch {}
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, setEnvLine(current, name, value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** The hosts an account's API calls may reach: `{settings.baseUrl}` stands for the host of that setting. */
function apiHostsOf(entry: AccountEntry): string[] {
  return (entry.provider?.descriptor.apiHosts ?? []).flatMap((h) => {
    const m = h.match(/^\{settings\.([A-Za-z0-9_]+)\}$/);
    if (!m) return [h];
    const v = entry.account.settings[m[1]];
    try {
      return typeof v === "string" ? [new URL(v).hostname] : [];
    } catch {
      return [];
    }
  });
}

/**
 * The global fetch, captured when the registry is loaded, before any external module: a module that patches the
 * global one does not reach the built-in providers' requests.
 */
const FETCH = globalThis.fetch;

/** Every known secret value masked in a text: a provider's errors and logs never carry one. */
const masked = (text: string, secrets: string[]) => secrets.reduce((t, s) => (s.length >= 6 ? t.split(s).join(`${s.slice(0, 4)}…`) : t), text);

/**
 * What a provider receives for one account (docs/design/providers.md, section 4.11): never the state folder, other
 * accounts' secrets, the topics, nor a way to start a session. Tests pass a fake `fetchImpl`.
 */
export function accountContext(entry: AccountEntry, opts: { identity?: Identity | null; signal?: AbortSignal; fetchImpl?: typeof fetch; log?: (line: string) => void } = {}): AccountContext {
  const specs = secretSpecs(entry);
  const declared = (name: string) => specs.find((x) => x.name === name);
  const known: string[] = [];
  const secret = (name: string): string | null => {
    const spec = declared(name);
    if (!spec) return null;
    const env = entry.account.id === "default" ? (spec.env ?? []) : [];
    const value = secretFiles(entry).map((file) => envFileValue(file, name)).find(Boolean) ?? env.map((v) => process.env[v]).find(Boolean) ?? null;
    if (value) known.push(value);
    return value;
  };
  const signal = opts.signal ?? new AbortController().signal;
  const baseFetch = opts.fetchImpl ?? FETCH;
  const hosts = apiHostsOf(entry);
  const label = `${entry.account.provider}${entry.account.id === "default" ? "" : `@${entry.account.id}`}`;
  const limitedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "https:" || !hosts.some((h) => hostMatches(h, url.hostname))) throw new Error(`${label}: ${url.hostname} is not among the provider's API hosts`);
    const timeout = AbortSignal.timeout(25_000);
    try {
      return await baseFetch(input, { ...init, signal: AbortSignal.any([signal, timeout, ...(init?.signal ? [init.signal] : [])]) });
    } catch (e) {
      throw new Error(masked(`${label}: ${(e as Error).message}`, known));
    }
  }) as typeof fetch;
  return {
    account: entry.account,
    identity: opts.identity ?? null,
    secret,
    setSecret(name, value) {
      if (!declared(name)) throw new Error(`${label}: ${name} is not a secret of this account`);
      writeSecret(entry.secretsFile, name, value);
      known.push(value);
    },
    fetch: limitedFetch,
    log(level, message) {
      if (level === "debug") return;
      (opts.log ?? ((line: string) => process.stderr.write(`${line}\n`)))(`[${label}] ${level}: ${masked(message, known)}`);
    },
    store: {
      read: <T>(name: string, fallback: T) => readJson<T>(storeFile(entry.account, name), fallback),
      write(name, value) {
        mkdirSync(accountDir(entry.account), { recursive: true });
        writeJson(storeFile(entry.account, name), value);
      },
    },
    signal,
    locale: locale(),
  };
}
