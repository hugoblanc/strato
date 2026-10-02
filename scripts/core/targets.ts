/**
 * Targets, rendering and the words of threads through the providers' pure parts (docs/design/providers.md, sections
 * 4.6, 4.10 and 8.3). A task's destination becomes a typed target here, from a typed `to` key or from a legacy
 * free-text `draftTo` read by the provider that recognizes it; the board, the panel and the gate resolve it the same
 * way, so what the board shows is what the gate acts on.
 *
 * Pure: the providers' pure parts are installed at startup with their descriptors (core/links.ts `useProviders`).
 */
import type { Identity, RenderNames, Target } from "../providers/sdk.ts";
import { t } from "./i18n.ts";
import { parseKey } from "./keys.ts";
import { descriptorOf, linkAccount, linkOfNative, parseLink, providerDescriptors, providerLabel, pureOf, textOf } from "./links.ts";
import type { Sujet } from "./sujet.ts";
import type { Task } from "./tasks.ts";

/** A destination resolved: the account it goes through and the target on it. */
export interface ResolvedTarget {
  provider: string;
  account: string;
  target: Target;
}

/** A destination that cannot be acted on: why, and the words the board still shows for it. */
export interface UnresolvedTarget {
  error: string;
  label: string;
  /** The tool the destination was read by, if any: its markup still renders the draft. */
  provider: string | null;
  /** No connected tool serves it: the key names a tool or an account the profile does not have, or none reads it. */
  noTool?: boolean;
}

export const isResolved = (r: ResolvedTarget | UnresolvedTarget): r is ResolvedTarget => "target" in r;

/** The topic as a provider reads it: its account, its native thread id, its conversation's id and label. */
interface TopicView {
  provider: string;
  account: string;
  native: string;
  conversation: { id: string; label: string };
}

function topicView(s: Pick<Sujet, "key" | "channel" | "conversation">): TopicView | null {
  const p = parseKey(s.key);
  if (!p || p.long) return null;
  const id = pureOf(p.provider)?.threadInfo?.(p.native)?.conversation ?? (s.conversation ? (parseKey(s.conversation)?.native ?? "") : "");
  return { provider: p.provider, account: p.account, native: p.native, conversation: { id, label: s.channel } };
}

/**
 * Who reads a free-text destination: the account of a link in it when that link belongs to another account than the
 * topic's; else the topic's own account; else, for a topic whose tool reads no destination (a ticket topic, a tool
 * without targets), the default account of the first installed tool that does, as a draft of a ticket topic always
 * went to Slack.
 */
function readerOf(text: string, topic: TopicView | null): { provider: string; account: string } | null {
  const link = text ? parseLink(text) : null;
  if (link && (!topic || link.provider !== topic.provider || link.account !== topic.account)) return { provider: link.provider, account: link.account };
  if (topic && pureOf(topic.provider)?.parseTarget && linkAccount(topic.provider, topic.account)) return { provider: topic.provider, account: topic.account };
  const first = providerDescriptors().find((d) => pureOf(d.id)?.parseTarget && linkAccount(d.id, "default"));
  return first ? { provider: first.id, account: "default" } : null;
}

/**
 * The tool that reads a topic's free-text destinations when nothing in the text names another one: the topic's own
 * tool when it reads destinations, else the default account of the first installed tool that does. The prompts give
 * sessions that tool's destination format, so a draft is written the way the board will read it.
 */
export function draftReaderOf(key: string | null): string | null {
  return readerOf("", key ? topicView({ key, channel: "" }) : null)?.provider ?? null;
}

/**
 * A typed `to` key to a target: a thread when its tool reads it as one, a ticket for a tracker, else a conversation
 * (a separate message). Only a configured account is a target.
 */
function typedTarget(to: string, topic: TopicView | null, channel: string): ResolvedTarget | UnresolvedTarget {
  const p = parseKey(to);
  if (!p || p.long) return { error: t("target.notAKey", { to }), label: to, provider: null };
  if (!linkAccount(p.provider, p.account)) return { error: t("target.noAccount", { tool: toolLabel(p.provider, p.account) }), label: to, provider: p.provider, noTool: true };
  const info = pureOf(p.provider)?.threadInfo?.(p.native) ?? null;
  const sameConversation = !!info && !!topic && topic.provider === p.provider && topic.account === p.account && info.conversation === topic.conversation.id;
  const scope: Target["scope"] = info ? "thread" : descriptorOf(p.provider)?.kinds.includes("tracker") ? "ticket" : "conversation";
  const label = info ? (sameConversation ? channel : info.conversation) : p.native;
  return { provider: p.provider, account: p.account, target: { scope, native: p.native, label } };
}

/**
 * Where a task's message goes: its typed `to` key, else its free-text `draftTo` read by the provider that recognizes it
 * (legacy strings keep their meaning: a Slack link, a channel id and "new message", else the topic's own thread).
 */
export function resolveTarget(s: Pick<Sujet, "key" | "channel" | "conversation">, x: Pick<Task, "to" | "draftTo">): ResolvedTarget | UnresolvedTarget {
  const topic = topicView(s);
  const to = (x.to ?? "").trim();
  if (to) return typedTarget(to, topic, s.channel);
  const text = (x.draftTo ?? "").trim();
  const reader = readerOf(text, topic);
  const parse = reader ? pureOf(reader.provider)?.parseTarget : undefined;
  const account = reader ? linkAccount(reader.provider, reader.account) : null;
  if (!reader || !parse || !account) return { error: t("target.noReader"), label: text || s.channel, provider: topic?.provider ?? null, noTool: true };
  const r = parse(text, { thread: topic?.native ?? s.key, conversation: topic?.conversation ?? { id: "", label: s.channel } }, account);
  if ("error" in r) return { error: textOf(r.error), label: r.label ?? (text || s.channel), provider: reader.provider };
  return { provider: reader.provider, account: reader.account, target: r };
}

/** The link of a resolved target (the thread, the channel), from the account's link patterns, or null. */
export const targetLink = (r: ResolvedTarget): string | null => r.target.link ?? linkOfNative(r.provider, r.account, r.target.native);

/** The longest text one action of this tool may carry, or null when it says nothing. */
export const maxTextOf = (provider: string): number | null => descriptorOf(provider)?.maxText ?? null;

/** A tool and its account as the board names them: "Slack", "Slack (partners)". */
export const toolLabel = (provider: string, account: string): string => `${providerLabel(provider)}${account === "default" ? "" : ` (${account})`}`;

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** A text in a tool's markup, as safe HTML for the board: the provider's rendering, else the text escaped. */
export function renderHtml(provider: string | null, text: string, names?: RenderNames): string {
  const render = provider ? pureOf(provider)?.render : undefined;
  return render ? render.html(text, names) : escapeHtml(text);
}

/** The tool whose markup a key's text is written in, or null. */
export const providerOfKey = (key: string): string | null => parseKey(key)?.provider ?? null;

/**
 * What a key's native thread id says by itself, through its tool: the conversation's id and the time of the thread,
 * with the tool's name ("Slack", "Slack (partners)"). Null for a key whose tool reads nothing from its ids (a ticket).
 */
export function threadInfoOfKey(key: string): { provider: string; account: string; tool: string; conversation: string; at?: number } | null {
  const p = parseKey(key);
  if (!p || p.long) return null;
  const info = pureOf(p.provider)?.threadInfo?.(p.native);
  return info ? { provider: p.provider, account: p.account, tool: toolLabel(p.provider, p.account), ...info } : null;
}

/** The deep link of an https link for the app of the tool that owns it, when that tool builds one. */
export function deepLinkOf(url: string, owner: { provider: string; account: string }, identity: Identity): string | null {
  const account = linkAccount(owner.provider, owner.account);
  const deep = pureOf(owner.provider)?.deepLink;
  return account && deep ? deep(url, account, identity) : null;
}
