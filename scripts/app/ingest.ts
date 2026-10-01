/**
 * Ingest through providers (docs/design/providers.md, sections 4.8, 4.12 and 7): every item that comes in, whatever
 * its tool, goes through one triage pass (`processItems`), one dedup per account, one line per event for the master's
 * Monitor and one log. This module also runs the ingest loop of one account (`runAccount`), with its own failure
 * handling and retry, so that one tool down never stops the others.
 *
 * The default Slack account keeps its state where it always was (seen.json and tick.json at the root of the state
 * folder) and its loop in commands/watch.ts, with the lines older versions printed; every other account keeps its
 * state in its own folder, `<state>/providers/<provider>-<account>/`: `seen.json` and `ingest.json` (its cursor).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Config, slackItem, type SlackMatch } from "../chat/slack-model.ts";
import { eventLine } from "../core/cards.ts";
import { conversationRef, formatKey, threadOfKey } from "../core/keys.ts";
import { checkedLink, providerLabel } from "../core/links.ts";
import { applyAssignments, draftMatches, findSujet, type Sujet, sujetKeys, trackedKeys, type Trigger } from "../core/sujet.ts";
import { closeTask, openTasks, taskDraftText } from "../core/tasks.ts";
import { t } from "../core/i18n.ts";
import { oneLine, truncate, untrusted } from "../core/text.ts";
import { classifyItem, editAlreadyRaised, effectiveIdentity, isSilent, itemEventType, type Kind, triageRules, type TriageRules, withoutAuthors } from "../core/triage.ts";
import { effectiveCapabilities, providerError } from "../providers/api.ts";
import { type AccountEntry, accountContext, accountDir, accountOf, accounts, keyFor, nativeOfKey } from "../providers/registry.ts";
import type { Account, AccountContext, Identity, IngestCursor, Item, PollResult, Provider } from "../providers/sdk.ts";
import { slackProvider } from "../providers/slack/index.ts";
import { F, nowIso, out, readJson, writeJson } from "./env.ts";
import { keepMessage, loadSujets, logEvent, updateSujet } from "./store.ts";

// ------------------------------------------------------------------ seen

/** What an account has already handled, by item key: an item is marked once its line is out, never before. */
export interface SeenStore {
  has(id: string): boolean;
  add(id: string): void;
  /** Purges what is older than three days and writes the file. */
  save(): void;
}

/** How long a handled item is remembered: well beyond the overlap of two passes. */
const SEEN_KEEP_MS = 3 * 86_400_000;

/**
 * What an edit is remembered under, next to its item's id: a tool that reports the same edit on every overlapping
 * poll raises it once. The item's id alone is marked too, so a later pass that finds the edited item stays quiet.
 */
const EDIT_MARK = "#edit";

/**
 * seen.json of the default Slack account, as older versions read it: the bare ids of its messages (`channel:ts`),
 * purged by the time their ts says. Edit marks stay in memory, so the file keeps the shape older versions wrote:
 * Slack reports an edit once, from its socket, and a mark only has to outlive the catch-ups of the same run.
 */
export function legacySeen(ids: Set<string> = new Set(readJson<string[]>(F.seen, []))): SeenStore {
  const edits = new Set<string>();
  return {
    has: (id) => (id.endsWith(EDIT_MARK) ? edits : ids).has(id),
    add: (id) => void (id.endsWith(EDIT_MARK) ? edits : ids).add(id),
    save() {
      const horizon = (Date.now() - SEEN_KEEP_MS) / 1000;
      for (const id of ids) if (Number(threadOfKey(id)?.ts) < horizon) ids.delete(id);
      writeJson(F.seen, [...ids]);
    },
  };
}

/** seen.json of another account, in its folder: `{ key: unixMs }`, purged by the time each item was handled. */
export function accountSeen(account: Pick<Account, "provider" | "id">): SeenStore {
  const dir = accountDir(account);
  const file = join(dir, "seen.json");
  const raw = readJson<Record<string, unknown>>(file, {});
  const ids = new Map(Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === "number"));
  return {
    has: (id) => ids.has(id),
    add: (id) => void ids.set(id, Date.now()),
    save() {
      const horizon = Date.now() - SEEN_KEEP_MS;
      for (const [id, at] of ids) if (at < horizon) ids.delete(id);
      mkdirSync(dir, { recursive: true });
      writeJson(file, Object.fromEntries(ids));
    },
  };
}

// ------------------------------------------------------------------ sources

/** One account as ingest runs it: its provider, what the provider receives, its rules, its dedup. */
export interface Source {
  account: Account;
  provider: Provider;
  ctx: AccountContext;
  rules: TriageRules;
  seen: SeenStore;
  /** Keys of the threads the person took part in recently. */
  participated: Set<string>;
  /** How lines name the account: "Slack", "Slack (partners)", "Tickets". */
  label: string;
}

/** The account's name in a line: its tool, and its name when it is not the default one. Third-party text when external. */
export const accountLabel = (a: Pick<Account, "provider" | "id">) => untrusted(oneLine(`${providerLabel(a.provider)}${a.id === "default" ? "" : ` (${a.id})`}`));

/**
 * What `connect` returned, as the core accepts it: its string fields, its groups that are strings. Null when it is not
 * an object at all: the provider broke its contract, and connecting is retried like any failure.
 */
export function checkedIdentity(raw: unknown): Identity | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    me: str(r.me),
    name: str(r.name),
    workspace: str(r.workspace),
    ...(typeof r.tenant === "string" && r.tenant ? { tenant: r.tenant } : {}),
    ...(Array.isArray(r.groups) ? { groups: r.groups.filter((g): g is string => typeof g === "string" && g !== "") } : {}),
  };
}

/** `connect` of an account, its answer checked: what it throws, or a provider error when its answer is not an identity. */
export async function connectAccount(entry: AccountEntry, ctx: AccountContext): Promise<Identity> {
  const identity = checkedIdentity(await (entry.provider as Provider).connect(ctx));
  if (!identity) throw { code: "bad_result", message: "connect returned something that is not an identity", retryable: true, fatal: false };
  return identity;
}

/** An account resolved with its provider and the identity `connect` returned. */
export function sourceOf(entry: AccountEntry, identity: Identity, seen: SeenStore, opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}): Source {
  const provider = entry.provider as Provider;
  const specs = provider.descriptor.settings;
  const who = effectiveIdentity(identity, entry.account.settings, specs);
  return {
    account: entry.account,
    provider,
    ctx: accountContext(entry, { identity: who, ...opts }),
    rules: triageRules(entry.account.settings, specs),
    seen,
    participated: new Set(),
    label: accountLabel(entry.account),
  };
}

/**
 * The default Slack account as a source, from `cfg`: the person's id, their groups and the rules (the `slack` section,
 * or a test's). `identity` is what `connect` returned, when it ran.
 */
export function slackSource(cfg: Config & { teammates?: string[] }, seen: SeenStore, participated: Set<string> = new Set(), identity?: Identity): Source {
  const entry = accountOf("slack", "default") as AccountEntry;
  const who: Identity = { name: identity?.name ?? "", workspace: identity?.workspace ?? "", ...(identity?.tenant ? { tenant: identity.tenant } : {}), me: cfg.me || identity?.me || "", groups: [...new Set([...(identity?.groups ?? []), ...cfg.subteams])] };
  return {
    account: entry.account,
    provider: entry.provider ?? slackProvider,
    ctx: accountContext(entry, { identity: who }),
    rules: { watch: cfg.watchChannels, ignore: cfg.ignoreChannels, ignoreAuthors: cfg.ignoreAuthors, teammates: cfg.teammates ?? [] },
    seen,
    participated,
    label: "Slack",
  };
}

/** The keys of the threads the person took part in recently; empty when the tool cannot tell or does not answer. */
export async function participatedOf(src: Source, days = 7): Promise<Set<string>> {
  const keys = new Set<string>();
  if (!src.provider.participated || !effectiveCapabilities(src.provider.descriptor, src.account.auth).participation) return keys;
  try {
    for (const native of await src.provider.participated(src.ctx, days)) {
      const key = typeof native === "string" ? keyFor(src.account, native) : null;
      if (key) keys.add(key);
    }
  } catch {}
  return keys;
}

// ------------------------------------------------------------------ one item

/** The key of an item's thread, the mapping of a long one kept in the account's folder; null when it cannot make a key. */
export const threadKeyOf = (src: Pick<Source, "account">, native: string) => keyFor(src.account, native);
/** The dedup key of an item. */
export const itemKeyOf = (src: Pick<Source, "account">, native: string) => formatKey(src.account.provider, src.account.id, native);

/** The line saying a message could not be triaged: the master reads it, the message will be retried. */
export function triageErrorLine(permalink: string, e: unknown): string {
  return `[strato] triage error ${permalink}: ${untrusted(oneLine(e instanceof Error ? e.message : String(e)))}`;
}

/**
 * What the master, the log and the inbox read of an item: every provider string on one line, the link only when it is
 * https and on the provider's hosts. A title (a ticket's, an email's subject) leads the text.
 */
export function triggerOf(provider: string, item: Item, key: string): Trigger & { key: string } {
  const text = oneLine(item.title ? `${item.title}: ${item.text}` : item.text);
  return { key, from: oneLine(item.author.name), channel: oneLine(item.conversation.label), text: truncate(text, 500), permalink: checkedLink(item.link, provider) ?? "-" };
}

/**
 * Two-step triage: first without the authors' names (no call for an ignored item), then with them, once the provider
 * completed the item (`Provider.complete`), for `ignoreAuthors`. null: ignored.
 */
export async function triageItem(src: Source, item: Item, key: string, tracked: Set<string>): Promise<{ kind: Kind; d: Trigger & { key: string }; item: Item } | null> {
  if (!classifyItem(item, key, withoutAuthors(src.rules), tracked, src.participated)) return null;
  let full = item;
  if (src.provider.complete) {
    const done = await src.provider.complete(src.ctx, [item]);
    if (Array.isArray(done) && done[0]) full = done[0];
  }
  const kind = classifyItem(full, key, src.rules, tracked, src.participated) as Kind;
  return { kind, d: triggerOf(src.account.provider, full, key), item: full };
}

/**
 * Handles a batch of items of one account: dedup by item key, triage, one line per kept event.
 * Shared by every way items come in (push, poll, the catch-ups): triage must live only here.
 * `markOnly` marks as read without a word, for the first pass of a fresh state.
 * An item enters `seen` only once handled (line printed, logged, or ignored): a triage error leaves it for the next
 * pass and says so on stdout. Marking it before would lose it silently on an error.
 * Returns how many items failed triage: their caller must not move its cursor past them (section 4.8), so that the
 * next pass reads them again; `seen` absorbs the items of the batch already handled.
 */
export async function processItems(src: Source, items: Item[], markOnly = false): Promise<number> {
  const sujets = loadSujets();
  const tracked = trackedKeys(sujets);
  let untriaged = 0;
  for (const item of items) {
    const key = threadKeyOf(src, item.thread);
    const id = itemKeyOf(src, item.id);
    if (!key || !id) {
      src.ctx.log("warn", `item refused: its id cannot make a key (${truncate(oneLine(String(item.id)), 80)})`);
      continue;
    }
    if (item.author.isMe) src.participated.add(key);
    const editId = item.edited ? id + EDIT_MARK : null;
    if (editId) {
      // an edit that adds the mention: the original is often already read (ignored silently), it must still come out,
      // unless its previous version already did (watched channel, tracked thread, DM), or this edit already came in
      // (a tool polled with overlapping windows reports it again): one line per message
      if (src.seen.has(editId) || editAlreadyRaised(item, key, src.rules, tracked, src.participated)) continue;
    } else if (src.seen.has(id)) continue;
    const mark = () => {
      src.seen.add(id);
      if (editId) src.seen.add(editId);
    };
    if (markOnly) {
      mark();
      continue;
    }
    try {
      await sortOne(src, item, key, id, tracked, sujets, mark);
    } catch (e) {
      untriaged++;
      out(triageErrorLine(checkedLink(item.link, src.account.provider) ?? id, e));
    }
  }
  return untriaged;
}

/**
 * The event line of a kept item, for the master, with the message kept in the inbox that `open --msg` and `relay`
 * read back. Shared by the listener and `backlog`.
 */
export function announcedLine(src: Pick<Source, "account">, r: { kind: Kind; d: Trigger & { key: string }; item: Item }, id: string | undefined, sujets: Sujet[]): string {
  const conversation = conversationRef(src.account.provider, src.account.id, r.item.conversation.id) ?? undefined;
  return eventLine(r.kind, { ...r.d, conversation }, sujets, keepMessage(r.d, { key: r.d.key, item: id, conversation }));
}

/** The line of a pass that hit its cap: the oldest items were not read. Slack's default account keeps its words. */
export function cappedLine(label: string | null, max: number, period = false): string {
  const n = max.toLocaleString("en");
  if (label === null) return period ? `[strato] more than ${n} messages over the period: only the most recent are read` : `[strato] more than ${n} messages since the last pass: the oldest were not read, run backlog if needed`;
  return period ? `[strato] ${label}: more than ${n} items over the period: only the most recent are read` : `[strato] ${label}: more than ${n} items since the last pass: the oldest were not read, run backlog if needed`;
}

/** Triages one item and prints its line; `done` marks it read as soon as its trace is written, not before. */
async function sortOne(src: Source, item: Item, key: string, id: string, tracked: Set<string>, sujets: Sujet[], done: () => void): Promise<void> {
  const r = await triageItem(src, item, key, tracked);
  if (!r) return void done();
  const { kind, d } = r;
  const conversation = conversationRef(src.account.provider, src.account.id, r.item.conversation.id) ?? undefined;
  // Slack's events keep the fields older versions wrote; another tool's name their conversation
  const extra = src.account.provider === "slack" || !conversation ? {} : { conversation };
  if (isSilent(kind)) {
    logEvent({ type: "info", kind, key: d.key, from: d.from, channel: d.channel, text: truncate(d.text, 200), permalink: d.permalink, ...extra });
    return void done();
  }
  if (kind === "moi") await dropSentDraft(d.key, d.text, d.permalink);
  out(announcedLine(src, r, id, sujets));
  // the line is out: even if the log fails next, do not repeat it on the next pass
  done();
  logEvent({ type: itemEventType(src.account.provider), kind, key: d.key, from: d.from, channel: d.channel, permalink: d.permalink, ...extra });
}

/**
 * The person served posted the text of a draft in a thread of the topic (the master sent it on a go, or they copied
 * it): its task closes and the card waits for the rest of the thread at once, as after Send, without waiting for the
 * session's turn. Otherwise the draft would stay on the board with its button until the session removed it.
 */
async function dropSentDraft(key: string, text: string, permalink: string): Promise<void> {
  const s = findSujet(loadSujets(), key);
  if (!s || s.status === "closed") return;
  // the open task whose draft is the message posted: the first one that matches
  const match = (x: Sujet) => openTasks(x).find((y) => taskDraftText(y) && draftMatches(taskDraftText(y), text));
  if (!match(s)) return;
  const at = nowIso();
  let taskId = "";
  // checked again under the lock: the session may have changed its draft or closed the topic meanwhile
  const done = await updateSujet(s.key, (x) => {
    const y = x.status === "closed" ? undefined : match(x);
    if (!y) return null;
    taskId = y.id;
    const next = closeTask(x, y.id, "done", at, t("task.note.postedByHand", { permalink }));
    return applyAssignments(next, openTasks(next).length ? { posted: `${at} ${permalink}` } : { status: "waiting", waiting: t("task.waiting.restOfThread"), posted: `${at} ${permalink}` }, at);
  });
  if (done) logEvent({ type: "draft-dropped", key: s.key, task: taskId, permalink });
}

// ------------------------------------------------------------------ the catch-up of tracked threads

/** Most replies of one tracked thread a catch-up reads: the newest are kept. */
export const THREAD_REPLIES_MAX = 2000;

/**
 * Rereads the threads of open topics that belong to this account, since `sinceMs`, and passes their new replies
 * through the shared triage. `failed` counts threads unreadable for a reason that may clear (network, rate limit),
 * `untriaged` the replies whose triage failed: either way the pass is not complete and the cursor must not move.
 * A thread unreadable for good (archived) does not hold it back.
 */
export async function catchUpThreads(src: Source, sinceMs: number): Promise<{ items: Item[]; failed: number; untriaged: number }> {
  const items: Item[] = [];
  let failed = 0;
  if (!src.provider.replies) return { items, failed, untriaged: 0 };
  for (const s of loadSujets()) {
    if (s.status === "closed") continue;
    for (const key of sujetKeys(s)) {
      // a ticket, or a key of another tool or account, is not this account's thread
      const target = nativeOfKey(key);
      if (!target || target.entry.account.provider !== src.account.provider || target.entry.account.id !== src.account.id) continue;
      let replies: Item[];
      try {
        replies = await src.provider.replies(src.ctx, target.native, { since: sinceMs, max: THREAD_REPLIES_MAX });
      } catch (e) {
        if (providerError(e).retryable) failed++;
        continue;
      }
      for (const it of Array.isArray(replies) ? replies : []) {
        const id = itemKeyOf(src, it.id);
        if (id && !src.seen.has(id)) items.push(it);
      }
    }
  }
  const untriaged = items.length ? await processItems(src, items) : 0;
  return { items, failed, untriaged };
}

// ------------------------------------------------------------------ the loop of one account

/** Most items one pass reads, as Slack's 30 pages of 100. */
export const PASS_MAX_ITEMS = 3000;
/** The window of an account's first poll, without a cursor: its history is marked as read, never raised. */
const FIRST_WINDOW_MS = 3_600_000;
/** How far before the cursor the catch-up of tracked threads rereads. */
const THREADS_MARGIN_MS = 300_000;
/** A listener rereads the tracked threads and polls a push account this often: a dead connection says nothing. */
export const RESYNC_MS = 300_000;

/** The cursor of an account, in its folder; null before its first pass. */
export function readCursor(account: Pick<Account, "provider" | "id">): IngestCursor | null {
  const c = readJson<{ cursor?: IngestCursor } | null>(join(accountDir(account), "ingest.json"), null)?.cursor;
  return c && typeof c.value === "string" && typeof c.at === "number" ? c : null;
}

function writeCursor(account: Pick<Account, "provider" | "id">, cursor: IngestCursor): void {
  mkdirSync(accountDir(account), { recursive: true });
  writeJson(join(accountDir(account), "ingest.json"), { cursor });
}

/** A poll's answer as the core accepts it: anything else is a provider error, and the pass is retried. */
function checkedPoll(r: unknown): PollResult {
  const p = r as Partial<PollResult> | null;
  const okCursor = p?.cursor && typeof p.cursor.value === "string" && typeof p.cursor.at === "number";
  if (!p || !Array.isArray(p.items) || !okCursor || typeof p.complete !== "boolean") throw { code: "bad_result", message: "the poll returned something that is not a poll result", retryable: true, fatal: false };
  return { items: p.items.filter(isItem), cursor: p.cursor as IngestCursor, complete: p.complete };
}

/** A poll's items the core cannot read, said once per pass in the account's log. */
function droppedItems(src: Source, r: unknown): void {
  const raw = (r as { items?: unknown[] } | null)?.items;
  const dropped = Array.isArray(raw) ? raw.filter((x) => !isItem(x)).length : 0;
  if (dropped) src.ctx.log("warn", `${dropped} item(s) dropped: missing or mistyped fields`);
}

/** The fields the core reads on an item, with their types: an item without them is dropped. */
export function isItem(x: unknown): x is Item {
  const i = x as Item;
  return (
    !!i &&
    typeof i.thread === "string" &&
    typeof i.id === "string" &&
    typeof i.text === "string" &&
    typeof i.link === "string" &&
    typeof i.time === "number" &&
    typeof i.mentionsMe === "boolean" &&
    typeof i.targetsOther === "boolean" &&
    !!i.author &&
    typeof i.author.name === "string" &&
    typeof i.author.isMe === "boolean" &&
    !!i.conversation &&
    typeof i.conversation.id === "string" &&
    typeof i.conversation.label === "string" &&
    ["dm", "group", "channel", "ticket", "email"].includes(i.conversation.kind) &&
    ["message", "comment", "created", "status", "assigned"].includes(i.event)
  );
}

/** One account's ingest state between passes. */
export interface AccountRun {
  src: Source;
  cursor: IngestCursor | null;
}

/**
 * One poll pass of an account (section 4.8): the items since its cursor, then, when asked, the replies of its tracked
 * threads. The first pass of an account without a cursor marks its history as read. The cursor is stored only once
 * every item is handled: not when an item failed triage (`untriaged`), nor when a tracked thread could not be read;
 * the next pass retries the same window. A failed poll throws, and nothing moves.
 */
export async function pollPass(run: AccountRun, opts: { maxItems?: number; threads?: boolean } = {}): Promise<{ complete: boolean; items: Item[]; threadsFailed: number; untriaged: number }> {
  const { src } = run;
  if (!src.provider.poll) throw { code: "no_poll", message: "this tool cannot be polled", retryable: false, fatal: true };
  const first = run.cursor === null;
  const started = Date.now();
  const answer = await src.provider.poll(src.ctx, run.cursor, { since: started - FIRST_WINDOW_MS, maxItems: opts.maxItems ?? PASS_MAX_ITEMS });
  const r = checkedPoll(answer);
  droppedItems(src, answer);
  const fresh = r.items.filter((it) => {
    const id = itemKeyOf(src, it.id);
    return id !== null && !src.seen.has(id);
  });
  let untriaged = await processItems(src, r.items, first);
  let threadsFailed = 0;
  const items = [...fresh];
  if (opts.threads && !first) {
    const t = await catchUpThreads(src, (run.cursor?.at ?? started) - THREADS_MARGIN_MS);
    threadsFailed = t.failed;
    untriaged += t.untriaged;
    items.push(...t.items);
  }
  src.seen.save();
  if (!threadsFailed && !untriaged) {
    run.cursor = r.cursor;
    writeCursor(src.account, r.cursor);
  }
  return { complete: r.complete, items, threadsFailed, untriaged };
}

/**
 * The lines of an account that fails: one when it starts failing, one when it is back, one when it stops for good. A
 * line per attempt would flood the master. `reason` is the provider's text: on one line and neutralized.
 */
export function outageLines(label: string, say: (line: string) => void): { failed: (reason: string, fatal?: boolean) => void; ok: () => void } {
  let down: string | null = null;
  return {
    failed(reason, fatal = false) {
      const why = untrusted(oneLine(truncate(reason, 200)));
      if (fatal) say(`[strato] ${label}: ${why}, listening to this account stopped`);
      else if (down === null) say(`[strato] ${label}: ${why} · retrying silently, one line when it is back`);
      down = why;
    },
    ok() {
      if (down !== null) say(`[strato] ${label} back after « ${down} »`);
      down = null;
    },
  };
}

/** Sleeps `ms`, or less when `stop` aborts. */
export function pause(ms: number, stop: AbortSignal): Promise<void> {
  if (stop.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      stop.removeEventListener("abort", done);
      resolve();
    }
    stop.addEventListener("abort", done);
  });
}

/** What `runAccount` needs besides the account: how it was started, and what tests replace. */
export interface RunOptions {
  mode: "listen" | "watch";
  stop: AbortSignal;
  /** Seconds between polls; default the account's `pollInterval`. */
  intervalSec?: number;
  say?: (line: string) => void;
  /** How long a resync waits in listen mode, and the wake detector's tick; tests shorten them. */
  resyncMs?: number;
  beatMs?: number;
  fetchImpl?: typeof fetch;
}

/** The accounts other than the default Slack one that bring items in: a provider that can poll or push, ingest not off. */
export function ingestAccounts(): AccountEntry[] {
  return accounts().filter((e) => {
    if (e.account.provider === "slack" && e.account.id === "default") return false;
    if (e.account.ingest === "off") return false;
    if (!e.provider) return true;
    const c = effectiveCapabilities(e.provider.descriptor, e.account.auth).ingest;
    return (c.poll && !!e.provider.poll) || (c.push && !!e.provider.subscribe);
  });
}

/**
 * The ingest loop of one account, until `stop` or a fatal error: connect (retried while the tool does not answer),
 * then push (listen, for a push account) or poll. Every failure stays inside this account: a line, a retry with a
 * growing delay, never an exception out of here. What the loops do not expect (a provider that breaks its contract,
 * a bug) ends this account with one line; the other accounts carry on.
 */
export async function runAccount(entry: AccountEntry, opts: RunOptions): Promise<void> {
  const say = opts.say ?? out;
  const lines = outageLines(accountLabel(entry.account), say);
  try {
    await runConnected(entry, opts, lines);
  } catch (e) {
    lines.failed(providerError(e).message, true);
  }
}

async function runConnected(entry: AccountEntry, opts: RunOptions, lines: ReturnType<typeof outageLines>): Promise<void> {
  if (!entry.provider) return void lines.failed(entry.problem ?? "no provider", true);
  const provider = entry.provider;
  const caps = effectiveCapabilities(provider.descriptor, entry.account.auth).ingest;
  const io = { signal: opts.stop, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) };

  let identity: Identity | null = null;
  for (let backoff = 5; !identity && !opts.stop.aborted; backoff = Math.min(300, backoff * 2)) {
    try {
      identity = await connectAccount(entry, accountContext(entry, io));
      lines.ok();
    } catch (e) {
      const pe = providerError(e);
      lines.failed(pe.message, pe.fatal);
      if (pe.fatal) return;
      await pause(Math.max(backoff, (pe.retryAfterMs ?? 0) / 1000) * 1000, opts.stop);
    }
  }
  if (!identity) return;
  const src = sourceOf(entry, identity, accountSeen(entry.account), io);
  src.participated = await participatedOf(src);
  const run: AccountRun = { src, cursor: readCursor(entry.account) };
  const push = opts.mode === "listen" && entry.account.ingest === "push" && caps.push && !!provider.subscribe;
  if (push) await runPush(run, opts, lines);
  else await runPoll(run, opts, lines);
}

/** How a push connection ended, read from what `subscribe` resolved or threw: a throw is a cut, or the end of push when fatal. */
type PushEnd = { end: "clean" | "cut" | "fatal"; retryAfterMs?: number; refused?: string };

type PushEvents = NonNullable<Parameters<NonNullable<Provider["subscribe"]>>[2]>;

async function pushOnce(src: Source, signal: AbortSignal, onItems: Parameters<NonNullable<Provider["subscribe"]>>[1], events: PushEvents): Promise<PushEnd> {
  try {
    const r = await (src.provider.subscribe as NonNullable<Provider["subscribe"]>)({ ...src.ctx, signal }, onItems, events);
    const end = r?.end === "clean" || r?.end === "fatal" ? r.end : "cut";
    return { end, ...(typeof r?.retryAfterMs === "number" ? { retryAfterMs: r.retryAfterMs } : {}), ...(typeof r?.refused === "string" ? { refused: r.refused } : {}) };
  } catch (e) {
    const pe = providerError(e);
    return { end: pe.fatal ? "fatal" : "cut", refused: pe.message, ...(pe.retryAfterMs !== undefined ? { retryAfterMs: pe.retryAfterMs } : {}) };
  }
}

/** The poll loop: one pass every interval, the tracked threads every 5 min in listen mode, a growing delay on failures. */
async function runPoll(run: AccountRun, opts: RunOptions, lines: ReturnType<typeof outageLines>): Promise<void> {
  const say = opts.say ?? out;
  const interval = opts.intervalSec ?? accountOf(run.src.account.provider, run.src.account.id)?.pollInterval ?? 60;
  const threadsEvery = opts.mode === "listen" ? (opts.resyncMs ?? RESYNC_MS) : 0;
  let lastThreads = 0;
  let backoff = 0;
  for (let tick = 0; !opts.stop.aborted; tick++) {
    if (tick > 0) await pause((interval + backoff) * 1000, opts.stop);
    if (opts.stop.aborted) break;
    try {
      const threads = threadsEvery > 0 && Date.now() - lastThreads >= threadsEvery;
      const r = await pollPass(run, { threads });
      if (threads && !r.threadsFailed) lastThreads = Date.now();
      if (!r.complete) say(cappedLine(run.src.label, PASS_MAX_ITEMS));
      lines.ok();
      backoff = 0;
    } catch (e) {
      const pe = providerError(e);
      lines.failed(pe.message, pe.fatal);
      if (pe.fatal) return;
      backoff = Math.max(Math.min(300, backoff === 0 ? interval : backoff * 2), (pe.retryAfterMs ?? 0) / 1000);
    }
  }
}

/**
 * The push loop of a listener: a poll pass at startup, every 5 min and on wake from sleep, because a dead connection
 * says nothing; the connection itself reopened with Retry-After or a growing delay, cut and reopened on wake. A tool
 * that will not push at all (its connection ends "fatal") is polled instead, with one line.
 */
async function runPush(run: AccountRun, opts: RunOptions, lines: ReturnType<typeof outageLines>): Promise<void> {
  const { src } = run;
  const say = opts.say ?? out;
  let syncing: Promise<void> | null = null;
  const resync = (why: "startup" | "periodic" | "wake"): Promise<void> => {
    if (syncing) return syncing;
    syncing = (async () => {
      try {
        const r = await pollPass(run, { threads: true });
        if (!r.complete) say(cappedLine(src.label, PASS_MAX_ITEMS));
      } catch (e) {
        const pe = providerError(e);
        if (why !== "periodic") say(`[strato] ${src.label}: catch-up failed (${why}): ${untrusted(oneLine(truncate(pe.message, 200)))}`);
      }
    })().finally(() => {
      syncing = null;
    });
    return syncing;
  };
  await resync("startup");

  let connection: AbortController | null = null;
  const timer = setInterval(() => void resync("periodic"), opts.resyncMs ?? RESYNC_MS);
  timer.unref?.();
  let lastBeat = Date.now();
  const beat = setInterval(() => {
    const now = Date.now();
    const gap = now - lastBeat;
    lastBeat = now;
    if (gap < 60_000) return;
    // wake from sleep: the connection from before is half open; cut it and catch up
    connection?.abort();
    void resync("wake");
  }, opts.beatMs ?? 10_000);
  beat.unref?.();

  let backoff = 1;
  let fellBack = false;
  let chain: Promise<void> = Promise.resolve();
  const onStop = () => connection?.abort();
  opts.stop.addEventListener("abort", onStop);
  try {
    while (!opts.stop.aborted && src.provider.subscribe) {
      connection = new AbortController();
      const r = await pushOnce(
        src,
        connection.signal,
        (items, cursor) => {
          const valid = Array.isArray(items) ? items.filter(isItem) : [];
          if (!valid.length) return;
          chain = chain.then(async () => {
            try {
              const untriaged = await processItems(src, valid);
              src.seen.save();
              // an item that failed triage holds the cursor back: the next catch-up reads it again
              if (!untriaged && cursor && typeof cursor.value === "string" && typeof cursor.at === "number") {
                run.cursor = cursor;
                writeCursor(src.account, cursor);
              }
            } catch (e) {
              say(triageErrorLine(checkedLink(valid[0].link, src.account.provider) ?? src.label, e));
            }
          });
        },
        {
          opened: () => {
            lines.ok();
            backoff = 1;
          },
          failed: (link, reason) => say(triageErrorLine(checkedLink(link, src.account.provider) ?? src.label, reason)),
        },
      );
      await chain;
      if (r.end === "fatal") {
        // the tool will not push (no app-level token, a refused connection): polling still brings its items
        say(`[strato] ${src.label}: ${untrusted(oneLine(truncate(r.refused ?? "the connection ended for good", 200)))} · polled instead`);
        fellBack = true;
        break;
      }
      if (r.refused) lines.failed(r.refused);
      if (opts.stop.aborted) break;
      await pause(Math.max(backoff, Math.min(900, (r.retryAfterMs ?? 0) / 1000)) * 1000, opts.stop);
      backoff = r.end === "clean" ? 1 : Math.min(60, backoff * 2);
    }
  } finally {
    opts.stop.removeEventListener("abort", onStop);
    clearInterval(timer);
    clearInterval(beat);
  }
  if (fellBack && !opts.stop.aborted) await runPoll(run, opts, lines);
}

// ------------------------------------------------------------------ the Slack forms kept for older callers

/**
 * Slack messages through the shared triage, on the default Slack account: `cfg` gives who the person is and the rules,
 * `seen` the ids already handled. The form `listen` and `watch` used before ingest went through providers, kept for
 * the tests written against it (ingest.test.ts); no command calls it.
 */
export async function processMatches(matches: SlackMatch[], cfg: Config, seen: Set<string>, participated: Set<string>, markOnly = false): Promise<void> {
  await processItems(slackSource(cfg, legacySeen(seen), participated), matches.map((m) => slackItem(m, cfg)), markOnly);
}
