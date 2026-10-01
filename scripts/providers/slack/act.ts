/**
 * The Slack provider's writes: a reply in a thread, a separate message, a reaction, a deletion, and taking them back
 * within the undo window. Kept apart from the rest of the provider on purpose: only the registry imports this module,
 * and only app/act.ts, behind the gate, reaches what it exports (docs/design/providers.md, section 8.2).
 */
import { connectSlack, NO_TOKEN, SlackError } from "../../app/slack.ts";
import { permalinkFor } from "../../chat/slack-model.ts";
import { linkOfNative } from "../../core/links.ts";
import { settings } from "../../core/settings.ts";
import type { AccountContext, ActInput, ActResult, Provider, ProviderError } from "../sdk.ts";
import { clientOf } from "./index.ts";
import { SLACK_DESCRIPTOR } from "./model.ts";

/**
 * A failed write. Slack answered with an error: nothing was written (`outcome: "none"`). Anything else (the network, a
 * timeout, an unreadable answer) after the write was sent may have written: `outcome: "unknown"`.
 */
function writeError(e: unknown, sent: boolean): ProviderError {
  if (e instanceof SlackError) return { code: e.code, message: e.message, retryable: !e.fatal, fatal: e.fatal, outcome: "none" };
  return { code: "network", message: (e as Error)?.message ?? String(e), retryable: true, fatal: false, outcome: sent ? "unknown" : "none" };
}

const failed = (error: ProviderError): ActResult => ({ ok: false, error });

/** `C…:ts` -> its channel and ts, or null. */
function split(native: string): { channel: string; ts: string } | null {
  const [channel, ts] = native.split(":");
  return channel && ts ? { channel, ts } : null;
}

/** The client of the account, with a token: the default account looks for one as the board always did. */
async function readyClient(ctx: AccountContext) {
  const client = clientOf(ctx);
  if (!client.token && ctx.account.id === "default") await connectSlack(settings().slack);
  return client.token ? client : null;
}

const undoUntil = () => Date.now() + (SLACK_DESCRIPTOR.undoMs ?? 0);

export const slackWrites: Required<Pick<Provider, "act" | "undo">> = {
  async act(ctx: AccountContext, input: ActInput): Promise<ActResult> {
    const a = input.action;
    if (input.dryRun) return { ok: true, ref: "", link: "", dry: `${a.kind} ${a.target.native}` };
    const client = await readyClient(ctx);
    if (!client) return failed({ code: "no_token", message: ctx.account.id === "default" ? NO_TOKEN(settings().slack) : `Slack account "${ctx.account.id}": no SLACK_USER_TOKEN in its secret file`, retryable: false, fatal: true, outcome: "none" });
    let sent = false;
    try {
      if (a.kind === "reply" || a.kind === "post") {
        const base = await client.workspaceUrl();
        const thread = a.kind === "reply" ? split(a.target.native) : null;
        if (a.kind === "reply" && !thread) return failed({ code: "not_found", message: `not a Slack thread: ${a.target.native}`, retryable: false, fatal: false, outcome: "none" });
        const channel = thread ? thread.channel : a.target.native;
        // the quoted link may point at a reply: go up to the thread's root, otherwise Slack refuses or posts beside it
        let root: string | null = thread?.ts ?? null;
        if (thread) {
          try {
            const r = await client.call("conversations.replies", { channel, ts: thread.ts, limit: 1 });
            root = r.messages?.[0]?.thread_ts ?? thread.ts;
          } catch {}
        }
        sent = true;
        const r = await client.post("chat.postMessage", root ? { channel, thread_ts: root, text: a.text } : { channel, text: a.text });
        return { ok: true, ref: `${channel}:${r.ts}`, link: permalinkFor(base, channel, r.ts, root), undo: { token: `message:${channel}:${r.ts}`, until: undoUntil() } };
      }
      const item = split(a.target.native);
      if (!item) return failed({ code: "not_found", message: `not a Slack message: ${a.target.native}`, retryable: false, fatal: false, outcome: "none" });
      const link = linkOfNative("slack", ctx.account.id, a.target.native) ?? "";
      if (a.kind === "react") {
        sent = true;
        try {
          await client.post("reactions.add", { channel: item.channel, timestamp: item.ts, name: a.emoji });
        } catch (e) {
          // already added by hand: that is the intended result, and there is nothing of ours to take back
          if (e instanceof SlackError && e.code === "already_reacted") return { ok: true, ref: a.target.native, link };
          throw e;
        }
        return { ok: true, ref: a.target.native, link, undo: { token: `reaction:${item.channel}:${item.ts}:${a.emoji}`, until: undoUntil() } };
      }
      if (a.kind === "delete") {
        sent = true;
        await client.post("chat.delete", { channel: item.channel, ts: item.ts });
        return { ok: true, ref: a.target.native, link };
      }
      return failed({ code: "unsupported", message: `Slack cannot ${a.kind}`, retryable: false, fatal: false, outcome: "none" });
    } catch (e) {
      return failed(writeError(e, sent));
    }
  },

  /** Takes back a message (`chat.delete`) or a reaction (`reactions.remove`), from the token `act` returned. */
  async undo(ctx: AccountContext, token: string): Promise<ActResult> {
    const m = token.match(/^(message|reaction):([A-Z0-9]+):(\d+\.\d+)(?::([a-z0-9_+-]+))?$/);
    if (!m || (m[1] === "reaction" && !m[4])) return failed({ code: "bad_token", message: `not a Slack undo token: ${token}`, retryable: false, fatal: false, outcome: "none" });
    const client = await readyClient(ctx);
    if (!client) return failed({ code: "no_token", message: NO_TOKEN(settings().slack), retryable: false, fatal: true, outcome: "none" });
    try {
      if (m[1] === "message") await client.post("chat.delete", { channel: m[2], ts: m[3] });
      else await client.post("reactions.remove", { channel: m[2], timestamp: m[3], name: m[4] });
      return { ok: true, ref: `${m[2]}:${m[3]}`, link: "" };
    } catch (e) {
      return failed(writeError(e, true));
    }
  },
};
