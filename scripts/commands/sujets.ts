/**
 * The commands that create a topic and keep it alive: doctor, open, attach, relay/send, set, close, list, gates.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { agentsBySession, sessionIdOf, spawnBackgroundOrThrow, workerSettings } from "../app/claude.ts";
import { CLAUDE_BIN, F, fail, flags, nowIso, out, SCRIPT, STATE, WORKSPACE } from "../app/env.ts";
import { appToken, connectSlack, NO_TOKEN } from "../app/slack.ts";
import { claimResume, createSujet, dropSujet, endResume, ensureState, loadSujets, logEvent, messageOf, mutateSujets, requireSujet, reserveLetter, updateSujet } from "../app/store.ts";
import { attention, firstSpawnArgs, inboundNote, isStuck, resumeArgs, routeDecision } from "../claude/model.ts";
import { deliverThroughInbox, ensureModFolder, modFolderState } from "../app/mod.ts";
import { gateLine } from "../core/cards.ts";
import { locale, t } from "../core/i18n.ts";
import { canonicalKey, conversationOfKey, parseKey, permalinkOfKey, sujetKey, threadOfKey, ticketUrl } from "../core/keys.ts";
import { descriptorOf, providerDescriptors, providerLabel, ticketClaims } from "../core/links.ts";
import { LEGACY_SLACK_READS, mcpReadRules } from "../core/mcp.ts";
import { toolLabel } from "../core/targets.ts";
import { missingSettings, resolveAccounts, settings } from "../core/settings.ts";
import { accountLines } from "./connect.ts";
import { closeTopic } from "../app/close.ts";
import { cliCommand, nextLine, short } from "./setup.ts";
import { applyAssignments, attachThread, findSujet, parseAssignments, type Sujet, sujetKeys, type Trigger } from "../core/sujet.ts";
import { reportFile, sessionName, truncate } from "../core/text.ts";
import { DEFAULT_POLICY_DIR, followUpMessage, POLICY_TEMPLATES, policySource, roleSource, shadowedPolicyNames, ticketPrompt, usesTopicWords, workerPrompt } from "../policy/prompts.ts";
import { isRole, roleOf, ROLES, ticketTemplateOf } from "../core/roles.ts";

// ------------------------------------------------------------------ commands

/**
 * What is wired and what is missing, one line per component. Everything is printed before concluding: a missing token
 * does not hide the rest. Exit code 78 when Slack is unreachable.
 */
export async function doctor() {
  ensureState();
  const s = settings();
  const cfg = s.slack;
  const missing = missingSettings(s);
  out(`profile  : ${short(F.config)}${missing.length ? ` · to fill in: ${missing.join(", ")}` : ""}`);
  // the role shows only when it is not the default: a developer's doctor prints what it always printed
  const role = roleOf(s);
  const roleNote =
    s.owner.role !== undefined && !isRole(s.owner.role) ? t("cli.doctor.roleUnknown", { role: String(s.owner.role), roles: ROLES.join(", ") })
    : role === "developer" ? ""
    : t("cli.doctor.role", { role, file: roleSource(role) === F.policy ? short(join(F.policy, "roles", `${role}.md`)) : t("cli.doctor.roleShipped") });
  out(`owner    : ${s.owner.name} · workspace ${WORKSPACE}${roleNote ? ` · ${roleNote}` : ""}`);
  const slackOk = await connectSlack(cfg);
  if (!slackOk) out(`slack    : ${NO_TOKEN(cfg)}`);
  else {
    const fixes = [
      ...(slackOk.teamUnset ? [`slack.team is not set: "${slackOk.team}"`] : []),
      ...(slackOk.me === cfg.me ? [] : [`slack.me is ${cfg.me || "empty"}: "${slackOk.me}"`]),
    ];
    out(`slack    : ${slackOk.team} · user ${slackOk.me}${fixes.length ? ` · to fix in config.json, ${fixes.join(", ")} (setup --detect proposes them)` : ""}`);
  }
  out(`socket   : ${appToken() ? "app token found, listen can open the socket" : "no app token (SLACK_APP_TOKEN or slack.appTokenFile): only watch, by polling, works"}`);
  // one line per other account (named Slack workspaces, connected tools): none in a Slack-only profile
  for (const line of await accountLines(cliCommand())) out(line);
  const rows = agentsBySession();
  out(`claude   : ${rows ? `${rows.size} active session(s)` : "claude agents --json does not answer"}`);
  out(`state    : ${short(STATE)} · ${loadSujets().length} topic(s)`);
  out(
    cfg.watchOnly
      ? `triggers : watched channels only (slack.watchOnly) ${cfg.watchChannels.join(", ") || "-"}, tracked threads · DMs and mentions are not raised`
      : `triggers : mentions of ${cfg.me || "-"}, groups ${cfg.subteams.join(", ") || "-"}, DMs, channels ${cfg.watchChannels.join(", ") || "-"}, tracked threads`,
  );
  out(`digest   : messages aimed at someone else, authors ${cfg.ignoreAuthors.join(", ") || "-"}`);
  // the accounts of a configured tracker tool (a connected Linear, an external tracker): topics come from them too
  const descriptors = Object.fromEntries(providerDescriptors().map((d) => [d.id, d]));
  const accounts = resolveAccounts(s, descriptors).map((a) => a.account);
  const trackers = accounts.filter((a) => descriptors[a.provider]?.kinds.includes("tracker")).map((a) => toolLabel(a.provider, a.id));
  out(`tickets  : ${s.tracker ? `Linear ${s.tracker.workspace}, prefixes ${s.tracker.prefixes.join(", ") || "none"}` : trackers.length ? `from ${trackers.join(", ")}` : "no tracker: topics only come from Slack"}`);
  out(`forge    : ${s.forge ? `${s.forge.host}, repositories ${Object.keys(s.forge.repos).join(", ") || "none"}, release ${s.forge.integrationBranch} -> ${s.forge.releaseBranch}` : "none: no delivery line on the board"}`);
  // the read tools connected tools bring beyond the Slack reads every session always had: none in a Slack-only profile
  const toolReads = mcpReadRules(s).filter((r) => !LEGACY_SLACK_READS.includes(r)).length;
  out(`sessions : ${s.workers.skipPermissions ? "without permission prompts (workers.skipPermissions)" : "with permission prompts"} · ${s.workers.allow.length} permission(s) added by the profile${toolReads > 0 ? ` · ${toolReads} MCP read tool(s) of the connected tools allowed` : ""}${s.workers.shadow ? " · shadow mode: nothing is posted (setup --live)" : ""}`);
  const overridden = POLICY_TEMPLATES.filter((t) => policySource(t) === F.policy);
  // the note matters only when another tool's topics exist: a Slack-only doctor prints what it always printed
  const otherTools = accounts.some((a) => a.provider !== "slack");
  const wordless = otherTools ? overridden.filter((name) => !usesTopicWords(name)) : [];
  const shadowed = shadowedPolicyNames(s.policy);
  const policyNotes = [
    ...(wordless.length ? [t("cli.doctor.policyWithoutWords", { names: wordless.join(", ") })] : []),
    ...(shadowed.length ? [t("cli.doctor.policyReserved", { names: shadowed.map((n) => `policy.${n}`).join(", ") })] : []),
  ];
  out(`policy   : ${overridden.length ? `${overridden.join(", ")} from ${F.policy}, the rest by default` : `skill defaults (${DEFAULT_POLICY_DIR})`}${policyNotes.map((n) => ` · ${n}`).join("")}`);
  out(`board    : http://127.0.0.1:${s.ui.port}/board${s.ui.iterm ? " · iTerm2 integration on" : ""}`);
  out(`locale   : ${locale()} (ui.locale: the language of the board and of the master's messages to ${s.owner.name})`);
  out(`mod      : ${modLine(s.workers.mod)}`);
  out(`notes    : ${existsSync(join(STATE, "local.md")) ? `${join(STATE, "local.md")}, to read at startup` : "none (no local.md)"}`);
  out(`script   : ${short(SCRIPT)}`);
  out(nextLine({ blocked: [...(rows ? [] : ["claude"]), ...(slackOk ? [] : ["slack"])], profileIncomplete: missing.length > 0 }));
  if (!slackOk) process.exit(78);
}

/**
 * Strato's mod (app/mod.ts): whether new topic sessions load it, whether its folder is in place (written now when it
 * is not), and what `claude plugin validate` says of it. A failed validation is a warning: the board falls back to
 * Claude Code's files for a session whose mod did not load.
 */
function modLine(on: boolean): string {
  if (!on) return "off (workers.mod: false): sessions declare nothing, the board reads Claude Code's files";
  const before = modFolderState(STATE);
  let dir: string;
  try {
    dir = ensureModFolder(STATE);
  } catch (e) {
    return `warning: ${short(join(STATE, "mod"))} cannot be written (${(e as Error).message}): sessions start without it`;
  }
  const place = `${short(dir)}${before === "missing" ? " (written now)" : before === "stale" ? " (updated now)" : ""}`;
  let r: ReturnType<typeof Bun.spawnSync>;
  try {
    r = Bun.spawnSync([CLAUDE_BIN, "plugin", "validate", dir], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  } catch {
    return `${place} · not validated, the claude CLI was not found`;
  }
  const text = `${r.stdout?.toString() ?? ""}${r.stderr?.toString() ?? ""}`;
  if (r.exitCode === 0 && /validation passed/i.test(text)) return `${place} · claude plugin validate: passed`;
  const why = text.trim().split("\n").filter(Boolean).pop() ?? `exit code ${r.exitCode}`;
  return `${place} · warning, claude plugin validate failed: ${why} (sessions fall back to Claude Code's files)`;
}

/** The message listen kept under this id, else stop: no relay with an empty text. */
function keptOrFail(id: string): Trigger {
  return messageOf(id) ?? fail(`message ${id} not found in ${F.inbox} (id from the [strato] line: msg=…)`);
}

/** `next` of a topic reserved by `open` whose session is not started yet. The French value is the one older versions wrote. */
const LAUNCHING = "starting the session";
const LAUNCHING_VALUES = [LAUNCHING, "lancement de la session"];
/** `attention()` label of a session whose turn is over: a protocol value shared with the live/ declarations, not display text. */
const TURN_DONE = "tour terminé";

export async function open(args: string[]) {
  ensureState();
  const { positional, opts } = flags(args);
  // --msg: the message surfaced by listen, reread as is; the master never copies a Slack text into the command
  const kept = opts.msg ? keptOrFail(opts.msg) : null;
  const ref = positional[0] ?? kept?.permalink;
  // a message of a tool whose link was not kept ("-"): the key it was kept with
  const key = (ref ? sujetKey(ref) : null) ?? (!positional[0] && kept?.key ? canonicalKey(kept.key) : null);
  // a bare ticket id two trackers claim: only its link says which one
  const claims = ref && !key ? ticketClaims(ref) : [];
  if (claims.length > 1) fail(t("cli.open.ambiguousTicket", { id: claims[0].native, tools: claims.map((c) => toolLabel(c.provider, c.account)).join(", ") }));
  if (!ref || !key) fail("usage: open [<Slack link | ABC-123 | Linear link>] --msg <id> --title …   (or --from … --channel … --text … without --msg)");
  // a ticket of any tracker account (linear:, linear@partners:, an external tracker): the ticket flow, its own link
  const parsed = parseKey(key);
  const tracker = parsed && !parsed.long && descriptorOf(parsed.provider)?.kinds.includes("tracker") ? parsed : null;
  const issueId = tracker ? tracker.native : null;
  const permalink = issueId ? ((key.startsWith("linear:") ? ticketUrl(issueId) : permalinkOfKey(key)) ?? ref) : ref;

  const existing = findSujet(loadSujets(), key);
  if (existing && existing.status !== "closed") {
    out(`already open · ${existing.letter} · ${existing.name} · ${existing.status} · claude attach ${existing.shortId}`);
    return;
  }
  const trigger: Trigger = kept ? { ...kept, permalink } : {
    from: opts.from ?? (issueId ? settings().owner.name : "?"),
    channel: opts.channel ?? (tracker ? toolLabel(tracker.provider, tracker.account) : (threadOfKey(key)?.channel ?? providerLabel(parseKey(key)?.provider ?? ""))),
    text: opts.text ?? "",
    permalink,
  };
  if (existing) {
    // a closed topic's letter may have been given out again meanwhile: two open topics never share a letter
    const clash = loadSujets().some((x) => x.key !== existing.key && x.status !== "closed" && x.letter === existing.letter);
    const letter = clash ? await reserveLetter() : existing.letter;
    // under the lock: a second `open` of the same thread finds the topic already reopened and starts nothing
    const reopened = await updateSujet(existing.key, (x) =>
      x.status === "closed" ? { ...applyAssignments(x, { status: "preparing", gate: "none", next: "reopened by a new message" }, nowIso()), letter } : null,
    );
    if (!reopened) {
      out(`already reopened · ${existing.letter} · ${existing.name}`);
      return;
    }
    out(`reopened · ${reopened.letter} · ${reopened.name}`);
    await route(reopened, followUpMessage("suite", trigger, SCRIPT, reopened.key, settings().slack.teammates));
    return;
  }

  mkdirSync(F.reports, { recursive: true });
  const report = join(F.reports, reportFile(key));
  const letter = await reserveLetter();
  const title = opts.title ?? truncate(trigger.text || (issueId ?? "Slack topic"), 40);
  const name = sessionName(trigger.channel, issueId ?? trigger.from, title, letter);
  const now = nowIso();
  // The topic is reserved under the lock before the launch, without a session: a second `open` of the same thread
  // finds it and stops there, so two simultaneous `open` never start two sessions for one topic.
  const reserved: Sujet = {
    key,
    threads: [key],
    letter,
    title,
    channel: trigger.channel,
    permalink,
    asker: trigger.from,
    sessionId: null,
    shortId: null,
    name,
    status: "preparing",
    gate: "none",
    waiting: "",
    next: LAUNCHING,
    summary: "",
    report,
    // the conversation the message came from, when the key does not name it: the event line's nearby topics read it
    ...(kept?.conversation && !conversationOfKey(key) ? { conversation: kept.conversation } : {}),
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, what: "opened" }],
  };
  const taken = await createSujet(reserved);
  if (taken) {
    out(`already open · ${taken.letter} · ${taken.name} · ${taken.status}${taken.shortId ? ` · claude attach ${taken.shortId}` : " · session starting"}`);
    return;
  }
  // a ticket opened from a message (a mention, an assignment) is a request to answer; from its id alone, the implementation
  // for a role other than developer, a ticket is a request to handle, not code to write: the worker flow (core/roles.ts)
  const prompt = issueId && !kept && ticketTemplateOf(roleOf()) === "ticket" ? ticketPrompt(title, key, issueId, permalink, SCRIPT, report) : workerPrompt(title, key, trigger, SCRIPT, report, settings().slack.teammates);
  // `workers.skipPermissions` (no permission prompts) and `workers.mod` (the session declares its state, app/mod.ts)
  // only apply at launch: added to `--resume`, a flag creates a copy of the session; a bare resume keeps them.
  // a mod folder that cannot be written costs the session its declarations, never its launch: the board falls back
  let pluginDir: string | null = null;
  if (settings().workers.mod) {
    try {
      pluginDir = ensureModFolder(STATE);
    } catch (e) {
      logEvent({ type: "mod-unwritable", key, error: (e as Error).message });
    }
  }
  let shortId: string;
  try {
    shortId = spawnBackgroundOrThrow(firstSpawnArgs({ name, settings: workerSettings(), prompt, skipPermissions: settings().workers.skipPermissions, modDir: pluginDir }));
  } catch (e) {
    // no session: the reservation goes, a later `open` can try again
    await dropSujet(key, (x) => x.createdAt === now && !x.shortId);
    fail((e as Error).message);
  }
  // the session may have written its card meanwhile (`set`): only the session's identity is filled in
  const sessionId = await sessionIdOf(shortId);
  await updateSujet(key, (x) => ({ ...x, shortId, sessionId, next: LAUNCHING_VALUES.includes(x.next) ? "preparing" : x.next }));
  logEvent({ type: "open", key, letter, shortId, name });
  out(`topic opened · ${name} · claude attach ${shortId}`);
}

export async function attach(args: string[]) {
  const [ref, link] = args;
  const key = link ? sujetKey(link) : null;
  if (!ref || !link || !key) fail("usage: attach <topic> <Slack link | ABC-123>");
  const s = requireSujet(ref);
  const other = loadSujets().find((x) => x.key !== s.key && x.status !== "closed" && sujetKeys(x).includes(key));
  if (other) fail(`${key} already belongs to the open topic ${other.letter} (${other.name}): close it or attach by hand`);
  let result = s;
  await mutateSujets((list) =>
    list.map((x) => {
      if (x.key !== s.key) return x;
      result = attachThread(x, key, nowIso());
      return result;
    }),
  );
  logEvent({ type: "attach", key: s.key, thread: key });
  out(`attached · ${result.letter} · ${result.name} · ${key} · ${sujetKeys(result).length} thread(s)`);
}

/** Gets a message into the topic's session, or tells the master to use SendMessage (exit code 3). */
export async function route(s: Sujet, message: string) {
  const sessionId = s.sessionId;
  if (!sessionId) fail(`topic ${s.key} has no sessionId`);
  // a session that declares itself through the mod takes the message from its inbox and acknowledges it
  const inbox = await deliverThroughInbox(STATE, sessionId, message);
  if (inbox.via === "inbox" && inbox.ack === "refused") fail(`the session of ${s.letter} has no ${message.trim().split(/\s/)[0]} command: nothing was delivered`);
  if (inbox.via === "inbox") {
    logEvent({ type: "relay", key: s.key, via: "inbox", ack: inbox.ack });
    return out(`delivered · ${s.letter} · ${s.name} · ${inbox.ack === "submitted" ? "the session took it now" : "the session is busy, it runs after its turn"}`);
  }
  const rows = agentsBySession();
  if (!rows) fail("claude agents --json does not answer, cannot tell whether the session runs");
  // The last line says the message is not delivered yet: a caller that keeps only the last line (`| tail -1`) used
  // to read the relay note at the end of the message and believe it was delivered.
  const toLive = () => {
    out(`SENDMESSAGE ${s.name}`);
    out(`${message}\n\n${inboundNote(settings().owner.name)}`);
    out(`NOT DELIVERED YET: send the text above with the SendMessage tool to "${s.name}", then check it reached the session's transcript.`);
    process.exit(3);
  };
  if (routeDecision(rows.get(sessionId)) === "sendmessage") toLive();
  const busyUntil = await claimResume(s.key);
  if (busyUntil !== null) {
    // another relay is already resuming the session: wait until it runs, then pass the message through SendMessage
    while (Date.now() < busyUntil) {
      await Bun.sleep(1_000);
      if (routeDecision(agentsBySession()?.get(sessionId)) === "sendmessage") toLive();
    }
    fail(`the session of topic ${s.letter} is being resumed by another message and is not visible yet: send this one again in a minute`);
  }
  // without any option: Claude Code continues the same session instead of creating a copy
  let shortId: string;
  try {
    shortId = spawnBackgroundOrThrow(resumeArgs(sessionId, message));
  } catch (e) {
    await endResume(s.key);
    fail((e as Error).message);
  }
  const resumedId = shortId !== s.shortId ? await sessionIdOf(shortId) : null;
  await updateSujet(s.key, (x) => {
    const { resumingUntil: _, ...next } = applyAssignments(x, { status: "working" }, nowIso());
    return shortId !== x.shortId ? { ...next, shortId, sessionId: resumedId ?? x.sessionId } : next;
  });
  logEvent({ type: "resume", key: s.key, shortId });
  out(`resumed · ${s.letter} · ${s.name} · claude attach ${shortId}`);
}

export async function relay(args: string[]) {
  const { positional, opts } = flags(args);
  const s = requireSujet(positional[0]);
  const kind = opts.kind === "moi" ? "moi" : "suite";
  const kept = opts.msg ? keptOrFail(opts.msg) : null;
  const t: Trigger = kept ?? { from: opts.from ?? "?", channel: opts.channel ?? s.channel, text: opts.text ?? "", permalink: opts.permalink ?? s.permalink };
  await route(s, followUpMessage(kind, t, SCRIPT, s.key, settings().slack.teammates));
}

export async function set(args: string[]) {
  const [ref, ...kv] = args;
  const s = requireSujet(ref);
  let kvs: Record<string, string>;
  try {
    kvs = parseAssignments(kv);
    applyAssignments(s, kvs, nowIso());
  } catch (e) {
    fail((e as Error).message);
  }
  // only the given fields change, applied to the state reread under the lock
  const next = await updateSujet(s.key, (x) => applyAssignments(x, kvs, nowIso()));
  if (!next) fail(`topic ${s.key} disappeared during the write`);
  out(`state written · ${next.letter} · ${next.name} · ${next.status}${next.gate !== "none" ? `/${next.gate}` : ""}${next.waiting ? ` · waiting for ${next.waiting}` : ""}`);
}

/**
 * Closes the topic and stops its session. `--settled` (the master, rule 1 of `suite` messages: the requester thanks
 * after an answer) also puts the tool's settled marker (Slack: ✅) on the topic's original message, through the act
 * path; the topic closes whatever becomes of it, and the second line says what did.
 */
export async function close(args: string[]) {
  // a flag without a value, wherever it is: `close --settled A` and `close A --settled` say the same
  const settled = args.includes("--settled");
  const s = requireSujet(args.find((a) => !a.startsWith("--")));
  const rows = agentsBySession();
  if (s.sessionId && rows?.has(s.sessionId) && s.shortId) Bun.spawnSync([CLAUDE_BIN, "stop", s.shortId], { stdout: "pipe", stderr: "pipe" });
  const r = await closeTopic({ key: s.key, settled, by: "master" });
  if (!r) fail(`topic ${s.key} disappeared during the write`);
  out(`closed · ${s.letter} · ${s.name} (conversation kept: claude attach ${s.shortId})`);
  if (settled) out(`${r.reaction === "posted" || r.reaction === "already" ? "✅" : "no ✅"} · ${r.note}`);
}

export function age(iso: string): string {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return min < 60 ? `${min} min` : min < 1440 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} d`;
}

export function list(all: boolean) {
  const rows = agentsBySession();
  const sujets = loadSujets()
    .filter((s) => all || s.status !== "closed")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!sujets.length) return out("no topic");
  for (const s of sujets) {
    const live = s.sessionId && rows ? (attention(rows.get(s.sessionId)) ?? "working") : "?";
    const threads = sujetKeys(s).length > 1 ? ` · ${sujetKeys(s).length} threads` : "";
    out(`${s.letter} · ${s.shortId ?? "-"} · ${s.status}${s.gate !== "none" ? `/${s.gate}` : ""} · ${live} · ${s.name}${threads} · ${age(s.updatedAt)}${s.waiting ? ` · waiting for ${s.waiting}` : ""}`);
    if (s.next) out(`    → ${truncate(s.next, 160)}`);
  }
}

export function gates() {
  const rows = agentsBySession();
  const open = loadSujets().filter((s) => s.status !== "closed");
  const live = (s: Sujet) => (s.sessionId && rows ? rows.get(s.sessionId) : undefined);
  const groups: [string, Sujet[]][] = [
    ["Stuck (permission or dialog)", open.filter((s) => isStuck(live(s)))],
    ["To approve", open.filter((s) => s.status === "gate")],
    ["Preparation done, state not written", open.filter((s) => s.status === "preparing" && attention(live(s)) === TURN_DONE)],
    ["Waiting for a third party", open.filter((s) => s.status === "waiting")],
    ["Working", open.filter((s) => live(s)?.status === "busy")],
  ];
  let any = false;
  const shown = new Set<string>();
  for (const [label, items] of groups) {
    const fresh = items.filter((s) => !shown.has(s.key));
    if (!fresh.length) continue;
    any = true;
    out(`${label}:`);
    for (const s of fresh) {
      shown.add(s.key);
      out(`  ${gateLine(s)}`);
    }
  }
  if (!any) out(`nothing is waiting for ${settings().owner.name}`);
}
