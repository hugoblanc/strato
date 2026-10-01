/**
 * `setup`: what the guided setup (SKILL.md, "Setup") runs.
 *
 *   setup --check                    what the profile lacks, and the state of each prerequisite; exit 1 if one blocks
 *   setup --detect                   JSON of what can be guessed without asking: Slack identity, groups, active channels,
 *                                    git remotes, ticket prefixes, Linear MCP; each field with its source and confidence
 *   setup --write <file.json> [--force]   merges the file into config.json (creates the state folder), shows the diff
 *   setup --live                     turns shadow mode off (workers.shadow = false)
 *   setup --slack-app [--print]      opens Slack's app creation with Strato's manifest filled in (--print: link only)
 *
 * Slack is only read (auth.test, users.info, usergroups.list, search.messages). Every probe tolerates a missing scope,
 * a missing token and a missing network: `--detect` then returns what it could find, and says why the rest is missing.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { CLAUDE_BIN, F, fail, flags, localDay, out, readJson, run, SCRIPT, STATE, WORKSPACE, writeJson } from "../app/env.ts";
import { appToken, tokenCandidates } from "../app/slack.ts";
import manifestYaml from "../../examples/slack-app-manifest.yaml" with { type: "text" };
import { type CheckItem, checkReport, tokenKindProblem, USER_TOKEN_WHERE, nextStep, type Progress, shortPath, slackAppLink, SLACK_SCOPES, type Detected, displayNameOf, firstNameOf, linearWorkspaces, localeFromEnv, mergeProfile, parseRemote, profileDiff, profileErrors, type Remote, type SearchMatch, slackWorkspaceFromUrl, suggestedConfig, ticketPrefixes, topChannels } from "../core/setup.ts";
import { missingSettings, NEW_INSTALL_PROFILE, resolveSettings, settings, useSettings } from "../core/settings.ts";

export const SHADOW_REFUSAL = "shadow mode: nothing is posted (bun strato.ts setup --live turns it off)";

/**
 * Shadow mode as config.json says now, not as it was when the process started: `setup --live` takes effect on a
 * running board without a restart. The loaded profile follows, so the board's rendering reads the same value.
 */
export function shadowNow(): boolean {
  let on = settings().workers.shadow;
  try {
    on = resolveSettings(readJson<unknown>(F.config, {})).workers.shadow === true;
  } catch {}
  if (on !== settings().workers.shadow) useSettings({ ...settings(), workers: { ...settings().workers, shadow: on } });
  return on;
}

/** A path as the person reads it: `./…` under the current folder, `~/…` under home. */
export const short = (path: string) => shortPath(path, homedir(), process.cwd());

/** How the person calls Strato from where they are: commands in hints are copied as is. */
export const cliCommand = () => `bun ${short(SCRIPT)}`;

/** The "Next:" line that ends `setup --check` and `doctor`. */
export const nextLine = (p: Progress) => `Next: ${nextStep(p, cliCommand())}`;

// ------------------------------------------------------------------ Slack, read only

class SlackAnswer extends Error {}

/** One read call with a given token. A Slack refusal throws SlackAnswer (its code); a network failure throws anything else. */
// biome-ignore lint/suspicious/noExplicitAny: untyped Slack responses
async function slackRead(token: string, method: string, params: Record<string, string> = {}): Promise<{ body: any; scopes: string[] | null }> {
  const res = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  const body = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(await res.arrayBuffer()));
  if (!body.ok) throw new SlackAnswer(body.error ?? "unknown");
  const header = res.headers.get("x-oauth-scopes");
  return { body, scopes: header === null ? null : header.split(",").map((x) => x.trim()).filter(Boolean) };
}

interface Probe {
  token: string;
  team?: string;
  url?: string;
  user?: string;
  scopes?: string[] | null;
  /** Slack's refusal code, or "network: …". */
  error?: string;
}

const mask = (t: string) => `${t.slice(0, 5)}…${t.slice(-4)}`;

async function probeTokens(): Promise<Probe[]> {
  const probes: Probe[] = [];
  for (const token of tokenCandidates()) {
    try {
      const { body, scopes } = await slackRead(token, "auth.test");
      probes.push({ token, team: body.team, url: body.url, user: body.user_id, scopes });
    } catch (e) {
      probes.push({ token, error: e instanceof SlackAnswer ? e.message : `network: ${(e as Error).message}` });
    }
  }
  return probes;
}

/** The token Strato would use: the one of `slack.team` when it is set, else the first one Slack accepts. */
function chosen(probes: Probe[]): Probe | null {
  const team = settings().slack.team;
  return probes.find((p) => !p.error && (!team || p.team === team)) ?? null;
}


// ------------------------------------------------------------------ --check

async function check() {
  const s = settings();
  const items: CheckItem[] = [];
  const bunOk = Bun.semver.satisfies(Bun.version, ">=1.1.0");
  items.push({ name: "bun", status: bunOk ? "ok" : "missing", detail: bunOk ? Bun.version : `${Bun.version}, 1.1 or later needed`, blocking: true });

  const claude = await run([CLAUDE_BIN, "--version"], 10_000).catch(() => ({ code: -1, out: "" }));
  items.push(claude.code === 0 ? { name: "claude", status: "ok", detail: `${CLAUDE_BIN}${claude.out.trim() ? ` (${claude.out.trim()})` : ""}`, blocking: true } : { name: "claude", status: "missing", detail: "Claude Code not found: https://claude.com/claude-code", blocking: true });

  const probes = await probeTokens();
  const token = chosen(probes);
  if (!probes.length) {
    items.push({ name: "slack", status: "missing", detail: `no user token. Copy ${USER_TOKEN_WHERE} into STRATO_SLACK_TOKEN, or SLACK_MCP_XOXP_TOKEN in ${short(join(WORKSPACE, ".claude/settings.local.json"))} or ${short(join(WORKSPACE, ".mcp.json"))} (SETUP.md "Connect Slack"). No Slack app yet: setup --slack-app creates it in one click`, blocking: true });
  } else if (token && tokenKindProblem(token.token)) {
    items.push({ name: "slack", status: "missing", detail: `${mask(token.token)}: ${tokenKindProblem(token.token)}`, blocking: true });
  } else if (token) {
    const host = token.url ? (slackWorkspaceFromUrl(token.url) ?? "?") : "?";
    const meOff = s.slack.me && s.slack.me !== token.user;
    items.push({ name: "slack", status: meOff ? "warn" : "ok", detail: `workspace ${token.team} (${host}.slack.com) · you are ${token.user} · token ${mask(token.token)}${meOff ? ` · slack.me is ${s.slack.me}, to fix` : ""}`, blocking: true });
    if (token.scopes) {
      const lacking = SLACK_SCOPES.filter((x) => !token.scopes?.includes(x.scope));
      items.push({ name: "scopes", status: lacking.length ? "warn" : "ok", detail: lacking.length ? `missing: ${lacking.map((x) => `${x.scope} (${x.why})`).join(", ")}` : `all ${SLACK_SCOPES.length} scopes Strato uses`, blocking: false });
    }
  } else if (probes.every((p) => p.error?.startsWith("network:"))) {
    items.push({ name: "slack", status: "warn", detail: `token found but Slack unreachable (${probes[0].error}): not verified`, blocking: true });
  } else {
    const seen = probes.map((p) => `${mask(p.token)}: ${p.error ? (tokenKindProblem(p.token) ?? p.error) : `workspace ${p.team}`}`).join(", ");
    items.push({ name: "slack", status: "missing", detail: `no usable token${s.slack.team ? ` for workspace "${s.slack.team}"` : ""} (${seen})`, blocking: true });
  }

  const xapp = appToken();
  items.push(
    !xapp
      ? { name: "socket", status: "skip", detail: "no app token (SLACK_APP_TOKEN or slack.appTokenFile): `watch` polls instead of `listen`, optional", blocking: false }
      : { name: "socket", status: xapp.startsWith("xapp-") ? "ok" : "warn", detail: xapp.startsWith("xapp-") ? "app token found, `listen` can open the socket" : "SLACK_APP_TOKEN does not start with xapp-", blocking: false },
  );

  const glab = Bun.which("glab");
  items.push({ name: "glab", status: glab ? "ok" : s.forge ? "warn" : "skip", detail: glab ? glab : s.forge ? "forge is set but glab is missing: no delivery line on the board" : "not found, only needed with a GitLab forge", blocking: false });
  const gh = Bun.which("gh");
  items.push({ name: "gh", status: gh ? "ok" : "skip", detail: gh ? `${gh} (GitHub is not wired as a forge yet: sessions may use it)` : "not found, optional", blocking: false });
  const ttyd = Bun.which("ttyd");
  items.push({ name: "ttyd", status: ttyd ? "ok" : "skip", detail: ttyd ? ttyd : "not found: no terminal inside the board (brew install ttyd), optional", blocking: false });
  if (process.platform === "darwin") {
    const iterm = existsSync("/Applications/iTerm.app");
    items.push({ name: "iTerm2", status: iterm ? "ok" : s.ui.iterm ? "warn" : "skip", detail: iterm ? `installed${s.ui.iterm ? "" : " (ui.iterm is off)"}` : s.ui.iterm ? "ui.iterm is on but iTerm2 is not installed" : "not installed, optional", blocking: false });
  }
  items.push({ name: "shadow", status: "ok", detail: s.workers.shadow ? "on: sessions prepare, nothing is posted (setup --live turns it off)" : "off: the board can post and send a go", blocking: false });

  const r = checkReport(short(F.config), existsSync(F.config), missingSettings(s), items, cliCommand());
  for (const line of r.lines) out(line);
  process.exit(r.code);
}

// ------------------------------------------------------------------ --detect

/** Folders that hold a git repository: the workspace itself, and its direct children (an umbrella folder of repos). */
function gitRepos(): string[] {
  const dirs = existsSync(join(WORKSPACE, ".git")) ? [WORKSPACE] : [];
  try {
    for (const d of readdirSync(WORKSPACE, { withFileTypes: true })) {
      if (d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules" && existsSync(join(WORKSPACE, d.name, ".git"))) dirs.push(join(WORKSPACE, d.name));
    }
  } catch {}
  return dirs.slice(0, 20);
}

const git = async (dir: string, ...args: string[]) => {
  const r = await run(["git", "-C", dir, ...args], 8_000).catch(() => ({ code: -1, out: "" }));
  return r.code === 0 ? r.out.trim() : "";
};

/** Where a Linear MCP server is declared, if anywhere: the workspace's .mcp.json, then the user's ~/.claude.json. */
function linearMcp(): string | null {
  const mentions = (servers: unknown) => servers && typeof servers === "object" && Object.entries(servers).some(([name, cfg]) => /linear/i.test(name) || /linear/i.test(JSON.stringify(cfg)));
  if (mentions(readJson<{ mcpServers?: unknown }>(join(WORKSPACE, ".mcp.json"), {}).mcpServers)) return `${WORKSPACE}/.mcp.json`;
  const user = readJson<{ mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> }>(join(homedir(), ".claude.json"), {});
  if (mentions(user.mcpServers) || mentions(user.projects?.[WORKSPACE]?.mcpServers)) return "~/.claude.json";
  return null;
}

async function detect() {
  const fields: Record<string, Detected> = {};
  const notes: string[] = [];
  const set = (path: string, value: unknown, source: string, confidence: Detected["confidence"], candidates?: unknown[]) => {
    fields[path] = { value, source, confidence, ...(candidates ? { candidates } : {}) };
  };

  // Slack: who, where, which groups, which channels
  const probes = await probeTokens();
  const token = chosen(probes);
  if (!probes.length) notes.push("slack: no user token found, nothing read from Slack (see SETUP.md, 'Connect Slack')");
  else if (!token) notes.push(`slack: no usable token (${probes.map((p) => p.error ?? `workspace ${p.team}`).join(", ")})`);
  if (token) {
    const me = token.user as string;
    set("slack.team", token.team, "auth.test", "high");
    set("slack.workspace", token.url ? slackWorkspaceFromUrl(token.url) : null, "auth.test url", "high");
    set("slack.me", me, "auth.test", "high");
    const tryRead = async (method: string, params: Record<string, string>, scope: string) => {
      try {
        return (await slackRead(token.token, method, params)).body;
      } catch (e) {
        notes.push(`slack: ${method} failed (${e instanceof SlackAnswer ? e.message : `network: ${(e as Error).message}`})${e instanceof SlackAnswer && e.message === "missing_scope" ? `: the token lacks ${scope}` : ""}`);
        return null;
      }
    };
    const profile = await tryRead("users.info", { user: me }, "users:read");
    if (profile) set("owner.name", firstNameOf(profile.user), "users.info (first name)", "medium");

    const groups = await tryRead("usergroups.list", { include_users: "true" }, "usergroups:read");
    if (groups) {
      const mine = ((groups.usergroups ?? []) as { id: string; handle: string; name: string; users?: string[] }[]).filter((g) => g.users?.includes(me));
      const listed = mine.map((g) => ({ id: g.id, handle: `@${g.handle}`, name: g.name, members: g.users?.length ?? 0 }));
      if (mine.length === 1) {
        set("slack.subteams", [mine[0].id], "usergroups.list (the only group you belong to)", "medium", listed);
        set("slack.teamAlias", `@${mine[0].handle}`, "usergroups.list", "medium");
        const names: string[] = [];
        for (const uid of (mine[0].users ?? []).filter((u) => u !== me).slice(0, 25)) {
          const u = await tryRead("users.info", { user: uid }, "users:read");
          if (u?.user && !u.user.deleted && !u.user.is_bot) names.push(displayNameOf(u.user) ?? uid);
        }
        set("slack.teammates", names, `members of @${mine[0].handle}`, "medium");
      } else set("slack.subteams", [], mine.length ? "usergroups.list (several groups: which ones mean you?)" : "usergroups.list (you belong to no group)", "low", listed);
    }

    const after = localDay(Date.now() - 15 * 86_400_000);
    const matches: SearchMatch[] = [];
    for (let page = 1; page <= 3; page++) {
      const r = await tryRead("search.messages", { query: `from:<@${me}> after:${after}`, count: "100", page: String(page), sort: "timestamp" }, "search:read");
      if (!r) break;
      matches.push(...((r.messages?.matches ?? []) as SearchMatch[]));
      if (page >= (r.messages?.paging?.pages ?? 1)) break;
    }
    if (matches.length) set("slack.watchChannels", [], `search.messages from:me, 14 days (${matches.length} messages): channels where you write most, to pick from`, "low", topChannels(matches));
  }
  if (process.env.SLACK_APP_TOKEN) notes.push("socket: SLACK_APP_TOKEN is in the environment, slack.appTokenFile is not needed");

  // git: forge, repositories, branches, ticket prefixes, Linear workspace
  const remotes: (Remote & { dir: string })[] = [];
  const texts: string[] = [];
  let integration: string | null = null;
  let release: string | null = null;
  for (const dir of gitRepos()) {
    const url = await git(dir, "remote", "get-url", "origin");
    const r = url ? parseRemote(url) : null;
    if (r) remotes.push({ ...r, dir });
    texts.push(...(await git(dir, "log", "-n", "300", "--format=%s%n%b")).split("\n"));
    const branches = (await git(dir, "branch", "-r")).split("\n").map((b) => b.trim());
    integration ??= ["origin/dev", "origin/develop", "origin/staging"].find((b) => branches.includes(b))?.slice("origin/".length) ?? null;
    release ??= (await git(dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")).replace(/^origin\//, "") || null;
  }
  const gitlab = remotes.filter((r) => r.kind === "gitlab");
  if (gitlab.length) {
    const repos = Object.fromEntries(gitlab.map((r) => [basename(r.path), r.path]));
    set("forge.kind", "gitlab", "git remote", "high");
    set("forge.host", gitlab[0].host, "git remote", "high");
    set("forge.repos", repos, `git remote of ${gitlab.map((r) => r.dir).join(", ")}`, "high");
    if (gitlab.length === 1) set("forge.defaultRepo", basename(gitlab[0].path), "the only repository", "high");
    if (integration) set("forge.integrationBranch", integration, "remote branches", "medium");
    if (release) set("forge.releaseBranch", release, "origin/HEAD", "medium");
  }
  const github = remotes.filter((r) => r.kind === "github");
  if (github.length) notes.push(`forge: ${github.map((r) => r.path).join(", ")} on GitHub, which Strato does not follow yet: leave forge null for them`);
  if (!remotes.length) notes.push(`forge: no git remote found in ${WORKSPACE} or its direct subfolders`);

  const mcp = linearMcp();
  const prefixes = ticketPrefixes(texts);
  const linearWs = linearWorkspaces(texts);
  if (mcp) set("tracker.kind", "linear", `Linear MCP in ${mcp}`, "medium");
  if (mcp || linearWs.length) {
    if (linearWs.length) set("tracker.workspace", linearWs[0], "linear.app links in commit messages", "medium", linearWs);
    if (prefixes.length) set("tracker.prefixes", prefixes.filter((p) => p.count >= 10).map((p) => p.prefix), "ticket ids in commit messages", prefixes[0].count >= 10 ? "medium" : "low", prefixes);
  } else notes.push("tracker: no Linear MCP found (.mcp.json, ~/.claude.json): tracker stays null unless you use Linear");

  // the machine
  if (process.platform === "darwin") set("ui.iterm", existsSync("/Applications/iTerm.app"), "/Applications/iTerm.app", "medium");
  set("ui.locale", localeFromEnv(process.env.LC_ALL || process.env.LANG), "LANG", "low");

  out(JSON.stringify({ workspace: WORKSPACE, state: STATE, config: { path: F.config, exists: existsSync(F.config) }, fields, suggested: suggestedConfig(fields), notes }, null, 2));
}

// ------------------------------------------------------------------ --write, --live

/** Writes `incoming` into config.json: created, merged into the existing file, or replaced with `force`. */
function writeProfile(incoming: unknown, force: boolean, label: string) {
  const errors = profileErrors(incoming);
  if (errors.length) fail(`${label} refused, nothing written:\n  ${errors.join("\n  ")}`);
  mkdirSync(STATE, { recursive: true });
  const existed = existsSync(F.config);
  const before = existed ? readJson<unknown>(F.config, {}) : {};
  // a profile created here starts in shadow mode unless it says otherwise: the first day posts nothing
  const next = existed ? (force ? incoming : mergeProfile(before, incoming)) : mergeProfile(NEW_INSTALL_PROFILE, incoming);
  const diff = profileDiff(before, next);
  writeJson(F.config, next);
  out(`${existed ? (force ? "replaced (--force)" : "merged into") : "created"} ${F.config}`);
  for (const line of diff.length ? diff : ["no change"]) out(`  ${line}`);
  const s = resolveSettings(next);
  const missing = missingSettings(s);
  out(missing.length ? `to fill in: ${missing.join(", ")}` : "profile complete");
  out(`shadow mode: ${s.workers.shadow ? "on, nothing is posted" : "off"}`);
}

/** Prints the prefilled app creation link, and opens it unless `print` (or nothing on the machine opens a URL). */
async function slackApp(print: boolean) {
  const link = slackAppLink(manifestYaml);
  out("Create Strato's Slack app, manifest already filled in: pick your workspace, Next, Create, then Install to Workspace.");
  out("Then copy the User OAuth Token (xoxp-…) from OAuth & Permissions.");
  out("");
  out(link);
  const opener = process.platform === "darwin" ? "open" : Bun.which("xdg-open") ? "xdg-open" : null;
  if (print || !opener) return;
  await run([opener, link], 10_000).catch(() => null);
}

export async function setup(args: string[]) {
  const { opts } = flags(args);
  if (opts["slack-app"]) return slackApp(opts.print === "true");
  if (opts.check) return check();
  if (opts.detect) return detect();
  if (opts.live) return writeProfile({ workers: { shadow: false } }, false, "--live");
  if (opts.write && opts.write !== "true") {
    let incoming: unknown;
    try {
      incoming = JSON.parse(opts.write === "-" ? await Bun.stdin.text() : readFileSync(opts.write, "utf8"));
    } catch (e) {
      fail(`cannot read ${opts.write} as JSON: ${(e as Error).message}`);
    }
    return writeProfile(incoming, opts.force === "true", opts.write);
  }
  fail("usage: setup --check | --detect | --write <profile.json> [--force] | --live | --slack-app [--print]", 64);
}
