/**
 * Triage of incoming items, the same for every provider (docs/design/providers.md, section 7): whether an item is
 * ignored, set aside for the digest, or raised to the master, and under which `<type>`. Pure: the facts come from the
 * provider on each item (`Item`), the rules from the account's settings that declare a triage role.
 */
import type { Item, SettingSpec } from "../providers/sdk.ts";

/**
 * suite/moi ("follow-up"/"me"): thread of a tracked topic. dm/mention/canal/fil ("channel"/"thread"): outside a
 * topic, raised to the master. tiers ("third party"): explicitly targets someone else. bot: an author from
 * `ignoreAuthors`. These last two go to the digest. Stored values, written to events.ndjson: never rename them.
 */
export type Kind = "suite" | "moi" | "dm" | "mention" | "canal" | "fil" | "tiers" | "bot";

/** What triage reads from an account's settings. */
export interface TriageRules {
  /** Conversations where every item is a request (Slack watchChannels, Linear watchTeams). */
  watch: string[];
  /** Conversations never raised. */
  ignore: string[];
  /** Display names whose items outside a topic go to the digest (bots). */
  ignoreAuthors: string[];
  /** Display names of the teammates: one of them answering takes the topic over. */
  teammates: string[];
}

export const NO_RULES: TriageRules = { watch: [], ignore: [], ignoreAuthors: [], teammates: [] };

/** Labels that do not go to stdout: logged as `info` for the digest. */
export function isSilent(kind: Kind | null): boolean {
  return kind === "tiers" || kind === "bot";
}

/** The author is one of `ignoreAuthors`, compared without case nor surrounding spaces. */
export function authorIgnored(author: string, ignoreAuthors: string[] | undefined): boolean {
  const a = author.trim().toLowerCase();
  return (ignoreAuthors ?? []).some((x) => x.trim().toLowerCase() === a);
}

/**
 * Should this item be raised to the master, and under which label? `key` is the key of its thread; `tracked` = all
 * the keys of known topics; `participated` = keys of threads where the person served wrote recently (an answer
 * without a mention there is often the one they wait for). null = ignored silently.
 * The rules' `ignoreAuthors` turn a kept item into `bot`: triage first runs without them, so that a provider reads the
 * author's name only for an item it keeps (`Provider.complete`).
 */
export function classifyItem(item: Item, key: string, rules: TriageRules, tracked: Set<string>, participated: Set<string>): Kind | null {
  const own = item.author.isMe;
  if (tracked.has(key)) return own ? "moi" : "suite";
  if (own) return null;
  // a status change says nothing to the person outside a topic that follows it
  if (item.event === "status") return null;
  if (rules.ignore.includes(item.conversation.id)) return null;
  const kind = untrackedKind(item, key, rules, participated);
  if (kind && authorIgnored(item.author.name, rules.ignoreAuthors)) return "bot";
  return kind;
}

function untrackedKind(item: Item, key: string, rules: TriageRules, participated: Set<string>): Kind | null {
  const elsewhere = item.targetsOther;
  if (item.conversation.kind === "dm") return "dm";
  if (item.conversation.kind === "group") return elsewhere ? "tiers" : "dm";
  if (item.mentionsMe) return "mention";
  if (rules.watch.includes(item.conversation.id)) return elsewhere ? "tiers" : "canal";
  if (participated.has(key)) return elsewhere ? "tiers" : "fil";
  return null;
}

/** The rules without `ignoreAuthors`: the first pass, before the author's name is read. */
export const withoutAuthors = (rules: TriageRules): TriageRules => ({ ...rules, ignoreAuthors: [] });

/**
 * An edit whose previous version was already raised (watched channel, tracked thread, DM): one line per message, so
 * the edit stays silent. An edit that adds a mention to a message triage ignored comes out, even though the
 * original is already marked as read.
 */
export function editAlreadyRaised(item: Item, key: string, rules: TriageRules, tracked: Set<string>, participated: Set<string>): boolean {
  if (!item.edited) return false;
  const { edited: _, ...rest } = item;
  const before = classifyItem({ ...rest, ...item.edited.before }, key, withoutAuthors(rules), tracked, participated);
  return before !== null && !isSilent(before);
}

/**
 * The rules of an account, from the settings its provider declares with a triage role (section 7.2): the same for
 * built-in and external providers. A setting that is not a list of strings counts as empty.
 */
export function triageRules(settings: Record<string, unknown>, specs: Pick<SettingSpec, "key" | "triage">[]): TriageRules {
  const list = (role: SettingSpec["triage"]) =>
    specs
      .filter((s) => s.triage === role)
      .flatMap((s) => {
        const v = settings[s.key];
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
      });
  return { watch: list("watch"), ignore: list("ignore"), ignoreAuthors: list("ignoreAuthors"), teammates: list("teammates") };
}

/**
 * Message events in events.ndjson: `"slack"` for every Slack account (the type older versions wrote, still read by the
 * board, the card sweep and the takeover), `"item"` for every other provider. Every reader goes through this.
 */
export const ITEM_EVENT_TYPES = ["slack", "item"] as const;

export const isItemEvent = (e: { type?: string }): boolean => (ITEM_EVENT_TYPES as readonly string[]).includes(e.type ?? "");

/** The event type an item of this provider is logged under. */
export const itemEventType = (provider: string): (typeof ITEM_EVENT_TYPES)[number] => (provider === "slack" ? "slack" : "item");
