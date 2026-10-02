/**
 * The Slack provider: today's network code (app/slack.ts) behind the provider interface, without changing it.
 * Each account has its own client: the default account (the `slack` section) keeps the token found in today's search
 * order (`slack.userTokenFile`, the environment, the workspace's `.claude/settings.local.json` and `.mcp.json`) and the
 * names of users.json; a named account reads its tokens from its own secret file and goes through the fetch its
 * account context limits to Slack's API host. Writes (`act`, `undo`) join it in the act stage.
 */
import { appToken, appTokenRefusal, connexionSocket, defaultSlack, NO_TOKEN, probeSlack, REPLIES_MAX, SlackClient, SlackError } from "../../app/slack.ts";
import { bestText, channelLabel, conversationKind, nextSyncCursor, permalinkFor, slackItem, type SlackMatch } from "../../chat/slack-model.ts";
import { linkOfNative } from "../../core/links.ts";
import { settings } from "../../core/settings.ts";
import { slackWorkspaceFromUrl, tokenKindProblem } from "../../core/setup.ts";
import { truncate } from "../../core/text.ts";
import { defineProvider } from "../api.ts";
import type { AccountContext, ContextResult, Detected, Identity, IngestCursor, Item, PollResult, ProviderError } from "../sdk.ts";
import { SLACK_DESCRIPTOR, slackDeepLink, slackParseTarget, slackRender, slackThreadInfo } from "./model.ts";

/** A Slack failure as a provider error: Slack's own code, fatal when the token must be set up again. */
export function slackProviderError(e: unknown): ProviderError {
  if (e instanceof SlackError) return { code: e.code, message: e.message, retryable: !e.fatal, fatal: e.fatal };
  return { code: "network", message: (e as Error)?.message ?? String(e), retryable: true, fatal: false };
}

/** An error that may clear on the next try: network, timeout, rate limit, Slack-side outage. */
export function transientSlackError(e: unknown): boolean {
  if (!(e instanceof SlackError)) return true;
  return ["ratelimited", "internal_error", "fatal_error", "request_timeout", "service_unavailable"].includes(e.code);
}

/** The search index lags a minute or two behind the messages: each poll starts this far before its cursor. */
export const INDEX_LAG_SEC = 300;

const named = new Map<string, SlackClient>();

/**
 * The client of an account. A named account's token is read from its secret file at each call, so a token stored by
 * setup is picked up without a restart; its people's names are kept in its own folder.
 */
export function clientOf(ctx: AccountContext): SlackClient {
  if (ctx.verifying) {
    // setup's verify step: the candidate token, on a client that keeps nothing
    const c = new SlackClient(() => ctx.fetch, new Map(), () => {});
    c.token = ctx.secret("SLACK_USER_TOKEN") ?? "";
    return c;
  }
  if (ctx.account.id === "default") return defaultSlack;
  let c = named.get(ctx.account.id);
  if (!c) {
    const store = ctx.store;
    c = new SlackClient(() => ctx.fetch, new Map(Object.entries(store.read<Record<string, string>>("users", {}))), (u) => store.write("users", Object.fromEntries(u)));
    named.set(ctx.account.id, c);
  }
  c.token = ctx.secret("SLACK_USER_TOKEN") ?? "";
  return c;
}

/** Who the person is, as triage reads it: their id and their groups, from the identity the core gives. */
const cfgOf = (ctx: AccountContext) => ({ me: ctx.identity?.me ?? "", subteams: ctx.identity?.groups ?? [] });

const fail = (code: string, message: string, fatal = true): ProviderError => ({ code, message, retryable: !fatal, fatal });

/**
 * Setup's check of a candidate app-level token: Slack opens a Socket Mode connection URL for it (nothing is connected).
 * No token given is fine: the account is then polled.
 */
async function checkAppToken(ctx: AccountContext): Promise<void> {
  const xapp = ctx.secret("SLACK_APP_TOKEN");
  if (!xapp) return;
  if (!xapp.startsWith("xapp-")) throw fail("wrong_token_kind", "an App-Level Token starts with xapp- (Basic Information > App-Level Tokens, scope connections:write)");
  let refusal: string | null;
  try {
    refusal = await appTokenRefusal(xapp, ctx.fetch);
  } catch (e) {
    throw fail("network", `Slack unreachable: ${(e as Error).message}`, false);
  }
  if (refusal) throw fail(refusal, `Slack refuses the app-level token: ${refusal}${refusal === "missing_scope" ? " (it needs connections:write)" : ""}`);
}

export const slackProvider = defineProvider({
  descriptor: SLACK_DESCRIPTOR,

  /**
   * One auth.test, whose answer also gives the workspace's id and URL. The default account tries each token found once:
   * a network failure or a rate limit is a retryable error, and the caller decides how long to wait (`listen` alone
   * waits as `connectSlack` did; next to other accounts it retries without end); no usable token is fatal.
   */
  async connect(ctx: AccountContext): Promise<Identity> {
    const client = clientOf(ctx);
    const s = ctx.account.settings;
    let team: string;
    let me: string;
    let tenant: string | undefined;
    let url = "";
    if (ctx.account.id === "default" && !ctx.verifying) {
      const cfg = settings().slack;
      const p = await probeSlack(cfg);
      if (!p.found) throw p.transient ? fail(p.transient, `no answer (${p.transient})`, false) : fail("invalid_auth", NO_TOKEN(cfg));
      ({ team, me } = p.found);
      tenant = p.found.teamId;
      url = p.found.url ?? "";
    } else if (!client.token) {
      throw fail("invalid_auth", `Slack account "${ctx.account.id}": no SLACK_USER_TOKEN in its secret file`);
    } else if (ctx.verifying && tokenKindProblem(client.token)) {
      throw fail("wrong_token_kind", tokenKindProblem(client.token) as string);
    } else {
      let r: Record<string, unknown>;
      try {
        r = await client.call("auth.test");
      } catch (e) {
        throw slackProviderError(e);
      }
      team = String(r.team ?? "");
      me = String(r.user_id ?? "");
      tenant = String(r.team_id ?? "") || undefined;
      url = String(r.url ?? "").replace(/\/$/, "");
      if (typeof s.team === "string" && s.team && s.team !== team) throw fail("wrong_workspace", `Slack account "${ctx.account.id}": its token belongs to the workspace "${team}", not "${s.team}"`);
      if (ctx.verifying) await checkAppToken(ctx);
    }
    if (url) client.base = url;
    const groups = Array.isArray(s.subteams) ? s.subteams.filter((x): x is string => typeof x === "string") : [];
    return { me, name: await client.nameOf(me), workspace: team, ...(tenant ? { tenant } : {}), groups };
  },

  async poll(ctx: AccountContext, cursor: IngestCursor | null, opts: { since: number; maxItems: number }): Promise<PollResult> {
    const startedSec = Date.now() / 1000;
    const prev = cursor ? Number(cursor.value) : Number.NaN;
    // the cursor is the time up to which everything was surely read; the index lag is read again each time
    const sinceSec = Number.isFinite(prev) ? prev - INDEX_LAG_SEC : opts.since / 1000;
    let found: { matches: SlackMatch[]; complete: boolean };
    try {
      found = await clientOf(ctx).fetchSince(sinceSec, Math.max(1, Math.ceil(opts.maxItems / 100)));
    } catch (e) {
      throw slackProviderError(e);
    }
    const { matches, complete } = found;
    const next = nextSyncCursor(Number.isFinite(prev) ? prev : sinceSec, startedSec, { ok: true, complete, oldestReadSec: matches.length ? Number(matches[0].ts) : undefined });
    const cfg = cfgOf(ctx);
    return { items: matches.map((m) => slackItem(m, cfg)), cursor: { value: String(next), at: Math.round(next * 1000) }, complete };
  },

  async subscribe(ctx: AccountContext, onItems: (items: Item[]) => void, events?: { opened(): void; failed?(link: string, reason: string): void }) {
    const client = clientOf(ctx);
    const xapp = ctx.account.id === "default" ? appToken() : ctx.secret("SLACK_APP_TOKEN");
    if (!xapp) return { end: "fatal" as const, refused: "no app-level token (xapp-)" };
    let base: string;
    try {
      base = await client.workspaceUrl();
    } catch {
      return { end: "cut" as const };
    }
    const cfg = cfgOf(ctx);
    const socket: { ws: WebSocket | null } = { ws: null };
    const cut = () => {
      try {
        socket.ws?.close();
      } catch {}
    };
    ctx.signal.addEventListener("abort", cut);
    // events are read one at a time, in the order they came: a reply never overtakes its root
    let chain: Promise<void> = Promise.resolve();
    try {
      const r = await connexionSocket(
        xapp,
        (e) => {
          onItems([]);
          chain = chain.then(async () => {
            try {
              const m = await client.matchFromEvent(e, base, cfg);
              if (m) onItems([slackItem(m, cfg)]);
            } catch (err) {
              // never silently: the listener prints it for the master, who must know a message was not triaged
              const reason = (err as Error)?.message ?? String(err);
              if (events?.failed) events.failed(permalinkFor(base, String(e.channel ?? "?"), String(e.ts ?? "?"), e.thread_ts), reason);
              else ctx.log("error", `event ${String(e.channel ?? "?")}:${String(e.ts ?? "?")} unreadable: ${reason}`);
            }
          });
        },
        socket,
        { ...(ctx.account.id === "default" ? {} : { fetch: ctx.fetch }), onOpen: () => events?.opened() },
      );
      await chain;
      return { end: r.fin === "propre" ? ("clean" as const) : r.fin === "fatal" ? ("fatal" as const) : ("cut" as const), ...(r.retryAfterSec ? { retryAfterMs: r.retryAfterSec * 1000 } : {}), ...(r.refus ? { refused: r.refus } : {}) };
    } finally {
      ctx.signal.removeEventListener("abort", cut);
    }
  },

  async replies(ctx: AccountContext, thread: string, opts: { since: number; max: number }): Promise<Item[]> {
    const [channel, ts] = thread.split(":");
    if (!channel || !ts) throw fail("not_found", `not a Slack thread: ${thread}`, false);
    const client = clientOf(ctx);
    const sinceSec = opts.since / 1000;
    let messages: SlackMatch[];
    let base: string;
    try {
      messages = (await client.repliesOf(channel, ts, { oldest: String(sinceSec) })) as SlackMatch[];
      base = await client.workspaceUrl();
    } catch (e) {
      throw { ...slackProviderError(e), retryable: transientSlackError(e) } satisfies ProviderError;
    }
    const c = await client.channelOf(channel);
    const cfg = cfgOf(ctx);
    const kept = messages.filter((m) => m.ts && m.ts !== ts && Number(m.ts) >= sinceSec).slice(-Math.max(1, opts.max));
    return kept.map((m) => slackItem({ ...m, channel: c, permalink: permalinkFor(base, channel, m.ts, ts) }, cfg));
  },

  async complete(ctx: AccountContext, items: Item[]): Promise<Item[]> {
    const client = clientOf(ctx);
    const out: Item[] = [];
    for (const it of items) {
      const name = it.author.id ? await client.nameOf(it.author.id) : it.author.name;
      out.push({ ...it, author: { ...it.author, name }, text: truncate(await client.readable(it.text), 500) });
    }
    return out;
  },

  async participated(ctx: AccountContext, days: number): Promise<string[]> {
    try {
      return [...(await clientOf(ctx).participatedThreads(cfgOf(ctx), days))];
    } catch (e) {
      throw slackProviderError(e);
    }
  },

  async context(ctx: AccountContext, thread: string, opts: { since?: number; max: number }): Promise<ContextResult> {
    const [channel, ts] = thread.split(":");
    if (!channel || !ts) throw fail("not_found", `not a Slack thread: ${thread}`, false);
    const client = clientOf(ctx);
    try {
      const extra: Record<string, string> = opts.since ? { oldest: String(Math.floor(opts.since / 1000)) } : {};
      const all = (await client.repliesOf(channel, ts, extra)) as (SlackMatch & { bot_profile?: { name?: string } })[];
      const kept = all.slice(-Math.max(1, Math.min(opts.max, REPLIES_MAX)));
      const c = await client.channelOf(channel);
      const items: ContextResult["items"] = [];
      for (const m of kept) {
        const author = m.user ? await client.nameOf(m.user) : m.username || m.bot_profile?.name || "bot";
        const link = linkOfNative("slack", ctx.account.id, `${channel}:${m.ts}`);
        items.push({ id: `${channel}:${m.ts}`, author, time: Math.round(Number(m.ts) * 1000), text: await client.readable(bestText({ ...m, channel: { id: channel } }), true), ...(link ? { link } : {}) });
      }
      return {
        thread,
        link: linkOfNative("slack", ctx.account.id, thread) ?? "",
        conversation: { id: channel, label: channelLabel(c), kind: conversationKind(c) },
        items,
        complete: kept.length === all.length,
        fetchedAt: Date.now(),
      };
    } catch (e) {
      throw slackProviderError(e);
    }
  },

  setup: {
    /** Who and where, read from the account's token: what `setup --connect` writes into the profile. */
    async detect(ctx: AccountContext): Promise<Record<string, Detected>> {
      let r: Record<string, unknown>;
      try {
        r = await clientOf(ctx).call("auth.test");
      } catch (e) {
        throw slackProviderError(e);
      }
      const workspace = typeof r.url === "string" ? slackWorkspaceFromUrl(r.url) : null;
      return {
        team: { value: String(r.team ?? ""), source: "auth.test", confidence: "high" },
        ...(workspace ? { workspace: { value: workspace, source: "auth.test url", confidence: "high" as const } } : {}),
        me: { value: String(r.user_id ?? ""), source: "auth.test", confidence: "high" },
      };
    },
  },

  parseTarget: (text, topic) => slackParseTarget(text, topic),
  render: slackRender,
  threadInfo: slackThreadInfo,
  deepLink: slackDeepLink,
});
