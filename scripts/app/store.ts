/**
 * The state on disk: sujets.json under the lock, today's letters, the events.ndjson log, reports.
 * File names and keys (sujets.json, compteurs.json, `lettres`) are kept as is: existing installations read them.
 */
import { appendFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { t } from "../core/i18n.ts";
import { NEW_INSTALL_PROFILE } from "../core/settings.ts";
import { findSujet, normalizeSujets, pickLetter, type StoredSujet, type Sujet, type Trigger } from "../core/sujet.ts";
import { reportFile, reportPathAllowed } from "../core/text.ts";
import { dayOfIso, F, fail, localDay, nowIso, readJson, STATE, writeJson } from "./env.ts";
import { selfCommand } from "./self.ts";

export interface Counters {
  /** Local day -> index of the next letter. Only the current day is kept. */
  lettres?: Record<string, number>;
  /** ISO date of the last digest. */
  digest?: string;
}

/**
 * Creates the state folder. A new one ignores itself in git (`.gitignore` with `*`): it holds Slack message texts,
 * reports and ids, and the workspace is often a repository. Only at creation: deleting that file to version the
 * folder sticks.
 */
export function createStateDir() {
  if (existsSync(STATE)) return;
  mkdirSync(STATE, { recursive: true });
  writeFileSync(join(STATE, ".gitignore"), "# Strato's state: Slack messages, reports, ids. Never committed.\n*\n");
}

/**
 * Creates the state folder, and a minimal config.json if missing: shadow mode on, nothing else. Every other field
 * keeps its default by being absent, so a later change of default reaches this installation, and the file the
 * person opens holds only what they or the setup chose.
 */
export function ensureState() {
  createStateDir();
  if (!existsSync(F.config)) writeJson(F.config, NEW_INSTALL_PROFILE);
}

export function logEvent(e: Record<string, unknown>) {
  appendFileSync(F.events, `${JSON.stringify({ at: nowIso(), ...e })}\n`);
}

// ------------------------------------------------------------------ topic state

/** The lock could not be taken in time. Only CLI commands turn it into an error exit; serve and listen carry on. */
export class LockTimeout extends Error {
  constructor(waitedMs: number) {
    super(`state lock unavailable after ${Math.round(waitedMs / 1000)} s (${F.lock})`);
    this.name = "LockTimeout";
  }
}

/** Past this, a lock whose holder is still alive is deemed abandoned. Everything written under the lock takes a few ms. */
export const LOCK_STALE_MS = 30_000;
/** The wait exceeds the staleness limit: an abandoned lock is always stolen before giving up. */
const LOCK_WAIT_MS = 40_000;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Takes the lock in one step with its content: a temp file linked under the lock's name (link fails if it exists). */
function tryLock(token: string): boolean {
  const tmp = `${F.lock}.${token}`;
  writeFileSync(tmp, token);
  try {
    linkSync(tmp, F.lock);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    unlinkSync(tmp);
  }
}

/**
 * Removes the lock only if it still contains `expected`. The rename is atomic: the lock is moved aside, what was taken
 * is checked, and if it belonged to someone else (taken between the read and the rename) it is linked back.
 * A plain unlink would let two waiters that judge the same lock stale each delete the other's fresh lock.
 */
function removeLockIf(expected: string): void {
  const aside = `${F.lock}.aside-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    renameSync(F.lock, aside);
  } catch {
    return;
  }
  let took = "";
  try {
    took = readFileSync(aside, "utf8");
  } catch {}
  if (took !== expected) {
    try {
      linkSync(aside, F.lock);
    } catch {}
  }
  try {
    unlinkSync(aside);
  } catch {}
}

/** Steals the lock if its holder is dead or it is older than LOCK_STALE_MS. A lock without a pid (old format, empty) is judged by age only. */
function stealIfAbandoned(): void {
  let content: string;
  let mtime: number;
  try {
    content = readFileSync(F.lock, "utf8");
    mtime = statSync(F.lock).mtimeMs;
  } catch {
    return;
  }
  const pid = Number(content.split("-")[0]);
  const dead = Number.isInteger(pid) && pid > 0 && !alive(pid);
  if (dead || Date.now() - mtime > LOCK_STALE_MS) removeLockIf(content);
}

/**
 * File lock: the master, the listener, the board server and the work sessions all write the state.
 * The lock contains "<pid>-<token>". Throws LockTimeout instead of killing the process, so that a lock held a little
 * too long never stops serve or listen in the middle of their work.
 */
export async function withLock<T>(fn: () => T, waitMs = LOCK_WAIT_MS): Promise<T> {
  const token = `${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const started = Date.now();
  while (!tryLock(token)) {
    stealIfAbandoned();
    if (Date.now() - started > waitMs) throw new LockTimeout(Date.now() - started);
    await Bun.sleep(50 + Math.random() * 50);
  }
  try {
    return fn();
  } finally {
    removeLockIf(token);
  }
}

/** Read only: missing letters and threads are added in memory, written on the next mutation. */
export const loadSujets = () => normalizeSujets(readJson<StoredSujet[]>(F.sujets, []), dayOfIso);

export async function mutateSujets(fn: (list: Sujet[]) => Sujet[]) {
  return withLock(() => {
    const next = fn(loadSujets());
    writeJson(F.sujets, next);
    return next;
  });
}

export function requireSujet(ref: string | undefined): Sujet {
  const s = findSujet(loadSujets(), ref);
  if (!s) fail(`topic not found: ${ref ?? "(none)"} · ${selfCommand()} list --all`);
  return s;
}

/**
 * Changes a topic from its version reread under the lock: `fn` gets the state on disk, not a copy read seconds
 * earlier, and must only change its own fields. Returns the topic written, or null if the topic is gone or `fn`
 * returns null (nothing to write). Rewriting a whole topic read too early would lose a session's `set` that lands
 * during a send from the board.
 */
export async function updateSujet(key: string, fn: (s: Sujet) => Sujet | null): Promise<Sujet | null> {
  let written: Sujet | null = null;
  await withLock(() => {
    const list = loadSujets();
    const i = list.findIndex((x) => x.key === key);
    if (i < 0) return;
    written = fn(list[i]);
    if (!written) return;
    list[i] = written;
    writeJson(F.sujets, list);
  });
  return written;
}

/**
 * Creates a topic, under the lock, unless a topic already has this key (open or closed): returns that one then,
 * writing nothing. This is `open`'s reservation, taken before starting the session: two `open` of the same thread start only one.
 */
export async function createSujet(s: Sujet): Promise<Sujet | null> {
  let existing: Sujet | null = null;
  await withLock(() => {
    const list = loadSujets();
    existing = findSujet(list, s.key) ?? null;
    if (!existing) writeJson(F.sujets, [...list, s]);
  });
  return existing;
}

/** Removes a topic, only if `still` still recognises it (a reservation whose launch failed). */
export async function dropSujet(key: string, still: (s: Sujet) => boolean): Promise<void> {
  await mutateSujets((list) => list.filter((x) => x.key !== key || !still(x)));
}

/** The window during which a resume (`claude --bg --resume`) is deemed in progress, until the session shows up. */
export const RESUME_WINDOW_MS = 30_000;

/**
 * Reserves the resume of the topic's session: `resumingUntil` written under the lock. Returns null if the reservation
 * is taken, else the end of the resume already in progress (ms): the caller does not resume, it waits for the live
 * session. Without it, two simultaneous relays to a stopped session resume it twice.
 */
export async function claimResume(key: string): Promise<number | null> {
  let busyUntil: number | null = null;
  await updateSujet(key, (s) => {
    const now = Date.now();
    const until = s.resumingUntil ? Date.parse(s.resumingUntil) : 0;
    if (until > now) {
      busyUntil = until;
      return null;
    }
    return { ...s, resumingUntil: new Date(now + RESUME_WINDOW_MS).toISOString() };
  });
  return busyUntil;
}

/** Lifts the resume reservation (resume done or failed). */
export async function endResume(key: string): Promise<void> {
  await updateSujet(key, (s) => {
    if (!s.resumingUntil) return null;
    const { resumingUntil: _, ...rest } = s;
    return rest;
  });
}

/** Reserves today's next letter (counter in compteurs.json). A letter reserved then unused is lost, harmlessly. */
export async function reserveLetter(): Promise<string> {
  return withLock(() => {
    const counters = readJson<Counters>(F.counters, {});
    const day = localDay(Date.now());
    const { letter, counter } = pickLetter(loadSujets(), day, counters.lettres?.[day] ?? 0, dayOfIso);
    writeJson(F.counters, { ...counters, lettres: { [day]: counter } });
    return letter;
  });
}

/**
 * The topic's report if it exists. The `report` field is written by the session: only a path under the reports
 * folder is followed, otherwise `set report=~/.ssh/…` would make the panel display any file.
 */
export function reportOf(s: Sujet): string | null {
  const fallback = join(F.reports, reportFile(s.key));
  const path = s.report && reportPathAllowed(s.report, F.reports) ? resolve(s.report) : fallback;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ messages surfaced to the master

/** A message is kept 7 days: the master opens or relays it within the minute, the margin covers a restart. */
const INBOX_KEEP_MS = 7 * 86_400_000;

/** A message's stable id, derived from its permalink: 12 hex characters. */
export function messageId(permalink: string): string {
  return new Bun.CryptoHasher("sha1").update(permalink).digest("hex").slice(0, 12);
}

/** Keeps the message surfaced to the master and returns its id; purges those older than 7 days on the way. */
export function keepMessage(t: Trigger): string {
  const id = messageId(t.permalink);
  mkdirSync(F.inbox, { recursive: true });
  writeJson(join(F.inbox, `${id}.json`), { from: t.from, channel: t.channel, text: t.text, permalink: t.permalink });
  const cutoff = Date.now() - INBOX_KEEP_MS;
  for (const f of readdirSync(F.inbox)) {
    try {
      if (statSync(join(F.inbox, f)).mtimeMs < cutoff) unlinkSync(join(F.inbox, f));
    } catch {}
  }
  return id;
}

/** The message kept under this id, or null. The id comes from a command: nothing but 12 hex characters. */
export function messageOf(id: string): Trigger | null {
  if (!/^[0-9a-f]{12}$/.test(id)) return null;
  const t = readJson<Partial<Trigger> | null>(join(F.inbox, `${id}.json`), null);
  if (!t || typeof t.permalink !== "string") return null;
  return { from: String(t.from ?? "?"), channel: String(t.channel ?? ""), text: String(t.text ?? ""), permalink: t.permalink };
}

/** The whole events.ndjson, unreadable lines dropped. The card sweep reads it once per pass. */
export function readEvents<T = Record<string, unknown>>(): T[] {
  const raw = existsSync(F.events) ? readFileSync(F.events, "utf8") : "";
  const events: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as T);
    } catch {}
  }
  return events;
}

// ------------------------------------------------------------------ images pasted from the board

/** The image formats a Claude Code session can read, and their extension. */
export const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
/** 10 MB: a full-page Retina screenshot weighs 2 to 4. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** Pasted images are kept 30 days, long enough for a topic to settle. */
const UPLOAD_KEEP_MS = 30 * 86_400_000;

/** Writes a pasted image for the topic and returns its absolute path. Throws if the format or size is wrong. */
export function saveUpload(key: string, type: string, bytes: Uint8Array): string {
  const ext = IMAGE_TYPES[type];
  if (!ext) throw new Error(t("board.api.upload.badFormat", { type: type || t("board.api.upload.unknownType") }));
  if (!bytes.length || bytes.length > IMAGE_MAX_BYTES) throw new Error(t("board.api.upload.badSize", { kb: Math.round(bytes.length / 1024) }));
  const dir = join(F.uploads, reportFile(key).replace(/\.md$/, ""));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${nowIso().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  writeFileSync(path, bytes);
  return path;
}

/** Deletes images pasted more than 30 days ago, and emptied folders. */
export function purgeUploads(now = Date.now()): void {
  if (!existsSync(F.uploads)) return;
  for (const d of readdirSync(F.uploads)) {
    const dir = join(F.uploads, d);
    try {
      for (const f of readdirSync(dir)) if (now - statSync(join(dir, f)).mtimeMs > UPLOAD_KEEP_MS) unlinkSync(join(dir, f));
      if (!readdirSync(dir).length) rmdirSync(dir);
    } catch {}
  }
}
