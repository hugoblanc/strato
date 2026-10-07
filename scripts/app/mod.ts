/**
 * Strato's mod on disk and its two files per session: the folder `--plugin-dir` points at, the state a session
 * declares (`live/<sessionId>.mod.json`), and its inbox (`mailbox/<sessionId>.ndjson` written here, `.acks` written by
 * the mod). Not `inbox/`: that folder keeps the listener's messages and is pruned by age.
 * Every function takes the state folder: nothing here resolves the installation, so tests call it directly.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { modUsable, type ModState, parseModState } from "../claude/mod-state.ts";
// Bun reads these as text and `bun build --compile` embeds them: the binary has no file next to its code.
// TypeScript types a JSON import as the parsed object, hence the casts.
import hooksJson from "../mod/strato-state/hooks/hooks.json" with { type: "text" };
import pluginJson from "../mod/strato-state/.claude-plugin/plugin.json" with { type: "text" };
import registerJs from "../mod/strato-state/hooks/register.js" with { type: "text" };

export const MOD_NAME = "strato-state";

/** The mod's files, by path relative to its folder: what `claude --plugin-dir` loads. */
export const MOD_FILES: Readonly<Record<string, string>> = {
  ".claude-plugin/plugin.json": pluginJson as unknown as string,
  "hooks/hooks.json": hooksJson as unknown as string,
  "hooks/register.js": registerJs,
};

export const modHash = (files: Readonly<Record<string, string>> = MOD_FILES) =>
  createHash("sha256")
    .update(Object.entries(files).map(([p, text]) => `${p}\0${text}`).join("\0"))
    .digest("hex")
    .slice(0, 16);

export const modDir = (state: string) => join(state, "mod", MOD_NAME);
/** Beside the folder, not in it: the engine reads every file of a plugin folder. */
const hashFile = (state: string) => join(state, "mod", `${MOD_NAME}.sha`);

/** Writes a file through a temporary one: a reader never sees half of it. */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/**
 * The mod's folder, written when its content changed (a new Strato) or a file is missing, and left alone otherwise:
 * a session that watches its plugin folder reloads the module on every write. Returns the folder.
 */
export function ensureModFolder(state: string, files: Readonly<Record<string, string>> = MOD_FILES): string {
  const dir = modDir(state);
  const hash = modHash(files);
  let current = "";
  try {
    current = readFileSync(hashFile(state), "utf8").trim();
  } catch {}
  if (current === hash && Object.keys(files).every((p) => existsSync(join(dir, p)))) return dir;
  for (const [p, text] of Object.entries(files)) writeAtomic(join(dir, p), text);
  writeAtomic(hashFile(state), `${hash}\n`);
  return dir;
}

/** What `doctor` says of the folder: missing, out of date, or in place. */
export function modFolderState(state: string, files: Readonly<Record<string, string>> = MOD_FILES): "missing" | "stale" | "ok" {
  const dir = modDir(state);
  if (!Object.keys(files).every((p) => existsSync(join(dir, p)))) return "missing";
  return Object.entries(files).every(([p, text]) => readFileSync(join(dir, p), "utf8") === text) ? "ok" : "stale";
}

// ------------------------------------------------------------------ declared state

export const modStatePath = (state: string, sessionId: string) => join(state, "live", `${sessionId}.mod.json`);

/**
 * The last declaration read whole, per file: the mod writes in place (its file system has no rename), so a read may
 * catch a write halfway. That read keeps the previous declaration, which freshness then judges like any other.
 */
const lastGood = new Map<string, { mtime: number; state: ModState }>();

/** The declaration of a session, or null when it has none the board may trust (missing, stale, unreadable). */
export function readModState(state: string, sessionId: string, now = Date.now()): ModState | null {
  const path = modStatePath(state, sessionId);
  let mtime: number;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    lastGood.delete(path);
    return null;
  }
  const cached = lastGood.get(path);
  let m = cached?.mtime === mtime ? cached.state : null;
  if (!m) {
    let raw = "";
    try {
      raw = readFileSync(path, "utf8");
    } catch {}
    m = parseModState(raw);
    if (m) lastGood.set(path, { mtime, state: m });
    else m = cached?.state ?? null;
  }
  return modUsable(m, now) ? m : null;
}

// ------------------------------------------------------------------ inbox

export interface InboxMessage {
  id: string;
  text: string;
  at: number;
}
/** queued: the session works; submitted: it took the message (or ran the command); refused: a slash command it does not have. */
export type AckState = "queued" | "submitted" | "refused";
/** The acks after which the mod never takes the message again. */
const done = (a: AckState | undefined) => a === "submitted" || a === "refused";

export const inboxPath = (state: string, sessionId: string) => join(state, "mailbox", `${sessionId}.ndjson`);
export const acksPath = (state: string, sessionId: string) => join(state, "mailbox", `${sessionId}.acks`);

const ndjson = <T>(path: string, keep: (x: unknown) => x is T): T[] => {
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const x = JSON.parse(line) as unknown;
      if (keep(x)) out.push(x);
    } catch {}
  }
  return out;
};
const isMessage = (x: unknown): x is InboxMessage => !!x && typeof (x as InboxMessage).id === "string" && typeof (x as InboxMessage).text === "string";
const isAck = (x: unknown): x is { id: string; state: AckState; at: number } => !!x && typeof (x as { id: unknown }).id === "string" && ["queued", "submitted", "refused"].includes((x as { state: unknown }).state as string);

/** The messages of a session's inbox, in order. */
export const inboxMessages = (state: string, sessionId: string): InboxMessage[] => ndjson(inboxPath(state, sessionId), isMessage);

/** What the mod acknowledged, by message id: `submitted` or `refused` wins over `queued`. */
export function inboxAcks(state: string, sessionId: string): Map<string, AckState> {
  const out = new Map<string, AckState>();
  for (const a of ndjson(acksPath(state, sessionId), isAck)) if (!done(out.get(a.id))) out.set(a.id, a.state);
  return out;
}

/**
 * Adds a message to a session's inbox and returns its id. The messages the mod acknowledged as submitted leave the
 * file on the way; the others stay, so a session that dies before taking one finds it at its next start.
 * Synchronous: two posts of one server never interleave. The mod only reads this file.
 */
export function postToInbox(state: string, sessionId: string, text: string, now = Date.now()): string {
  const id = `m_${now.toString(36)}${randomBytes(4).toString("hex")}`;
  const acks = inboxAcks(state, sessionId);
  const kept = inboxMessages(state, sessionId).filter((m) => !done(acks.get(m.id)));
  writeAtomic(inboxPath(state, sessionId), [...kept, { id, text, at: now }].map((m) => `${JSON.stringify(m)}\n`).join(""));
  return id;
}

/**
 * Takes a message back that the mod did not acknowledge, before it goes another way. False when it was acknowledged
 * meanwhile: the mod has it, nothing else must send it.
 */
export function withdrawFromInbox(state: string, sessionId: string, id: string): boolean {
  if (inboxAcks(state, sessionId).has(id)) return false;
  const all = inboxMessages(state, sessionId);
  writeAtomic(inboxPath(state, sessionId), all.filter((m) => m.id !== id).map((m) => `${JSON.stringify(m)}\n`).join(""));
  return !inboxAcks(state, sessionId).has(id);
}

/** Waits for the mod's acknowledgement of a message: submitted, queued (the session works), or null past `timeoutMs`. */
export async function waitForAck(state: string, sessionId: string, id: string, timeoutMs = 20_000, pollMs = 250): Promise<AckState | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const ack = inboxAcks(state, sessionId).get(id);
    if (ack) return ack;
    if (Date.now() >= end) return null;
    await Bun.sleep(pollMs);
  }
}

export type InboxDelivery = { via: "inbox"; ack: AckState } | { via: "none"; reason: "no-mod" | "unacknowledged" };

/**
 * Hands a message to a session through its mod, when the session declared itself recently and is not ended.
 * `no-mod`: no fresh declaration, the caller uses its other routes and nothing was written. `unacknowledged`: the
 * message was taken back from the inbox, the caller uses its other routes and says so.
 */
export async function deliverThroughInbox(state: string, sessionId: string, text: string, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<InboxDelivery> {
  const m = readModState(state, sessionId);
  if (!m || m.status === "ended") return { via: "none", reason: "no-mod" };
  const id = postToInbox(state, sessionId, text);
  const ack = await waitForAck(state, sessionId, id, opts.timeoutMs, opts.pollMs);
  if (ack) return { via: "inbox", ack };
  // acknowledged at the last moment: the session has it, the relay must not send it a second time
  if (!withdrawFromInbox(state, sessionId, id)) return { via: "inbox", ack: inboxAcks(state, sessionId).get(id) ?? "queued" };
  return { via: "none", reason: "unacknowledged" };
}
