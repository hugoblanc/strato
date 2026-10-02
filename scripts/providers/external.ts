/**
 * Loading the external providers of the profile (docs/design/providers.md, section 13): only the ones config.json
 * names with a `source` and an enabled account, and only when their folder is the one the person trusted. A module is
 * imported; an exec provider is set up from its trusted descriptor, and its processes start at the first call.
 * Whatever goes wrong becomes the reason its accounts show on `doctor` and `provider list`: loading never fails a
 * command.
 */
import { t } from "../core/i18n.ts";
import type { ExternalProviders } from "../core/setup.ts";
import { type ProviderSource, resolveAccounts, type Settings, settings } from "../core/settings.ts";
import { oneLine, truncate } from "../core/text.ts";
import { STRATO_VERSION } from "../core/build-info.ts";
import { BUILTIN, accountDir, addProvider, setExternalProblem } from "./registry.ts";
import { descriptorProblems } from "./check.ts";
import { execProvider } from "./host/exec.ts";
import { importModule, LoadError, missingMethods } from "./host/module.ts";
import { type TrustRecord, type TrustState, readTrust, trustOf } from "./host/trust.ts";
import { join } from "node:path";
import type { Provider } from "./sdk.ts";

/** One external provider of the profile, and where it stands after loading. */
export interface ExternalStatus {
  id: string;
  source: ProviderSource;
  trust: TrustState;
  loaded: boolean;
  /** Why its accounts cannot run, when they cannot. */
  problem: string | null;
}

/**
 * The external providers the profile names: a `source`, not a built-in id, and an enabled account or none yet (a
 * provider is trusted, then connected: `setup --connect` needs it before its first account exists).
 */
export function configuredExternal(s: Settings = settings()): { id: string; source: ProviderSource }[] {
  return Object.entries(s.providers)
    .filter(([id, p]) => p.source && !BUILTIN[id] && (!Object.keys(p.accounts).length || Object.values(p.accounts).some((a) => a.enabled !== false)))
    .map(([id, p]) => ({ id, source: p.source as ProviderSource }));
}

/** Why a provider is not trusted as it is, in a sentence that names the command to run. */
export function trustProblem(id: string, trust: TrustState): string | null {
  if (trust.state === "trusted") return null;
  if (trust.state === "missing") return t("cli.provider.load.missing", { id, path: trust.detail });
  if (trust.state === "invalid") return t("cli.provider.load.invalid", { id, detail: trust.detail });
  return t(trust.state === "changed" ? "cli.provider.load.changed" : "cli.provider.load.untrusted", { id });
}

/**
 * The provider object of a trusted source: the module imported (its descriptor checked), or the exec host built on the
 * trusted descriptor. `offline`: the conformance harness.
 */
export async function providerFromSource(id: string, trust: Extract<TrustState, { state: "trusted" }> | { resolved: NonNullable<TrustState["resolved"]>; record: Pick<TrustRecord, "descriptor"> }, opts: { offline?: boolean } = {}): Promise<Provider> {
  const r = trust.resolved;
  if (r.shape === "module") return importModule(r.file, id);
  const problems = descriptorProblems(trust.record.descriptor, id, { timing: false });
  if (problems.length) throw new LoadError(problems);
  return execProvider({ id, argv: r.argv, cwd: r.cwd, descriptor: trust.record.descriptor, logFile: (a) => join(accountDir(a), "provider.log"), stratoVersion: STRATO_VERSION, ...(opts.offline ? { offline: true } : {}) });
}

let loading: Promise<ExternalStatus[]> | null = null;

/**
 * Loads every trusted external provider of the profile once per process, and records why the others cannot run.
 * Never throws: a provider that fails to load leaves its accounts with a reason, the other tools carry on.
 */
export function loadExternalProviders(s: Settings = settings()): Promise<ExternalStatus[]> {
  loading ??= (async () => {
    const trust = safeTrust();
    const out: ExternalStatus[] = [];
    // `<state>/providers/<provider>-<account>/` is an account's folder: a provider named like one would share it
    const accountFolders = new Set(resolveAccounts(s).map((a) => `${a.account.provider}-${a.account.id}`));
    for (const { id, source } of configuredExternal(s)) {
      if (accountFolders.has(id)) {
        const problem = t("cli.provider.load.folderClash", { id });
        setExternalProblem(id, problem);
        out.push({ id, source, trust: { state: "invalid", resolved: null, detail: problem }, loaded: false, problem });
        continue;
      }
      let state: TrustState;
      try {
        state = trustOf(id, source, trust);
      } catch (e) {
        state = { state: "invalid", resolved: null, detail: (e as Error).message };
      }
      let problem = trustProblem(id, state);
      if (!problem && state.state === "trusted") {
        try {
          const p = await providerFromSource(id, state);
          const missing = missingMethods(p.descriptor.capabilities, (m) => typeof (p as unknown as Record<string, unknown>)[m] === "function");
          if (missing.length) throw new LoadError(missing);
          addProvider(p);
        } catch (e) {
          problem = t("cli.provider.load.failed", { id, error: oneLine(truncate(e instanceof LoadError ? e.problems.join("; ") : String((e as Error)?.message ?? e), 500)) });
        }
      }
      setExternalProblem(id, problem);
      out.push({ id, source, trust: state, loaded: !problem, problem });
    }
    return out;
  })();
  return loading;
}

function safeTrust(): Record<string, TrustRecord> {
  try {
    return readTrust();
  } catch {
    return {};
  }
}

/**
 * What profile validation knows of the external providers a raw profile names with a source: the descriptor the person
 * trusted, whether the folder changed since, or nothing yet (not trusted). Read from the trust file and the folders'
 * hashes; no provider code runs.
 */
export function externalKnowledge(raw: unknown): ExternalProviders {
  const out: ExternalProviders = {};
  const providers = raw && typeof raw === "object" ? (raw as { providers?: unknown }).providers : null;
  if (!providers || typeof providers !== "object") return out;
  const trust = safeTrust();
  for (const [id, entry] of Object.entries(providers as Record<string, unknown>)) {
    const source = entry && typeof entry === "object" ? (entry as { source?: unknown }).source : undefined;
    if (!source || typeof source !== "object" || BUILTIN[id]) continue;
    try {
      const state = trustOf(id, source as ProviderSource, trust);
      out[id] = state.state === "trusted" ? { descriptor: state.record.descriptor } : state.state === "changed" ? { changed: true } : {};
    } catch {
      out[id] = {};
    }
  }
  return out;
}
