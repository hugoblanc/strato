/**
 * `strato provider …`: external providers, for the person who installs one and for its author
 * (docs/design/providers.md, section 13; the author guide is docs/providers/authoring.md).
 *
 *   provider list                        the built-in and configured providers, where each one stands
 *   provider types                       the SDK types file, for an author's editor (`sdk` is the same)
 *   provider guide                       the author guide, docs/providers/authoring.md, embedded in the binary
 *   provider new <name> [--exec python] [--dir <folder>]
 *                                        a provider that works as is against its fixtures, with its README
 *   provider trust <id>                  shows a configured provider's folder, hash and descriptor, and trusts it on a
 *                                        typed "yes", in the person's own terminal
 *   provider test <id | path>            the offline conformance harness (providers/harness/run.ts); `--live` runs its
 *                                        read checks against the person's own account, never its writes
 *
 * A work session never trusts, scaffolds nor tests provider code: those subcommands refuse a session caller
 * (`STRATO_CALLER=session`, set in every session's environment). That is a convention a session with a shell could
 * get around, not a boundary: the boundary is that trusting needs typed answers in a terminal.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expandHome, F, fail, flags, nowIso, out, readJson, writeJson } from "../app/env.ts";
import { selfArgv } from "../app/self.ts";
import { readLine } from "../app/secrets.ts";
import { locale, t } from "../core/i18n.ts";
import { textOf } from "../core/links.ts";
import { shortPath } from "../core/setup.ts";
import { resolveSettings, settings, useSettings } from "../core/settings.ts";
import { PROVIDER_ID } from "../providers/api.ts";
import { descriptorProblems } from "../providers/check.ts";
import { loadExternalProviders, trustProblem } from "../providers/external.ts";
import { describeExec } from "../providers/host/exec.ts";
import { importModule, LoadError } from "../providers/host/module.ts";
import { type HarnessSpec, runHarness } from "../providers/harness/run.ts";
import { EXEC_LANGUAGES, type ExecLanguage, scaffold } from "../providers/templates/scaffold.ts";
import { providerHome, type ResolvedSource, resolveSource, trustOf, writeTrust } from "../providers/host/trust.ts";
import { accounts, BUILTIN } from "../providers/registry.ts";
import type { ProviderDescriptor } from "../providers/sdk.ts";
import GUIDE from "../../docs/providers/authoring.md" with { type: "text" };
// @ts-expect-error: imported as text, which Bun embeds in the binary; TypeScript reads it as the module it also is
import sdkText from "../providers/sdk.ts" with { type: "text" };
import { cliCommand } from "./setup.ts";

const short = (path: string) => shortPath(path, homedir(), process.cwd());

/** providers/sdk.ts as it is in the source: types only, so a valid declaration file as printed. */
export const SDK_TYPES: string = sdkText;

/** A session runs this command: provider code is never trusted, written nor run on a session's behalf. */
export const sessionCaller = (env: Record<string, string | undefined> = process.env) => env.STRATO_CALLER === "session";

function refuseSession(sub: string): void {
  if (sessionCaller()) fail(t("cli.provider.session", { cmd: `${cliCommand()} provider ${sub}` }), 77);
}

export async function provider(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      return list();
    case "types":
    case "sdk":
      process.stdout.write(SDK_TYPES);
      return;
    case "guide":
      process.stdout.write(GUIDE);
      return;
    case "trust":
      refuseSession("trust");
      return trust(rest);
    case "new":
      refuseSession("new");
      return scaffoldCommand(rest);
    case "test":
      refuseSession("test");
      return test(rest);
    case "_harness":
      refuseSession("test");
      return harness();
    default:
      fail(`usage: provider list | types | guide | new <name> [--exec python] [--dir <folder>] | trust <id> | test <id | path> [--fixtures <dir>] [--live [--account <name>]]`, 64);
  }
}

// ------------------------------------------------------------------ list

/** Folders of `<state>/providers/` that hold provider code the profile does not name: listed, never loaded. */
function unconfiguredFolders(known: Set<string>): string[] {
  if (!existsSync(F.providers)) return [];
  return readdirSync(F.providers, { withFileTypes: true })
    .filter((d) => d.isDirectory() && PROVIDER_ID.test(d.name) && !known.has(d.name))
    .filter((d) => ["provider.ts", "provider.js", "provider.mjs", "provider.py", "provider.cjs"].some((f) => existsSync(join(F.providers, d.name, f))))
    .map((d) => d.name);
}

async function list(): Promise<void> {
  const status = await loadExternalProviders();
  const all = accounts();
  const accountsOf = (id: string) => all.filter((a) => a.account.provider === id).map((a) => a.account.id);
  for (const p of Object.values(BUILTIN)) {
    const names = accountsOf(p.descriptor.id);
    out(t("cli.provider.list.builtin", { id: p.descriptor.id, label: textOf(p.descriptor.label), kinds: p.descriptor.kinds.join(", "), accounts: names.length ? names.join(", ") : "-" }));
  }
  for (const s of status) {
    const r = s.trust.resolved;
    const where = r ? (r.shape === "module" ? short(r.file) : r.argv.map((a) => (a.includes("/") ? short(a) : a)).join(" ")) : "?";
    out(t("cli.provider.list.external", { id: s.id, shape: r?.shape ?? "?", where, accounts: accountsOf(s.id).join(", ") || "-" }));
    out(`    ${s.problem ?? t("cli.provider.list.loaded")}`);
  }
  const named = new Set([...Object.keys(BUILTIN), ...Object.keys(settings().providers)]);
  for (const id of unconfiguredFolders(named)) out(t("cli.provider.list.unconfigured", { id, path: short(providerHome(id)) }));
  if (!status.length) out(t("cli.provider.list.none", { cmd: `${cliCommand()} provider new <name>` }));
}

// ------------------------------------------------------------------ trust

/** The descriptor a source declares, read by running it: the module imported, or `describe` in a throwaway process. */
async function declaredDescriptor(id: string, r: ResolvedSource): Promise<unknown> {
  if (r.shape === "module") return (await importModule(r.file, id)).descriptor;
  return (await describeExec({ id, argv: r.argv, cwd: r.cwd })).descriptor;
}

/** What the person reads before trusting: what the provider can reach, sign in with and do. */
export function descriptorLines(d: ProviderDescriptor): string[] {
  const c = d.capabilities;
  const ingest = [c.ingest.push ? "push" : "", c.ingest.poll ? "poll" : ""].filter(Boolean).join(", ") || "-";
  return [
    t("cli.provider.trust.label", { label: textOf(d.label), kinds: d.kinds.join(", ") }),
    t("cli.provider.trust.auth", { methods: d.auth.map((m) => `${m.id} (${m.kind})`).join(", ") || "-" }),
    t("cli.provider.trust.actions", { actions: c.actions.join(", ") || "-", undo: c.undo.join(", ") || "-" }),
    t("cli.provider.trust.reads", { ingest, context: c.context ? "context" : "-" }),
    t("cli.provider.trust.hosts", { api: d.apiHosts.join(", ") || "-", links: d.hosts.join(", ") || "-" }),
  ];
}

/** A typed yes, in either language. */
const yes = (answer: string) => ["yes", "oui"].includes(answer.trim().toLowerCase());

async function trust(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) fail("usage: provider trust <id>", 64);
  if (!process.stdin.isTTY) fail(t("cli.provider.trust.noTty", { cmd: `${cliCommand()} provider trust ${id}` }), 64);
  // a provider is trusted before its accounts exist: validation needs its descriptor to check their settings
  const source = BUILTIN[id] ? undefined : settings().providers[id]?.source;
  if (!source) fail(t("cli.provider.trust.notConfigured", { id }));
  const state = trustOf(id, source);
  if (state.state !== "trusted" && state.state !== "untrusted" && state.state !== "changed") return fail(trustProblem(id, state) ?? id);
  const r = state.resolved;
  if (!state.sha256) return fail(t("cli.provider.load.missing", { id, path: r.shape === "module" ? r.file : r.argv[0] }));
  // what the person can check without running anything comes first: reading the descriptor runs the provider's code
  out(t("cli.provider.trust.folder", { path: short(r.folder) }));
  if (r.shape === "exec") out(t("cli.provider.trust.command", { argv: r.argv.join(" ") }));
  if (r.shape === "exec" && r.pinned === "executable") out(t("cli.provider.trust.executableOnly", { path: short(r.pinPath ?? r.argv[0]) }));
  out(t("cli.provider.trust.hash", { sha256: state.sha256 }));
  if (state.state === "trusted") out(t("cli.provider.trust.already"));
  out(t("cli.provider.trust.privileges"));
  out(t("cli.provider.trust.runOnce"));
  if (!yes(await readLine(t("cli.provider.trust.confirmRun", { id })))) fail(t("cli.provider.trust.declined"));
  let d: unknown;
  try {
    d = await declaredDescriptor(id, r);
  } catch (e) {
    fail(t("cli.provider.load.failed", { id, error: e instanceof LoadError ? e.problems.join("; ") : ((e as Error)?.message ?? String(e)) }));
  }
  const problems = descriptorProblems(d, id);
  if (problems.length) fail(`${t("cli.provider.trust.problems", { id })}\n  ${problems.join("\n  ")}`);
  const descriptor = d as ProviderDescriptor;
  for (const line of descriptorLines(descriptor)) out(`  ${line}`);
  if (!yes(await readLine(t("cli.provider.trust.confirm", { id })))) fail(t("cli.provider.trust.declined"));
  writeTrust(id, { sha256: state.sha256, source, descriptor, at: nowIso() });
  out(t("cli.provider.trust.done", { id, cmd: `${cliCommand()} provider test ${id}` }));
}

// ------------------------------------------------------------------ test

/** A provider's code given by path: a folder holding provider.ts/.js/.mjs or provider.py, or the file itself. */
function targetOfPath(path: string): { target: HarnessSpec["target"]; folder: string } | null {
  const abs = resolve(expandHome(path));
  if (!existsSync(abs)) return null;
  const file = statSync(abs).isDirectory() ? ["provider.ts", "provider.mts", "provider.js", "provider.mjs", "provider.py"].map((f) => join(abs, f)).find((f) => existsSync(f)) : abs;
  if (!file) return null;
  const folder = dirname(file);
  if (/\.(m?ts|m?js)$/.test(file)) return { target: { shape: "module", file }, folder };
  if (file.endsWith(".py")) return { target: { shape: "exec", argv: ["python3", file], cwd: folder }, folder };
  return { target: { shape: "exec", argv: [file], cwd: folder }, folder };
}

/**
 * `provider test <id | path>`: the conformance harness on a throwaway state folder, in a process of its own (the state
 * folder is fixed when a Strato process starts). By id, the configured source; by path, the code there. Fixtures come
 * from `<folder>/fixtures/` or `--fixtures`. `--live` runs the read checks against the person's own account instead.
 */
async function test(args: string[]): Promise<void> {
  const { positional, opts } = flags(args);
  const ref = positional[0];
  if (!ref) fail("usage: provider test <id | path> [--fixtures <dir>] [--live [--account <name>]]", 64);
  const live = opts.live === "true";
  if (live && !process.stdin.isTTY) fail(t("cli.provider.test.liveNoTty", { cmd: `${cliCommand()} provider test ${ref} --live` }), 64);
  const source = BUILTIN[ref] ? undefined : settings().providers[ref]?.source;
  let found: { target: HarnessSpec["target"]; folder: string } | null = null;
  if (source) {
    const r = resolveSource(ref, source);
    // a configured provider runs by its name only as the person trusted it; its folder, given as a path, runs as it is
    let state: ReturnType<typeof trustOf>;
    try {
      state = trustOf(ref, source);
    } catch (e) {
      state = { state: "invalid", resolved: null, detail: (e as Error).message };
    }
    const problem = trustProblem(ref, state);
    if (problem) fail(r ? t("cli.provider.test.untrusted", { problem, cmd: `${cliCommand()} provider test ${short(r.folder)}` }) : problem);
    if (r) found = { target: r.shape === "module" ? { shape: "module", file: r.file } : { shape: "exec", argv: r.argv, cwd: r.cwd }, folder: r.folder };
  } else if (!live) found = targetOfPath(ref);
  if (!found) fail(t("cli.provider.test.notFound", { path: ref }));
  let liveSpec: HarnessSpec["live"] = null;
  if (live) {
    const account = opts.account && opts.account !== "true" ? opts.account : "default";
    const e = accounts().find((a) => a.account.provider === ref && a.account.id === account);
    if (!e) fail(t("cli.provider.test.liveNeeds", { id: ref, account }));
    liveSpec = { settings: e.account.settings, secretsFile: expandHome(e.secretsFile), auth: e.account.auth };
  }
  const dir = mkdtempSync(join(tmpdir(), "strato-harness-"));
  try {
    const state = join(dir, "state");
    mkdirSync(join(state, "providers"), { recursive: true });
    const spec: HarnessSpec = {
      nonce: randomUUID(),
      target: found.target,
      fixturesDir: opts.fixtures && opts.fixtures !== "true" ? resolve(opts.fixtures) : join(found.folder, "fixtures"),
      live: liveSpec,
      locale: locale(),
    };
    writeJson(join(state, "harness.json"), spec);
    const p = Bun.spawn([...selfArgv(), "provider", "_harness"], {
      env: { ...process.env, STRATO_STATE: state, STRATO_WORKSPACE: dir, STRATO_HARNESS_NONCE: spec.nonce, STRATO_UPDATE_CHECK: "off" },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exitCode = await p.exited;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The harness process: only on a state folder `provider test` made, proven by the nonce it put in the environment. */
async function harness(): Promise<void> {
  const spec = readJson<HarnessSpec | null>(join(F.providers, "..", "harness.json"), null);
  if (!spec || !process.env.STRATO_HARNESS_NONCE || spec.nonce !== process.env.STRATO_HARNESS_NONCE) fail(t("cli.provider.test.internal"), 64);
  // offline: the process's own fetch refuses everything before any provider code runs; the provider gets the fake
  if (!spec.live) globalThis.fetch = (async () => Promise.reject(new Error(t("cli.provider.test.globalFetch")))) as unknown as typeof fetch;
  useSettings(resolveSettings({ ui: { locale: spec.locale } }));
  const ok = await runHarness(spec, out);
  process.exit(ok ? 0 : 1);
}

// ------------------------------------------------------------------ new

/** `provider new <name>`: the scaffold, in `<state>/providers/<name>/` or `<folder>/<name>/`, never over existing files. */
async function scaffoldCommand(args: string[]): Promise<void> {
  const { positional, opts } = flags(args);
  const id = positional[0];
  if (!id) fail("usage: provider new <name> [--exec python] [--dir <folder>]", 64);
  if (!PROVIDER_ID.test(id)) fail(t("cli.setup.provider.name", { path: id }), 64);
  if (BUILTIN[id]) fail(t("cli.provider.new.builtin", { id }), 64);
  const language = opts.exec && opts.exec !== "true" ? opts.exec : opts.exec === "true" ? "python" : null;
  if (language && !(EXEC_LANGUAGES as readonly string[]).includes(language)) fail(t("cli.provider.new.language", { language, languages: EXEC_LANGUAGES.join(", ") }), 64);
  const folder = opts.dir && opts.dir !== "true" ? join(resolve(expandHome(opts.dir)), id) : providerHome(id);
  if (existsSync(folder) && readdirSync(folder).length) fail(t("cli.provider.new.exists", { path: short(folder) }));
  const { files, source } = scaffold(id, { ...(language ? { exec: language as ExecLanguage } : {}), sdk: SDK_TYPES, folder, home: folder === providerHome(id), cli: cliCommand() });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, rel)), { recursive: true });
    writeFileSync(join(folder, rel), content);
  }
  out(t("cli.provider.new.written", { path: short(folder), files: Object.keys(files).join(", ") }));
  out(t("cli.provider.new.test", { cmd: `${cliCommand()} provider test ${folder}` }));
  out(t("cli.provider.new.config"));
  out(`  ${JSON.stringify({ providers: { [id]: { source } } })}`);
  out(t("cli.provider.new.next", { trust: `${cliCommand()} provider trust ${id}`, connect: `${cliCommand()} setup --connect ${id}`, guide: `${cliCommand()} provider guide` }));
}
