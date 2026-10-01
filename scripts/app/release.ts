/**
 * The update of a compiled binary from GitHub releases (app/update.ts dispatches here when Strato runs compiled).
 *
 * - `checkRelease()`: `GET api.github.com/repos/<repo>/releases/latest` (no token), compares its tag with the
 *   embedded version, and reads "what's new" from the release body (written by scripts/build/release-notes.ts).
 * - `applyRelease()`: downloads this platform's asset and `SHA256SUMS`, checks the SHA-256, writes the new binary next
 *   to the old one, checks that it starts (`<new> version`), then swaps it in: the old binary stays as
 *   `<binary>.previous`, and the binary path never stops pointing at a whole executable.
 *
 * Never throws on a network or disk failure: every outcome is a value the board can show.
 */
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { assetName, RELEASE_REPO, type ReleaseTarget, releaseTarget, STRATO_VERSION } from "../core/build-info.ts";
import { compareSemver, groupChanges } from "../core/version.ts";
import { BUILD_SHA } from "./self.ts";
import type { Commit, LocalVersion, UpdateCheck, UpdateResult } from "./update.ts";

export interface GithubAsset {
  name: string;
  browser_download_url: string;
}

export interface GithubRelease {
  tag_name: string;
  body?: string | null;
  html_url?: string;
  assets: GithubAsset[];
}

export interface ReleaseOptions {
  /** The fetch to use (tests mock it). */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** The binary to replace: `process.execPath` by default. */
  execPath?: string;
  /** This platform's release target, null for a platform without a binary. */
  target?: ReleaseTarget | null;
  /** The installed version, the embedded one by default. */
  current?: string;
  /** The installed commit, the one embedded at build time by default. */
  currentSha?: string;
  repo?: string;
  /** Checks that a downloaded binary starts: `<path> version` prints the expected version, by default. */
  verify?: (path: string, version: string) => Promise<{ ok: boolean; output: string }>;
  /** Rewrites the skills written by install-skill with the new binary (`install-skill --refresh`); on by default. */
  refreshSkills?: boolean;
}

const UA = { "User-Agent": "strato-updater", Accept: "application/vnd.github+json" };

/** The latest-release endpoint; `STRATO_RELEASE_URL` replaces it (a mirror, or an end-to-end test). */
const latestUrl = (repo: string) => process.env.STRATO_RELEASE_URL || `https://api.github.com/repos/${repo}/releases/latest`;

/** `SHA256SUMS` (the `sha256sum` format: `<hex>  <name>`, `*` before the name in binary mode) -> name -> hex. */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S.*?)\s*$/.exec(line);
    if (m) sums.set(m[2], m[1].toLowerCase());
  }
  return sums;
}

export const sha256Hex = (bytes: Uint8Array | ArrayBuffer) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/**
 * The changes listed in a release body: the bullets under "### Features" become `feat:` subjects, those under
 * "### Fixes" `fix:`, any other bullet keeps its own conventional prefix or none. `- **scope**: text (abc1234)`.
 */
export function releaseCommits(body: string | null | undefined): Commit[] {
  const commits: Commit[] = [];
  let type = "";
  for (const raw of String(body ?? "").split("\n")) {
    const line = raw.trim();
    const h = /^#{2,4}\s+(.*)$/.exec(line);
    if (h) {
      const title = h[1].toLowerCase();
      type = /feature|new/.test(title) ? "feat" : /fix/.test(title) ? "fix" : "";
      continue;
    }
    const b = /^[-*]\s+(.+?)(?:\s+\(([0-9a-f]{7,40})\))?$/.exec(line);
    if (!b) continue;
    let text = b[1];
    let scope = "";
    const s = /^\*\*([^*]+)\*\*:\s*(.+)$/.exec(text);
    if (s) {
      scope = s[1];
      text = s[2];
    }
    const subject = type ? `${type}${scope ? `(${scope})` : ""}: ${text}` : text;
    commits.push({ sha: b[2] ?? "", subject });
  }
  return commits;
}

/** The commit a release was built from: the `Commit: <sha>` line its body ends with, or null. */
export const releaseSha = (body: string | null | undefined) => /^Commit:\s*([0-9a-f]{7,40})\s*$/im.exec(String(body ?? ""))?.[1] ?? null;

export const tagVersion = (tag: string) => tag.replace(/^v/, "");

export function binaryLocalVersion(o: ReleaseOptions = {}): LocalVersion {
  return { version: o.current ?? STRATO_VERSION, sha: o.currentSha ?? BUILD_SHA, branch: "release", upstream: `github:${o.repo ?? RELEASE_REPO}`, dirty: [] };
}

async function fetchLatest(o: ReleaseOptions): Promise<{ ok: true; release: GithubRelease } | { ok: false; error: string }> {
  const f = o.fetch ?? fetch;
  try {
    const res = await f(latestUrl(o.repo ?? RELEASE_REPO), { headers: UA, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { ok: false, error: `GitHub answered ${res.status}${res.status === 404 ? " (no release published yet)" : ""}` };
    const release = (await res.json()) as GithubRelease;
    if (typeof release?.tag_name !== "string" || !Array.isArray(release.assets)) return { ok: false, error: "unexpected answer from GitHub" };
    return { ok: true, release };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const targetOf = (o: ReleaseOptions) => (o.target === undefined ? releaseTarget() : o.target);

export async function checkRelease(o: ReleaseOptions = {}): Promise<UpdateCheck> {
  const local = binaryLocalVersion(o);
  const base: UpdateCheck = { checkedAt: new Date().toISOString(), available: false, upstream: local.upstream, target: null, newer: false, commits: [], changes: groupChanges([]) };
  const latest = await fetchLatest(o);
  if (!latest.ok) return { ...base, reason: "fetchFailed", error: latest.error };
  const { release } = latest;
  const target = tagVersion(release.tag_name);
  const newer = compareSemver(target, local.version) > 0;
  const listed = releaseCommits(release.body);
  // the button counts changes: a release whose body lists none still counts as one
  const commits = listed.length ? listed : [{ sha: releaseSha(release.body) ?? "", subject: `release ${release.tag_name}` }];
  const t = targetOf(o);
  const hasAsset = !!t && release.assets.some((a) => a.name === assetName(t));
  const result: UpdateCheck = { ...base, target, newer, commits: newer ? commits : [], changes: groupChanges(newer ? commits : []) };
  if (newer && !hasAsset) return { ...result, reason: "noAsset", error: `release ${release.tag_name} has no binary for ${t ?? `${process.platform}-${process.arch}`}` };
  return { ...result, available: newer };
}

async function download(o: ReleaseOptions, url: string): Promise<Uint8Array> {
  const res = await (o.fetch ?? fetch)(url, { headers: { "User-Agent": UA["User-Agent"] }, redirect: "follow", signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Runs `<path> version` and expects the release's version in its output, within 15 s. */
async function defaultVerify(path: string, version: string): Promise<{ ok: boolean; output: string }> {
  try {
    const p = Bun.spawn([path, "version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, STRATO_UPDATE_CHECK: "off" } });
    const timer = setTimeout(() => p.kill(), 15_000);
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timer);
    const output = `${out}${err}`.trim();
    return { ok: code === 0 && output.includes(version), output: output || `exit code ${code}` };
  } catch (e) {
    return { ok: false, output: (e as Error).message };
  }
}

/**
 * Swaps `bytes` in at `path`, keeping the old file as `<path>.previous`. The new binary is written next to the old one
 * (same folder, so the final rename is atomic), made executable and flushed, then checked by `verify` before anything
 * else moves.
 * - POSIX: `<path>.previous` becomes a hard link to the current binary (a copy when links are refused), then the new
 *   file is renamed over `path`. A running process keeps its own inode: the server restarts on the new file.
 * - Windows: a running .exe cannot be overwritten but can be renamed: `path` -> `.previous`, then new -> `path`,
 *   undone if the second rename fails.
 */
export async function replaceBinary(
  path: string,
  bytes: Uint8Array,
  verify: (p: string) => Promise<{ ok: boolean; output: string }> = async () => ({ ok: true, output: "" }),
  platform: string = process.platform,
): Promise<{ ok: true; previous: string } | { ok: false; stage: "write" | "verify" | "swap"; output: string }> {
  const tmp = join(dirname(path), `.${basename(path)}.new-${process.pid}`);
  const previous = `${path}.previous`;
  const clean = () => {
    try {
      unlinkSync(tmp);
    } catch {}
  };
  try {
    const fd = openSync(tmp, "w", 0o755);
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o755);
  } catch (e) {
    clean();
    return { ok: false, stage: "write", output: (e as Error).message };
  }
  const checked = await verify(tmp);
  if (!checked.ok) {
    clean();
    return { ok: false, stage: "verify", output: checked.output };
  }
  try {
    if (existsSync(previous)) unlinkSync(previous);
    if (platform === "win32") {
      renameSync(path, previous);
      try {
        renameSync(tmp, path);
      } catch (e) {
        renameSync(previous, path);
        throw e;
      }
    } else {
      try {
        linkSync(path, previous);
      } catch {
        await Bun.write(previous, Bun.file(path));
        chmodSync(previous, 0o755);
      }
      renameSync(tmp, path);
    }
    return { ok: true, previous };
  } catch (e) {
    clean();
    return { ok: false, stage: "swap", output: (e as Error).message };
  }
}

/** Puts `<path>.previous` back in place of `path`. False when there is no previous binary. */
export function rollbackBinary(path: string): boolean {
  const previous = `${path}.previous`;
  if (!existsSync(previous)) return false;
  renameSync(previous, path);
  return true;
}

export async function applyRelease(o: ReleaseOptions = {}): Promise<UpdateResult> {
  const local = binaryLocalVersion(o);
  const from = local.sha || `v${local.version}`;
  const latest = await fetchLatest(o);
  if (!latest.ok) return { ok: false, reason: "downloadFailed", from, output: latest.error };
  const { release } = latest;
  const toVersion = tagVersion(release.tag_name);
  const to = releaseSha(release.body) ?? release.tag_name;
  const changes = groupChanges(releaseCommits(release.body));
  if (compareSemver(toVersion, local.version) <= 0) return { ok: true, from, to: from, fromVersion: local.version, toVersion: local.version, changes: groupChanges([]) };
  const t = targetOf(o);
  const asset = t ? release.assets.find((a) => a.name === assetName(t)) : undefined;
  const sumsAsset = release.assets.find((a) => a.name === "SHA256SUMS");
  if (!t || !asset || !sumsAsset) {
    return { ok: false, reason: "noAsset", from, output: !asset ? `no binary for ${t ?? `${process.platform}-${process.arch}`} in ${release.tag_name}` : `no SHA256SUMS in ${release.tag_name}` };
  }
  let bytes: Uint8Array;
  let sums: Map<string, string>;
  try {
    [bytes, sums] = await Promise.all([download(o, asset.browser_download_url), download(o, sumsAsset.browser_download_url).then((b) => parseSha256Sums(new TextDecoder().decode(b)))]);
  } catch (e) {
    return { ok: false, reason: "downloadFailed", from, output: (e as Error).message };
  }
  const expected = sums.get(asset.name);
  const actual = sha256Hex(bytes);
  if (!expected || expected !== actual) {
    return { ok: false, reason: "checksumFailed", from, output: expected ? `${asset.name}: expected ${expected}, got ${actual}` : `${asset.name} is not listed in SHA256SUMS` };
  }
  const path = o.execPath ?? process.execPath;
  const verify = o.verify ?? defaultVerify;
  const swapped = await replaceBinary(path, bytes, (p) => verify(p, toVersion));
  if (!swapped.ok) return { ok: false, reason: swapped.stage === "verify" ? "checkFailed" : "replaceFailed", from, output: swapped.output };
  if (o.refreshSkills !== false) {
    try {
      const p = Bun.spawn([path, "install-skill", "--refresh"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      const timer = setTimeout(() => p.kill(), 15_000);
      await p.exited;
      clearTimeout(timer);
    } catch {}
  }
  return { ok: true, from, to, fromVersion: local.version, toVersion, changes };
}
