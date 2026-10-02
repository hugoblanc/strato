/**
 * An exec provider for the tests, speaking the JSON-RPC protocol of docs/design/providers.md section 13.2 over its
 * stdin and stdout: a ticket tool on tickets.example whose every request to the tool goes through Strato's
 * `http.fetch`. Run as `bun test-exec-provider.ts [--mode <mode>]`; the modes make it break the contract on purpose:
 *
 *   crash-on-poll     exits in the middle of a poll
 *   crash-on-act      exits in the middle of a write, after it reached the tool
 *   hang-on-poll      never answers a poll; answers $/cancel with -32004, unless --cancel ignore
 *   old-protocol      answers describe with a protocol version Strato does not speak
 *   noise             writes a line that is not JSON-RPC on stdout when connecting
 *   no-replies        answers -32601 to replies and complete
 *   stubborn          ignores the end of its stdin and keeps running; writes its pid to --pid-file
 *
 * Self-contained on purpose (types only from the SDK file): it is what an author's provider looks like.
 */
import type { ActInput, Item, ProviderDescriptor } from "./providers/sdk.ts";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const mode = opt("mode") ?? "normal";
const text = (en: string) => ({ en });

const descriptor: ProviderDescriptor = {
  id: opt("id") ?? "tickets",
  label: text("Tickets"),
  api: { min: 1, max: 1 },
  kinds: ["tracker"],
  capabilities: { ingest: { push: true, poll: true }, participation: false, context: true, actions: ["comment"], undo: ["comment"], idempotent: ["comment"], edits: false, identity: false },
  auth: [{ id: "api-key", kind: "api-key", label: text("API key"), docs: "https://tickets.example/docs/api-keys", steps: [{ kind: "paste", secret: "TICKETS_API_KEY", say: text("Paste your API key") }, { kind: "verify" }], stores: [{ name: "TICKETS_API_KEY" }] }],
  settings: [
    { key: "me", type: "string", label: text("Your user id"), ask: text("Your user id?"), triage: "me" },
    { key: "watchTeams", type: "string[]", label: text("Watched teams"), default: [], ask: text("Which teams?"), triage: "watch" },
  ],
  vocabulary: { item: text("comment"), thread: text("ticket"), conversation: text("team"), targetFormat: "the ticket's key, such as tickets:OPS-7" },
  links: { parse: [{ host: "tickets.example", pattern: "^/t/([A-Z]+-\\d+)", thread: "$1" }], of: [{ match: "^([A-Z]+-\\d+)$", url: "https://tickets.example/t/$1" }] },
  hosts: ["tickets.example"],
  apiHosts: ["tickets.example"],
  undoMs: 30_000,
};

let nextId = 1;
const waiting = new Map<number, (v: { result?: any; error?: any }) => void>();
let secrets: Record<string, string> = {};
let settings: Record<string, unknown> = {};

const send = (m: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
const reply = (id: number | string, result: unknown) => send({ id, result });
const error = (id: number | string, code: number, message: string, data?: object) => send({ id, error: { code, message, ...(data ? { data } : {}) } });

/** A request to Strato (`http.fetch`, `store.*`), answered while Strato's own request is pending. */
function ask(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => waiting.set(id, (v) => (v.error ? reject({ code: -32000, message: v.error.message, data: v.error.data }) : resolve(v.result))));
}

const api = async (method: string, path: string, body?: unknown) => {
  // a request that failed on the way (timeout, network) comes back with Strato's error data: it is passed on as is
  const r = await ask("http.fetch", { method, url: `https://tickets.example${path}`, headers: { authorization: `Bearer ${secrets.TICKETS_API_KEY ?? ""}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (r.status === 401 || r.status === 403) throw { code: -32002, message: "the API key was refused", data: { code: "invalid_auth", fatal: true } };
  if (r.status === 429) throw { code: -32003, message: "rate limited", data: { code: "rate_limited", retryable: true, retryAfterMs: Number(r.headers["retry-after"] ?? 1) * 1000 } };
  if (r.status >= 400) throw { code: -32000, message: `HTTP ${r.status}`, data: { code: "http", retryable: r.status >= 500 } };
  return JSON.parse(r.body || "null");
};

const item = (n: { id: string; ticket: string; author: string; text: string; at: number }): Item => ({
  thread: n.ticket,
  id: n.id,
  event: "comment",
  author: { id: n.author, name: n.author, isMe: n.author === settings.me, isBot: false },
  conversation: { id: n.ticket.split("-")[0], label: `Team ${n.ticket.split("-")[0]}`, kind: "ticket" },
  text: n.text,
  time: n.at,
  link: `https://tickets.example/t/${n.ticket}`,
  mentionsMe: n.text.includes(`@${settings.me}`),
  targetsOther: false,
});

const handlers: Record<string, (p: any) => Promise<unknown> | unknown> = {
  describe: () => ({ api: mode === "old-protocol" ? 99 : 1, descriptor }),
  initialize: (p) => {
    secrets = p.secrets ?? {};
    settings = p.account?.settings ?? {};
    process.stderr.write(`started for ${p.account?.id} with key ${secrets.TICKETS_API_KEY ?? "-"}\n`);
    return { ok: true };
  },
  connect: async () => {
    if (mode === "noise") process.stdout.write("hello from a print statement\n");
    const me = await api("GET", "/api/me");
    // the environment the provider was started with, so a test can check that no secret is in it
    return { me: me.id, name: Object.keys(process.env).sort().join(","), workspace: me.workspace };
  },
  poll: async (p) => {
    if (mode === "crash-on-poll") process.exit(3);
    if (mode === "hang-on-poll") return new Promise(() => {});
    const since = Number(p.cursor?.value ?? 0);
    const list: { id: string; ticket: string; author: string; text: string; at: number }[] = await api("GET", "/api/notifications");
    const fresh = list.filter((n) => n.at > since).sort((a, b) => a.at - b.at);
    const kept = fresh.slice(-p.maxItems);
    const newest = kept.length ? kept[kept.length - 1].at : since;
    return { items: kept.map(item), cursor: { value: String(kept.length < fresh.length ? kept[0].at - 1 : newest), at: newest }, complete: kept.length === fresh.length };
  },
  subscribe: () => {
    setTimeout(() => {
      send({ method: "items", params: { items: [item({ id: "n-9", ticket: "OPS-9", author: "bob", text: "pushed", at: 1_790_000_900_000 })], cursor: { value: "1790000900000", at: 1_790_000_900_000 } } });
      send({ method: "items", params: { items: [] } });
      send({ method: "log", params: { level: "info", message: `pushed with ${secrets.TICKETS_API_KEY}` } });
      send({ method: "health", params: { status: "ok" } });
    }, 10);
    return { ok: true };
  },
  unsubscribe: () => ({ ok: true }),
  replies: async (p) => {
    if (mode === "no-replies") throw { code: -32601, message: "no replies" };
    return { items: p.thread === "OPS-7" ? [item({ id: "n-8", ticket: "OPS-7", author: "carol", text: "a reply", at: 1_790_000_800_000 })] : [] };
  },
  complete: (p) => {
    if (mode === "no-replies") throw { code: -32601, message: "no complete" };
    return { items: p.items };
  },
  context: async (p) => {
    const t = await api("GET", `/api/tickets/${p.thread}`);
    return { thread: p.thread, link: `https://tickets.example/t/${p.thread}`, conversation: { id: "OPS", label: "Team OPS", kind: "ticket" }, title: t.title, items: t.comments, complete: true, fetchedAt: 1 };
  },
  act: async (p: ActInput) => {
    if (p.action.kind !== "comment") throw { code: -32000, message: "only comments", data: { code: "unsupported", outcome: "none" } };
    if (p.dryRun) return { ok: true, ref: "", link: `https://tickets.example/t/${p.action.target.native}`, dry: `comment on ${p.action.target.native}` };
    if (mode === "crash-on-act") {
      await api("POST", `/api/tickets/${p.action.target.native}/comments`, { body: p.action.text });
      process.exit(4);
    }
    const c = await api("POST", `/api/tickets/${p.action.target.native}/comments`, { body: p.action.text, idempotencyKey: p.idempotencyKey });
    return { ok: true, ref: c.id, link: `https://tickets.example/t/${p.action.target.native}#${c.id}`, undo: { token: c.id, until: Date.now() + 30_000 } };
  },
  undo: async (p) => {
    await api("DELETE", `/api/comments/${p.token}`);
    return { ok: true, ref: p.token, link: "" };
  },
  shutdown: () => {
    setTimeout(() => process.exit(0), 5);
    return { ok: true };
  },
};

const pending = new Map<number | string, boolean>();

async function onMessage(m: any): Promise<void> {
  if (m.method === undefined) {
    // an answer to one of our requests
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
    return;
  }
  if (m.id === undefined) {
    if (m.method === "$/cancel" && pending.has(m.params?.id) && opt("cancel") !== "ignore") {
      pending.delete(m.params.id);
      error(m.params.id, -32004, "cancelled");
    }
    return;
  }
  const h = handlers[m.method];
  if (!h) {
    error(m.id, -32601, `no method ${m.method}`);
    return;
  }
  pending.set(m.id, true);
  try {
    const r = await h(m.params ?? {});
    if (pending.delete(m.id)) reply(m.id, r);
  } catch (e: any) {
    if (pending.delete(m.id)) error(m.id, typeof e?.code === "number" ? e.code : -32000, e?.message ?? String(e), e?.data);
  }
}

let rest = "";
process.stdin.on("data", (chunk) => {
  const lines = (rest + chunk.toString()).split("\n");
  rest = lines.pop() ?? "";
  for (const line of lines) if (line.trim()) void onMessage(JSON.parse(line));
});
process.stdin.on("end", () => {
  if (mode !== "stubborn") process.exit(0);
});
if (mode === "stubborn") {
  const file = opt("pid-file");
  if (file) (await import("node:fs")).writeFileSync(file, String(process.pid));
  setInterval(() => {}, 60_000);
}
