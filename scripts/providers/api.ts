/**
 * The values that go with providers/sdk.ts: the interface version, the identity function built-in providers are
 * written with, and the pure rules every provider shares (capabilities of an account, errors read from a throw).
 */
import type { ActionKind, Capabilities, Provider, ProviderDescriptor, ProviderError } from "./sdk.ts";

/** The version of the provider interface and of the exec protocol, one number for both. */
export const PROVIDER_API = 1;

/** The identity function: a built-in provider is type-checked against the interface where it is written. */
export const defineProvider = <P extends Provider>(p: P): P => p;

/** A provider id, which prefixes its keys: lowercase, 2 to 31 characters. */
export const PROVIDER_ID = /^[a-z][a-z0-9-]{1,30}$/;
/** An account name: "default", or lowercase letters, digits and dashes. */
export const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,29}$/;

/** The provider runs with this version of the interface. */
export const apiSupported = (d: Pick<ProviderDescriptor, "api">): boolean => d.api.min <= PROVIDER_API && PROVIDER_API <= d.api.max;

/**
 * The capabilities of an account: the descriptor's, minus what its auth method cannot do. Nothing is ever added, and
 * an unknown method removes nothing (validation refuses it before an account is used).
 */
export function effectiveCapabilities(d: Pick<ProviderDescriptor, "capabilities" | "auth">, authId: string): Capabilities {
  const c = d.capabilities;
  const l = d.auth.find((a) => a.id === authId)?.limits ?? {};
  const minus = (list: ActionKind[], drop: ActionKind[] = []) => list.filter((k) => !drop.includes(k));
  const poll = c.ingest.poll && l.ingest?.poll !== false;
  return {
    // push requires poll: a push account is also polled, to catch up after a silent cut
    ingest: { push: c.ingest.push && l.ingest?.push !== false && poll, poll },
    participation: c.participation && l.participation !== false,
    context: c.context && l.context !== false,
    actions: minus(c.actions, l.actions),
    undo: minus(c.undo, l.undo),
    idempotent: minus(c.idempotent, l.idempotent),
    edits: c.edits && l.edits !== false,
    identity: c.identity && l.identity !== false,
  };
}

/**
 * The account connects with one of its provider's auth methods. A links-only account (the `tracker` section without
 * an account of its own) says "none" for a tool that has methods: Strato recognizes its links and ids, and never reads,
 * polls nor acts through it. A provider of local data declares no method, and its accounts say "none".
 */
export function authUsable(d: Pick<ProviderDescriptor, "auth">, authId: string): boolean {
  return d.auth.length ? d.auth.some((m) => m.id === authId) : authId === "none";
}

/**
 * Anything a provider throws, read as a `ProviderError`: an object whose `code` is a string keeps its fields, missing
 * ones default to not retryable and not fatal. Anything else is a crash, retryable; during `act` or `undo` it may have
 * written, so it carries `outcome: "unknown"` and is never retried automatically.
 */
export function providerError(thrown: unknown, during: "read" | "write" = "read"): ProviderError {
  if (typeof thrown === "object" && thrown !== null && typeof (thrown as { code?: unknown }).code === "string") {
    const e = thrown as Partial<ProviderError> & { code: string };
    return {
      code: e.code,
      message: typeof e.message === "string" ? e.message : e.code,
      retryable: e.retryable === true,
      fatal: e.fatal === true,
      ...(typeof e.retryAfterMs === "number" ? { retryAfterMs: e.retryAfterMs } : {}),
      ...(e.outcome === "none" || e.outcome === "unknown" ? { outcome: e.outcome } : during === "write" ? { outcome: "unknown" as const } : {}),
    };
  }
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return { code: "internal", message, retryable: true, fatal: false, ...(during === "write" ? { outcome: "unknown" as const } : {}) };
}
