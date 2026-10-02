/**
 * The exec protocol, pure side (docs/design/providers.md, section 13.2): framing of JSON-RPC lines, what a line is,
 * how an error object reads as a `ProviderError`, the timeouts, the environment a provider process gets, and the
 * restart policy. providers/host/exec.ts runs the processes.
 */
import { PROVIDER_API, providerError } from "../api.ts";
import type { ExecMethods, ProviderError, RpcError } from "../sdk.ts";

/** The protocol versions this Strato speaks, offered in `describe`. */
export const PROTOCOL_VERSIONS: readonly number[] = [PROVIDER_API];

/** Longest line either side may write: a longer one is a protocol error. */
export const MAX_LINE = 4 * 1024 * 1024;

/** How long Strato waits for each method, counted from when the request is written, not from when it was queued. */
export const EXEC_TIMEOUTS_MS: Record<keyof ExecMethods, number> = {
  describe: 5_000,
  initialize: 15_000,
  connect: 20_000,
  poll: 60_000,
  subscribe: 15_000,
  unsubscribe: 5_000,
  participated: 30_000,
  replies: 30_000,
  complete: 30_000,
  context: 30_000,
  act: 30_000,
  undo: 30_000,
  "setup.detect": 30_000,
  "setup.check": 30_000,
  shutdown: 5_000,
};

/** After a timeout, how long the provider has to answer `$/cancel` before its process is killed and restarted. */
export const CANCEL_GRACE_MS = 5_000;
/** A process with nothing to do (no request, no subscription) for this long is shut down; the next call starts it again. */
export const IDLE_MS = 10 * 60_000;
/** One request to a tool through `http.fetch`. */
export const FETCH_TIMEOUT_MS = 30_000;

export const RPC = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  provider: -32000,
  version: -32001,
  auth: -32002,
  rateLimited: -32003,
  cancelled: -32004,
} as const;

// ------------------------------------------------------------------ framing

/**
 * Splits what a process wrote into complete lines: `rest` is the unfinished line kept from before. A line longer than
 * `MAX_LINE`, finished or not, is reported as `overflow`: the process is then restarted, whatever it meant.
 */
export function takeLines(rest: string, chunk: string, max = MAX_LINE): { lines: string[]; rest: string; overflow: boolean } {
  const parts = (rest + chunk).split("\n");
  const tail = parts.pop() ?? "";
  const lines = parts.map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== "");
  const overflow = tail.length > max || lines.some((l) => l.length > max);
  return { lines, rest: overflow ? "" : tail, overflow };
}

/** One line read from a provider's stdout. */
export type Incoming =
  | { kind: "response"; id: number | string; result?: unknown; error?: RpcError }
  | { kind: "request"; id: number | string; method: string; params: unknown }
  | { kind: "notification"; method: string; params: unknown }
  | { kind: "invalid"; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is number | string => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

/** What a line is: a JSON-RPC 2.0 response, request or notification, or not a protocol message at all. */
export function readLine(line: string): Incoming {
  let m: unknown;
  try {
    m = JSON.parse(line);
  } catch {
    return { kind: "invalid", reason: "not JSON" };
  }
  if (!isObject(m) || m.jsonrpc !== "2.0") return { kind: "invalid", reason: "not a JSON-RPC 2.0 message" };
  if (typeof m.method === "string") return isId(m.id) ? { kind: "request", id: m.id, method: m.method, params: m.params } : { kind: "notification", method: m.method, params: m.params };
  if (!isId(m.id)) return { kind: "invalid", reason: "a response without an id" };
  if ("error" in m) {
    const e = m.error;
    if (!isObject(e) || typeof e.code !== "number") return { kind: "invalid", reason: "an error without a numeric code" };
    return { kind: "response", id: m.id, error: { code: e.code, message: typeof e.message === "string" ? e.message : "", ...(isObject(e.data) ? { data: e.data as Partial<ProviderError> } : {}) } };
  }
  if (!("result" in m)) return { kind: "response", id: m.id, error: { code: RPC.invalidRequest, message: "a response without result nor error" } };
  return { kind: "response", id: m.id, result: m.result };
}

export const request = (id: number, method: string, params: unknown = {}) => `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
export const notification = (method: string, params: unknown = {}) => `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`;
export const result = (id: number | string, value: unknown) => `${JSON.stringify({ jsonrpc: "2.0", id, result: value })}\n`;
export const failure = (id: number | string, code: number, message: string, data?: Partial<ProviderError>) => `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } })}\n`;

// ------------------------------------------------------------------ errors

/**
 * A JSON-RPC error object as a `ProviderError`: the `data` a provider sends wins, else the code says what it can
 * (-32002 needs setup, -32003 rate limited, -32601 not supported). A write that failed for an unknown reason may have
 * happened: `providerError` marks it so.
 */
export function errorOfRpc(e: RpcError, during: "read" | "write" = "read"): ProviderError {
  const byCode: Record<number, Partial<ProviderError> & { code: string }> = {
    [RPC.auth]: { code: "invalid_auth", fatal: true },
    [RPC.rateLimited]: { code: "rate_limited", retryable: true },
    [RPC.methodNotFound]: { code: "unsupported", fatal: false, outcome: "none" },
    [RPC.version]: { code: "protocol_version", fatal: true, outcome: "none" },
    [RPC.cancelled]: { code: "cancelled", retryable: true },
    [RPC.parse]: { code: "protocol", outcome: "none" },
    [RPC.invalidRequest]: { code: "protocol", outcome: "none" },
    [RPC.invalidParams]: { code: "invalid_params", outcome: "none" },
  };
  const base = byCode[e.code] ?? { code: "provider_error" };
  const data = e.data ?? {};
  return providerError({ ...base, message: e.message || base.code, ...data, code: typeof data.code === "string" ? data.code : base.code }, during);
}

/** An error Strato raises itself about a provider process (it crashed, it timed out, it is down). */
export const hostError = (code: string, message: string, o: Partial<ProviderError> = {}): ProviderError => ({ code, message, retryable: true, fatal: false, ...o });

// ------------------------------------------------------------------ environment

/** The variables a provider process inherits, when the person's environment sets them: proxies and certificates. */
const PASSED = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS"];

/**
 * The environment of a provider process: `PATH`, `HOME`, `LANG`, `TZ`, the protocol version, and the proxy and
 * certificate variables, so a provider works behind a corporate proxy. Never a secret: those travel in `initialize`.
 */
export function execEnv(parent: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = { STRATO_PROVIDER_PROTOCOL: String(PROVIDER_API) };
  for (const k of ["PATH", "HOME", "LANG", "TZ", ...PASSED]) {
    const v = parent[k];
    if (typeof v === "string" && v !== "") out[k] = v;
  }
  return out;
}

// ------------------------------------------------------------------ restart policy

/** Crashes within this window count towards marking an account down. */
export const CRASH_WINDOW_MS = 10 * 60_000;
/** This many crashes within the window mark the account down. */
export const CRASHES_DOWN = 5;
/** A down account is tried again after this long. */
export const DOWN_RETRY_MS = 15 * 60_000;

/** The wait before the n-th restart in a row (n from 1): 1 s, 2 s, 4 s… up to 5 minutes. */
export const backoffMs = (n: number): number => Math.min(300_000, 1_000 * 2 ** Math.max(0, n - 1));

/**
 * Whether a process may start now, from the times of its crashes (oldest first): `down` after five crashes within
 * ten minutes, until fifteen minutes after the last one; else the backoff after the last crash, longer for each crash
 * of the ten minutes before it.
 */
export function startGate(crashes: number[], now: number): { ok: true } | { ok: false; down: boolean; retryAfterMs: number } {
  if (!crashes.length) return { ok: true };
  const last = crashes[crashes.length - 1];
  const recent = crashes.filter((c) => last - c < CRASH_WINDOW_MS);
  if (recent.length >= CRASHES_DOWN && now - last < DOWN_RETRY_MS) return { ok: false, down: true, retryAfterMs: last + DOWN_RETRY_MS - now };
  const wait = last + backoffMs(recent.length) - now;
  return wait > 0 ? { ok: false, down: false, retryAfterMs: wait } : { ok: true };
}

/**
 * What `p` gives within `ms`, or that it did not. The timer is cleared either way: a pending sleep would keep a
 * command that is done alive until it fires.
 */
export async function within<T>(p: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p.then((value) => ({ ok: true as const, value })), new Promise<{ ok: false }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false }), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
