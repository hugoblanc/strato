import { settings } from "./settings.ts";
import { t } from "./i18n.ts";
import { conversationOfKey, permalinkOfKey } from "./keys.ts";
import { parseSteps, type Sujet, sujetKeys, sujetsByKey, type Trigger } from "./sujet.ts";
import { openTasks, taskDraftText } from "./tasks.ts";
import { truncate, untrusted } from "./text.ts";

export interface ThreadDump {
  key: string;
  permalink: string;
  /** Readable channel name ("#sales", "DM"), when Slack gave it. */
  channel?: string;
  messages: { at: string; from: string; text: string }[];
}

/**
 * Dive sheet: what the person served reads next to the session to pick a topic up cold.
 */
export function diveMarkdown(s: Sujet, threads: ThreadDump[], report: string | null, generatedAt: string): string {
  const field = (label: string, value: string | undefined) => t("dive.field", { label, value: value?.trim() ? value.trim() : t("dive.notSet") });
  const gate = s.gate && s.gate !== "none" ? `/${s.gate}` : "";
  const lines = [
    `# ${s.letter} · ${s.title}`,
    "",
    t("dive.meta", { asker: s.asker, channel: s.channel, status: `${s.status}${gate}`, waiting: s.waiting ? t("dive.waiting", { who: s.waiting }) : "", updated: s.updatedAt, generated: generatedAt }),
    "",
    `## ${t("dive.card")}`,
    field(t("dive.ask"), s.ask || s.title),
    field(t("dive.why"), s.why),
    field(t("dive.proposal"), s.proposal || s.next),
    ...openTasks(s).map((x) => field(t("dive.task", { id: x.id, kind: x.kind }), [x.ask, x.proposal, x.action ? t("dive.onGo", { action: x.action }) : "", taskDraftText(x) ? t("dive.draftTo", { to: x.draftTo || "?", text: taskDraftText(x) }) : ""].filter(Boolean).join(" · "))),
    field(t("dive.unverified"), s.unverified),
    field(t("dive.summary"), s.summary),
    "",
    `## ${t("dive.threads")}`,
    ...sujetKeys(s).map((k) => `- ${permalinkOfKey(k) ?? k}`),
  ];
  for (const th of threads) {
    lines.push("", `## Thread ${th.permalink}`, "");
    if (!th.messages.length) lines.push(t("dive.noMessage"));
    for (const m of th.messages) lines.push(`[${m.at}] ${m.from} : ${m.text}`, "");
  }
  lines.push("", `## ${t("dive.report")}${s.report ? ` (${s.report})` : ""}`, "", report?.trim() || t("dive.noReport"));
  lines.push("", "## Session", "", `claude attach ${s.shortId ?? "?"}`);
  return `${lines.join("\n")}\n`;
}

/**
 * A message raised to the master. Outside a tracked topic, the open topics of the same conversation are listed to
 * help attach it: `d.conversation` names it (`conversationRef`), else the key does when it is a Slack thread. `msg` is
 * the id of the message kept in inbox/: the master passes it to `open` and `relay` (--msg) instead of copying the
 * text into a shell command, where a `$(…)` written by a third party would run.
 */
export function eventLine(kind: string, d: Trigger & { key: string; conversation?: string }, sujets: Sujet[], msg?: string): string {
  const sujet = sujetsByKey(sujets).get(d.key);
  const tag = sujet ? ` · topic ${sujet.letter} ${sujet.shortId ?? "?"} (${sujet.status})` : "";
  const conversation = d.conversation ?? conversationOfKey(d.key);
  const nearby = sujet || !conversation ? [] : sujets.filter((s) => s.status !== "closed" && conversationsOf(s).includes(conversation));
  const hint = nearby.length ? ` · open topics in this channel: ${nearby.map((s) => `${s.letter} « ${truncate(s.title, 40)} »`).join(", ")}` : "";
  return `[strato] ${kind} · ${untrusted(d.channel)} · ${untrusted(d.from)} · key=${d.key}${msg ? ` · msg=${msg}` : ""}${tag}${hint} · « ${untrusted(d.text)} » · ${d.permalink}`;
}

/** The conversations a topic's threads belong to: those its Slack keys name, and the one it was opened from. */
function conversationsOf(s: Sujet): string[] {
  return [...sujetKeys(s).map(conversationOfKey), s.conversation].filter((c): c is string => !!c);
}

// ------------------------------------------------------------------ cards

/** What the card waits for from the person served, between brackets: the gate, else the wait, else the status. */
export function gateLabel(s: Sujet): string {
  if (s.gate && s.gate !== "none") return s.gate;
  if (s.waiting) return `waiting on ${s.waiting}`;
  return s.status;
}

/** One line per topic in `gates`: `A · Peter (#requests) · <ask> → <proposal> · [draft]`. */
export function gateLine(s: Sujet): string {
  // what waits is the oldest open task; a topic without tasks falls back on its card
  const first = openTasks(s)[0];
  const ask = truncate(first?.ask || s.ask || s.title, 90);
  const proposal = truncate(first?.proposal || s.proposal || s.next || s.summary || "no proposal yet", 110);
  const more = openTasks(s).length > 1 ? ` (+${openTasks(s).length - 1})` : "";
  return `${s.letter} · ${s.asker} (${s.channel}) · ${ask} → ${proposal} · [${first ? first.kind : gateLabel(s)}${more}]`;
}

/** The detail of a card, for `card`: what it takes to say go or to dig deeper. */
export function cardLines(s: Sujet): string[] {
  const indent = (v: string) => v.replace(/\n/g, "\n    ");
  const lines = [
    gateLine(s),
    `why ${settings().owner.name} : ${s.why || "not set"}`,
    `unverified    : ${s.unverified || "not set"}`,
    ...(openTasks(s).length ? openTasks(s).map((x) => `task ${x.id.padEnd(9)}: ${x.kind} · ${indent(x.ask)}${x.action ? `\n    on go: ${indent(x.action)}` : ""}`) : ["tasks         : no open task"]),
    ...(s.blocker ? [`blocked on    : ${s.blocker}`] : []),
    ...(s.steps ? [`steps         :\n    ${parseSteps(s.steps).map((x) => `${x.state === "done" ? "✓" : x.state === "now" ? "◉" : "○"} ${x.text}`).join("\n    ")}`] : []),
    ...openTasks(s).filter((x) => taskDraftText(x)).flatMap((x) => [`draft ${x.id.padEnd(8)}: ${indent(taskDraftText(x))}`, `to            : ${x.draftTo || "destination not set"}`]),
  ];
  if (sujetKeys(s).length > 1) lines.push(`threads       : ${sujetKeys(s).join(", ")}`);
  lines.push(`report        : ${s.report || "no report"}`);
  lines.push(`session       : claude attach ${s.shortId ?? "?"}`);
  return lines;
}

// ------------------------------------------------------------------ digest

/** An `info` event of events.ndjson: a message set aside by `watch`. */
export interface InfoEvent {
  at: string;
  type?: string;
  kind?: string;
  key?: string;
  from?: string;
  channel?: string;
  text?: string;
  permalink?: string;
}

/** The messages set aside, grouped by channel, one line each. */
export function digestLines(events: InfoEvent[], timeOf: (iso: string) => string): string[] {
  if (!events.length) return ["nothing new"];
  const groups = new Map<string, InfoEvent[]>();
  for (const e of events) {
    const c = e.channel ?? "?";
    groups.set(c, [...(groups.get(c) ?? []), e]);
  }
  const lines: string[] = [];
  for (const [channel, items] of groups) {
    lines.push(`${channel} (${items.length}):`);
    for (const e of items) {
      const bot = e.kind === "bot" ? " (bot)" : "";
      lines.push(`  ${timeOf(e.at)} · ${e.from ?? "?"}${bot} · « ${truncate(e.text ?? "", 140)} » · ${e.permalink ?? "-"}`);
    }
  }
  return lines;
}
