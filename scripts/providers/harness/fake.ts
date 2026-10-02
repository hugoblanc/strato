/**
 * The fake tool of the conformance harness (docs/design/providers.md, section 13.5): every request a provider makes
 * through `ctx.fetch` or `http.fetch` is answered from the fixtures, recorded, and checked. Nothing reaches a network.
 *
 * Matching: method, then URL (scheme, host, path, and the query parameters as a sorted set), then the body: compared
 * as canonical JSON when the exchange gives `body`, or by substrings when it gives `bodyContains`. Headers are not
 * matched, since they carry secrets. Each exchange answers once unless it says `"repeat": true`. A GET, or an exchange
 * marked `"safe": true`, writes nothing: the only requests a dry run may make. Besides the fixtures,
 * the fake can answer every request with a 401, a 429 (Retry-After: 7) or a timeout, for the error checks.
 */

/** One request and its answer, as a fixture file writes it. */
export interface Exchange {
  request: { method: string; url: string; body?: unknown; bodyContains?: string[] };
  response?: { status?: number; headers?: Record<string, string>; body?: unknown };
  /** A request that writes nothing: a dry run may make it. */
  safe?: boolean;
  /** Answers every matching request, not only the first. */
  repeat?: boolean;
}

/** A fixture file. */
export interface Fixture {
  /** The account's secrets for the run: fake ones, never a real secret. */
  secrets?: Record<string, string>;
  /** The account's settings for the run. */
  settings?: Record<string, unknown>;
  /** The auth method of the account; the descriptor's first one by default. */
  auth?: string;
  exchanges?: Exchange[];
  expect?: {
    /** Items a poll returns, and the triage kind each must get (`null`: ignored); `rules` override the settings' rules. */
    items?: { id: string; kind: string | null; rules?: { watch?: string[]; ignore?: string[]; ignoreAuthors?: string[] } }[];
    /** Destinations a module's `parseTarget` reads: the target it must give, or an error. */
    targets?: { draftTo: string; target?: { scope: string; native: string }; error?: true }[];
  };
  /** What the act checks write: on which thread (the first thread a poll returns by default), which text, which values. */
  act?: { thread?: string; text?: string; status?: string; assignee?: string };
  /** How long the push check listens, in ms. */
  push?: { waitMs?: number };
}

/** One request the provider made, and what answered it. */
export interface Recorded {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
  /** The index of the exchange that answered, or null when none matched. */
  exchange: number | null;
  /** A request answered from a fixture that writes nothing: a GET, or an exchange marked `safe`. */
  safe: boolean;
  /** How the fake answered: from the fixtures, or with a forced error. */
  mode: FakeMode;
}

/** JSON with sorted keys: one text for one value, whatever the order its keys were written in. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** A URL as the matcher compares it: scheme, host, path, and the query as a sorted list of pairs. */
function urlKey(raw: string): string | null {
  try {
    const u = new URL(raw);
    const query = [...u.searchParams.entries()].map(([k, v]) => `${k}=${v}`).sort();
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname}?${query.join("&")}`;
  } catch {
    return null;
  }
}

/** The request matches the exchange: method, URL, then body. */
export function matches(ex: Exchange, req: { method: string; url: string; body: string }): boolean {
  if (ex.request.method.toUpperCase() !== req.method.toUpperCase()) return false;
  const a = urlKey(ex.request.url);
  if (!a || a !== urlKey(req.url)) return false;
  if (ex.request.body !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body);
    } catch {
      return typeof ex.request.body === "string" && ex.request.body === req.body;
    }
    return canonicalJson(parsed) === canonicalJson(ex.request.body);
  }
  return (ex.request.bodyContains ?? []).every((s) => req.body.includes(s));
}

export type FakeMode = "fixtures" | "401" | "429" | "timeout";

/** The fake tool: a fetch answering from the exchanges (or failing as `mode` says), and every request it received. */
export class FakeTool {
  mode: FakeMode = "fixtures";
  readonly requests: Recorded[] = [];
  private used = new Set<number>();

  constructor(private readonly exchanges: Exchange[]) {}

  /** The requests that matched no exchange. */
  get unmatched(): Recorded[] {
    return this.requests.filter((r) => r.exchange === null && r.mode === "fixtures");
  }

  /** The requests made from this point on: `since()` marks, `madeSince(mark)` reads. */
  since(): number {
    return this.requests.length;
  }
  madeSince(mark: number): Recorded[] {
    return this.requests.slice(mark);
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const body = req.body ? await req.text() : "";
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const rec: Recorded = { method: req.method, url: req.url, body, headers, exchange: null, safe: false, mode: this.mode };
    this.requests.push(rec);
    if (this.mode === "401") return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
    if (this.mode === "429") return new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "7" } });
    if (this.mode === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
    const i = this.exchanges.findIndex((ex, n) => (ex.repeat || !this.used.has(n)) && matches(ex, { method: req.method, url: req.url, body }));
    if (i < 0) return new Response(JSON.stringify({ error: "no fixture matches this request" }), { status: 599, headers: { "content-type": "application/json" } });
    this.used.add(i);
    rec.exchange = i;
    const ex = this.exchanges[i];
    rec.safe = ex.safe === true || /^(GET|HEAD|OPTIONS)$/i.test(req.method);
    const r = ex.response ?? {};
    const text = typeof r.body === "string" ? r.body : r.body === undefined ? "" : JSON.stringify(r.body);
    const type = typeof r.body === "string" ? "text/plain" : "application/json";
    return new Response(text, { status: r.status ?? 200, headers: { "content-type": type, ...(r.headers ?? {}) } });
  }) as typeof fetch;
}
