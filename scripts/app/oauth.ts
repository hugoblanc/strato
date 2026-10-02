/**
 * The OAuth 2.0 authorization code flow on the loopback, shared by every provider (docs/design/providers.md, section
 * 11.2): a one-shot listener on 127.0.0.1 at the fixed callback port, PKCE (S256) when the step asks for it, `state`
 * checked, the listener closed after the first answer or after five minutes, then the code exchanged for a token.
 * The person approves in their own browser; Strato never sees their password, and reads no cookie nor any other
 * application's storage.
 */
import { randomBytes } from "node:crypto";
import { t } from "../core/i18n.ts";
import { authorizeUrlOf, CALLBACK_PATH, endpointProblem, oauthPortProblem, pkceChallenge, REDIRECT_HOSTS, redirectUriOf, base64url, tokenOf, tokenRequestBody } from "../core/oauth.ts";
import type { OAuthStep } from "../providers/sdk.ts";
import { escapeHtml } from "../core/text.ts";

/** A flow that did not end with a token, its reason in the person's language. */
export class OAuthError extends Error {}

export interface OAuthTokens {
  access: string;
  refresh?: string;
  expiresInSec?: number;
}

export interface OAuthOptions {
  clientId: string;
  /** Only where the service requires one even with PKCE. */
  clientSecret?: string;
  /** The callback port (`ui.oauthPort`), and the board's, which it may never be. */
  port: number;
  boardPort: number;
  /** Called once with the link to approve: print it, open it. */
  onUrl(url: string): void;
  /** Five minutes by default. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}


/** The page the browser shows after the redirect: one sentence, no script, nothing from the query echoed but escaped. */
const page = (title: string, status: number) =>
  new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Strato</title></head><body style="font-family:system-ui,sans-serif;margin:3rem"><p>${escapeHtml(title)}</p></body></html>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });

/**
 * Runs the flow and returns the tokens, or throws an OAuthError. The listener takes one answer: the code with the
 * right `state`, an error, or a wrong `state` (refused, and the flow ends, since it may come from another page).
 */
export async function runOAuth(step: OAuthStep, o: OAuthOptions): Promise<OAuthTokens> {
  const portProblem = oauthPortProblem(o.port, o.boardPort);
  if (portProblem === "board") throw new OAuthError(t("cli.oauth.boardPort", { port: o.port }));
  if (portProblem) throw new OAuthError(t("cli.oauth.badPort", { port: o.port }));
  for (const url of [step.authorizeUrl, step.tokenUrl]) {
    const problem = endpointProblem(url);
    if (problem) throw new OAuthError(t("cli.oauth.endpoint", { problem }));
  }
  if (step.redirectHost !== undefined && !(REDIRECT_HOSTS as readonly string[]).includes(step.redirectHost)) throw new OAuthError(t("cli.oauth.redirectHost", { host: String(step.redirectHost) }));
  const verifier = step.pkce ? base64url(randomBytes(32)) : undefined;
  const state = base64url(randomBytes(16));
  const redirectUri = redirectUriOf(step, o.port);

  let settle: (r: { code: string } | { error: string }) => void = () => {};
  const answer = new Promise<{ code: string } | { error: string }>((resolve) => {
    settle = resolve;
  });
  let done = false;
  const finish = (r: { code: string } | { error: string }) => {
    if (done) return;
    done = true;
    settle(r);
  };
  const handler = (req: Request): Response => {
    const u = new URL(req.url);
    if (req.method !== "GET" || u.pathname !== CALLBACK_PATH || done) return new Response("", { status: 404 });
    const error = u.searchParams.get("error");
    if (u.searchParams.get("state") !== state) {
      finish({ error: t("cli.oauth.state") });
      return page(t("cli.oauth.page.refused"), 400);
    }
    if (error) {
      finish({ error: t("cli.oauth.denied", { error: error.slice(0, 100) }) });
      return page(t("cli.oauth.page.refused"), 400);
    }
    const code = u.searchParams.get("code");
    if (!code) {
      finish({ error: t("cli.oauth.noCode") });
      return page(t("cli.oauth.page.refused"), 400);
    }
    finish({ code });
    return page(t("cli.oauth.page.done"), 200);
  };

  const servers: ReturnType<typeof Bun.serve>[] = [];
  try {
    servers.push(Bun.serve({ hostname: "127.0.0.1", port: o.port, fetch: handler }));
  } catch (e) {
    throw new OAuthError(t("cli.oauth.listen", { port: o.port, error: (e as Error).message }));
  }
  // a browser may resolve localhost to ::1 first: listen there too when the machine has it
  if (step.redirectHost === "localhost") {
    try {
      servers.push(Bun.serve({ hostname: "::1", port: o.port, fetch: handler }));
    } catch {}
  }
  const timer = setTimeout(() => finish({ error: t("cli.oauth.timeout", { minutes: Math.round((o.timeoutMs ?? 300_000) / 60_000) || 1 }) }), o.timeoutMs ?? 300_000);
  let result: { code: string } | { error: string };
  try {
    o.onUrl(authorizeUrlOf(step, { clientId: o.clientId, redirectUri, state, ...(verifier ? { challenge: pkceChallenge(verifier) } : {}) }));
    result = await answer;
  } finally {
    clearTimeout(timer);
    // graceful: the page of the last answer is still sent, no new connection is accepted
    for (const s of servers) s.stop();
  }
  if ("error" in result) throw new OAuthError(result.error);

  let body: unknown;
  try {
    const res = await (o.fetchImpl ?? fetch)(step.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: tokenRequestBody({ clientId: o.clientId, code: result.code, redirectUri, ...(verifier ? { verifier } : {}), ...(o.clientSecret ? { clientSecret: o.clientSecret } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    body = JSON.parse(await res.text());
  } catch (e) {
    throw new OAuthError(t("cli.oauth.exchange", { error: (e as Error).message }));
  }
  const token = tokenOf(step, body);
  if (!token.ok) throw new OAuthError(t("cli.oauth.refused", { error: token.error.slice(0, 200) }));
  return { access: token.access, ...(token.refresh ? { refresh: token.refresh } : {}), ...(token.expiresInSec ? { expiresInSec: token.expiresInSec } : {}) };
}
