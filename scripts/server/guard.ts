/**
 * What the local server accepts, as pure functions: the target host, the origin of a POST, and the terminals' path token.
 * The server only listens on 127.0.0.1, but a page open in the browser can still reach it: through a direct POST
 * (the origin gives it away) or through DNS rebinding, where a foreign domain resolves to 127.0.0.1 and becomes
 * "same origin" as the server (the host gives it away).
 */

/** The only Host header values a page of the board or the panel sends. */
export function hostAllowed(host: string | null, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/**
 * A POST comes from the board or the panel: the browser always sets the page's origin.
 * Without an origin, only the panel's iTerm2 script is expected, and only on the routes that accept it (focus).
 */
export function originAllowed(origin: string | null, port: number, allowMissing = false): boolean {
  if (origin === null) return allowMissing;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

/** The routes the iTerm2 script calls without an Origin header. */
export const ORIGINLESS_ROUTES = new Set(["POST /api/focus"]);

/**
 * Secret path of a ttyd terminal: ttyd only serves under this prefix, and also checks the WebSocket's origin (-O).
 * A page from another site does not know the prefix, and neither does a DNS rebinding on the terminal's port.
 */
export function terminalBasePath(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return "/" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
