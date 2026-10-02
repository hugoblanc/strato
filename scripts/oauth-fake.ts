/**
 * A fake OAuth 2.0 authorization server for the tests, on a free loopback port, and the browser that approves on it.
 * Nothing leaves the machine.
 */
import { pkceChallenge } from "./core/oauth.ts";

/** A free TCP port on the loopback, closed again. */
export function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

/**
 * A fake authorization server: `/authorize` checks the request and sends the browser back to the redirect URI with a
 * code (or with another `state`, or an error, when the test asks); `/token` checks the code, the redirect URI and the
 * PKCE verifier against the challenge it received, and answers Slack's shape or the plain OAuth one.
 */
export function fakeAuthServer(o: { shape?: "slack" | "plain"; wrongState?: boolean; deny?: boolean; requireSecret?: string } = {}) {
  const seen: { authorize: URLSearchParams[]; token: URLSearchParams[] } = { authorize: [], token: [] };
  const codes = new Map<string, { challenge: string | null; redirect: string }>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname.endsWith("/authorize")) {
        const q = u.searchParams;
        seen.authorize.push(q);
        const redirect = q.get("redirect_uri") ?? "";
        if (o.deny) return Response.redirect(`${redirect}?error=access_denied&state=${q.get("state")}`, 302);
        const code = `code-${seen.authorize.length}`;
        codes.set(code, { challenge: q.get("code_challenge"), redirect });
        return Response.redirect(`${redirect}?code=${code}&state=${o.wrongState ? "forged" : q.get("state")}`, 302);
      }
      if (u.pathname.endsWith("/token") || u.pathname.endsWith("/oauth.v2.access")) {
        const body = new URLSearchParams(await req.text());
        seen.token.push(body);
        const grant = codes.get(body.get("code") ?? "");
        const bad = (error: string) => Response.json(o.shape === "slack" ? { ok: false, error } : { error }, { status: o.shape === "slack" ? 200 : 400 });
        if (!grant || grant.redirect !== body.get("redirect_uri")) return bad("invalid_grant");
        if (grant.challenge && pkceChallenge(body.get("code_verifier") ?? "") !== grant.challenge) return bad("invalid_code_verifier");
        if (o.requireSecret && body.get("client_secret") !== o.requireSecret) return bad("invalid_client");
        if (!o.requireSecret && body.has("client_secret")) return bad("client_secret_sent");
        codes.delete(body.get("code") ?? "");
        return Response.json(o.shape === "slack" ? { ok: true, team: { id: "T0ACME0000", name: "Acme" }, authed_user: { id: "UALICE", access_token: "xoxp-oauth-fake-7777", token_type: "user", scope: "search:read" } } : { access_token: "tok-plain", refresh_token: "ref-plain", expires_in: 86399, token_type: "Bearer" });
      }
      return new Response("", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) };
}

/** The browser: follows the authorization link on the fake server, then its redirect to Strato's callback. */
export async function approve(authorizeUrl: string, fake: { url: string }) {
  const u = new URL(authorizeUrl);
  return fetch(`${fake.url}${u.pathname}${u.search}`);
}
