/**
 * The Slack provider: today's network code (app/slack.ts) behind the provider interface, without changing it.
 * app/slack.ts holds one token for the process, found in today's search order (`slack.userTokenFile`, the environment,
 * the workspace's `.claude/settings.local.json` and `.mcp.json`): this provider serves the default Slack account, and a
 * named Slack account is refused until ingest gives each account its own client.
 * Ingest (`poll`, `subscribe`) and writes (`act`, `undo`) join it in the ingest and act stages.
 */
import { bestText, channelLabel, type SlackMatch } from "../../chat/slack-model.ts";
import { linkOfNative } from "../../core/links.ts";
import { settings } from "../../core/settings.ts";
import { channelOf, connectSlack, NO_TOKEN, nameOf, participatedThreads, readable, repliesOf, slack, SlackError } from "../../app/slack.ts";
import { defineProvider } from "../api.ts";
import type { AccountContext, ConversationKind, ContextResult, Identity, ProviderError } from "../sdk.ts";
import { SLACK_DESCRIPTOR, slackDeepLink, slackParseTarget, slackRender } from "./model.ts";

/** A Slack failure as a provider error: Slack's own code, fatal when the token must be set up again. */
export function slackProviderError(e: unknown): ProviderError {
  if (e instanceof SlackError) return { code: e.code, message: e.message, retryable: !e.fatal, fatal: e.fatal };
  return { code: "network", message: (e as Error)?.message ?? String(e), retryable: true, fatal: false };
}

function defaultOnly(ctx: AccountContext): void {
  if (ctx.account.id !== "default") {
    throw { code: "unsupported_account", message: `Slack account "${ctx.account.id}": only the default Slack account (the "slack" section) is wired in this version`, retryable: false, fatal: true } satisfies ProviderError;
  }
}

const conversationKind = (c: { id: string; is_im?: boolean; is_mpim?: boolean }): ConversationKind => (c.is_im ? "dm" : c.is_mpim ? "group" : "channel");

export const slackProvider = defineProvider({
  descriptor: SLACK_DESCRIPTOR,

  async connect(ctx: AccountContext): Promise<Identity> {
    defaultOnly(ctx);
    const cfg = settings().slack;
    const r = await connectSlack(cfg);
    if (!r) throw { code: "invalid_auth", message: NO_TOKEN(cfg), retryable: false, fatal: true } satisfies ProviderError;
    let tenant: string | undefined;
    try {
      tenant = String((await slack("auth.test")).team_id ?? "") || undefined;
    } catch {}
    return { me: r.me, name: await nameOf(r.me), workspace: r.team, ...(tenant ? { tenant } : {}), groups: cfg.subteams };
  },

  async participated(ctx: AccountContext, days: number): Promise<string[]> {
    defaultOnly(ctx);
    try {
      return [...(await participatedThreads(settings().slack, days))];
    } catch (e) {
      throw slackProviderError(e);
    }
  },

  async context(ctx: AccountContext, thread: string, opts: { since?: number; max: number }): Promise<ContextResult> {
    defaultOnly(ctx);
    const [channel, ts] = thread.split(":");
    if (!channel || !ts) throw { code: "not_found", message: `not a Slack thread: ${thread}`, retryable: false, fatal: false } satisfies ProviderError;
    try {
      const extra: Record<string, string> = opts.since ? { oldest: String(Math.floor(opts.since / 1000)) } : {};
      const all = (await repliesOf(channel, ts, extra)) as (SlackMatch & { bot_profile?: { name?: string } })[];
      const kept = all.slice(-Math.max(1, opts.max));
      const c = await channelOf(channel);
      const items: ContextResult["items"] = [];
      for (const m of kept) {
        const author = m.user ? await nameOf(m.user) : m.username || m.bot_profile?.name || "bot";
        const link = linkOfNative("slack", ctx.account.id, `${channel}:${m.ts}`);
        items.push({ id: `${channel}:${m.ts}`, author, time: Math.round(Number(m.ts) * 1000), text: await readable(bestText({ ...m, channel: { id: channel } }), true), ...(link ? { link } : {}) });
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

  parseTarget: (text, topic) => slackParseTarget(text, topic),
  render: slackRender,
  deepLink: slackDeepLink,
});
