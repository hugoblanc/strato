/**
 * The pure side of the OAuth 2.0 authorization code flow on the loopback (docs/design/providers.md, section 11.2):
 * the PKCE challenge, the authorization link, the token request, and reading the token response. The listener and the
 * requests live in app/oauth.ts.
 */
import { createHash } from "node:crypto";
import type { OAuthStep } from "../providers/sdk.ts";

/** Bytes as base64url without padding (RFC 7636, appendix A). */
export const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

/** The S256 code challenge of a verifier: base64url(SHA-256(verifier)). */
export const pkceChallenge = (verifier: string): string => base64url(createHash("sha256").update(verifier, "ascii").digest());

/** The callback path the loopback listener answers on; any other path is refused. */
export const CALLBACK_PATH = "/oauth/callback";

/** The redirect URI of a step on a port: what the OAuth application declares and both requests repeat. */
export const redirectUriOf = (step: Pick<OAuthStep, "redirectHost">, port: number): string => `http://${step.redirectHost ?? "127.0.0.1"}:${port}${CALLBACK_PATH}`;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Why an endpoint of a step cannot be used: https only, except a loopback host (a local test server). Null when fine. */
export function endpointProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `not a URL: ${url}`;
  }
  if (u.username || u.password) return `credentials in ${u.host}`;
  if (u.protocol === "https:") return null;
  return u.protocol === "http:" && LOOPBACK.has(u.hostname) ? null : `${u.protocol}//${u.host} is not https`;
}

/** Why a port cannot take the callback, or null: a TCP port, never the board's own one. */
export function oauthPortProblem(port: number, boardPort: number): "invalid" | "board" | null {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return "invalid";
  return port === boardPort ? "board" : null;
}

/** The link the person opens to approve: the step's authorization endpoint with the request in its query. */
export function authorizeUrlOf(step: OAuthStep, req: { clientId: string; redirectUri: string; state: string; challenge?: string }): string {
  const u = new URL(step.authorizeUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", req.clientId);
  u.searchParams.set("redirect_uri", req.redirectUri);
  u.searchParams.set(step.scopeParam ?? "scope", step.scopes.join(step.scopeSeparator ?? " "));
  u.searchParams.set("state", req.state);
  if (req.challenge) {
    u.searchParams.set("code_challenge", req.challenge);
    u.searchParams.set("code_challenge_method", "S256");
  }
  return u.toString();
}

/** The body of the code exchange: the same redirect URI, the verifier, and a client secret only when the step has one. */
export function tokenRequestBody(req: { clientId: string; code: string; redirectUri: string; verifier?: string; clientSecret?: string }): URLSearchParams {
  const body = new URLSearchParams({ grant_type: "authorization_code", code: req.code, redirect_uri: req.redirectUri, client_id: req.clientId });
  if (req.verifier) body.set("code_verifier", req.verifier);
  if (req.clientSecret) body.set("client_secret", req.clientSecret);
  return body;
}

/** What the token response gave: the access token, else the service's error code. */
export type TokenAnswer = { ok: true; access: string; refresh?: string; expiresInSec?: number } | { ok: false; error: string };

/** A value at a dotted path of a JSON object. */
function at(body: unknown, path: string): unknown {
  let v = body;
  for (const part of path.split(".")) v = typeof v === "object" && v !== null ? (v as Record<string, unknown>)[part] : undefined;
  return v;
}

/**
 * The token response read with the step's `tokenField` (`authed_user.access_token` for Slack); the refresh token and the
 * lifetime sit next to the access token. A Slack refusal comes as `{ ok: false, error }` with status 200.
 */
export function tokenOf(step: Pick<OAuthStep, "tokenField">, body: unknown): TokenAnswer {
  const field = step.tokenField ?? "access_token";
  const access = at(body, field);
  if (typeof access === "string" && access) {
    const parent = field.includes(".") ? field.slice(0, field.lastIndexOf(".")) : "";
    const near = (name: string) => at(body, parent ? `${parent}.${name}` : name);
    const refresh = near("refresh_token");
    const expires = near("expires_in");
    return { ok: true, access, ...(typeof refresh === "string" && refresh ? { refresh } : {}), ...(typeof expires === "number" && expires > 0 ? { expiresInSec: expires } : {}) };
  }
  const error = at(body, "error");
  const description = at(body, "error_description");
  return { ok: false, error: typeof error === "string" && error ? `${error}${typeof description === "string" && description ? `: ${description}` : ""}` : "no access token in the answer" };
}
