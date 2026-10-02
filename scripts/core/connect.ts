/**
 * The pure side of connecting a tool (`setup --providers`, `setup --connect`, and the account lines of `doctor` and
 * `setup --check`): which auth method, what goes into config.json, and the lines a person reads. No disk, no network:
 * commands/connect.ts does that (docs/design/providers.md, section 11).
 */
import type { Account, AuthMethod, Detected, Identity, ProviderDescriptor } from "../providers/sdk.ts";
import { t } from "./i18n.ts";
import { textOf } from "./links.ts";

/** One tool as `setup --providers` lists it: its descriptor, its accounts in the profile, and why it cannot connect yet. */
export interface ListedProvider {
  descriptor: ProviderDescriptor;
  accounts: { id: string; label: string; linksOnly: boolean }[];
  refusal: string | null;
}

/** The lines of `setup --providers`: each tool, its accounts, then its auth methods with their trade-off, the default first. */
export function providerListLines(list: ListedProvider[], cli: string): string[] {
  const lines = [t("cli.connect.list.head", { cmd: `${cli} setup --connect <tool> [--account <name>] [--auth <method>]` })];
  for (const p of list) {
    const d = p.descriptor;
    const accounts = p.accounts.map((a) => (a.linksOnly ? t("cli.connect.list.linksOnly", { id: a.id }) : a.label && a.label !== a.id ? `${a.id} (${a.label})` : a.id));
    lines.push("", `${d.id} · ${textOf(d.label)} (${d.kinds.join(", ")}) · ${accounts.length ? t("cli.connect.list.accounts", { accounts: accounts.join(", ") }) : t("cli.connect.list.noAccount")}`);
    if (p.refusal) lines.push(`  ${p.refusal}`);
    const width = Math.max(0, ...d.auth.map((m) => m.id.length));
    d.auth.forEach((m, i) => lines.push(`  ${m.id.padEnd(width)}  ${methodText(m, i === 0)}`));
    if (!d.auth.length) lines.push(`  ${t("cli.connect.list.noAuth")}`);
  }
  return lines;
}

/** A method as the person chooses it: its label, "(default)" for the first one, and its trade-off. */
export const methodText = (m: AuthMethod, isDefault: boolean): string => `${textOf(m.label)}${isDefault ? ` ${t("cli.connect.list.default")}` : ""}${m.tradeoff ? `: ${textOf(m.tradeoff)}` : ""}`;

/** The auth method asked for (`--auth`), else the provider's default; or what to type instead. */
export function chooseMethod(d: ProviderDescriptor, wanted: string | undefined): AuthMethod | { error: string } {
  if (!d.auth.length) return { error: t("cli.connect.noMethod", { tool: textOf(d.label) }) };
  if (!wanted) return d.auth[0];
  const m = d.auth.find((x) => x.id === wanted);
  return m ?? { error: t("cli.connect.unknownMethod", { tool: textOf(d.label), auth: wanted, methods: d.auth.map((x) => x.id).join(", ") }) };
}

/** The detected values sure enough to write: high and medium confidence, a non-empty value, a setting the provider has. */
export function detectedSettings(detected: Record<string, Detected>, settingKeys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, d] of Object.entries(detected)) {
    if (!settingKeys.includes(k) || d.confidence === "low" || d.value === null || d.value === undefined || d.value === "") continue;
    out[k] = d.value;
  }
  return out;
}

/**
 * What `setup --connect` merges into config.json once the secrets are verified and stored. The default Slack account
 * keeps its place, the `slack` section, written as `setup --token` writes it; every other account goes under
 * `providers.<tool>.accounts.<name>`, with its auth method. A secret never goes in this patch.
 */
export function connectPatch(o: {
  provider: string;
  account: string;
  method: string;
  settings: Record<string, unknown>;
  clientId?: string;
  secretsFile?: string;
  /** The default Slack account's token file, and whether an app-level token was stored in it. */
  slackFile?: { path: string; appToken: boolean };
}): Record<string, unknown> {
  const clientId = o.clientId ? { clientId: o.clientId } : {};
  if (o.provider === "slack" && o.account === "default" && o.slackFile) {
    return { slack: { userTokenFile: o.slackFile.path, ...o.settings, ...(o.slackFile.appToken ? { appTokenFile: o.slackFile.path } : {}), ...clientId } };
  }
  const account = { auth: o.method, ...(o.secretsFile ? { secretsFile: o.secretsFile } : {}), ...o.settings, ...clientId };
  return { providers: { [o.provider]: { accounts: { [o.account]: account } } } };
}

/** What an account's check found: who the person is there, or why it cannot connect and the command that fixes it. */
export type AccountStatus = { ok: true; identity: Identity } | { ok: false; reason: string; fix: string | null };

/**
 * One line of `doctor` per account beyond the default Slack one, after the profile lines (docs/design/providers.md,
 * section 11.5): `slack    : Acme Partners (partners) · user token · polling every 60 s · you are U… on Acme`.
 */
export function accountLine(a: Pick<Account, "provider" | "id" | "label" | "ingest">, method: AuthMethod | null, pollInterval: number, status: AccountStatus): string {
  const ingest = a.ingest === "push" ? t("cli.doctor.account.push") : a.ingest === "poll" ? t("cli.doctor.account.poll", { seconds: pollInterval }) : t("cli.doctor.account.off");
  const state = status.ok
    ? t("cli.doctor.account.ok", { me: status.identity.me, workspace: status.identity.workspace })
    : status.fix
      ? t("cli.doctor.account.downFix", { reason: status.reason, fix: status.fix })
      : t("cli.doctor.account.down", { reason: status.reason });
  return `${a.provider.padEnd(9)}: ${a.label} (${a.id}) · ${method ? textOf(method.label) : t("cli.doctor.account.noMethod")} · ${ingest} · ${state}`;
}
