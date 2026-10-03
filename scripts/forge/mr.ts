import { type MessageKey, t } from "../core/i18n.ts";
import { type ForgeSettings, settings } from "../core/settings.ts";

/**
 * The merge requests (MRs) quoted in cards, and their path to production. Repositories, their aliases and the
 * branches come from `settings().forge`: without a configured forge, no topic has an MR.
 */

export interface MrRef {
  repo: string;
  iid: number;
}

/** Card fields where an MR may be quoted. Never the draft: it is a message to someone. */
const MR_TEXT_FIELDS = ["mrs", "steps", "blocker", "next", "summary", "action", "proposal", "unverified", "ask"] as const;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Project path of a forge repository ("acme/api"), or null if it is not configured. */
export function repoPath(repo: string, forge: ForgeSettings | null = settings().forge): string | null {
  return forge?.repos[repo] ?? null;
}

/** Link of an MR, built without reading it. */
export function mrUrl(repo: string, iid: number, forge: ForgeSettings | null = settings().forge): string {
  return `https://${forge?.host ?? "gitlab.com"}/${repoPath(repo, forge) ?? repo}/-/merge_requests/${iid}`;
}

/** Repository of a "!N" quoted without a repository: the number range that contains it, else the default repository. */
function repoOfBareIid(iid: number, forge: ForgeSettings): string {
  const range = [...forge.iidRanges].sort((a, b) => b.from - a.from).find((r) => iid >= r.from);
  return range?.repo ?? forge.defaultRepo;
}

/**
 * The MRs of a topic. Order of trust: the `mrs` field the session declares, then a forge link or "repo!N" in the
 * card, then a bare "!N". A bare "!N" has no repository: take the one the card names alone, else the configured
 * number range (`forge.iidRanges`), else `forge.defaultRepo`. A heuristic, hence `mrs`.
 */
export function mrRefs(s: Partial<Record<(typeof MR_TEXT_FIELDS)[number], string>>, forge: ForgeSettings | null = settings().forge): MrRef[] {
  if (!forge || !Object.keys(forge.repos).length) return [];
  const repos = forge.repos;
  const out = new Map<string, MrRef>();
  const add = (repo: string, iid: number) => {
    if (!(repo in repos) || !Number.isFinite(iid)) return;
    out.set(`${repo}!${iid}`, { repo, iid });
  };
  const aliases = Object.fromEntries(Object.entries(forge.aliases).map(([k, v]) => [k.toLowerCase(), v]));
  const alias = (r: string) => aliases[r.toLowerCase()] ?? r.toLowerCase();
  const names = [...Object.keys(repos), ...Object.keys(forge.aliases)].map(escapeRe).join("|");
  const byPath = new Map(Object.entries(repos).map(([name, path]) => [path, name]));
  const texts = MR_TEXT_FIELDS.map((f) => s[f] ?? "").filter(Boolean);
  const all = texts.join("\n");
  const qualified = new Set<string>();
  const links = new RegExp(`${escapeRe(forge.host)}\\/(${[...byPath.keys()].map(escapeRe).join("|")})\\/-\\/merge_requests\\/(\\d+)`, "g");
  for (const m of all.matchAll(links)) {
    add(byPath.get(m[1]) as string, Number(m[2]));
    qualified.add(m[2]);
  }
  for (const m of all.matchAll(new RegExp(`\\b(${names})\\s*(?:MR\\s*)?!(\\d+)`, "gi"))) {
    add(alias(m[1]), Number(m[2]));
    qualified.add(m[2]);
  }
  const named = [...new Set([...all.matchAll(new RegExp(`\\b(${names})\\b`, "gi"))].map((m) => alias(m[1])))];
  for (const m of all.matchAll(/(?:^|[\s(/,;:])!(\d{2,5})\b/g)) {
    if (qualified.has(m[1])) continue;
    const iid = Number(m[1]);
    add(named.length === 1 ? named[0] : repoOfBareIid(iid, forge), iid);
  }
  return [...out.values()];
}

/** An MR as GitLab describes it, reduced to what the board shows. */
export interface MrState {
  repo: string;
  iid: number;
  title: string;
  url: string;
  state: string;
  draft: boolean;
  target: string;
  mergedAt: string | null;
  /** GitLab's detailed_merge_status: mergeable, not_approved, ci_still_running, need_rebase, conflict… */
  mergeStatus: string;
  /** Status of the MR's last pipeline: success, failed, running… */
  pipeline: string | null;
}

export type MrStage = "closed" | "draft" | "review" | "ready" | "dev" | "prod";
/** Progress order: the topic is as far as its least advanced MR. */
export const MR_STAGE_ORDER: MrStage[] = ["draft", "review", "ready", "dev", "prod", "closed"];

/**
 * GitLab merge status -> blocker shown on the board (key of core/i18n.ts). null: not a blocker.
 * `hard`: the author has to act (red CI, conflict, rebase, requested changes); the board shows it as a warning.
 */
const MERGE_BLOCKERS: Record<string, { key: MessageKey | null; hard?: boolean }> = {
  not_approved: { key: "board.mr.blocker.notApproved" },
  ci_must_pass: { key: "board.mr.blocker.ciMustPass" },
  ci_still_running: { key: "board.mr.blocker.ciRunning" },
  need_rebase: { key: "board.mr.blocker.needRebase", hard: true },
  conflict: { key: "board.mr.blocker.conflict", hard: true },
  discussions_not_resolved: { key: "board.mr.blocker.discussions" },
  blocked_status: { key: "board.mr.blocker.blocked" },
  draft_status: { key: "board.mr.blocker.draft" },
  requested_changes: { key: "board.mr.blocker.changesRequested", hard: true },
  jira_association_missing: { key: "board.mr.blocker.ticketMissing" },
  not_open: { key: null },
  checking: { key: "board.mr.blocker.checking" },
  unchecked: { key: null },
  mergeable: { key: null },
};

/**
 * Where an MR stands, from review to production. An MR into the release branch (`forge.releaseBranch`) is in
 * production when merged; an MR into the integration branch is once an integration → release MR was merged after it.
 * `releases` = merge dates of those releases, read by the server. The `label` and `blocker` texts are shown on the
 * board, in the profile's locale (computed at each render); `hard` says the blocker needs the author, so the board
 * never has to parse the text. The `stage` values are compared by the board: keep them.
 */
export function mrStage(m: MrState, releases: string[], forge: ForgeSettings | null = settings().forge): { stage: MrStage; label: string; blocker: string | null; hard: boolean; at: string | null } {
  const release = forge?.releaseBranch ?? "main";
  const integration = forge?.integrationBranch ?? "dev";
  if (m.state === "closed" || m.state === "locked") return { stage: "closed", label: t("board.mr.label.closed"), blocker: null, hard: false, at: null };
  if (m.state === "merged") {
    if (m.target === release) return { stage: "prod", label: t("board.mr.label.prod"), blocker: null, hard: false, at: m.mergedAt };
    const released = m.mergedAt ? releases.filter((r) => r > (m.mergedAt as string)).sort()[0] : undefined;
    if (released) return { stage: "prod", label: t("board.mr.label.prod"), blocker: null, hard: false, at: released };
    return { stage: "dev", label: t("board.mr.label.on", { branch: m.target }), blocker: m.target === integration ? t("board.mr.blocker.release", { integration, release }) : null, hard: false, at: m.mergedAt };
  }
  if (m.draft) return { stage: "draft", label: t("board.mr.label.draft"), blocker: null, hard: false, at: null };
  if (m.pipeline === "failed") return { stage: "review", label: t("board.mr.label.review"), blocker: t("board.mr.blocker.redCi"), hard: true, at: null };
  if (m.mergeStatus === "mergeable") return { stage: "ready", label: t("board.mr.label.ready"), blocker: null, hard: false, at: null };
  const b = MERGE_BLOCKERS[m.mergeStatus];
  return { stage: "review", label: t("board.mr.label.review"), blocker: b === undefined ? m.mergeStatus.replace(/_/g, " ") : b.key ? t(b.key) : null, hard: !!b?.hard, at: null };
}
