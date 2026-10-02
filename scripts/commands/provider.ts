/**
 * `strato provider …`: external providers, for the person who installs one and for its author
 * (docs/design/providers.md, section 13; the author guide is docs/providers/authoring.md).
 *
 *   provider list                        the built-in and configured providers, where each one stands
 *   provider types                       the SDK types file, for an author's editor (`sdk` is the same)
 *   provider trust <id>                  shows a configured provider's folder, hash and descriptor, and trusts it on a
 *                                        typed "yes", in the person's own terminal
 *
 * A work session never trusts, scaffolds nor runs provider code: those subcommands refuse a session caller
 * (`STRATO_CALLER=session`, set in every session's environment) and trusting needs a terminal on top.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { F, fail, nowIso, out } from "../app/env.ts";
import { readLine } from "../app/secrets.ts";
import { t } from "../core/i18n.ts";
import { textOf } from "../core/links.ts";
import { shortPath } from "../core/setup.ts";
import { settings } from "../core/settings.ts";
import { PROVIDER_ID } from "../providers/api.ts";
import { descriptorProblems } from "../providers/check.ts";
import { loadExternalProviders, trustProblem } from "../providers/external.ts";
import { describeExec } from "../providers/host/exec.ts";
import { importModule, LoadError } from "../providers/host/module.ts";
import { providerHome, type ResolvedSource, trustOf, writeTrust } from "../providers/host/trust.ts";
import { accounts, BUILTIN } from "../providers/registry.ts";
import type { ProviderDescriptor } from "../providers/sdk.ts";
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
    case "trust":
      refuseSession("trust");
      return trust(rest);
    default:
      fail(`usage: provider list | types | trust <id>`, 64);
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
  let d: unknown;
  try {
    d = await declaredDescriptor(id, r);
  } catch (e) {
    fail(t("cli.provider.load.failed", { id, error: e instanceof LoadError ? e.problems.join("; ") : ((e as Error)?.message ?? String(e)) }));
  }
  const problems = descriptorProblems(d, id);
  if (problems.length) fail(`${t("cli.provider.trust.problems", { id })}\n  ${problems.join("\n  ")}`);
  const descriptor = d as ProviderDescriptor;
  out(t("cli.provider.trust.folder", { path: short(r.folder) }));
  if (r.shape === "exec") out(t("cli.provider.trust.command", { argv: r.argv.join(" ") }));
  if (r.shape === "exec" && r.pinned === "executable") out(t("cli.provider.trust.executableOnly", { path: short(r.pinPath ?? r.argv[0]) }));
  out(t("cli.provider.trust.hash", { sha256: state.sha256 }));
  if (state.state === "trusted") out(t("cli.provider.trust.already"));
  for (const line of descriptorLines(descriptor)) out(`  ${line}`);
  out(t("cli.provider.trust.privileges"));
  const answer = (await readLine(t("cli.provider.trust.confirm", { id }))).toLowerCase();
  if (answer !== "yes" && answer !== "oui") fail(t("cli.provider.trust.declined"));
  writeTrust(id, { sha256: state.sha256, source, descriptor, at: nowIso() });
  out(t("cli.provider.trust.done", { id, cmd: `${cliCommand()} provider test ${id}` }));
}
