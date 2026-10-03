/**
 * The forge: reads the state of the topics' merge requests through `glab api`, for the board's delivery line.
 */
import { existsSync } from "node:fs";
import { type Delivery } from "../board.ts";
import { t } from "../core/i18n.ts";
import { settings } from "../core/settings.ts";
import { type Sujet } from "../core/sujet.ts";
import { mrRefs, mrStage, type MrState, mrUrl, repoPath } from "../forge/mr.ts";
import { WORKSPACE } from "./env.ts";
import { loadSujets } from "./store.ts";

/** The server is started by the iTerm2 script with a minimal PATH, without Homebrew: look for glab in the usual places. */
export const GLAB_BIN = Bun.which("glab") ?? ["/opt/homebrew/bin/glab", "/usr/local/bin/glab"].find((p) => existsSync(p)) ?? "glab";
/**
 * glab's GitLab token comes from `GITLAB_TOKEN` in the environment. A server started by iTerm2 does not inherit the
 * shell's environment: on macOS, fall back once to the login keychain (generic password whose service is GITLAB_TOKEN).
 */
let GITLAB_TOKEN_CACHE: string | undefined;
export function gitlabToken(): string {
  if (GITLAB_TOKEN_CACHE !== undefined) return GITLAB_TOKEN_CACHE;
  GITLAB_TOKEN_CACHE = process.env.GITLAB_TOKEN ?? "";
  if (!GITLAB_TOKEN_CACHE) {
    const r = Bun.spawnSync(["/usr/bin/security", "find-generic-password", "-a", process.env.USER ?? "", "-s", "GITLAB_TOKEN", "-w"], { stdout: "pipe", stderr: "ignore" });
    GITLAB_TOKEN_CACHE = r.exitCode === 0 ? r.stdout.toString().trim() : "";
  }
  return GITLAB_TOKEN_CACHE;
}

/**
 * The state of the open topics' merge requests, read from the forge by `glab api`, in the background: rendering never
 * waits for it. An open MR is reread every 90 s, a merged one every 5 min (its release may ship), one in production or
 * closed never again. Each repository's integration -> release merges tell when an MR to the integration branch
 * reached production. Without a forge in the profile, nothing is read and no topic has a delivery.
 * `onChange` is called when a state read has changed.
 */
export function deliveryTracker(onChange: () => void): { refresh: () => Promise<void>; of: (sujets: Sujet[]) => Map<string, Delivery[]>; version: () => number } {
  const mrCache = new Map<string, { at: number; state: MrState | null; final: boolean }>();
  const releases = new Map<string, { at: number; list: string[] }>();
  let deliveriesVersion = 0;
  let refreshing = false;
  // biome-ignore lint/suspicious/noExplicitAny: untyped GitLab responses
  async function glabApi(path: string): Promise<any> {
    const proc = Bun.spawn([GLAB_BIN, "api", path], { cwd: WORKSPACE, env: { ...process.env, GITLAB_TOKEN: gitlabToken() }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), 20_000);
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    if (code !== 0) throw new Error(`glab api ${path}: ${err.trim().split("\n").pop() || `code ${code}`}`);
    return JSON.parse(out);
  }
  async function refreshDeliveries() {
    const forge = settings().forge;
    if (refreshing || !forge) return;
    refreshing = true;
    let changed = false;
    try {
      const refs = loadSujets()
        .filter((s) => s.status !== "closed")
        .flatMap((s) => mrRefs(s));
      const now = Date.now();
      for (const repo of new Set(refs.map((r) => r.repo))) {
        const c = releases.get(repo);
        if (c && now - c.at < 120_000) continue;
        try {
          const list = (await glabApi(`projects/${encodeURIComponent(repoPath(repo) ?? repo)}/merge_requests?state=merged&target_branch=${forge.releaseBranch}&source_branch=${forge.integrationBranch}&per_page=30`)) as { merged_at?: string }[];
          const next = list.map((x) => x.merged_at ?? "").filter(Boolean);
          if (JSON.stringify(next) !== JSON.stringify(c?.list)) changed = true;
          releases.set(repo, { at: now, list: next });
        } catch {}
      }
      for (const r of refs) {
        const k = `${r.repo}!${r.iid}`;
        const c = mrCache.get(k);
        if (c && (c.final || now - c.at < (c.state?.state === "merged" ? 300_000 : 90_000))) continue;
        try {
          const j = await glabApi(`projects/${encodeURIComponent(repoPath(r.repo) ?? r.repo)}/merge_requests/${r.iid}`);
          const state: MrState = {
            repo: r.repo,
            iid: r.iid,
            title: String(j.title ?? ""),
            url: String(j.web_url ?? ""),
            state: String(j.state ?? ""),
            draft: !!j.draft,
            target: String(j.target_branch ?? ""),
            mergedAt: j.merged_at ?? null,
            mergeStatus: String(j.detailed_merge_status ?? ""),
            pipeline: j.head_pipeline?.status ?? null,
          };
          const stage = mrStage(state, releases.get(r.repo)?.list ?? []).stage;
          if (JSON.stringify(state) !== JSON.stringify(c?.state)) changed = true;
          mrCache.set(k, { at: now, state, final: stage === "prod" || stage === "closed" });
        } catch (e) {
          console.error(`[board] MR ${k} unreadable: ${(e as Error).message}`);
          mrCache.set(k, { at: now, state: c?.state ?? null, final: false });
        }
      }
    } finally {
      refreshing = false;
    }
    if (changed) {
      deliveriesVersion++;
      onChange();
    }
  }
  function deliveriesOf(sujets: Sujet[]): Map<string, Delivery[]> {
    const out = new Map<string, Delivery[]>();
    for (const s of sujets) {
      if (s.status === "closed") continue;
      const items: Delivery[] = [];
      for (const r of mrRefs(s)) {
        const st = mrCache.get(`${r.repo}!${r.iid}`)?.state;
        if (!st) {
          items.push({ repo: r.repo, iid: r.iid, title: "", url: mrUrl(r.repo, r.iid), stage: null, label: t("board.mr.label.unread"), blocker: null, at: null });
          continue;
        }
        items.push({ repo: r.repo, iid: r.iid, title: st.title, url: st.url, ...mrStage(st, releases.get(r.repo)?.list ?? []) });
      }
      if (items.length) out.set(s.key, items);
    }
    return out;
  }
  return { refresh: refreshDeliveries, of: deliveriesOf, version: () => deliveriesVersion };
}
