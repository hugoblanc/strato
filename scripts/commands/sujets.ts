/**
 * The commands that create a topic and keep it alive: doctor, open, attach, relay/send, set, close, list, gates.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { agentsBySession, sessionIdOf, spawnBackgroundOrThrow, workerSettings } from "../app/claude.ts";
import { CLAUDE_BIN, F, fail, flags, nowIso, out, SCRIPT, STATE, WORKSPACE } from "../app/env.ts";
import { appToken, connectSlack, NO_TOKEN } from "../app/slack.ts";
import { claimResume, createSujet, dropSujet, endResume, ensureState, loadSujets, logEvent, messageOf, mutateSujets, requireSujet, reserveLetter, updateSujet } from "../app/store.ts";
import { attention, inboundNote, isStuck, routeDecision } from "../claude/model.ts";
import { gateLine } from "../core/cards.ts";
import { locale } from "../core/i18n.ts";
import { parseKey, sujetKey, threadOfKey, ticketUrl } from "../core/keys.ts";
import { providerLabel } from "../core/links.ts";
import { missingSettings, settings } from "../core/settings.ts";
import { nextLine, short } from "./setup.ts";
import { applyAssignments, attachThread, findSujet, parseAssignments, type Sujet, sujetKeys, type Trigger } from "../core/sujet.ts";
import { reportFile, sessionName, truncate } from "../core/text.ts";
import { DEFAULT_POLICY_DIR, followUpMessage, POLICY_TEMPLATES, policySource, ticketPrompt, workerPrompt } from "../policy/prompts.ts";

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
  out(`owner    : ${s.owner.name} · workspace ${WORKSPACE}`);
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
  const rows = agentsBySession();
  out(`claude   : ${rows ? `${rows.size} active session(s)` : "claude agents --json does not answer"}`);
  out(`state    : ${short(STATE)} · ${loadSujets().length} topic(s)`);
  out(`triggers : mentions of ${cfg.me || "-"}, groups ${cfg.subteams.join(", ") || "-"}, DMs, channels ${cfg.watchChannels.join(", ") || "-"}, tracked threads`);
  out(`digest   : messages aimed at someone else, authors ${cfg.ignoreAuthors.join(", ") || "-"}`);
  out(`tickets  : ${s.tracker ? `Linear ${s.tracker.workspace}, prefixes ${s.tracker.prefixes.join(", ") || "none"}` : "no tracker: topics only come from Slack"}`);
  out(`forge    : ${s.forge ? `${s.forge.host}, repositories ${Object.keys(s.forge.repos).join(", ") || "none"}, release ${s.forge.integrationBranch} -> ${s.forge.releaseBranch}` : "none: no delivery line on the board"}`);
  out(`sessions : ${s.workers.skipPermissions ? "without permission prompts (workers.skipPermissions)" : "with permission prompts"} · ${s.workers.allow.length} permission(s) added by the profile${s.workers.shadow ? " · shadow mode: nothing is posted (setup --live)" : ""}`);
  const overridden = POLICY_TEMPLATES.filter((t) => policySource(t) === F.policy);
  out(`policy   : ${overridden.length ? `${overridden.join(", ")} from ${F.policy}, the rest by default` : `skill defaults (${DEFAULT_POLICY_DIR})`}`);
  out(`board    : http://127.0.0.1:${s.ui.port}/board${s.ui.iterm ? " · iTerm2 integration on" : ""}`);
  out(`locale   : ${locale()} (ui.locale: the language of the board and of the master's messages to ${s.owner.name})`);
  out(`notes    : ${existsSync(join(STATE, "local.md")) ? `${join(STATE, "local.md")}, to read at startup` : "none (no local.md)"}`);
  out(`script   : ${short(SCRIPT)}`);
  out(nextLine({ blocked: [...(rows ? [] : ["claude"]), ...(slackOk ? [] : ["slack"])], profileIncomplete: missing.length > 0 }));
  if (!slackOk) process.exit(78);
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
  const key = ref ? sujetKey(ref) : null;
  if (!ref || !key) fail("usage: open [<Slack link | ABC-123 | Linear link>] --msg <id> --title …   (or --from … --channel … --text … without --msg)");
  const issueId = key.startsWith("linear:") ? key.slice("linear:".length) : null;
  const permalink = issueId ? (ticketUrl(issueId) ?? ref) : ref;

  const existing = findSujet(loadSujets(), key);
  if (existing && existing.status !== "closed") {
    out(`already open · ${existing.letter} · ${existing.name} · ${existing.status} · claude attach ${existing.shortId}`);
    return;
  }
  const trigger: Trigger = kept ? { ...kept, permalink } : {
    from: opts.from ?? (issueId ? settings().owner.name : "?"),
    channel: opts.channel ?? (issueId ? "Linear" : (threadOfKey(key)?.channel ?? providerLabel(parseKey(key)?.provider ?? ""))),
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
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, what: "opened" }],
  };
  const taken = await createSujet(reserved);
  if (taken) {
    out(`already open · ${taken.letter} · ${taken.name} · ${taken.status}${taken.shortId ? ` · claude attach ${taken.shortId}` : " · session starting"}`);
    return;
  }
  const prompt = issueId ? ticketPrompt(title, key, issueId, permalink, SCRIPT, report) : workerPrompt(title, key, trigger, SCRIPT, report, settings().slack.teammates);
  // `workers.skipPermissions`: topic sessions run without permission prompts. The flag only applies at launch:
  // added to `--resume`, it creates a copy of the session; a bare resume keeps the mode.
  const permissionFlags = settings().workers.skipPermissions ? ["--dangerously-skip-permissions"] : [];
  let shortId: string;
  try {
    shortId = spawnBackgroundOrThrow([...permissionFlags, "-n", name, "--settings", workerSettings(), prompt]);
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
  const rows = agentsBySession();
  if (!rows) fail("claude agents --json does not answer, cannot tell whether the session runs");
  const sessionId = s.sessionId;
  if (!sessionId) fail(`topic ${s.key} has no sessionId`);
  const toLive = () => {
    out(`SENDMESSAGE ${s.name}`);
    out(`${message}\n\n${inboundNote(settings().owner.name)}`);
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
    shortId = spawnBackgroundOrThrow(["--resume", sessionId, message]);
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

export async function close(ref: string | undefined) {
  const s = requireSujet(ref);
  const rows = agentsBySession();
  if (s.sessionId && rows?.has(s.sessionId) && s.shortId) Bun.spawnSync([CLAUDE_BIN, "stop", s.shortId], { stdout: "pipe", stderr: "pipe" });
  await updateSujet(s.key, (x) => applyAssignments(x, { status: "closed", gate: "none", waiting: "-" }, nowIso()));
  out(`closed · ${s.letter} · ${s.name} (conversation kept: claude attach ${s.shortId})`);
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
