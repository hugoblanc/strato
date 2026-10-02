/**
 * Linear's GraphQL API for one account: the request, its authorization header per auth method, the rate limits
 * Linear announces in its headers, and the renewal of an OAuth access token. Every request goes through the account
 * context's fetch, which reaches `api.linear.app` only.
 *
 * Facts from Linear's documentation (linear.app/developers): a personal API key is sent as `Authorization: <key>`, an
 * OAuth access token as `Authorization: Bearer <token>`; an access token lasts about a day and is renewed at the token
 * endpoint with `grant_type=refresh_token` and the client id; a request over the limit answers with the `RATELIMITED`
 * error code, and `X-RateLimit-Requests-Remaining` and `X-RateLimit-Requests-Reset` (epoch ms) say where the hour stands.
 */
import type { AccountContext, ProviderError } from "../sdk.ts";
import { LINEAR_API, LINEAR_SECRETS, LINEAR_TOKEN_URL } from "./model.ts";

/**
 * A failed request. `answered`: Linear read the request and refused it, so nothing was written; otherwise the request
 * may have reached Linear (a cut connection, a timeout), which a write must treat as an unknown outcome.
 */
export class LinearError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly fatal: boolean,
    readonly answered: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }

  toProviderError(): ProviderError {
    return { code: this.code, message: this.message, retryable: this.retryable, fatal: this.fatal, ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}) };
  }
}

/** Anything a request threw, as a provider error: a `LinearError` keeps its fields, anything else is a network error. */
export function linearProviderError(e: unknown): ProviderError {
  if (e instanceof LinearError) return e.toProviderError();
  return { code: "network", message: (e as Error)?.message ?? String(e), retryable: true, fatal: false };
}

/** Where the hour stands, per account, from the last answer's headers: a request is not sent while none is left. */
const limits = new Map<string, { remaining: number; reset: number }>();

const accountId = (ctx: AccountContext) => `${ctx.account.provider}@${ctx.account.id}`;

/** The token of the account's auth method and the header it goes in, or null when the secret is missing. */
function authorization(ctx: AccountContext): string | null {
  if (ctx.account.auth === "oauth-pkce") {
    const token = ctx.secret(LINEAR_SECRETS.access);
    return token ? `Bearer ${token}` : null;
  }
  return ctx.secret(LINEAR_SECRETS.apiKey);
}

function noteLimits(ctx: AccountContext, res: Response): void {
  const remaining = Number(res.headers.get("x-ratelimit-requests-remaining"));
  const reset = Number(res.headers.get("x-ratelimit-requests-reset"));
  if (res.headers.has("x-ratelimit-requests-remaining") && Number.isFinite(remaining)) limits.set(accountId(ctx), { remaining, reset: Number.isFinite(reset) ? reset : Date.now() + 60_000 });
}

/** How long until the hour resets, at least a minute when Linear does not say. */
function waitOf(ctx: AccountContext, now = Date.now()): number {
  const reset = limits.get(accountId(ctx))?.reset;
  return reset && reset > now ? reset - now : 60_000;
}

const ERRORS: Record<string, { code: string; fatal: boolean; retryable: boolean }> = {
  RATELIMITED: { code: "rate_limited", fatal: false, retryable: true },
  AUTHENTICATION_ERROR: { code: "invalid_auth", fatal: true, retryable: false },
  FORBIDDEN: { code: "forbidden", fatal: false, retryable: false },
};

/** The renewal of an OAuth access token with the refresh token Linear gave; both are stored again (Linear renews both). */
async function refresh(ctx: AccountContext): Promise<boolean> {
  const token = ctx.secret(LINEAR_SECRETS.refresh);
  const clientId = typeof ctx.account.settings.clientId === "string" ? ctx.account.settings.clientId : "";
  if (ctx.account.auth !== "oauth-pkce" || !token || !clientId) return false;
  let res: Response;
  try {
    res = await ctx.fetch(LINEAR_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: clientId }) });
  } catch {
    return false;
  }
  const body = (await res.json().catch(() => null)) as { access_token?: unknown; refresh_token?: unknown } | null;
  if (!res.ok || typeof body?.access_token !== "string" || !body.access_token) return false;
  ctx.setSecret(LINEAR_SECRETS.access, body.access_token);
  if (typeof body.refresh_token === "string" && body.refresh_token) ctx.setSecret(LINEAR_SECRETS.refresh, body.refresh_token);
  ctx.log("info", "access token renewed");
  return true;
}

/**
 * One GraphQL request: its data, or a `LinearError`. An access token Linear refuses is renewed once with the refresh
 * token, then the request is sent again; a key or a token it still refuses is fatal (the account needs setup again).
 */
export async function linearQuery<T>(ctx: AccountContext, query: string, variables: Record<string, unknown> = {}, renewed = false): Promise<T> {
  const auth = authorization(ctx);
  if (!auth) throw new LinearError("invalid_auth", `Linear account "${ctx.account.id}": no ${ctx.account.auth === "oauth-pkce" ? LINEAR_SECRETS.access : LINEAR_SECRETS.apiKey} in its secret file`, false, true, true);
  const known = limits.get(accountId(ctx));
  if (known && known.remaining <= 0 && known.reset > Date.now()) throw new LinearError("rate_limited", "Linear's hourly request limit is reached", true, false, true, waitOf(ctx));
  let res: Response;
  try {
    res = await ctx.fetch(LINEAR_API, { method: "POST", headers: { "Content-Type": "application/json", Authorization: auth }, body: JSON.stringify({ query, variables }) });
  } catch (e) {
    throw new LinearError("network", `Linear unreachable: ${(e as Error)?.message ?? String(e)}`, true, false, false);
  }
  noteLimits(ctx, res);
  const body = (await res.json().catch(() => null)) as { data?: T; errors?: { message?: string; extensions?: { code?: string } }[] } | null;
  const first = body?.errors?.[0];
  const code = first?.extensions?.code ?? (res.status === 401 ? "AUTHENTICATION_ERROR" : res.status === 429 ? "RATELIMITED" : "");
  if (code === "AUTHENTICATION_ERROR" && !renewed && (await refresh(ctx))) return linearQuery<T>(ctx, query, variables, true);
  if (first || !res.ok || !body?.data) {
    const known = ERRORS[code];
    const message = `Linear: ${first?.message ?? `HTTP ${res.status}`}`;
    if (known) throw new LinearError(known.code, message, known.retryable, known.fatal, true, known.code === "rate_limited" ? waitOf(ctx) : undefined);
    // an answer without data nor a known error: a server-side failure is worth another try, and may have written
    throw new LinearError(code ? code.toLowerCase() : "linear_error", message, res.status >= 500, false, res.status < 500);
  }
  return body.data;
}
