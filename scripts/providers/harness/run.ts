/**
 * The conformance harness, inside its own process (docs/design/providers.md, section 13.5): `strato provider test`
 * starts it on a throwaway state folder, so the gate, the topics and the event log it uses are its own. It loads the
 * provider under test, answers every request from the fixtures (providers/harness/fake.ts), and prints one line per
 * check: ok, fail with the reason, skip, or not verifiable offline.
 *
 * Offline by construction: the global fetch of this process refuses everything before the provider is loaded, and a
 * provider's fetch is the fake; the secrets are the fixtures' fake ones. Writes go only through the gate (app/act.ts):
 * dry runs for every action kind, then real acts against the fake when every request went through it.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { actOnTask, dryRunTask, undoTask } from "../../app/act.ts";
import { F, writeJson } from "../../app/env.ts";
import { checkedIdentity, isItem } from "../../app/ingest.ts";
import { loadSujets } from "../../app/store.ts";
import { planOfTask, planSha } from "../../core/gate.ts";
import { contextProblem } from "../../core/context.ts";
import { t } from "../../core/i18n.ts";
import { canonicalKey, formatKey, parseKey } from "../../core/keys.ts";
import { linkOfNative, parseLink, pureOf } from "../../core/links.ts";
import { resolveSettings, useSettings } from "../../core/settings.ts";
import { STRATO_VERSION } from "../../core/build-info.ts";
import { classifyItem, triageRules } from "../../core/triage.ts";
import { findTask } from "../../core/tasks.ts";
import { oneLine, truncate } from "../../core/text.ts";
import { effectiveCapabilities, providerError } from "../api.ts";
import { descriptorProblems } from "../check.ts";
import { describeExec, type ExecProvider, execProvider } from "../host/exec.ts";
import { importModule, LoadError } from "../host/module.ts";
import { accountContext, accountOf, addProvider, type AccountEntry, useBaseFetch } from "../registry.ts";
import type { ActionKind, AccountContext, Item, PollResult, Provider, ProviderDescriptor } from "../sdk.ts";
import { FakeTool, type Fixture, type Recorded } from "./fake.ts";

/** What `provider test` hands its harness process, in `<state>/harness.json`. */
export interface HarnessSpec {
  /** Proves the state folder was made by `provider test`: the same value is in the process's environment. */
  nonce: string;
  target: { shape: "module"; file: string } | { shape: "exec"; argv: string[]; cwd: string };
  /** Where the fixture files are; null: none. */
  fixturesDir: string | null;
  /** `--live`: the person's own account, read checks only. */
  live: { settings: Record<string, unknown>; secretsFile: string; auth: string } | null;
  /** The person's language, for the lines. */
  locale: "en" | "fr";
}

export type Status = "ok" | "fail" | "skip" | "offline";

const SAMPLE_TEXT = "Strato conformance check";
/** Characters a provider string never carries: control characters other than a tab or a line break in a text. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this finds
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this finds
const CONTROL_ANY = /[\u0000-\u001f\u007f]/;
const TEXT_MAX = 1024 * 1024;

class Report {
  failed = false;
  constructor(private readonly say: (line: string) => void) {}
  line(status: Status, check: string, detail = ""): void {
    if (status === "fail") this.failed = true;
    const word = t(`cli.provider.test.${status}` as Parameters<typeof t>[0]);
    // a provider's own words (its errors, its dry descriptions) stay on the line they belong to
    this.say(`${word.padEnd(7)} ${check}${detail ? `: ${oneLine(truncate(detail, 500))}` : ""}`);
  }
}

const reason = (e: unknown) => (e instanceof LoadError ? e.problems.join("; ") : providerError(e).message);

/** The provider under test, loaded the way Strato loads it, with its descriptor checked (pattern timing included). */
async function load(spec: HarnessSpec, report: Report): Promise<{ provider: Provider; exec: ExecProvider | null } | null> {
  let descriptor: unknown;
  try {
    if (spec.target.shape === "module") {
      const raw = (await import(pathToFileURL(spec.target.file).href)) as { default?: { descriptor?: unknown }; provider?: { descriptor?: unknown } };
      descriptor = (raw.default ?? raw.provider)?.descriptor;
    } else descriptor = (await describeExec({ id: "provider", argv: spec.target.argv, cwd: spec.target.cwd })).descriptor;
  } catch (e) {
    report.line("fail", "descriptor", reason(e));
    return null;
  }
  const id = (descriptor as { id?: unknown } | undefined)?.id;
  const problems = descriptorProblems(descriptor, typeof id === "string" ? id : undefined);
  if (problems.length || typeof id !== "string") {
    report.line("fail", "descriptor", problems.join("; "));
    return null;
  }
  try {
    if (spec.target.shape === "module") return { provider: await importModule(spec.target.file, id), exec: null };
    const exec = execProvider({ id, argv: spec.target.argv, cwd: spec.target.cwd, descriptor: descriptor as ProviderDescriptor, logFile: () => join(F.providers, "provider.log"), stratoVersion: STRATO_VERSION, offline: !spec.live });
    return { provider: exec, exec };
  } catch (e) {
    report.line("fail", "descriptor", reason(e));
    return null;
  }
}

/** The fixture files of a folder, in name order; one empty fixture when there is none. */
function fixtures(dir: string | null): { name: string; fixture: Fixture }[] {
  if (!dir || !existsSync(dir)) return [{ name: "", fixture: {} }];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (!files.length) return [{ name: "", fixture: {} }];
  return files.map((f) => ({ name: f, fixture: JSON.parse(readFileSync(join(dir, f), "utf8")) as Fixture }));
}

/**
 * Runs every check and says whether all passed. The profile of this throwaway state names the provider with one
 * account, `default`, whose settings and secrets come from the fixture (or, live, from the person's account).
 */
export async function runHarness(spec: HarnessSpec, say: (line: string) => void): Promise<boolean> {
  const report = new Report(say);
  const loaded = await load(spec, report);
  if (!loaded) return false;
  const { provider, exec } = loaded;
  const d = provider.descriptor;
  report.line("ok", "descriptor");
  try {
    addProvider(provider);
  } catch (e) {
    report.line("fail", "descriptor", reason(e));
    return false;
  }
  for (const { name, fixture } of spec.live ? [{ name: "", fixture: {} as Fixture }] : fixtures(spec.fixturesDir)) {
    if (name) say(t("cli.provider.test.fixture", { name }));
    await runFixture(spec, provider, exec, d, fixture, report);
  }
  await exec?.stopAll();
  return !report.failed;
}

/** One fixture: its account, then the checks in order. */
async function runFixture(spec: HarnessSpec, provider: Provider, exec: ExecProvider | null, d: ProviderDescriptor, fx: Fixture, report: Report): Promise<void> {
  const fake = new FakeTool(fx.exchanges ?? []);
  const secretsFile = spec.live ? spec.live.secretsFile : join(F.providers, "secrets.env");
  if (!spec.live) writeFileSync(secretsFile, Object.entries(fx.secrets ?? {}).map(([k, v]) => `${k}=${v}\n`).join(""), { mode: 0o600 });
  const auth = spec.live?.auth ?? fx.auth ?? d.auth[0]?.id ?? "none";
  const raw = {
    owner: { name: "Alice" },
    ui: { locale: spec.locale },
    workers: { shadow: false },
    providers: { [d.id]: { accounts: { default: { auth, secretsFile, ...(spec.live?.settings ?? fx.settings ?? {}) } } } },
  };
  writeJson(F.config, raw);
  useSettings(resolveSettings(raw));
  writeJson(F.sujets, []);
  const entry = accountOf(d.id, "default") as AccountEntry;
  // every account context of this process answers from the fake, the gate's included: nothing reaches a network
  if (!spec.live) useBaseFetch(fake.fetch);
  const ctx = (o: { signal?: AbortSignal } = {}): AccountContext => accountContext(entry, { ...o, log: () => {} });
  const caps = effectiveCapabilities(d, auth);
  const live = !!spec.live;

  // ---- protocol (exec): an unknown method answers -32601
  if (exec) {
    try {
      await exec.rpc(ctx(), "strato.conformance.unknown", {});
      report.line("fail", "protocol", t("cli.provider.test.unknownMethod"));
    } catch (e) {
      const pe = providerError(e);
      report.line(pe.code === "unsupported" ? "ok" : "fail", "protocol", pe.code === "unsupported" ? "" : t("cli.provider.test.unknownMethod"));
    }
  }

  // ---- connect
  let mark = fake.since();
  try {
    const identity = checkedIdentity(await provider.connect(ctx()));
    if (!identity?.me) report.line("fail", "connect", t("cli.provider.test.noIdentity"));
    else report.line("ok", "connect", t("cli.provider.test.identity", { me: identity.me, workspace: identity.workspace }));
  } catch (e) {
    report.line("fail", "connect", reason(e));
  }
  const connectRequests = fake.madeSince(mark).length;

  // ---- poll
  let items: Item[] = [];
  let pollOffline = false;
  let pollRequests = 0;
  if (caps.ingest.poll && provider.poll) {
    mark = fake.since();
    const poll = provider.poll.bind(provider);
    try {
      const first = await poll(ctx(), null, { since: 0, maxItems: 50 });
      const problems = pollProblems(first);
      items = Array.isArray(first?.items) ? first.items.filter(isItem) : [];
      if (!problems.length) {
        const again = await poll(ctx(), first.cursor, { since: 0, maxItems: 50 });
        const seen = new Set(items.map((i) => i.id));
        const repeated = (again?.items ?? []).filter((i) => seen.has(i?.id)).length;
        if (repeated) problems.push(t("cli.provider.test.repeated", { n: repeated }));
        if (items.length >= 2) {
          const capped = await poll(ctx(), null, { since: 0, maxItems: 1 });
          if ((capped?.items ?? []).length > 1 || capped?.complete !== false) problems.push(t("cli.provider.test.cap"));
          else {
            const next = await poll(ctx(), capped.cursor, { since: 0, maxItems: 50 });
            if (next?.complete !== true) problems.push(t("cli.provider.test.noProgress"));
          }
        }
      }
      pollRequests = fake.madeSince(mark).length;
      pollOffline = !live && items.length > 0 && pollRequests === 0;
      if (problems.length) report.line("fail", "poll", problems.join("; "));
      else if (pollOffline) report.line("offline", "poll", t("cli.provider.test.noRequest"));
      else report.line("ok", "poll", t("cli.provider.test.items", { n: items.length }));
    } catch (e) {
      report.line("fail", "poll", reason(e));
    }
  } else report.line("skip", "poll", t("cli.provider.test.notDeclared"));

  // ---- links: of then parse gives the same native thread
  const threads = [...new Set(items.map((i) => i.thread))];
  if (!threads.length) report.line("skip", "links", t("cli.provider.test.noThread"));
  else {
    const broken = threads.filter((th) => {
      const link = linkOfNative(d.id, "default", th);
      return !link || parseLink(link)?.thread !== th;
    });
    report.line(broken.length ? "fail" : "ok", "links", broken.length ? t("cli.provider.test.links", { threads: broken.join(", ") }) : "");
  }

  // ---- keys: each thread's key reads back as the same thread, in its one stored form
  if (!threads.length) report.line("skip", "keys", t("cli.provider.test.noThread"));
  else {
    const broken = threads.filter((th) => {
      const key = formatKey(d.id, "default", th);
      const p = key ? parseKey(key) : null;
      // a long native id becomes a hash the registry maps back: the key only has to be its own canonical form
      return !key || !p || p.provider !== d.id || p.account !== "default" || (!p.long && p.native !== th) || canonicalKey(key) !== key;
    });
    report.line(broken.length ? "fail" : "ok", "keys", broken.length ? t("cli.provider.test.keys", { threads: broken.join(", ") }) : "");
  }

  // ---- triage
  const expected = fx.expect?.items ?? [];
  if (!expected.length) report.line("skip", "triage", t("cli.provider.test.noExpect"));
  else {
    const rules = triageRules(entry.account.settings, d.settings);
    const wrong = expected.flatMap((x) => {
      const item = items.find((i) => i.id === x.id);
      if (!item) return [t("cli.provider.test.itemMissing", { id: x.id })];
      const key = formatKey(d.id, "default", item.thread) ?? item.thread;
      const kind = classifyItem(item, key, { ...rules, ...(x.rules ?? {}) }, new Set(), new Set());
      return kind === x.kind ? [] : [t("cli.provider.test.kind", { id: x.id, got: String(kind), want: String(x.kind) })];
    });
    report.line(wrong.length ? "fail" : "ok", "triage", wrong.join("; "));
  }

  // ---- context
  const thread = fx.act?.thread ?? threads[0] ?? null;
  const texts: Parameters<typeof textCheck>[1] = [...items];
  if (!caps.context || !provider.context) report.line("skip", "context", t("cli.provider.test.notDeclared"));
  else if (!thread) report.line("skip", "context", t("cli.provider.test.noThread"));
  else {
    try {
      const c = await provider.context(ctx(), thread, { max: 50 });
      const list = Array.isArray(c?.items) ? c.items : null;
      const ordered = !!list && list.every((x, i) => i === 0 || x.time >= list[i - 1].time);
      // the check `strato context` makes before printing a thread
      const shaped = contextProblem(c) === null;
      report.line(ordered && shaped ? "ok" : "fail", "context", ordered && shaped ? t("cli.provider.test.items", { n: list?.length ?? 0 }) : t("cli.provider.test.contextShape"));
      if (shaped && list) texts.push(...list.map((x) => ({ id: x.id, author: { name: x.author }, text: x.text })));
    } catch (e) {
      report.line("fail", "context", reason(e));
    }
  }
  textCheck(report, texts);

  // ---- targets: a module's parseTarget on the fixture's destinations
  const samples = fx.expect?.targets ?? [];
  const parse = pureOf(d.id)?.parseTarget;
  if (!samples.length) report.line("skip", "targets", t("cli.provider.test.noExpect"));
  else if (!parse) report.line("skip", "targets", t("cli.provider.test.typedOnly"));
  else {
    const wrong = samples.filter((x) => {
      const r = parse(x.draftTo, { thread: thread ?? "", conversation: { id: "", label: "" } }, entry.account);
      return x.error ? !("error" in r) : "error" in r || r.scope !== x.target?.scope || r.native !== x.target?.native;
    });
    report.line(wrong.length ? "fail" : "ok", "targets", wrong.map((x) => x.draftTo).join("; "));
  }

  // ---- acts, through the gate
  if (live) report.line("skip", "act", t("cli.provider.test.liveNoAct"));
  // a real write runs only for a provider seen talking through the fake, and never when items came without a request
  else await actChecks(provider, d, caps.actions, caps.undo, caps.idempotent, fx, thread, fake, report, pollOffline || (connectRequests === 0 && pollRequests === 0));

  // ---- errors: a 401 needs setup, a 429 says when, a timeout is retried
  if (live) report.line("skip", "errors", t("cli.provider.test.liveNoAct"));
  else if (!connectRequests) report.line("offline", "errors", t("cli.provider.test.noRequest"));
  else {
    const problems: string[] = [];
    const attempt = async (mode: "401" | "429" | "timeout", run: () => Promise<unknown>) => {
      fake.mode = mode;
      try {
        await run();
        return null;
      } catch (e) {
        return providerError(e);
      } finally {
        fake.mode = "fixtures";
      }
    };
    const e401 = await attempt("401", () => provider.connect(ctx()));
    if (!e401?.fatal) problems.push(t("cli.provider.test.e401"));
    const read = caps.ingest.poll && provider.poll ? () => (provider.poll as NonNullable<Provider["poll"]>)(ctx(), null, { since: 0, maxItems: 5 }) : () => provider.connect(ctx());
    const e429 = await attempt("429", read);
    if (!e429?.retryable || !(e429.retryAfterMs && e429.retryAfterMs > 0)) problems.push(t("cli.provider.test.e429"));
    const eTimeout = await attempt("timeout", read);
    if (!eTimeout?.retryable || eTimeout.fatal) problems.push(t("cli.provider.test.eTimeout"));
    report.line(problems.length ? "fail" : "ok", "errors", problems.join("; "));
  }

  // ---- push
  if (!caps.ingest.push || !provider.subscribe) report.line("skip", "push", t("cli.provider.test.notDeclared"));
  else {
    mark = fake.since();
    const stop = new AbortController();
    const got: Item[] = [];
    const timer = setTimeout(() => stop.abort(), fx.push?.waitMs ?? 1500);
    try {
      const end = await provider.subscribe(ctx({ signal: stop.signal }), (batch) => {
        if (Array.isArray(batch)) got.push(...batch.filter(isItem));
      });
      const offline = !live && fake.madeSince(mark).length === 0;
      const want = live ? undefined : fx.expect?.push;
      const ids = got.map((i) => i.id);
      const problems: string[] = [];
      if (!end || !["clean", "cut", "fatal"].includes(end.end)) problems.push(t("cli.provider.test.pushEnd"));
      if (want && ids.join("\n") !== want.join("\n")) problems.push(t("cli.provider.test.pushItems", { got: ids.join(", ") || "-", want: want.join(", ") || "-" }));
      if (problems.length) report.line("fail", "push", problems.join("; "));
      else report.line(offline ? "offline" : "ok", "push", `${t("cli.provider.test.items", { n: got.length })}, ${end.end}`);
    } catch (e) {
      report.line("fail", "push", reason(e));
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- network: every request matched a fixture
  if (!live) {
    const unmatched = fake.unmatched;
    report.line(unmatched.length ? "fail" : "ok", "network", unmatched.length ? t("cli.provider.test.unmatched", { requests: unmatched.slice(0, 5).map((r) => `${r.method} ${r.url}`).join(", ") }) : t("cli.provider.test.requests", { n: fake.requests.length }));
  }
}

/** What is wrong in a poll's answer: its shape, items Strato cannot read, their order. */
function pollProblems(r: PollResult | null | undefined): string[] {
  const out: string[] = [];
  if (!r || !Array.isArray(r.items) || !r.cursor || typeof r.cursor.value !== "string" || typeof r.cursor.at !== "number" || typeof r.complete !== "boolean") return [t("cli.provider.test.pollShape")];
  const bad = r.items.filter((i) => !isItem(i)).length;
  if (bad) out.push(t("cli.provider.test.badItems", { n: bad }));
  const items = r.items.filter(isItem);
  if (!items.every((x, i) => i === 0 || x.time >= items[i - 1].time)) out.push(t("cli.provider.test.order"));
  return out;
}

/** No control characters in ids and names, and texts under 1 MiB. */
function textCheck(report: Report, list: { id: string; author?: { name?: string }; text?: string; conversation?: { label?: string }; title?: string }[]): void {
  const wrong = list.filter((x) => CONTROL_ANY.test(x.id) || CONTROL_ANY.test(x.author?.name ?? "") || CONTROL_ANY.test(x.conversation?.label ?? "") || CONTROL.test(x.text ?? "") || CONTROL.test(x.title ?? "") || (x.text ?? "").length > TEXT_MAX);
  report.line(wrong.length ? "fail" : list.length ? "ok" : "skip", "text", wrong.length ? t("cli.provider.test.control", { ids: wrong.map((x) => x.id).join(", ") }) : list.length ? "" : t("cli.provider.test.noThread"));
}

const TASK_AT = "2026-01-01T00:00:00Z";

/** The topic the act checks write on: one thread of the provider, with one task. */
function writeTopic(key: string, task: Record<string, unknown>): void {
  writeJson(F.sujets, [
    {
      key,
      threads: [key],
      letter: "A",
      title: SAMPLE_TEXT,
      channel: "harness",
      permalink: "",
      asker: "Alice",
      sessionId: null,
      shortId: null,
      name: "harness",
      status: "gate",
      gate: "draft",
      waiting: "",
      next: "",
      summary: "",
      createdAt: TASK_AT,
      updatedAt: TASK_AT,
      history: [],
      tasks: [{ ask: "check", createdAt: TASK_AT, updatedAt: TASK_AT, status: "open", origin: "task", ...task }],
    },
  ]);
}

/** The hash the board would show for the topic's task, what a Go sends back, and the kind of its action. */
function planOf(key: string, taskId: string): { sha: string; kind: ActionKind } | null {
  const s = loadSujets().find((x) => x.key === key);
  const x = s ? findTask(s, taskId) : undefined;
  const plan = s && x ? planOfTask(s, x) : null;
  const kind = plan && "plan" in plan ? plan.plan.actions[0]?.kind : undefined;
  return plan && "plan" in plan && kind ? { sha: planSha(plan.plan), kind } : null;
}

/**
 * Every action kind a task can carry, dry first, then for real against the fake once the provider was seen talking
 * through it (its connect or its poll made requests there, and no poll gave items without one): the write must carry
 * the text and, for an idempotent kind, the idempotency key; an undoable kind is then undone; a write that times out
 * must never say it surely did not happen. `offline`: no such evidence, the real write is reported not verifiable.
 */
async function actChecks(provider: Provider, d: ProviderDescriptor, actions: ActionKind[], undo: ActionKind[], idempotent: ActionKind[], fx: Fixture, thread: string | null, fake: FakeTool, report: Report, offline: boolean): Promise<void> {
  if (!actions.length) return report.line("skip", "act", t("cli.provider.test.notDeclared"));
  if (!thread) return report.line("skip", "act", t("cli.provider.test.noThread"));
  const key = formatKey(d.id, "default", thread);
  if (!key) return report.line("fail", "act", t("cli.provider.test.noKey", { thread }));
  const text = fx.act?.text ?? SAMPLE_TEXT;
  const tasks: { name: string; task: Record<string, unknown>; carries: string }[] = [{ name: "text", task: { id: "t1", kind: "draft", draft: text, to: key }, carries: text }];
  if (actions.includes("setStatus")) tasks.push({ name: "setStatus", task: { id: "t1", kind: "action", act: "setStatus", value: fx.act?.status ?? "Done", to: key }, carries: fx.act?.status ?? "Done" });
  if (actions.includes("assign")) tasks.push({ name: "assign", task: { id: "t1", kind: "action", act: "assign", value: fx.act?.assignee ?? "me", to: key }, carries: "" });
  const unreachable = actions.filter((k) => !["post", "reply", "comment", "setStatus", "assign"].includes(k));
  if (unreachable.length) report.line("skip", "act", t("cli.provider.test.unreachable", { kinds: unreachable.join(", ") }));

  for (const { name, task, carries } of tasks) {
    writeTopic(key, task);
    const plan = planOf(key, "t1");
    if (!plan) {
      report.line("fail", `act ${name}`, t("cli.provider.test.noPlan"));
      continue;
    }
    const { sha, kind } = plan;
    if (!actions.includes(kind)) {
      report.line("skip", `act ${name}`, t("cli.provider.test.kindNotDeclared", { kind }));
      continue;
    }
    // dry: validated and described, nothing written
    let mark = fake.since();
    const dry = await dryRunTask({ key, taskId: "t1", sha, by: "board" });
    const unsafe = fake.madeSince(mark).filter((r) => !r.safe);
    if (!dry.ok) report.line("fail", `act ${kind}, dry`, "refused" in dry ? dry.refused.message : dry.failed.message);
    else if (unsafe.length) report.line("fail", `act ${kind}, dry`, t("cli.provider.test.dryWrote", { requests: unsafe.map((r) => `${r.method} ${r.url}`).join(", ") }));
    else report.line("ok", `act ${kind}, dry`, dry.result.dry ?? "");

    // real, against the fake
    if (offline) {
      report.line("offline", `act ${kind}`, t("cli.provider.test.noRequest"));
      continue;
    }
    mark = fake.since();
    const real = await actOnTask({ key, taskId: "t1", sha, by: "board" });
    const writes = fake.madeSince(mark).filter((r) => !r.safe && r.exchange !== null);
    const idem = `${key}#t1#${sha.slice(0, 12)}#1`;
    const carried = (r: Recorded) => (!carries || r.body.includes(carries)) && (!idempotent.includes(kind) || r.body.includes(idem) || Object.values(r.headers).some((v) => v.includes(idem)));
    if (!real.ok) report.line("fail", `act ${kind}`, "refused" in real ? real.refused.message : real.failed.message);
    else if (!writes.length) report.line("fail", `act ${kind}`, t("cli.provider.test.noWrite"));
    else if (!writes.some(carried)) report.line("fail", `act ${kind}`, idempotent.includes(kind) ? t("cli.provider.test.noIdem", { key: idem }) : t("cli.provider.test.noText"));
    else report.line("ok", `act ${kind}`, real.sent.link);

    // undo, within the window
    if (real.ok && undo.includes(kind)) {
      mark = fake.since();
      const back = await undoTask({ key, taskId: "t1", by: "board" });
      const made = fake.madeSince(mark).filter((r) => r.exchange !== null);
      if (!back.ok) report.line("fail", `undo ${kind}`, "refused" in back ? back.refused.message : back.failed.message);
      else report.line(made.length ? "ok" : "fail", `undo ${kind}`, made.length ? "" : t("cli.provider.test.noWrite"));
    } else if (undo.includes(kind)) report.line("skip", `undo ${kind}`, t("cli.provider.test.noAct"));

    // a write that times out may have happened: it never says it surely did not
    writeTopic(key, task);
    mark = fake.since();
    fake.mode = "timeout";
    const late = await actOnTask({ key, taskId: "t1", sha, by: "board" });
    fake.mode = "fixtures";
    const said = !late.ok && "failed" in late ? late.failed.outcome : null;
    if (!fake.madeSince(mark).length) report.line("skip", `act ${kind}, timeout`, t("cli.provider.test.noRequest"));
    else report.line(late.ok || said === "none" ? "fail" : "ok", `act ${kind}, timeout`, late.ok || said === "none" ? t("cli.provider.test.timeoutNone") : "");
  }
  writeJson(F.sujets, []);
}
