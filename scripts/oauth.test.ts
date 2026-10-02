/**
 * The OAuth 2.0 authorization code flow on the loopback (docs/design/providers.md, section 11.2): the pure helpers of
 * core/oauth.ts, and app/oauth.ts against a fake authorization server started on a free port. No network.
 */
import { describe, expect, test } from "bun:test";
import { OAuthError, runOAuth } from "./app/oauth.ts";
import { t } from "./core/i18n.ts";
import { authorizeUrlOf, endpointProblem, oauthPortProblem, pkceChallenge, redirectUriOf, tokenOf, tokenRequestBody } from "./core/oauth.ts";
import type { OAuthStep } from "./providers/sdk.ts";
import { approve, fakeAuthServer, freePort } from "./oauth-fake.ts";

const step = (fake: { url: string }, over: Partial<OAuthStep> = {}): OAuthStep => ({ kind: "oauth", authorizeUrl: `${fake.url}/authorize`, tokenUrl: `${fake.url}/token`, clientId: "setting", pkce: true, scopes: ["read", "write"], secret: "ACCESS", refreshSecret: "REFRESH", ...over });

describe("OAuth helpers", () => {
  test("the S256 challenge of RFC 7636's example verifier", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("the authorization link carries the request: scopes, state, the S256 challenge", () => {
    const step: OAuthStep = { kind: "oauth", authorizeUrl: "https://auth.example/authorize?prompt=consent", tokenUrl: "https://auth.example/token", clientId: "setting", pkce: true, scopes: ["read", "write"], secret: "ACCESS" };
    const url = new URL(authorizeUrlOf(step, { clientId: "cid", redirectUri: redirectUriOf(step, 4353), state: "st", challenge: "ch" }));
    expect(Object.fromEntries(url.searchParams)).toEqual({ prompt: "consent", response_type: "code", client_id: "cid", redirect_uri: "http://127.0.0.1:4353/oauth/callback", scope: "read write", state: "st", code_challenge: "ch", code_challenge_method: "S256" });
    expect(new URL(authorizeUrlOf({ ...step, pkce: false }, { clientId: "cid", redirectUri: "r", state: "st" })).searchParams.has("code_challenge")).toBe(false);
  });

  test("the token request sends the verifier, and a client secret only when there is one", () => {
    expect(Object.fromEntries(tokenRequestBody({ clientId: "c", code: "k", redirectUri: "r", verifier: "v" }))).toEqual({ grant_type: "authorization_code", code: "k", redirect_uri: "r", client_id: "c", code_verifier: "v" });
    expect(tokenRequestBody({ clientId: "c", code: "k", redirectUri: "r", clientSecret: "s" }).get("client_secret")).toBe("s");
  });

  test("the token response: Slack's nested user token, the plain shape with its refresh token, and refusals", () => {
    expect(tokenOf({ tokenField: "authed_user.access_token" }, { ok: true, authed_user: { access_token: "xoxp-1", refresh_token: "xoxe-1", expires_in: 43200 } })).toEqual({ ok: true, access: "xoxp-1", refresh: "xoxe-1", expiresInSec: 43200 });
    expect(tokenOf({}, { access_token: "a", refresh_token: "r" })).toEqual({ ok: true, access: "a", refresh: "r" });
    expect(tokenOf({ tokenField: "authed_user.access_token" }, { ok: false, error: "invalid_code" })).toEqual({ ok: false, error: "invalid_code" });
    expect(tokenOf({}, { error: "invalid_grant", error_description: "expired" })).toEqual({ ok: false, error: "invalid_grant: expired" });
    expect(tokenOf({}, {})).toEqual({ ok: false, error: "no access token in the answer" });
  });

  test("endpoints are https, or a loopback test server; the callback port is never the board's", () => {
    expect(endpointProblem("https://slack.com/oauth/v2/authorize")).toBeNull();
    expect(endpointProblem("http://127.0.0.1:9/token")).toBeNull();
    expect(endpointProblem("http://slack.com/oauth")).toContain("is not https");
    expect(endpointProblem("https://user:pw@slack.com/")).toContain("credentials");
    expect(oauthPortProblem(4343, 4343)).toBe("board");
    expect(oauthPortProblem(0, 4343)).toBe("invalid");
    expect(oauthPortProblem(4353, 4343)).toBeNull();
  });
});

describe("the loopback flow against a fake authorization server", () => {
  test("PKCE: S256 challenge, the same redirect at both steps, no client secret, tokens returned", async () => {
    const fake = fakeAuthServer();
    try {
      const port = freePort();
      const tokens = await runOAuth(step(fake), { clientId: "cid", port, boardPort: 4343, onUrl: (url) => void approve(url, fake) });
      expect(tokens).toEqual({ access: "tok-plain", refresh: "ref-plain", expiresInSec: 86399 });
      const [asked] = fake.seen.authorize;
      expect(asked.get("code_challenge_method")).toBe("S256");
      expect(asked.get("scope")).toBe("read write");
      expect(asked.get("redirect_uri")).toBe(`http://127.0.0.1:${port}/oauth/callback`);
      expect(fake.seen.token[0].get("redirect_uri")).toBe(asked.get("redirect_uri"));
      expect(fake.seen.token[0].get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // one code only: the listener is closed once the flow ended
      await expect(fetch(`http://127.0.0.1:${port}/oauth/callback?code=x&state=y`)).rejects.toThrow();
    } finally {
      fake.stop();
    }
  });

  test("a client secret, where the service requires one, is sent at the exchange", async () => {
    const fake = fakeAuthServer({ requireSecret: "s3cret" });
    try {
      const tokens = await runOAuth(step(fake), { clientId: "cid", clientSecret: "s3cret", port: freePort(), boardPort: 4343, onUrl: (url) => void approve(url, fake) });
      expect(tokens.access).toBe("tok-plain");
      expect(fake.seen.token[0].get("client_secret")).toBe("s3cret");
    } finally {
      fake.stop();
    }
  });

  test("refused: another request's state, a denied approval, no approval in time, the board's port, a plain-http endpoint", async () => {
    const forged = fakeAuthServer({ wrongState: true });
    const denied = fakeAuthServer({ deny: true });
    try {
      await expect(runOAuth(step(forged), { clientId: "cid", port: freePort(), boardPort: 4343, onUrl: (url) => void approve(url, forged) })).rejects.toThrow(t("cli.oauth.state"));
      expect(forged.seen.token).toHaveLength(0);
      await expect(runOAuth(step(denied), { clientId: "cid", port: freePort(), boardPort: 4343, onUrl: (url) => void approve(url, denied) })).rejects.toThrow("access_denied");
      await expect(runOAuth(step(denied), { clientId: "cid", port: freePort(), boardPort: 4343, timeoutMs: 150, onUrl: () => {} })).rejects.toBeInstanceOf(OAuthError);
      await expect(runOAuth(step(denied), { clientId: "cid", port: 4343, boardPort: 4343, onUrl: () => {} })).rejects.toThrow(t("cli.oauth.boardPort", { port: 4343 }));
      await expect(runOAuth(step(denied, { tokenUrl: "http://auth.example/token" }), { clientId: "cid", port: freePort(), boardPort: 4343, onUrl: () => {} })).rejects.toThrow("is not https");
    } finally {
      forged.stop();
      denied.stop();
    }
  });

  test("a wrong code verifier makes the exchange fail: nothing is returned", async () => {
    const fake = fakeAuthServer();
    try {
      // the fake checks the verifier against the challenge: drop PKCE from the request and keep it at the server
      let link = "";
      const done = runOAuth(step(fake), { clientId: "cid", port: freePort(), boardPort: 4343, onUrl: (url) => void (link = url) });
      while (!link) await Bun.sleep(5);
      const u = new URL(link);
      u.searchParams.set("code_challenge", pkceChallenge("another verifier"));
      await approve(u.toString(), fake);
      await expect(done).rejects.toThrow("invalid_code_verifier");
    } finally {
      fake.stop();
    }
  });
});
