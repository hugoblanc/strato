import { keyFromPermalink } from "../chat/slack-model.ts";
import { settings } from "./settings.ts";

/**
 * Topic keys. Two kinds, and this is the only place that tells them apart:
 * - a chat thread: `channel:ts` (ts of the root message);
 * - a ticket: `linear:ABC-123`.
 * The format is the one of the state on disk (sujets.json, seen.json, events.ndjson): it does not change.
 */

const TICKET_PREFIX = "linear:";

export const isTicketKey = (key: string): boolean => key.startsWith(TICKET_PREFIX);

export const ticketKey = (id: string): string => `${TICKET_PREFIX}${id}`;

/** The ticket id of a ticket key, else null. */
export function ticketIdOfKey(key: string): string | null {
  return isTicketKey(key) ? key.slice(TICKET_PREFIX.length) : null;
}

/** Channel and ts of a thread key, else null. */
export function threadOfKey(key: string): { channel: string; ts: string } | null {
  if (isTicketKey(key)) return null;
  const [channel, ts] = key.split(":");
  return channel && ts ? { channel, ts } : null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Pattern of a ticket id from the tracker's prefixes, or null without a tracker. */
export function ticketPattern(flags = ""): RegExp | null {
  const prefixes = settings().tracker?.prefixes ?? [];
  if (!prefixes.length) return null;
  return new RegExp(`\\b(?:${prefixes.map(escapeRe).join("|")})-\\d+\\b`, flags);
}

/** Ticket id (ABC-123, OPS-42) in a link or a text, upper-cased. */
export function linearIssueId(ref: string): string | null {
  const m = ref.match(ticketPattern("i") ?? /(?!)/);
  return m ? m[0].toUpperCase() : null;
}

/** Link of a ticket, or null without a tracker. */
export function ticketUrl(id: string): string | null {
  const t = settings().tracker;
  return t ? `https://linear.app/${t.workspace}/issue/${id}` : null;
}

/** Host of ticket links, for the list of links the panel may open. */
export const TRACKER_HOST = "linear.app";

/** Key of a thread or a ticket: `channel:ts` for a Slack thread, `linear:ABC-123` for a ticket. */
export function sujetKey(ref: string): string | null {
  if (isTicketKey(ref)) return ref;
  const slack = keyFromPermalink(ref);
  if (slack) return slack;
  const issue = linearIssueId(ref);
  return issue ? ticketKey(issue) : null;
}

/** Slack thread key -> link of the root message; ticket key -> link of the ticket. */
export function permalinkOfKey(key: string, workspace = settings().slack.workspace): string | null {
  const slackKey = key.match(/^([A-Z0-9]+):(\d{10})\.(\d{6})$/);
  if (slackKey) return workspace ? `https://${workspace}.slack.com/archives/${slackKey[1]}/p${slackKey[2]}${slackKey[3]}` : null;
  const id = ticketIdOfKey(key);
  const pattern = ticketPattern();
  return id && pattern && new RegExp(`^${pattern.source}$`).test(id) ? ticketUrl(id) : null;
}
