/**
 * Connecting tools (docs/design/providers.md, section 11), driven by each provider's descriptor:
 *
 *   setup --providers                                    the tools Strato can connect, their accounts and auth methods
 *   setup --connect [<tool>] [--account <name>] [--auth <method>] [--client-id <id>] [--print]
 *                                                        walks the method's steps in the person's own terminal: open the
 *                                                        documented page, paste a secret without echo or approve in the
 *                                                        browser (OAuth with PKCE), verify, then store the secrets (600)
 *                                                        and write the account into config.json
 *
 * and the per-account lines of `doctor`, `setup --check` and `setup --detect`. Official flows only: a secret is pasted
 * by the person or returned by the tool's OAuth endpoint, never read from a browser or another application's storage.
 */
import { homedir } from "node:os";
import { expandHome, fail, out, run } from "../app/env.ts";
import { OAuthError, runOAuth } from "../app/oauth.ts";
import { writeProfile } from "../app/profile.ts";
import { readLine, readSecret, writeSecret } from "../app/secrets.ts";
import { accountLine, type AccountStatus, chooseMethod, connectPatch, detectedSettings, methodText, providerListLines } from "../core/connect.ts";
import { t } from "../core/i18n.ts";
import { textOf } from "../core/links.ts";
import { type CheckItem, type Detected, profileErrors, shortPath } from "../core/setup.ts";
import { oauthPortOf, settings, TRACKER_LINK_FIELDS } from "../core/settings.ts";
import { ACCOUNT_ID, providerError } from "../providers/api.ts";
import { accountContext, accounts, type AccountEntry, providerOf, providerViews, type ProviderView } from "../providers/registry.ts";
import type { AuthMethod, Identity } from "../providers/sdk.ts";

const short = (path: string) => shortPath(path, homedir(), process.cwd());

/** Opens a URL in the person's browser, unless `print` or nothing on the machine opens one. */
export async function openInBrowser(url: string, print: boolean): Promise<void> {
  const opener = process.platform === "darwin" ? "open" : Bun.which("xdg-open") ? "xdg-open" : null;
  if (print || !opener) return;
  await run([opener, url], 10_000).catch(() => null);
}

/** The default account of a tool that is only a link recognizer (the `tracker` section without an account of its own). */
const linksOnly = (e: AccountEntry) => e.from === "tracker" && e.account.auth === "none";

/** The accounts with a line of their own: every one but the default Slack account (its lines are older) and links-only ones. */
const otherAccounts = () => accounts().filter((e) => !(e.account.provider === "slack" && e.account.id === "default") && !linksOnly(e));

/** The command that connects an account again. */
const fixCommand = (cli: string, e: AccountEntry) => `${cli} setup --connect ${e.account.provider}${e.account.id === "default" ? "" : ` --account ${e.account.id}`}`;

/** The auth method an account says it uses, from its provider's descriptor. */
const methodOf = (e: AccountEntry): AuthMethod | null => e.provider?.descriptor.auth.find((m) => m.id === e.account.auth) ?? null;

/** Connects one account with what is stored, within `timeoutMs`: who the person is there, or why not and what fixes it. */
async function accountStatus(e: AccountEntry, cli: string, timeoutMs = 10_000): Promise<AccountStatus> {
  if (!e.provider) return { ok: false, reason: e.problem ?? e.account.provider, fix: null };
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const identity = await Promise.race([
      e.provider.connect(accountContext(e, { signal })),
      new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject({ code: "timeout", message: t("cli.doctor.account.timeout", { seconds: Math.round(timeoutMs / 1000) }), retryable: true, fatal: false }))),
    ]);
    return { ok: true, identity };
  } catch (err) {
    const pe = providerError(err);
    return { ok: false, reason: pe.message, fix: pe.retryable ? null : fixCommand(cli, e) };
  }
}

/** `doctor`'s lines for the accounts beyond the default Slack one: nothing for a Slack-only profile. */
export async function accountLines(cli: string): Promise<string[]> {
  const lines: string[] = [];
  for (const e of otherAccounts()) lines.push(accountLine(e.account, methodOf(e), e.pollInterval, await accountStatus(e, cli)));
  return lines;
}

/** `setup --check`'s items for the same accounts, never blocking: the default Slack account still is. */
export async function accountCheckItems(cli: string): Promise<CheckItem[]> {
  const items: CheckItem[] = [];
  for (const e of otherAccounts()) {
    const st = await accountStatus(e, cli);
    const name = `${e.account.provider}@${e.account.id}`;
    items.push(st.ok ? { name, status: "ok", detail: t("cli.doctor.account.ok", { me: st.identity.me, workspace: st.identity.workspace }), blocking: false } : { name, status: "warn", detail: st.fix ? t("cli.doctor.account.downFix", { reason: st.reason, fix: st.fix }) : t("cli.doctor.account.down", { reason: st.reason }), blocking: false });
  }
  return items;
}

/** `setup --detect`'s fields for the same accounts, under their path in config.json, and a note for each one that cannot be read. */
export async function accountDetectFields(cli: string): Promise<{ fields: Record<string, Detected>; notes: string[] }> {
  const fields: Record<string, Detected> = {};
  const notes: string[] = [];
  for (const e of otherAccounts()) {
    const detect = e.provider?.setup?.detect;
    if (!e.provider || !detect) continue;
    const label = `${e.account.provider}@${e.account.id}`;
    const st = await accountStatus(e, cli);
    if (!st.ok) {
      notes.push(`${label}: ${st.reason}`);
      continue;
    }
    try {
      const found = await detect(accountContext(e, { identity: st.identity, signal: AbortSignal.timeout(20_000) }));
      for (const [k, d] of Object.entries(found)) fields[`providers.${e.account.provider}.accounts.${e.account.id}.${k}`] = d;
    } catch (err) {
      notes.push(`${label}: ${providerError(err).message}`);
    }
  }
  return { fields, notes };
}

// ------------------------------------------------------------------ --providers

export function listProviders(cli: string): void {
  const all = accounts();
  const list = providerViews().map((v) => ({
    descriptor: v.descriptor,
    accounts: all.filter((e) => e.account.provider === v.descriptor.id && (e.account.id !== "default" || e.account.provider !== "slack" || settings().slack.team || settings().slack.me)).map((e) => ({ id: e.account.id, label: e.account.label, linksOnly: linksOnly(e) })),
    refusal: null,
  }));
  for (const line of providerListLines(list, cli)) out(line);
}

// ------------------------------------------------------------------ --connect

/** A choice among numbered options, read on stdin: a number, a name, or Enter for the first one. */
async function choose<T>(question: string, options: { name: string; text: string; value: T }[]): Promise<T | null> {
  options.forEach((o, i) => out(`  ${i + 1}. ${o.name}  ${o.text}`));
  const answer = (await readLine(`${question} `)).trim();
  if (!answer) return options[0]?.value ?? null;
  const n = Number(answer);
  if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value;
  return options.find((o) => o.name === answer.toLowerCase())?.value ?? null;
}

/** The account a connection fills: the one of the profile, else a new one under `providers` with the default secret file. */
function entryFor(view: ProviderView, accountId: string, method: AuthMethod, clientId: string): AccountEntry {
  const existing = accounts().find((e) => e.account.provider === view.descriptor.id && e.account.id === accountId);
  const base: AccountEntry = existing ?? {
    account: { provider: view.descriptor.id, id: accountId, label: accountId, auth: method.id, ingest: "poll", settings: {} },
    secretsFile: `~/.config/strato/${view.descriptor.id}-${accountId}.env`,
    pollInterval: 60,
    mcpServer: null,
    from: "providers",
    provider: view,
    problem: null,
  };
  return { ...base, provider: view, problem: null, account: { ...base.account, auth: method.id, settings: { ...base.account.settings, ...(clientId ? { clientId } : {}) } } };
}

/** The client id an OAuth step uses: the flag, else the account's `clientId` setting. */
function clientIdOf(opts: Record<string, string>, view: ProviderView, accountId: string): string {
  const flag = opts["client-id"];
  if (flag && flag !== "true") return flag;
  const existing = accounts().find((e) => e.account.provider === view.descriptor.id && e.account.id === accountId);
  const v = existing?.account.settings.clientId;
  return typeof v === "string" ? v : "";
}

/**
 * `setup --connect`: in the person's own terminal only, because a secret is pasted there or a browser approves; from
 * a session or a pipe it stops, so a secret never enters a transcript.
 */
export async function connectCommand(opts: Record<string, string>, cli: string): Promise<void> {
  const print = opts.print === "true";
  const asked = opts.connect === "true" ? null : opts.connect;
  const rerun = `${cli} setup --connect${asked ? ` ${asked}` : ""}${opts.account && opts.account !== "true" ? ` --account ${opts.account}` : ""}${opts.auth && opts.auth !== "true" ? ` --auth ${opts.auth}` : ""}`;
  if (!process.stdin.isTTY) fail(t("cli.connect.noTty", { cmd: rerun }), 64);

  const views = providerViews();
  let view: ProviderView | null;
  if (asked) view = providerOf(asked.toLowerCase());
  else {
    out(t("cli.connect.whichTool"));
    view = await choose(t("cli.connect.pick"), views.map((v) => ({ name: v.descriptor.id, text: textOf(v.descriptor.label), value: v })));
  }
  if (!view) fail(t("cli.connect.unknownTool", { id: asked ?? "?", tools: views.map((v) => v.descriptor.id).join(", ") }), 64);
  const d = view.descriptor;
  const tool = textOf(d.label);
  const accountId = opts.account && opts.account !== "true" ? opts.account : "default";
  if (accountId !== "default" && !ACCOUNT_ID.test(accountId)) fail(t("cli.connect.accountName", { account: accountId }), 64);

  let method: AuthMethod | null;
  if (opts.auth && opts.auth !== "true") {
    const m = chooseMethod(d, opts.auth);
    if ("error" in m) fail(m.error, 64);
    method = m;
  } else if (d.auth.length > 1) {
    out(t("cli.connect.whichMethod", { tool }));
    method = await choose(t("cli.connect.pick"), d.auth.map((m, i) => ({ name: m.id, text: methodText(m, i === 0), value: m })));
    if (!method) fail(t("cli.connect.unknownMethod", { tool, auth: "?", methods: d.auth.map((x) => x.id).join(", ") }), 64);
  } else {
    const m = chooseMethod(d, undefined);
    if ("error" in m) fail(m.error, 64);
    method = m;
  }

  const clientId = clientIdOf(opts, view, accountId);
  const entry = entryFor(view, accountId, method, clientId);
  const candidates: Record<string, string> = {};
  let found: { identity: Identity; detected: Record<string, Detected> } | null = null;
  const notes: string[] = [];

  const verify = async () => {
    const ctx = accountContext(entry, { candidates, signal: AbortSignal.timeout(30_000) });
    try {
      const identity = await view.connect(ctx);
      const detected = (await view.setup?.detect?.(ctx)) ?? {};
      return { identity, detected };
    } catch (e) {
      return fail(t("cli.connect.refused", { tool, reason: providerError(e).message }));
    }
  };

  for (const step of method.steps) {
    if (step.kind === "open") {
      out(textOf(step.say));
      out(step.url);
      await openInBrowser(step.url, print);
    } else if (step.kind === "paste") {
      const value = await readSecret(`${textOf(step.say)}${step.optional ? ` ${t("cli.connect.optional")}` : ""}: `);
      if (value) candidates[step.secret] = value;
      else if (!step.optional) fail(t("cli.connect.nothingRead"));
    } else if (step.kind === "oauth") {
      const id = step.clientId === "setting" ? clientId : step.clientId;
      if (!id) fail(d.id === "slack" ? t("cli.connect.noClientIdSlack", { cmd: `${rerun} --client-id <id>`, create: `${cli} setup --slack-app --team` }) : t("cli.connect.noClientId", { tool, cmd: `${rerun} --client-id <id>` }), 64);
      const clientSecret = step.clientSecret ? await readSecret(`${t("cli.connect.clientSecret", { tool })}: `) : "";
      if (step.clientSecret && clientSecret) candidates[step.clientSecret] = clientSecret;
      const s = settings();
      try {
        const tokens = await runOAuth(step, {
          clientId: id,
          ...(clientSecret ? { clientSecret } : {}),
          port: oauthPortOf(s),
          boardPort: s.ui.port,
          onUrl: (url) => {
            out(t("cli.connect.approve", { tool }));
            out(url);
            void openInBrowser(url, print);
          },
        });
        candidates[step.secret] = tokens.access;
        if (tokens.refresh && step.refreshSecret) candidates[step.refreshSecret] = tokens.refresh;
        else if (tokens.expiresInSec) notes.push(t("cli.connect.expires", { tool, hours: Math.max(1, Math.round(tokens.expiresInSec / 3600)) }));
      } catch (e) {
        fail(e instanceof OAuthError ? e.message : String(e));
      }
    } else if (step.kind === "verify") found = await verify();
  }
  found ??= await verify();

  // what goes into config.json: the settings the tool told, never a secret; checked before anything is stored
  const tracked = settings().tracker?.kind === "linear";
  const keys = d.settings.map((x) => x.key).filter((k) => !(d.id === "linear" && accountId === "default" && tracked && (TRACKER_LINK_FIELDS as readonly string[]).includes(k)));
  const values = detectedSettings(found.detected, keys);
  const flagClientId = opts["client-id"] && opts["client-id"] !== "true" ? opts["client-id"] : undefined;
  const defaultSlack = d.id === "slack" && accountId === "default";
  const workspace = typeof values.workspace === "string" ? values.workspace : found.identity.workspace.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const s = settings();
  const file = defaultSlack ? s.slack.userTokenFile || s.slack.appTokenFile || `~/.config/strato/${workspace}.env` : entry.secretsFile;
  const patch = connectPatch({ provider: d.id, account: accountId, method: method.id, settings: values, ...(flagClientId ? { clientId: flagClientId } : {}), ...(defaultSlack ? { slackFile: { path: file, appToken: Boolean(candidates.SLACK_APP_TOKEN) } } : {}) });
  const errors = profileErrors(patch);
  if (errors.length) fail(`--connect refused, nothing stored:\n  ${errors.join("\n  ")}`);

  for (const [name, value] of Object.entries(candidates)) writeSecret(file, name, value);
  out(t("cli.connect.connected", { tool, account: accountId, name: found.identity.name || found.identity.me, me: found.identity.me, workspace: found.identity.workspace }));
  out(t("cli.connect.stored", { names: Object.keys(candidates).join(", "), file: short(expandHome(file)) }));
  writeProfile(patch, false, "--connect");
  for (const n of notes) out(`warn: ${n}`);
  if (!defaultSlack) out(t("cli.connect.restart", { cmd: `${cli} doctor` }));
}
