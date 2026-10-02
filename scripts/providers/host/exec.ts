/**
 * External providers written in any language, as an executable speaking JSON-RPC 2.0 over stdio
 * (docs/design/providers.md, section 13.2; the message types are in providers/sdk.ts, the pure rules in protocol.ts).
 *
 * - One process per account, started at the first call (argv, no shell, in the provider's folder, a minimal
 *   environment), handshake `describe` then `initialize` with the account and its secrets, which never travel in an
 *   argument or an environment variable.
 * - One request at a time unless the provider says `concurrent`; each timeout counts from when the request is written.
 *   On a timeout Strato sends `$/cancel`; a provider that answers neither the request nor the cancel within 5 s is
 *   killed. A write that timed out may have happened: its outcome is unknown.
 * - The provider's own requests (`http.fetch`, `store.*`, `secret.set`) are answered with the context of the request
 *   in progress, or of the subscription: its fetch is limited to the API hosts, its store to the account's folder.
 * - Stderr and `log` notifications go to the account's provider.log (1 MiB, one rotation, secrets masked).
 * - A crash stays inside the account: pending calls fail as retryable (a write as unknown), a subscription ends as
 *   cut, and the next start waits 1 s, 2 s, 4 s… up to 5 minutes; five crashes in ten minutes mark the account down
 *   for fifteen minutes. A process idle for ten minutes is shut down.
 */
import type { Subprocess } from "bun";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { providerError } from "../api.ts";
import type { Account, AccountContext, ActResult, ContextResult, ExecMethods, Identity, IngestCursor, Item, PollResult, Provider, ProviderDescriptor, ProviderError } from "../sdk.ts";
import { CANCEL_GRACE_MS, EXEC_TIMEOUTS_MS, errorOfRpc, execEnv, failure, FETCH_TIMEOUT_MS, hostError, IDLE_MS, type Incoming, notification, PROTOCOL_VERSIONS, readLine, request, result, RPC, startGate, takeLines, within } from "./protocol.ts";
import { maskSecrets } from "../../core/text.ts";

export interface ExecHostOptions {
  id: string;
  argv: string[];
  cwd: string;
  /** The descriptor the person trusted: what Strato knows of the provider before any process runs. */
  descriptor: ProviderDescriptor;
  /** The log file of one account. */
  logFile: (account: Pick<Account, "provider" | "id">) => string;
  stratoVersion: string;
  /** The conformance harness: the provider is told it runs against fixtures. */
  offline?: boolean;
  /** Tests: the clock, shorter timeouts, the parent environment. */
  now?: () => number;
  timeouts?: Partial<Record<keyof ExecMethods, number>>;
  cancelGraceMs?: number;
  idleMs?: number;
  env?: Record<string, string | undefined>;
}

/** An exec provider as Strato runs it, with a way to stop its processes and to read their state (doctor, tests). */
export interface ExecProvider extends Provider {
  stopAll(): Promise<void>;
  processes(): { account: string; pid: number | null; crashes: number }[];
  /** Any request, for the conformance harness's protocol checks (an unknown method must answer -32601). */
  rpc(ctx: AccountContext, method: string, params?: unknown): Promise<unknown>;
}

type During = "read" | "write";

interface Pending {
  method: string;
  ctx: AccountContext;
  during: During;
  resolve: (v: unknown) => void;
  reject: (e: ProviderError) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** The caller was already told it timed out: the answer, or the cancel's, only frees the slot. */
  timedOut: boolean;
}

interface Subscription {
  ctx: AccountContext;
  onItems: (items: Item[], cursor?: IngestCursor) => void;
  end: (r: { end: "clean" | "cut" | "fatal"; retryAfterMs?: number; refused?: string }) => void;
}

const LOG_MAX = 1024 * 1024;
const STORE_NAME = /^[a-z0-9-]{1,40}$/;
const STORE_MAX = 1024 * 1024;

/** Every process of every exec provider of this Strato process: killed when it exits. */
const live = new Set<Subprocess>();
let exitHook = false;
function track(p: Subprocess): void {
  live.add(p);
  if (exitHook) return;
  exitHook = true;
  process.on("exit", () => {
    for (const x of live) x.kill();
  });
}

/** One account's process, from start to crash or shutdown, and the account's crash history across processes. */
class Channel {
  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private starting: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private queue: (() => void)[] = [];
  private busy = 0;
  private concurrent = false;
  private stopping = false;
  private crashes: number[] = [];
  private idle: ReturnType<typeof setTimeout> | null = null;
  private sub: Subscription | null = null;
  private secrets: string[] = [];
  /** Methods the provider answered "not found" to: asked once per process. */
  readonly unsupported = new Set<string>();
  private ctx: AccountContext;

  constructor(
    private readonly o: ExecHostOptions,
    ctx: AccountContext,
  ) {
    this.ctx = ctx;
  }

  private now = () => (this.o.now ?? Date.now)();
  get pid(): number | null {
    return this.proc?.pid ?? null;
  }
  get crashCount(): number {
    return this.crashes.length;
  }

  // ---------------------------------------------------------------- logging

  private log(line: string): void {
    const file = this.o.logFile(this.ctx.account);
    try {
      mkdirSync(dirname(file), { recursive: true });
      try {
        if (statSync(file).size > LOG_MAX) renameSync(file, `${file}.1`);
      } catch {}
      appendFileSync(file, `${new Date(this.now()).toISOString()} ${this.masked(line)}\n`);
    } catch {}
  }

  private masked(text: string): string {
    return maskSecrets(text, this.secrets);
  }

  // ---------------------------------------------------------------- lifecycle

  /** Starts the process when none runs, or tells why it cannot start yet. */
  private async ensure(ctx: AccountContext): Promise<void> {
    // a process on its way out ends first: its pending `shutdown` must not hold the slot of the next process, nor
    // its timeout kill that process
    while (this.proc && this.stopping) await this.proc.exited;
    if (this.proc) return;
    if (this.starting) return this.starting;
    const gate = startGate(this.crashes, this.now());
    if (!gate.ok) {
      const seconds = Math.ceil(gate.retryAfterMs / 1000);
      throw hostError(gate.down ? "provider_down" : "restarting", gate.down ? `${this.o.id}: the provider crashed five times within ten minutes; tried again in ${seconds} s` : `${this.o.id}: the provider restarts in ${seconds} s`, { retryAfterMs: gate.retryAfterMs, outcome: "none" });
    }
    this.starting = this.start(ctx).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(ctx: AccountContext): Promise<void> {
    this.stopping = false;
    this.unsupported.clear();
    let proc: Subprocess<"pipe", "pipe", "pipe">;
    try {
      proc = Bun.spawn(this.o.argv, { cwd: this.o.cwd, env: execEnv(this.o.env ?? process.env), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    } catch (e) {
      this.crashes.push(this.now());
      throw hostError("spawn_failed", `${this.o.id}: ${(e as Error).message}`, { outcome: "none" });
    }
    this.proc = proc;
    track(proc);
    this.readStdout(proc);
    this.readStderr(proc);
    proc.exited.then((code) => this.exited(proc, code));
    try {
      const d = (await this.send("describe", { apis: [...PROTOCOL_VERSIONS] }, ctx, "read", true)) as { api?: unknown; descriptor?: { id?: unknown; api?: { min?: unknown; max?: unknown } }; concurrent?: unknown };
      const api = typeof d?.api === "number" ? d.api : NaN;
      const range = d?.descriptor?.api;
      if (!PROTOCOL_VERSIONS.includes(api) || typeof range?.min !== "number" || typeof range.max !== "number" || api < range.min || api > range.max) {
        throw hostError("protocol_version", `${this.o.id}: the provider speaks protocol ${String(d?.api)}, Strato speaks ${PROTOCOL_VERSIONS.join(", ")}`, { fatal: true, retryable: false, outcome: "none" });
      }
      if (d.descriptor?.id !== this.o.id) throw hostError("descriptor", `${this.o.id}: the provider answers to "${String(d.descriptor?.id)}"`, { fatal: true, retryable: false, outcome: "none" });
      this.concurrent = d.concurrent === true;
      const method = this.o.descriptor.auth.find((m) => m.id === ctx.account.auth);
      const secrets: Record<string, string> = {};
      for (const s of method?.stores ?? []) {
        const v = ctx.secret(s.name);
        if (v) secrets[s.name] = v;
      }
      this.secrets = Object.values(secrets);
      const a = ctx.account;
      await this.send("initialize", { api, strato: this.o.stratoVersion, locale: ctx.locale, account: { id: a.id, label: a.label, auth: a.auth, settings: a.settings }, secrets, offline: !!this.o.offline }, ctx, "read", true);
    } catch (e) {
      const pe = providerError(e);
      this.log(`handshake failed: ${pe.message}`);
      // a provider that cannot agree on the protocol is not restarted in a loop: it is down until someone fixes it
      if (pe.fatal) this.crashes.push(...Array(5).fill(this.now()));
      await this.kill();
      throw { ...pe, outcome: "none" };
    }
  }

  /** The process ended: everything waiting on it fails, a subscription ends as cut, and a crash is counted. */
  private exited(proc: Subprocess, code: number | null): void {
    live.delete(proc);
    if (this.proc !== proc) return;
    this.proc = null;
    const expected = this.stopping;
    if (!expected) {
      this.crashes.push(this.now());
      this.crashes = this.crashes.filter((c) => this.now() - c < 60 * 60_000);
      this.log(`the process stopped (exit code ${code})`);
    }
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      this.pending.delete(id);
      if (!p.timedOut) p.reject(hostError("crashed", `${this.o.id}: the provider's process stopped (exit code ${code})`, p.during === "write" ? { outcome: "unknown" } : { outcome: "none" }));
    }
    this.busy = 0;
    const sub = this.sub;
    this.sub = null;
    sub?.end({ end: "cut" });
    this.clearIdle();
    // what was queued runs now, and finds no process: it starts one, or learns why it cannot
    for (const run of this.queue.splice(0)) run();
  }

  private async kill(): Promise<void> {
    const p = this.proc;
    if (!p) return;
    p.kill("SIGKILL");
    await p.exited;
  }

  /** Asks the process to stop, and kills it when it does not within the shutdown timeout. */
  async shutdown(): Promise<void> {
    const p = this.proc;
    if (!p) return;
    this.stopping = true;
    this.clearIdle();
    try {
      await this.send("shutdown", {}, this.ctx, "read", true);
    } catch {}
    if (!(await within(p.exited, this.timeout("shutdown"))).ok) await this.kill();
  }

  private clearIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }

  /** Nothing to do: shut down after the idle delay, unless a call or a subscription comes. */
  private armIdle(): void {
    this.clearIdle();
    if (this.sub || this.pending.size || this.queue.length || !this.proc) return;
    this.idle = setTimeout(() => void this.shutdown(), this.o.idleMs ?? IDLE_MS);
    (this.idle as { unref?: () => void }).unref?.();
  }

  private timeout(method: string): number {
    return this.o.timeouts?.[method as keyof ExecMethods] ?? EXEC_TIMEOUTS_MS[method as keyof ExecMethods] ?? 30_000;
  }

  // ---------------------------------------------------------------- requests

  /** A call from Strato: the process is started when needed, and the call waits for its turn. */
  async call(method: keyof ExecMethods, params: unknown, ctx: AccountContext, during: During = "read"): Promise<unknown> {
    this.ctx = ctx;
    this.clearIdle();
    await this.ensure(ctx);
    return this.send(method, params, ctx, during, false);
  }

  /** Writes one request when the slot is free (or at once for the handshake and a concurrent provider). */
  private send(method: string, params: unknown, ctx: AccountContext, during: During, now: boolean): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const run = () => {
        const proc = this.proc;
        if (!proc) {
          // the process died while this call waited: start again, or say why not
          this.ensure(ctx).then(() => (this.proc ? run() : reject(hostError("crashed", `${this.o.id}: no process`, { outcome: "none" }))), reject);
          return;
        }
        const id = this.nextId++;
        this.busy++;
        const p: Pending = { method, ctx, during, resolve, reject, timer: null, timedOut: false };
        p.timer = setTimeout(() => this.timedOut(id), this.timeout(method));
        this.pending.set(id, p);
        try {
          proc.stdin.write(request(id, method, params));
          proc.stdin.flush();
        } catch (e) {
          this.settle(id);
          reject(hostError("crashed", `${this.o.id}: ${(e as Error).message}`, during === "write" ? { outcome: "unknown" } : { outcome: "none" }));
        }
      };
      if (now || this.concurrent || this.busy === 0) run();
      else this.queue.push(run);
    });
  }

  /** A request without an answer in time: the caller learns it now, the provider gets `$/cancel` and 5 s more. */
  private timedOut(id: number): void {
    const p = this.pending.get(id);
    if (!p || p.timedOut) return;
    p.timedOut = true;
    p.reject(hostError("timeout", `${this.o.id}: no answer to ${p.method} within ${Math.round(this.timeout(p.method) / 1000)} s`, p.during === "write" ? { outcome: "unknown" } : { outcome: "none" }));
    this.write(notification("$/cancel", { id }));
    p.timer = setTimeout(() => {
      if (!this.pending.has(id)) return;
      this.log(`no answer to $/cancel of ${p.method} within ${Math.round((this.o.cancelGraceMs ?? CANCEL_GRACE_MS) / 1000)} s: the process is restarted`);
      void this.kill();
    }, this.o.cancelGraceMs ?? CANCEL_GRACE_MS);
  }

  /** A request is over: its slot frees for the next one. */
  private settle(id: number): void {
    const p = this.pending.get(id);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(id);
    this.busy = Math.max(0, this.busy - 1);
    const next = this.queue.shift();
    if (next) next();
    else this.armIdle();
  }

  private write(line: string): void {
    try {
      this.proc?.stdin.write(line);
      this.proc?.stdin.flush();
    } catch {}
  }

  // ---------------------------------------------------------------- what the process writes

  private async readStdout(proc: Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
    const decoder = new TextDecoder();
    let rest = "";
    try {
      for await (const chunk of proc.stdout) {
        const r = takeLines(rest, decoder.decode(chunk, { stream: true }));
        rest = r.rest;
        for (const line of r.lines) this.onLine(proc, line);
        if (r.overflow) {
          this.log("protocol error: a line longer than 4 MiB; the process is restarted");
          if (this.proc === proc) await this.kill();
          return;
        }
      }
    } catch {}
  }

  private async readStderr(proc: Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
    const decoder = new TextDecoder();
    let rest = "";
    try {
      for await (const chunk of proc.stderr) {
        const parts = (rest + decoder.decode(chunk, { stream: true })).split("\n");
        rest = (parts.pop() ?? "").slice(-8192);
        for (const line of parts) if (line.trim()) this.log(`stderr: ${line.slice(0, 8192)}`);
      }
      if (rest.trim()) this.log(`stderr: ${rest}`);
    } catch {}
  }

  private onLine(proc: Subprocess, line: string): void {
    if (this.proc !== proc) return;
    const m: Incoming = readLine(line);
    if (m.kind === "invalid") {
      this.log(`protocol error: ${m.reason}; the process is restarted`);
      void this.kill();
      return;
    }
    if (m.kind === "response") return this.onResponse(m);
    if (m.kind === "request") return void this.onRequest(m.id, m.method, m.params);
    this.onNotification(m.method, m.params);
  }

  private onResponse(m: Extract<Incoming, { kind: "response" }>): void {
    const id = typeof m.id === "number" ? m.id : Number(m.id);
    const p = this.pending.get(id);
    if (!p) return;
    this.settle(id);
    if (p.timedOut) return;
    if (m.error) {
      if (m.error.code === RPC.methodNotFound) this.unsupported.add(p.method);
      p.reject(errorOfRpc(m.error, p.during));
    } else p.resolve(m.result);
  }

  /** The context the provider's own request runs with: the oldest call in progress, else the subscription's. */
  private requestCtx(): AccountContext {
    for (const p of this.pending.values()) if (!p.timedOut) return p.ctx;
    return this.sub?.ctx ?? this.ctx;
  }

  private async onRequest(id: number | string, method: string, params: unknown): Promise<void> {
    const ctx = this.requestCtx();
    const x = (params ?? {}) as Record<string, unknown>;
    try {
      if (method === "http.fetch") return this.write(result(id, await this.fetchFor(ctx, x)));
      if (method === "store.read") {
        if (typeof x.name !== "string" || !STORE_NAME.test(x.name)) return this.write(failure(id, RPC.invalidParams, "store names are ^[a-z0-9-]{1,40}$"));
        const value = ctx.store.read<unknown>(`provider-${x.name}`, undefined);
        return this.write(result(id, value === undefined ? null : { value }));
      }
      if (method === "store.write") {
        if (typeof x.name !== "string" || !STORE_NAME.test(x.name)) return this.write(failure(id, RPC.invalidParams, "store names are ^[a-z0-9-]{1,40}$"));
        if ((JSON.stringify(x.value) ?? "").length > STORE_MAX) return this.write(failure(id, RPC.invalidParams, "a stored value is at most 1 MiB"));
        ctx.store.write(`provider-${x.name}`, x.value);
        return this.write(result(id, { ok: true }));
      }
      if (method === "secret.set") {
        if (typeof x.name !== "string" || typeof x.value !== "string") return this.write(failure(id, RPC.invalidParams, "secret.set takes { name, value }"));
        ctx.setSecret(x.name, x.value);
        this.secrets.push(x.value);
        return this.write(result(id, { ok: true }));
      }
      this.write(failure(id, RPC.methodNotFound, `Strato has no method ${method}`));
    } catch (e) {
      // a request that failed on the way (timeout, network) may succeed later: the provider can pass this on as is
      const timeout = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
      this.write(failure(id, RPC.provider, this.masked((e as Error)?.message ?? String(e)), method === "http.fetch" ? { code: timeout ? "timeout" : "network", retryable: true } : undefined));
    }
  }

  /** `http.fetch` through the account's fetch: its API hosts only, its timeout, the abort of the call that caused it. */
  private async fetchFor(ctx: AccountContext, x: Record<string, unknown>): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    if (typeof x.url !== "string") throw new Error("http.fetch takes { method, url, headers?, body? }");
    const headers = x.headers && typeof x.headers === "object" ? Object.fromEntries(Object.entries(x.headers as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string> : {};
    const body = typeof x.bodyBase64 === "string" ? Buffer.from(x.bodyBase64, "base64") : typeof x.body === "string" ? x.body : undefined;
    const res = await ctx.fetch(x.url, { method: typeof x.method === "string" ? x.method : "GET", headers, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      out[k] = v;
    });
    return { status: res.status, headers: out, body: await res.text() };
  }

  private onNotification(method: string, params: unknown): void {
    const x = (params ?? {}) as Record<string, unknown>;
    if (method === "log") return this.log(`${typeof x.level === "string" ? x.level : "info"}: ${String(x.message ?? "")}`);
    if (method === "health") return this.log(`health: ${String(x.status ?? "")}${x.detail ? ` (${String(x.detail)})` : ""}`);
    if (method === "items") {
      if (!this.sub) return this.log("items received outside a subscription: ignored");
      const items = Array.isArray(x.items) ? (x.items as Item[]) : [];
      const c = x.cursor as IngestCursor | undefined;
      const cursor = c && typeof c.value === "string" && typeof c.at === "number" ? c : undefined;
      return this.sub.onItems(items, cursor);
    }
    if (method === "subscription.end") {
      const sub = this.sub;
      this.sub = null;
      const end = x.end === "clean" || x.end === "fatal" ? x.end : "cut";
      sub?.end({ end, ...(typeof x.retryAfterMs === "number" ? { retryAfterMs: x.retryAfterMs } : {}), ...(typeof x.refused === "string" ? { refused: x.refused } : {}) });
      return this.armIdle();
    }
    this.log(`unknown notification ${method}: ignored`);
  }

  // ---------------------------------------------------------------- push

  async subscribe(ctx: AccountContext, onItems: Subscription["onItems"], events?: { opened(): void }): Promise<{ end: "clean" | "cut" | "fatal"; retryAfterMs?: number; refused?: string }> {
    let finish!: Subscription["end"];
    const ended = new Promise<{ end: "clean" | "cut" | "fatal"; retryAfterMs?: number; refused?: string }>((resolve) => {
      finish = resolve;
    });
    // the subscription exists before the request is written: items may follow its answer on the same line read
    const sub: Subscription = { ctx, onItems, end: finish };
    this.sub = sub;
    try {
      await this.call("subscribe", {}, ctx);
    } catch (e) {
      if (this.sub === sub) this.sub = null;
      const pe = providerError(e);
      if (pe.fatal || pe.code === "unsupported") return { end: "fatal", refused: pe.message };
      throw pe;
    }
    this.clearIdle();
    events?.opened();
    const stop = () => {
      if (this.sub !== sub) return;
      this.sub = null;
      finish({ end: "clean" });
      this.call("unsubscribe", {}, ctx).catch(() => {});
    };
    if (ctx.signal.aborted) stop();
    else ctx.signal.addEventListener("abort", stop, { once: true });
    return ended;
  }
}

/**
 * An exec provider: a `Provider` whose methods are requests to the account's process. It declares only what the
 * trusted descriptor declares; `replies` and `complete` are asked, and dropped for the process when it says it has
 * none. A provider of this shape has no pure functions: its links are its descriptor's patterns, its destinations are
 * typed keys (`to=<key>`), and its text is shown as plain text.
 */
export function execProvider(o: ExecHostOptions): ExecProvider {
  const provider = buildExecProvider(o);
  hosts.add(provider);
  return provider;
}

/** Every exec provider built in this Strato process, so that a command that ends can stop their processes. */
const hosts = new Set<ExecProvider>();

/**
 * Stops the processes of every exec provider of this Strato process, each with `shutdown` then a kill. A one-shot
 * command calls it before it returns: a running child and its pipes would keep the command alive until the idle delay.
 */
export async function stopExecProviders(): Promise<void> {
  await Promise.all([...hosts].map((h) => h.stopAll().catch(() => {})));
}

function buildExecProvider(o: ExecHostOptions): ExecProvider {
  const channels = new Map<string, Channel>();
  const channel = (ctx: AccountContext) => {
    const key = `${ctx.account.provider}-${ctx.account.id}`;
    let c = channels.get(key);
    if (!c) {
      c = new Channel(o, ctx);
      channels.set(key, c);
    }
    return c;
  };
  const c = o.descriptor.capabilities;
  const call = <R>(ctx: AccountContext, method: keyof ExecMethods, params: unknown = {}, during: During = "read") => channel(ctx).call(method, params, ctx, during) as Promise<R>;

  return {
    descriptor: o.descriptor,
    async connect(ctx) {
      // setup's verify step: a throwaway process with the candidate secrets, stopped once it answered
      if (!ctx.verifying) return call<Identity>(ctx, "connect");
      const once = new Channel(o, ctx);
      try {
        return (await once.call("connect", {}, ctx)) as Identity;
      } finally {
        await once.shutdown();
      }
    },
    ...(c.ingest.poll ? { poll: (ctx: AccountContext, cursor: IngestCursor | null, opts: { since: number; maxItems: number }) => call<PollResult>(ctx, "poll", { cursor, since: opts.since, maxItems: opts.maxItems }) } : {}),
    ...(c.ingest.push ? { subscribe: (ctx: AccountContext, onItems: Subscription["onItems"], events?: { opened(): void }) => channel(ctx).subscribe(ctx, onItems, events) } : {}),
    async replies(ctx, thread, opts) {
      const ch = channel(ctx);
      if (ch.unsupported.has("replies")) return [];
      try {
        const r = await call<{ items?: unknown }>(ctx, "replies", { thread, since: opts.since, max: opts.max });
        if (!Array.isArray(r?.items)) throw { code: "bad_result", message: "replies returned no items list", retryable: true, fatal: false };
        return r.items as Item[];
      } catch (e) {
        if (providerError(e).code === "unsupported") return [];
        throw e;
      }
    },
    async complete(ctx, items) {
      const ch = channel(ctx);
      if (ch.unsupported.has("complete")) return items;
      try {
        const r = await call<{ items?: unknown }>(ctx, "complete", { items });
        // the same items, in the same order, or the ones Strato already has
        return Array.isArray(r?.items) && r.items.length === items.length ? (r.items as Item[]) : items;
      } catch (e) {
        if (providerError(e).code === "unsupported") return items;
        throw e;
      }
    },
    ...(c.participation ? { participated: async (ctx: AccountContext, days: number) => ((await call<{ threads?: unknown }>(ctx, "participated", { days }))?.threads as string[]) ?? [] } : {}),
    ...(c.context ? { context: (ctx: AccountContext, thread: string, opts: { since?: number; max: number }) => call<ContextResult>(ctx, "context", { thread, ...opts }) } : {}),
    ...(c.actions.length ? { act: (ctx: AccountContext, input: Parameters<NonNullable<Provider["act"]>>[1]) => call<ActResult>(ctx, "act", input, "write") } : {}),
    ...(c.undo.length ? { undo: (ctx: AccountContext, token: string) => call<ActResult>(ctx, "undo", { token }, "write") } : {}),
    setup: {
      detect: async (ctx) => ((await call<{ fields?: unknown }>(ctx, "setup.detect"))?.fields ?? {}) as Awaited<ReturnType<NonNullable<NonNullable<Provider["setup"]>["detect"]>>>,
      check: async (ctx) => ((await call<{ items?: unknown }>(ctx, "setup.check"))?.items ?? []) as Awaited<ReturnType<NonNullable<NonNullable<Provider["setup"]>["check"]>>>,
    },
    async stopAll() {
      await Promise.all([...channels.values()].map((ch) => ch.shutdown()));
    },
    processes: () => [...channels.entries()].map(([account, ch]) => ({ account, pid: ch.pid, crashes: ch.crashCount })),
    rpc: (ctx, method, params = {}) => channel(ctx).call(method as keyof ExecMethods, params, ctx),
  };
}

/**
 * `describe` alone, in a throwaway process without secrets: what `provider trust`, the harness and `provider list`
 * read before anything else. Shut down after it answered, killed if it does not stop.
 */
export async function describeExec(o: Pick<ExecHostOptions, "id" | "argv" | "cwd" | "env" | "timeouts">): Promise<{ api: number; descriptor: unknown; concurrent: boolean }> {
  const proc = Bun.spawn(o.argv, { cwd: o.cwd, env: execEnv(o.env ?? process.env), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  track(proc);
  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  let rest = "";
  // what the process said on stderr, for the error when it stops: usually why it could not start
  let said = "";
  void (async () => {
    try {
      for await (const chunk of proc.stderr) said = (said + new TextDecoder().decode(chunk)).slice(-2048);
    } catch {}
  })();
  const stderrTail = () => {
    const last = said.trim().split("\n").at(-1) ?? "";
    return last ? `: ${last.slice(0, 300)}` : "";
  };
  // one read at a time: a read that outlived a wait is the next wait's
  let reading: ReturnType<typeof reader.read> | null = null;
  const answer = async (id: number, timeoutMs: number): Promise<{ result?: unknown; error?: { code: number; message: string } }> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) throw hostError("timeout", `${o.id}: no answer to describe within ${Math.round(timeoutMs / 1000)} s`);
      reading ??= reader.read();
      const got = await within(reading, left);
      if (!got.ok) continue;
      reading = null;
      const chunk = got.value;
      if (chunk.done) {
        await within(proc.exited, 200);
        throw hostError("crashed", `${o.id}: the provider's process stopped before answering describe${stderrTail()}`);
      }
      const r = takeLines(rest, decoder.decode(chunk.value, { stream: true }));
      rest = r.rest;
      for (const line of r.lines) {
        const m = readLine(line);
        if (m.kind === "invalid") throw hostError("protocol", `${o.id}: ${m.reason}`, { retryable: false });
        if (m.kind === "response" && Number(m.id) === id) return m;
      }
    }
  };
  try {
    proc.stdin.write(request(1, "describe", { apis: [...PROTOCOL_VERSIONS] }));
    proc.stdin.flush();
    const m = await answer(1, o.timeouts?.describe ?? EXEC_TIMEOUTS_MS.describe);
    if (m.error) throw errorOfRpc(m.error);
    const r = (m.result ?? {}) as { api?: unknown; descriptor?: unknown; concurrent?: unknown };
    if (typeof r.api !== "number" || !PROTOCOL_VERSIONS.includes(r.api)) throw hostError("protocol_version", `${o.id}: the provider speaks protocol ${String(r.api)}, Strato speaks ${PROTOCOL_VERSIONS.join(", ")}`, { fatal: true, retryable: false });
    proc.stdin.write(request(2, "shutdown", {}));
    proc.stdin.flush();
    await answer(2, EXEC_TIMEOUTS_MS.shutdown).catch(() => null);
    return { api: r.api, descriptor: r.descriptor, concurrent: r.concurrent === true };
  } finally {
    if (!(await within(proc.exited, 1_000)).ok) proc.kill("SIGKILL");
    live.delete(proc);
  }
}
