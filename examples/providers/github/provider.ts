/**
 * GitHub: a Strato provider for the requests that reach a person on github.com, written as a TypeScript module.
 *
 * Sign-in is a fine-grained personal access token. GitHub's notifications API (`GET /notifications`) only accepts a
 * classic token, so this provider rebuilds the person's notifications from two endpoints a fine-grained token can read:
 *
 * - the issue search (`involves:@me`, `review-requested:@me`), for the issues and pull requests that moved since the
 *   cursor and concern the person;
 * - the timeline of each of them, for what happened there: comments, reviews, assignments, review requests, state.
 *
 * Context reads the same timeline; the one write is a comment on an issue or a pull request, only ever called by
 * Strato's gate after the person's Go on that exact text, and undone by deleting it.
 *
 * Native ids: a thread is `owner/repo#number` (an issue or a pull request, GitHub numbers them together); an item is
 * the thread followed by `/c<comment id>`, `/r<review id>`, `/e<event id>` or `/body`.
 * The guide: `strato provider guide`. The types: strato-provider.d.ts (`strato provider types` prints it again).
 */
import type {
  AccountContext,
  ActInput,
  ActResult,
  ContextResult,
  Identity,
  IngestCursor,
  Item,
  PollResult,
  Provider,
  ProviderDescriptor,
  ProviderError,
  Target,
} from "./strato-provider.d.ts";

const WEB = "github.com";
const API = "https://api.github.com";
const SECRET = "GITHUB_TOKEN";
const UNDO_MS = 60_000;
/** GitHub's own limit on a comment body. */
const MAX_TEXT = 65_536;
/** How far back each poll searches again: the search index lags behind the timeline by seconds to minutes. */
const OVERLAP_MS = 10 * 60_000;
/** One page of search results per query, GitHub's maximum. */
const SEARCH_PAGE = 100;
/** Timeline pages read per thread, from the newest: enough for any burst between two polls. */
const TIMELINE_PAGES = 3;

const text = (en: string, fr: string) => ({ en, fr });

// ------------------------------------------------------------------ native ids

/** A GitHub login or organization: letters, digits and single dashes. Repositories also allow `.` and `_`. */
const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const REPO = "[A-Za-z0-9_.-]{1,100}";
const THREAD_RE = new RegExp(`^(${OWNER})/(${REPO})#([1-9][0-9]{0,9})$`);

interface ThreadRef {
  owner: string;
  repo: string;
  number: number;
}

/** `owner/repo#12` to its parts, or null; `.` and `..` are refused so a path can never climb out of /repos. */
function parseThread(native: string): ThreadRef | null {
  const m = THREAD_RE.exec(native);
  if (!m || m[2] === "." || m[2] === "..") return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

const threadId = (r: ThreadRef) => `${r.owner}/${r.repo}#${r.number}`;
const repoOf = (r: ThreadRef) => `${r.owner}/${r.repo}`;
const repoPath = (r: ThreadRef) => `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;
const issueUrl = (r: ThreadRef) => `https://${WEB}/${r.owner}/${r.repo}/issues/${r.number}`;

/** A link GitHub gave, kept only when it is an https link on github.com; else the issue link, which GitHub redirects for a pull request. */
function webLink(url: unknown, fallback: string): string {
  if (typeof url !== "string") return fallback;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === WEB && !u.username && !u.password ? u.toString() : fallback;
  } catch {
    return fallback;
  }
}

// ------------------------------------------------------------------ descriptor

const PATH_THREAD = `^/(${OWNER})/(${REPO})/(?:issues|pull)/([1-9][0-9]{0,9})`;

const descriptor: ProviderDescriptor = {
  id: "github",
  label: text("GitHub", "GitHub"),
  api: { min: 1, max: 1 },
  kinds: ["tracker"],
  capabilities: {
    ingest: { push: false, poll: true },
    participation: false,
    context: true,
    actions: ["comment"],
    undo: ["comment"],
    // GitHub has no idempotency key on comments: a replay of the same Go could comment twice, so none is claimed
    idempotent: [],
    edits: false,
    identity: false,
  },
  auth: [
    {
      id: "fine-grained-pat",
      kind: "api-key",
      label: text("Fine-grained personal access token", "Jeton d'accès personnel à granularité fine"),
      tradeoff: text(
        "Limited to the repositories you pick; GitHub's notifications inbox is out of its reach, so Strato searches what concerns you instead.",
        "Limité aux dépôts choisis ; la boîte de notifications de GitHub lui est fermée, Strato cherche donc ce qui vous concerne.",
      ),
      docs: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token",
      steps: [
        {
          kind: "open",
          url: "https://github.com/settings/personal-access-tokens/new",
          say: text(
            "Create a fine-grained token: choose the repositories, then the repository permissions Issues (read and write), Pull requests (read and write) and Metadata (read).",
            "Créez un jeton à granularité fine : choisissez les dépôts, puis les permissions de dépôt Issues (lecture et écriture), Pull requests (lecture et écriture) et Metadata (lecture).",
          ),
        },
        { kind: "paste", secret: SECRET, shape: "github_pat_", say: text("Paste the token (it is not shown)", "Collez le jeton (il ne s'affiche pas)") },
        { kind: "verify" },
      ],
      stores: [{ name: SECRET }],
    },
  ],
  settings: [
    {
      key: "teams",
      type: "string[]",
      label: text("Your teams", "Vos équipes"),
      default: [],
      ask: text(
        "Which teams, written org/team, count as you when they are mentioned or asked for a review?",
        "Quelles équipes, écrites org/équipe, comptent comme vous quand on les mentionne ou leur demande une revue ?",
      ),
      triage: "groups",
    },
    {
      key: "ignoreAuthors",
      type: "string[]",
      label: text("Bots to set aside", "Bots à mettre de côté"),
      default: [],
      ask: text(
        "Which accounts (such as dependabot[bot]) post there that you do not need to read?",
        "Quels comptes (comme dependabot[bot]) y écrivent sans que vous ayez besoin de les lire ?",
      ),
      triage: "ignoreAuthors",
    },
  ],
  vocabulary: {
    item: text("comment", "commentaire"),
    thread: text("issue or pull request", "issue ou pull request"),
    conversation: text("repository", "dépôt"),
    // a key escapes `#` as %23 (keys keep letters, digits and . _ : / + = @ , - only)
    targetFormat: "the key of the issue or pull request, owner/repo%23number, such as github:acme/api%2342",
    targetHint: "owner/repo#number",
  },
  links: {
    parse: [
      { host: WEB, pattern: `${PATH_THREAD}#issuecomment-([0-9]{1,15})`, thread: "$1/$2#$3", item: "$1/$2#$3/c$4" },
      { host: WEB, pattern: `${PATH_THREAD}#pullrequestreview-([0-9]{1,15})`, thread: "$1/$2#$3", item: "$1/$2#$3/r$4" },
      { host: WEB, pattern: PATH_THREAD, thread: "$1/$2#$3" },
    ],
    of: [
      { match: `^(${OWNER})/(${REPO})#([0-9]{1,10})/c([0-9]{1,15})$`, url: `https://${WEB}/$1/$2/issues/$3#issuecomment-$4` },
      { match: `^(${OWNER})/(${REPO})#([0-9]{1,10})/r([0-9]{1,15})$`, url: `https://${WEB}/$1/$2/pull/$3#pullrequestreview-$4` },
      { match: `^(${OWNER})/(${REPO})#([0-9]{1,10})(?:/[a-z0-9]+)?$`, url: `https://${WEB}/$1/$2/issues/$3` },
    ],
  },
  hosts: [WEB],
  apiHosts: ["api.github.com"],
  undoMs: UNDO_MS,
  maxText: MAX_TEXT,
};

// ------------------------------------------------------------------ requests

/** A ProviderError, as Strato reads it from a throw or an `{ ok: false }`. */
function failure(code: string, message: string, more: Partial<ProviderError> = {}): ProviderError {
  return { code, message, retryable: false, fatal: false, ...more };
}

/** The wait GitHub asks for on a rate limit: `retry-after` in seconds, else the reset time of the primary limit. */
function retryAfter(res: Response): number {
  const after = Number(res.headers.get("retry-after"));
  if (after > 0) return after * 1000;
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  return reset > 0 ? Math.max(1000, reset * 1000 - Date.now()) : 60_000;
}

/** GitHub's error text, short: its `message` field when the body is JSON. */
async function reasonOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    return typeof body?.message === "string" ? body.message.slice(0, 200) : `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** A request to GitHub's REST API, through `ctx.fetch`; the body and the `link` header of its answer, or a ProviderError thrown. */
async function call(ctx: AccountContext, method: string, path: string, body?: unknown): Promise<{ body: any; link: string }> {
  let res: Response;
  try {
    res = await ctx.fetch(`${API}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${ctx.secret(SECRET) ?? ""}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "strato-github-provider",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    // a timeout or a network failure: worth retrying, and for a write its outcome stays unknown
    throw failure("network", String((e as Error)?.message ?? e), { retryable: true });
  }
  const what = `${method} ${path.split("?")[0]}`;
  if (res.status === 401) throw failure("invalid_auth", "GitHub refused the token: create a new one and connect again", { fatal: true });
  if (res.status === 429 || ((res.status === 403) && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after")))) {
    throw failure("rate_limited", `${what}: rate limited`, { retryable: true, retryAfterMs: retryAfter(res) });
  }
  // a 403 here is one repository the token was not given, not a dead token: the account keeps working elsewhere
  if (res.status === 403) throw failure("forbidden", `${what}: ${await reasonOf(res)}`);
  if (res.status === 404) throw failure("not_found", `${what}: not found, or not shared with the token`);
  if (res.status >= 400) throw failure("http", `${what}: ${await reasonOf(res)}`, { retryable: res.status >= 500 });
  const raw = await res.text();
  return { body: raw ? JSON.parse(raw) : null, link: res.headers.get("link") ?? "" };
}

/** The `last` page number of a `link` header, 1 without one. */
function lastPage(link: string): number {
  const m = /<[^>]*[?&]page=([0-9]{1,6})[^>]*>;\s*rel="last"/.exec(link);
  return m ? Number(m[1]) : 1;
}

// ------------------------------------------------------------------ GitHub shapes, as far as this provider reads them

interface GhUser {
  login: string;
  type?: string;
}

/** One result of the issue search. */
interface GhIssue {
  number: number;
  title: string;
  body?: string | null;
  user: GhUser | null;
  html_url: string;
  repository_url: string;
  created_at: string;
  updated_at: string;
  state?: string;
  locked?: boolean;
  assignees?: GhUser[];
  labels?: ({ name?: string } | string)[];
  pull_request?: { merged_at?: string | null };
}

/** One timeline event; only the fields of the kinds this provider reads. */
interface GhEvent {
  event: string;
  id?: number;
  body?: string | null;
  state?: string;
  user?: GhUser | null;
  actor?: GhUser | null;
  assignee?: GhUser | null;
  requested_reviewer?: GhUser | null;
  requested_team?: { slug?: string; name?: string } | null;
  html_url?: string;
  created_at?: string;
  submitted_at?: string;
}

/** `https://api.github.com/repos/acme/api` and an issue number to a thread. */
function refOfIssue(issue: GhIssue): ThreadRef | null {
  const m = /\/repos\/([^/]+)\/([^/]+)$/.exec(issue.repository_url ?? "");
  return m ? parseThread(`${m[1]}/${m[2]}#${issue.number}`) : null;
}

const timeOf = (iso: string | undefined | null) => (iso ? Date.parse(iso) : Number.NaN);

// ------------------------------------------------------------------ the person and their mentions

interface Me {
  login: string;
  /** `org/team`, lowercase. */
  teams: string[];
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase()) : [];
}

/** Who the person is on this account: from `connect`, else read again. */
async function whoAmI(ctx: AccountContext): Promise<Me> {
  const login = ctx.identity?.me || (await call(ctx, "GET", "/user")).body?.login;
  if (typeof login !== "string" || !login) throw failure("invalid_auth", "GitHub did not say who the token belongs to", { fatal: true });
  return { login: login.toLowerCase(), teams: strings(ctx.account.settings.teams) };
}

/** The `@login` and `@org/team` mentions of a Markdown text, lowercase, outside code. */
function mentionsOf(markdown: string): string[] {
  const prose = markdown.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const found = new Set<string>();
  for (const m of prose.matchAll(/(?:^|[^A-Za-z0-9_`/])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9_.-]{1,100})?)(?![A-Za-z0-9_-])/g)) {
    found.add(m[1].toLowerCase());
  }
  return [...found];
}

/** Whether a mention names the person: their login, or one of their teams. */
const isMine = (me: Me, who: string) => who === me.login || me.teams.includes(who);

// ------------------------------------------------------------------ timeline events to items

/** An item's wording for what GitHub did, in the board's language. */
function said(ctx: AccountContext, en: string, fr: string): string {
  return ctx.locale === "fr" ? fr : en;
}

interface Thread {
  ref: ThreadRef;
  title: string;
  link: string;
}

function baseItem(t: Thread, me: Me, author: GhUser | null | undefined): Pick<Item, "thread" | "author" | "conversation" | "title"> {
  const login = author?.login ?? "ghost";
  return {
    thread: threadId(t.ref),
    author: { id: login, name: login, isMe: login.toLowerCase() === me.login, isBot: author?.type === "Bot" || login.endsWith("[bot]") },
    conversation: { id: repoOf(t.ref), label: repoOf(t.ref), kind: "ticket" },
    title: t.title,
  };
}

/** A text item (a comment, a review, an issue's opening): the mentions say whether it targets the person or someone else. */
function textItem(t: Thread, me: Me, ev: { id: string; event: Item["event"]; author: GhUser | null | undefined; text: string; at: number; link: string }): Item {
  const mentions = mentionsOf(ev.text);
  const mentionsMe = mentions.some((m) => isMine(me, m));
  return {
    ...baseItem(t, me, ev.author),
    id: `${threadId(t.ref)}/${ev.id}`,
    event: ev.event,
    text: ev.text,
    time: ev.at,
    link: ev.link,
    mentionsMe,
    targetsOther: !mentionsMe && mentions.length > 0,
    // the search only returns threads that concern the person: a reply there without a mention is one they follow
    reason: mentionsMe ? "mentioned" : "subscribed",
  };
}

/**
 * One timeline event to an item, or null for what the person does not need: labels, commits, references, and the
 * assignments and review requests of other people.
 */
function itemOfEvent(ctx: AccountContext, t: Thread, me: Me, e: GhEvent): Item | null {
  if (typeof e.id !== "number") return null;
  if (e.event === "commented") {
    const at = timeOf(e.created_at);
    return Number.isNaN(at) ? null : textItem(t, me, { id: `c${e.id}`, event: "comment", author: e.user, text: e.body ?? "", at, link: webLink(e.html_url, t.link) });
  }
  if (e.event === "reviewed") {
    const at = timeOf(e.submitted_at);
    if (Number.isNaN(at)) return null;
    const verdict = (e.state ?? "").toLowerCase().replace(/_/g, " ");
    const body = e.body ?? "";
    return textItem(t, me, { id: `r${e.id}`, event: "comment", author: e.user, text: body ? `[${verdict}] ${body}` : `[${verdict}]`, at, link: webLink(e.html_url, t.link) });
  }
  const at = timeOf(e.created_at);
  if (Number.isNaN(at)) return null;
  const actor = e.actor?.login ?? "ghost";
  const base = { ...baseItem(t, me, e.actor), id: `${threadId(t.ref)}/e${e.id}`, time: at, link: t.link, targetsOther: false };
  if (e.event === "assigned" && e.assignee?.login?.toLowerCase() === me.login) {
    return { ...base, event: "assigned", text: said(ctx, `${actor} assigned you`, `${actor} vous a assigné`), mentionsMe: true, reason: "assigned" };
  }
  if (e.event === "review_requested") {
    const who = e.requested_reviewer?.login?.toLowerCase() ?? (e.requested_team?.slug ? `${t.ref.owner.toLowerCase()}/${e.requested_team.slug.toLowerCase()}` : "");
    if (!who || !isMine(me, who)) return null;
    const requester = (e as { review_requester?: GhUser | null }).review_requester ?? e.actor;
    const by = requester?.login ?? actor;
    const target = who === me.login ? said(ctx, "your review", "votre revue") : said(ctx, `a review from ${who}`, `une revue de ${who}`);
    return { ...base, ...baseItem(t, me, requester), event: "assigned", text: said(ctx, `${by} requested ${target}`, `${by} a demandé ${target}`), mentionsMe: true, reason: "review_requested" };
  }
  if (e.event === "closed" || e.event === "reopened" || e.event === "merged") {
    const fr = e.event === "closed" ? "a fermé" : e.event === "reopened" ? "a rouvert" : "a fusionné";
    return { ...base, event: "status", text: said(ctx, `${actor} ${e.event} it`, `${actor} ${fr}`), mentionsMe: false };
  }
  return null;
}

/** An issue or a pull request opened by someone else: its description, as the thread's first item. */
function openingItem(t: Thread, me: Me, issue: GhIssue): Item {
  return textItem(t, me, { id: "body", event: "created", author: issue.user, text: issue.body ?? "", at: timeOf(issue.created_at), link: t.link });
}

/**
 * The newest timeline events of a thread, oldest first: page 1 tells how many pages there are, then the last pages are
 * read backwards, at most TIMELINE_PAGES of them, until one starts before `from`. `complete` says nothing at or after
 * `from` was left unread: every page was read, or the reading reached `from`.
 */
async function timeline(ctx: AccountContext, ref: ThreadRef, from: number | undefined): Promise<{ events: GhEvent[]; complete: boolean }> {
  const page = async (n: number) => call(ctx, "GET", `${repoPath(ref)}/issues/${ref.number}/timeline?per_page=100&page=${n}`);
  const first = await page(1);
  const last = lastPage(first.link);
  if (last <= 1) return { events: (first.body as GhEvent[]) ?? [], complete: true };
  const pages: GhEvent[][] = [];
  let reached = false;
  // n is the next page to read; the loop stops when page 2 was read, after TIMELINE_PAGES pages, or at `from`
  let n = last;
  while (n > 1 && last - n < TIMELINE_PAGES && !reached) {
    const events = ((await page(n)).body as GhEvent[]) ?? [];
    pages.unshift(events);
    const oldest = Math.min(...events.map((e) => timeOf(e.created_at ?? e.submitted_at)).filter((x) => !Number.isNaN(x)));
    reached = from !== undefined && oldest < from;
    n--;
  }
  // page 1 belongs only when every page after it was read: a gap between them would hide events
  const all = n === 1;
  return { events: [...(all ? [first.body as GhEvent[]] : []), ...pages].flat(), complete: all || reached };
}

// ------------------------------------------------------------------ the poll cursor

/**
 * The cursor's value: the time it reads from, and the items already returned at or after it. Each poll searches again
 * from `OVERLAP_MS` before its newest item, because GitHub's search index lags; the ids keep that overlap from
 * returning an item twice.
 */
interface CursorState {
  from: number;
  seen: [string, number][];
}

function readCursor(cursor: IngestCursor | null, since: number): CursorState {
  if (!cursor) return { from: since, seen: [] };
  try {
    const v = JSON.parse(cursor.value) as CursorState;
    if (typeof v.from === "number" && Array.isArray(v.seen)) return v;
  } catch {
    // an older or foreign cursor: read from its time
  }
  return { from: cursor.at, seen: [] };
}

/** `2026-01-01T10:00:00Z`: the search's date syntax, to the second, rounded down so nothing at `ms` is missed. */
const isoSecond = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The issues and pull requests a search returns, updated since `from`, and whether it returned them all. */
async function search(ctx: AccountContext, qualifier: string, from: number): Promise<{ issues: GhIssue[]; complete: boolean }> {
  const q = new URLSearchParams({ q: `${qualifier} updated:>=${isoSecond(from)}`, sort: "updated", order: "desc", per_page: String(SEARCH_PAGE) });
  const res = (await call(ctx, "GET", `/search/issues?${q}`)).body as { total_count?: number; incomplete_results?: boolean; items?: GhIssue[] };
  const issues = res?.items ?? [];
  return { issues, complete: !res?.incomplete_results && (res?.total_count ?? issues.length) <= issues.length };
}

// ------------------------------------------------------------------ targets

/**
 * A destination to a thread: `owner/repo#12`, a github.com link to it, or `#12` in the topic's repository. Pure, for
 * the board.
 */
function targetOf(raw: string, topic: { thread: string; conversation: { id: string } }): ThreadRef | null {
  const s = raw.trim().replace(/^github:/, "");
  const direct = parseThread(s);
  if (direct) return direct;
  const link = new RegExp(`^https://(?:www\\.)?github\\.com${PATH_THREAD.slice(1)}(?:[/?#].*)?$`, "i").exec(s);
  if (link) return parseThread(`${link[1]}/${link[2]}#${link[3]}`);
  const bare = /^#?([1-9][0-9]{0,9})$/.exec(s);
  const repo = parseThread(topic.thread) ?? parseThread(`${topic.conversation.id}#1`);
  return bare && repo ? { owner: repo.owner, repo: repo.repo, number: Number(bare[1]) } : null;
}

/** An undo token: `owner/repo:<comment id>`. */
function parseUndo(token: string): { ref: ThreadRef; comment: string } | null {
  const m = /^([^:]+):([0-9]{1,15})$/.exec(token);
  const ref = m ? parseThread(`${m[1]}#1`) : null;
  return m && ref ? { ref, comment: m[2] } : null;
}

// ------------------------------------------------------------------ the provider

const provider: Provider = {
  descriptor,

  async connect(ctx): Promise<Identity> {
    const user = (await call(ctx, "GET", "/user")).body as { login?: string; name?: string | null };
    if (typeof user?.login !== "string") throw failure("invalid_auth", "GitHub did not say who the token belongs to", { fatal: true });
    return { me: user.login, name: user.name || user.login, workspace: WEB };
  },

  /**
   * What concerns the person since the cursor: the issues and pull requests they are involved in, or asked to review,
   * that moved; then, for each, the timeline events that are new. Oldest first; when there are more than `maxItems`,
   * the newest.
   */
  async poll(ctx, cursor, opts): Promise<PollResult> {
    const me = await whoAmI(ctx);
    const state = readCursor(cursor, opts.since);
    const seen = new Set(state.seen.map(([id]) => id));
    const found = await Promise.all([search(ctx, "involves:@me", state.from), search(ctx, "review-requested:@me", state.from)]);
    const threads = new Map<string, { ref: ThreadRef; issue: GhIssue }>();
    for (const issue of found.flatMap((f) => f.issues)) {
      const ref = refOfIssue(issue);
      if (ref) threads.set(threadId(ref), { ref, issue });
    }
    const fresh: Item[] = [];
    // a thread busier than TIMELINE_PAGES pages since the cursor: its older events are dropped, as a capped pass does
    let timelinesWhole = true;
    for (const { ref, issue } of threads.values()) {
      const t: Thread = { ref, title: issue.title, link: webLink(issue.html_url, issueUrl(ref)) };
      let read: Awaited<ReturnType<typeof timeline>>;
      try {
        read = await timeline(ctx, ref, state.from);
      } catch (e) {
        // deleted, made private, or not shared with the token while the lagging index still lists it: skip that
        // thread only, so one unreadable issue never holds the account's cursor
        const code = (e as ProviderError)?.code;
        if (code !== "not_found" && code !== "forbidden") throw e;
        ctx.log("warn", `${threadId(ref)} skipped: ${(e as ProviderError).message}`);
        continue;
      }
      const { events, complete: whole } = read;
      timelinesWhole &&= whole;
      const items = events.map((e) => itemOfEvent(ctx, t, me, e)).filter((x): x is Item => x !== null);
      if (timeOf(issue.created_at) >= state.from) items.push(openingItem(t, me, issue));
      // `ignoreAuthors` is a triage setting: Strato sets those authors aside itself
      for (const item of items) if (item.time >= state.from && !seen.has(item.id)) fresh.push(item);
    }
    fresh.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    const kept = fresh.slice(-opts.maxItems);
    const complete = kept.length === fresh.length && found.every((f) => f.complete) && timelinesWhole;
    let next: CursorState;
    let at: number;
    if (complete) {
      // read again from a little before the newest item, without returning what this window already returned
      const newest = Math.max(state.from, ...kept.map((i) => i.time));
      const from = Math.max(state.from, newest - OVERLAP_MS);
      next = { from, seen: [...state.seen, ...kept.map((i): [string, number] => [i.id, i.time])].filter(([, time]) => time >= from) };
      at = newest;
    } else {
      // a capped pass starts again at the oldest item it kept: the older backlog is dropped on purpose
      const oldest = kept.length ? kept[0].time : state.from;
      next = { from: oldest, seen: kept.map((i): [string, number] => [i.id, i.time]) };
      at = oldest;
    }
    return { items: kept, cursor: { value: JSON.stringify(next), at }, complete };
  },

  /** The issue or pull request for a work session: its description, then its comments, reviews and state changes. */
  async context(ctx, native, opts): Promise<ContextResult> {
    const ref = parseThread(native);
    if (!ref) throw failure("not_found", "not an issue or pull request id: write owner/repo#number");
    const me = await whoAmI(ctx);
    const issue = (await call(ctx, "GET", `${repoPath(ref)}/issues/${ref.number}`)).body as GhIssue;
    const t: Thread = { ref, title: issue.title, link: webLink(issue.html_url, issueUrl(ref)) };
    const { events, complete: allPages } = await timeline(ctx, ref, opts.since);
    const all = [openingItem(t, me, issue), ...events.map((e) => itemOfEvent(ctx, t, me, e)).filter((x): x is Item => x !== null)]
      .filter((i) => opts.since === undefined || i.time >= opts.since)
      .sort((a, b) => a.time - b.time);
    const kept = all.slice(-opts.max);
    const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean);
    const isPull = !!issue.pull_request;
    const state = isPull && issue.pull_request?.merged_at ? "merged" : issue.state ?? "";
    return {
      thread: threadId(ref),
      link: t.link,
      conversation: { id: repoOf(ref), label: repoOf(ref), kind: "ticket" },
      title: issue.title,
      fields: {
        type: isPull ? "pull request" : "issue",
        state,
        author: issue.user?.login ?? "ghost",
        ...(issue.assignees?.length ? { assignees: issue.assignees.map((a) => a.login).join(", ") } : {}),
        ...(labels.length ? { labels: labels.join(", ") } : {}),
      },
      items: kept.map((i) => ({ id: i.id, author: i.author.name, time: i.time, text: i.text, link: i.link })),
      complete: allPages && kept.length === all.length,
      fetchedAt: Date.now(),
    };
  },

  /** A comment on an issue or a pull request, only ever called by Strato's gate after the person's Go on this exact text. */
  async act(ctx, input: ActInput): Promise<ActResult> {
    const a = input.action;
    if (a.kind !== "comment") return { ok: false, error: failure("unsupported", `${a.kind} is not supported on GitHub`, { outcome: "none" }) };
    const ref = parseThread(a.target.native);
    if (!ref) return { ok: false, error: failure("bad_target", `${a.target.native}: write owner/repo#number`, { outcome: "none" }) };
    if (!a.text.trim()) return { ok: false, error: failure("empty", "the comment is empty", { outcome: "none" }) };
    if (a.text.length > MAX_TEXT) return { ok: false, error: failure("too_long", `the comment is longer than ${MAX_TEXT} characters`, { outcome: "none" }) };
    if (input.dryRun) {
      // a read only: the issue exists and the token sees it
      try {
        const issue = (await call(ctx, "GET", `${repoPath(ref)}/issues/${ref.number}`)).body as GhIssue;
        return { ok: true, ref: "", link: webLink(issue.html_url, issueUrl(ref)), dry: `comment on ${threadId(ref)}${issue.locked ? " (locked)" : ""}` };
      } catch (e) {
        return { ok: false, error: { ...(e as ProviderError), outcome: "none" } };
      }
    }
    let c: { id?: number; html_url?: string };
    try {
      c = (await call(ctx, "POST", `${repoPath(ref)}/issues/${ref.number}/comments`, { body: a.text })).body;
    } catch (e) {
      const err = e as ProviderError;
      // GitHub answered with a refusal: nothing was written. A timeout or a 5xx leaves the outcome unknown.
      const refused = err.code !== "network" && !err.retryable;
      return { ok: false, error: { ...err, outcome: refused || err.code === "rate_limited" ? "none" : "unknown" } };
    }
    if (typeof c?.id !== "number") return { ok: false, error: failure("http", "GitHub did not return the comment it created", { outcome: "unknown" }) };
    return {
      ok: true,
      ref: String(c.id),
      link: webLink(c.html_url, `${issueUrl(ref)}#issuecomment-${c.id}`),
      undo: { token: `${repoOf(ref)}:${c.id}`, until: Date.now() + UNDO_MS },
    };
  },

  /** Deletes the comment `act` created. */
  async undo(ctx, token): Promise<ActResult> {
    const u = parseUndo(token);
    if (!u) return { ok: false, error: failure("bad_token", "not an undo token of this provider", { outcome: "none" }) };
    try {
      await call(ctx, "DELETE", `${repoPath(u.ref)}/issues/comments/${u.comment}`);
    } catch (e) {
      const err = e as ProviderError;
      return { ok: false, error: { ...err, outcome: err.code === "network" || err.retryable ? "unknown" : "none" } };
    }
    return { ok: true, ref: u.comment, link: `https://${WEB}/${u.ref.owner}/${u.ref.repo}` };
  },

  parseTarget(raw, topic): Target | { error: { en: string; fr: string }; label?: string } {
    const ref = targetOf(raw, topic);
    if (!ref) return { error: text("Write the issue or pull request as owner/repo#number.", "Écrivez l'issue ou la pull request sous la forme owner/repo#numéro."), label: raw.slice(0, 80) };
    return { scope: "ticket", native: threadId(ref), label: threadId(ref), link: issueUrl(ref) };
  },
};

export default provider;
