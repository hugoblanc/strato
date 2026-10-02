/**
 * HTML rendering of the Strato panel, shown in iTerm2's sidebar (toolbelt) by `serve`.
 * Pure: no disk, no network, tested in panel.test.ts. Standalone page: inline CSS and JS, no CDN.
 * The toolbelt's web view has no navigation delegate: a followed link would open inside the panel itself.
 * External links therefore go through POST /api/open, which opens them in the browser.
 * Every visible word goes through core/i18n.ts (keys `panel.*`).
 */
import { locale, openTasks, parseSteps, permalinkOfKey, providerKeyLabel, repoLabel, settings, sujetKeys, sujetsByKey, t, taskDraftText, threadInfoOfKey, ticketIdOfKey, isResolved, resolveTarget, targetLink, type Task, ticketUrl, type SessionContext, type Sujet, type ThreadDump } from "./lib.ts";

import { escapeHtml } from "./core/text.ts";

export { escapeHtml };

function externalLink(url: string, label: string): string {
  return `<a href="${escapeHtml(url)}" data-open>${escapeHtml(label)}</a>`;
}

/** Punctuation stuck to the end of a URL in a sentence, which is not part of it. */
const trimUrl = (url: string) => url.replace(/[.,;:!?)\]]+$/, "");

/** Plain text -> escaped HTML, clickable http(s) links. Line breaks are kept by the CSS (pre-wrap). */
export function textToHtml(raw: string): string {
  let html = "";
  let last = 0;
  for (const m of raw.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
    const url = trimUrl(m[0]);
    const at = m.index ?? 0;
    html += escapeHtml(raw.slice(last, at)) + externalLink(url, url);
    last = at + url.length;
  }
  return html + escapeHtml(raw.slice(last));
}

/** Inline Markdown: `code`, [label](url), **bold**, bare URL. */
export function inlineMarkdown(raw: string): string {
  let html = "";
  let last = 0;
  for (const m of raw.matchAll(/`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*\n]+)\*\*|(https?:\/\/[^\s<>"'`]+)/g)) {
    const at = m.index ?? 0;
    let token = m[0];
    let rendered: string;
    if (m[1] !== undefined) rendered = `<code>${escapeHtml(m[1])}</code>`;
    else if (m[2] !== undefined) rendered = externalLink(m[3], m[2]);
    else if (m[4] !== undefined) rendered = `<strong>${textToHtml(m[4])}</strong>`;
    else {
      token = trimUrl(m[0]);
      rendered = externalLink(token, token);
    }
    html += escapeHtml(raw.slice(last, at)) + rendered;
    last = at + token.length;
  }
  return html + escapeHtml(raw.slice(last));
}

const LIST_ITEM = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/;
const HR = /^\s*(---+|\*\*\*+|___+)\s*$/;

/**
 * The simple Markdown of reports: headings, paragraphs (one line per sentence, kept), lists, tables, code blocks,
 * quotes, rules. The rest goes through as escaped text.
 */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const startsBlock = (l: string) => l.startsWith("```") || /^#{1,6}\s/.test(l) || HR.test(l) || l.trimStart().startsWith("|") || l.startsWith(">") || LIST_ITEM.test(l);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      // h1 and h2 belong to the panel: the report's headings start at h3
      const level = Math.min(6, heading[1].length + 2);
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (line.trimStart().startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        const cells = lines[i].trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      if (head) {
        const tr = (cells: string[], tag: string) => `<tr>${cells.map((c) => `<${tag}>${inlineMarkdown(c)}</${tag}>`).join("")}</tr>`;
        out.push(`<div class="table"><table><thead>${tr(head, "th")}</thead><tbody>${body.map((r) => tr(r, "td")).join("")}</tbody></table></div>`);
      }
      continue;
    }
    if (line.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) body.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${markdownToHtml(body.join("\n"))}</blockquote>`);
      continue;
    }
    const first = line.match(LIST_ITEM);
    if (first) {
      const ordered = first[2] !== undefined;
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(LIST_ITEM);
        if (m && (m[2] !== undefined) === ordered) {
          items.push(m[3]);
          i++;
        } else if (!m && items.length && /^\s+\S/.test(lines[i])) {
          // indented line under an item: the rest of that item
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i++;
        } else break;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((it) => `<li>${inlineMarkdown(it)}</li>`).join("")}</${tag}>`);
      continue;
    }
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) para.push(lines[i++].trim());
    out.push(`<p>${para.map(inlineMarkdown).join("<br>")}</p>`);
  }
  return out.join("\n");
}

// ------------------------------------------------------------------ views

export interface PanelContext {
  /** ISO -> short readable date ("15/09 13:44"), injected to keep the rendering pure. */
  timeOf: (iso: string) => string;
  /** Why the Slack threads could not be read, if so. */
  slackError?: string;
  /** When the shown threads were read (60 s cache). */
  threadsReadAt?: string;
  /** Sentence shown at the top of the list (no topic session in the foreground, topic not found). */
  note?: string;
}

/** Number of visible messages per thread; the older ones are folded. */
export const RECENT_MESSAGES = 12;

/** The card's status as stored (status/gate, protocol values), then who it waits on. */
function statusText(s: Sujet): string {
  const gate = s.gate && s.gate !== "none" ? `/${s.gate}` : "";
  return `${s.status}${gate}${s.waiting ? ` · ${t("panel.status.waiting", { who: s.waiting })}` : ""}`;
}

/**
 * Short label of a key: the topic's channel for the main thread, the channel id otherwise, the id for a ticket, the
 * tool and its native id for any other key.
 */
function keyLabel(key: string, s: Sujet, ctx: PanelContext): string {
  const ticket = ticketIdOfKey(key);
  if (ticket) return ticket;
  const thread = threadInfoOfKey(key);
  if (!thread) return providerKeyLabel(key);
  const when = thread.at ? ` · ${ctx.timeOf(new Date(thread.at).toISOString())}` : "";
  return `${thread.tool} ${key === s.key ? s.channel : thread.conversation}${when}`;
}

function topBar(): string {
  return `<nav class="bar"><span><a href="/?liste" data-nav>${t("panel.nav.all")}</a> · <a href="/board">${t("panel.nav.board")}</a></span><button type="button" data-refresh>${t("panel.nav.refresh")}</button></nav>`;
}

/** Label of a thread cited by a session: the channel's name when known, else its id, then the time of the root message. */
function threadLabel(key: string, channel: string | undefined, ctx: PanelContext): string {
  const thread = threadInfoOfKey(key);
  if (!thread) return providerKeyLabel(key);
  const when = thread.at ? ` · ${ctx.timeOf(new Date(thread.at).toISOString())}` : "";
  return `${thread.tool} ${channel ?? thread.conversation}${when}`;
}

/**
 * Where a draft goes, for the card. A typed target (`to`) is what the gate sends to, so it comes first, as its tool
 * names it, with its link; the session's words (`draftTo`) follow only as a description. Without one, the words.
 */
function destinationText(s: Sujet, x: Task): string | undefined {
  if (!x.to) return x.draftTo;
  const r = resolveTarget(s, x);
  const url = isResolved(r) ? targetLink(r) : null;
  const target = isResolved(r) ? (url ? `${r.target.label}, ${url}` : r.target.label) : x.to;
  const words = x.draftTo?.trim();
  return words ? `${target} (${words})` : target;
}

function messageItem(m: ThreadDump["messages"][number]): string {
  return `<li class="msg"><div class="msg-head"><span class="from">${escapeHtml(m.from)}</span><span class="at">${escapeHtml(m.at)}</span></div><div class="msg-text">${m.text.trim() ? textToHtml(m.text) : `<span class="muted">${t("panel.message.noText")}</span>`}</div></li>`;
}

/** "1 message" / "3 messages", in the profile's locale. */
const messages = (n: number) => t(n > 1 ? "panel.messages.other" : "panel.messages.one", { n });

/** A thread: its `limit` last messages; the older ones are folded (`foldOlder`) or only counted. `extra` goes into the heading. */
function threadSection(th: ThreadDump, label: string, opts: { limit: number; foldOlder: boolean; extra?: string }): string {
  const cut = Math.max(0, th.messages.length - opts.limit);
  const older = th.messages.slice(0, cut);
  const recent = th.messages.slice(cut);
  const many = older.length > 1;
  const olderBlock = !older.length
    ? ""
    : opts.foldOlder
      ? `<details class="older"><summary>${t(many ? "panel.messages.older.other" : "panel.messages.older.one", { n: older.length })}</summary><ul class="msgs">${older.map(messageItem).join("")}</ul></details>`
      : `<p class="muted small">${t(many ? "panel.messages.hidden.other" : "panel.messages.hidden.one", { n: older.length })}</p>`;
  const body = recent.length ? `<ul class="msgs">${recent.map(messageItem).join("")}</ul>` : `<p class="muted">${t("panel.thread.empty")}</p>`;
  return `<section><h2>${t("panel.thread.title")} ${externalLink(th.permalink, label)} <span class="count">· ${messages(th.messages.length)}</span>${opts.extra ?? ""}</h2>${olderBlock}${body}</section>`;
}

/** A topic's context: header, card, links, last messages of each thread, report. */
export function sujetView(s: Sujet, threads: ThreadDump[], report: string | null, ctx: PanelContext): string {
  const field = (label: string, value: string | undefined) =>
    `<dt>${label}</dt><dd>${value?.trim() ? textToHtml(value.trim()) : `<span class="muted">${t("panel.field.empty")}</span>`}</dd>`;
  const links = sujetKeys(s)
    .map((k) => {
      const url = permalinkOfKey(k);
      return `<li>${url ? externalLink(url, keyLabel(k, s, ctx)) : escapeHtml(k)}</li>`;
    })
    .join("");
  const slack = ctx.slackError ? `<p class="warn">${escapeHtml(ctx.slackError)}</p>` : "";
  const readAt = ctx.threadsReadAt && threads.length ? `<p class="muted small">${escapeHtml(t("panel.thread.readAt", { time: ctx.threadsReadAt }))}</p>` : "";
  const reportBlock = report?.trim()
    ? `<div class="md">${markdownToHtml(report)}</div>${s.report ? `<p class="muted small path">${escapeHtml(s.report)}</p>` : ""}`
    : `<p class="muted">${t("panel.report.none")}</p>`;
  return `<div class="view status-${escapeHtml(s.status)}" data-key="${escapeHtml(s.key)}">
${topBar()}
<header class="head">
<div class="title-row"><span class="letter">${escapeHtml(s.letter)}</span><h1>${escapeHtml(s.title)}</h1></div>
<div class="meta"><span class="badge">${escapeHtml(statusText(s))}</span><span>${escapeHtml(s.asker)} · ${escapeHtml(s.channel)}</span><span class="muted">${escapeHtml(t("panel.updated", { time: ctx.timeOf(s.updatedAt) }))}</span></div>
</header>
<section><h2>${t("panel.card")}</h2><dl>
${field(t("board.card.ask"), s.ask || s.title)}
${field(escapeHtml(t("board.card.why", { owner: settings().owner.name })), s.why)}
${field(t("board.card.proposal"), s.proposal || s.next)}
${openTasks(s).map((x) => field(t("panel.task", { id: escapeHtml(x.id) }), [x.ask, x.proposal, x.action ? t("panel.task.onGo", { action: x.action }) : ""].filter(Boolean).join("\n"))).join("")}
${s.steps ? field(t("board.card.plan"), parseSteps(s.steps).map((x) => `${x.state === "done" ? "✓" : x.state === "now" ? "◉" : "○"} ${x.text}`).join("\n")) : ""}
${s.blocker ? field(t("board.card.blocker"), s.blocker) : ""}
${openTasks(s).filter((x) => taskDraftText(x)).map((x) => field(t("panel.draft", { id: escapeHtml(x.id) }), taskDraftText(x)) + field(t("panel.draftTo"), destinationText(s, x))).join("")}
${field(t("board.card.unverified"), s.unverified)}
${field(t("board.card.summary"), s.summary)}
</dl></section>
<section><h2>${t("panel.links")}</h2><ul class="links">${links}</ul><p class="session"><code>claude attach ${escapeHtml(s.shortId ?? "?")}</code></p></section>
${slack}${threads.map((th) => threadSection(th, keyLabel(th.key, s, ctx), { limit: RECENT_MESSAGES, foldOlder: true })).join("\n")}${readAt}
<section><h2>${t("board.card.report")}</h2>${reportBlock}</section>
</div>`;
}

/** A clickable line of the topic list. */
function sujetRow(s: Sujet, ctx: PanelContext): string {
  return `<li><a class="row status-${escapeHtml(s.status)}" href="/?sujet=${encodeURIComponent(s.key)}" data-nav><span class="letter">${escapeHtml(s.letter)}</span><span class="row-body"><span class="row-title">${escapeHtml(s.title)}</span><span class="row-sub">${escapeHtml(statusText(s))} · ${escapeHtml(s.asker)} · ${escapeHtml(s.channel)} · ${escapeHtml(ctx.timeOf(s.updatedAt))}</span></span></a></li>`;
}

const byRecent = (a: Sujet, b: Sujet) => b.updatedAt.localeCompare(a.updatedAt);

/** Visible messages per Slack thread cited in a session's view. */
export const SESSION_THREAD_MESSAGES = 8;

export interface SessionViewInput {
  /** The session's name, already cleaned. */
  name: string;
  context: SessionContext;
  /** Slack threads read; a cited thread missing here shows as unread. */
  threads: ThreadDump[];
  sujets: Sujet[];
}

/**
 * The context of a Claude Code session that is not a topic: name, repo and branch, first request, the agent's last
 * message, cited Slack threads and tracker tickets, then the open topics, folded except for the master.
 */
export function sessionView(input: SessionViewInput, ctx: PanelContext): string {
  const c = input.context;
  const bySujetKey = sujetsByKey(input.sujets);
  const sujetLink = (key: string) => {
    const s = bySujetKey.get(key);
    return s ? ` <a href="/?sujet=${encodeURIComponent(s.key)}" data-nav>${t("panel.topicLink", { letter: escapeHtml(s.letter) })}</a>` : "";
  };
  const when = (at: string | null) => (at ? ` <span class="count">· ${escapeHtml(ctx.timeOf(at))}</span>` : "");
  const textBlock = (title: string, entry: { text: string; at: string | null } | null, empty: string) =>
    `<section><h2>${title}${entry ? when(entry.at) : ""}</h2>${entry ? `<div class="msg-text">${textToHtml(entry.text)}</div>` : `<p class="muted">${empty}</p>`}</section>`;
  const where = [c.cwd ? `<span>${escapeHtml(repoLabel(c.cwd))}</span>` : "", c.branch ? `<code>${escapeHtml(c.branch)}</code>` : ""].join("");
  const dumps = new Map(input.threads.map((th) => [th.key, th]));
  const threads = c.slackThreads
    .map((cited) => {
      const th = dumps.get(cited.key);
      if (th) return threadSection(th, threadLabel(cited.key, th.channel, ctx), { limit: SESSION_THREAD_MESSAGES, foldOlder: false, extra: sujetLink(cited.key) });
      const why = cited.workspace !== settings().slack.workspace ? t("panel.thread.otherWorkspace", { workspace: cited.workspace }) : (ctx.slackError ?? t("panel.thread.unread"));
      return `<section><h2>${t("panel.thread.title")} ${externalLink(cited.url, threadLabel(cited.key, undefined, ctx))}${sujetLink(cited.key)}</h2><p class="muted">${escapeHtml(why)}</p></section>`;
    })
    .join("\n");
  const readAt = ctx.threadsReadAt && input.threads.length ? `<p class="muted small">${escapeHtml(t("panel.thread.readAt", { time: ctx.threadsReadAt }))}</p>` : "";
  const tickets = c.linearIssues.length
    ? `<section><h2>${t("panel.tickets")}</h2><ul class="links">${c.linearIssues.map((id) => `<li>${externalLink(ticketUrl(id) ?? "#", id)}${sujetLink(`linear:${id}`)}</li>`).join("")}</ul></section>`
    : "";
  const open = input.sujets.filter((s) => s.status !== "closed").sort(byRecent);
  const list = `<section><details id="sujets-ouverts" class="sujets"${c.master ? " open" : ""}><summary>${t("panel.open.title")} <span class="count">${open.length}</span></summary><ul class="rows">${open.map((s) => sujetRow(s, ctx)).join("") || `<li class="muted empty">${t("panel.open.empty")}</li>`}</ul></details></section>`;
  return `<div class="view session" data-key="${escapeHtml(`session:${c.sessionId ?? ""}`)}">
${topBar()}
<header class="head">
<h1>${escapeHtml(input.name)}</h1>
<div class="meta">${c.master ? `<span class="badge">${t("panel.session.master")}</span>` : ""}${where}</div>
${c.sessionId ? `<p class="muted small">${t("panel.session.conversation")} <code>${escapeHtml(c.sessionId)}</code></p>` : ""}
</header>
${textBlock(t("panel.session.firstRequest"), c.firstRequest, t("panel.session.firstRequest.empty"))}
${textBlock(t("panel.session.lastAgent"), c.lastAgent, t("panel.session.lastAgent.empty"))}
${threads}${readAt}
${tickets}
${list}
</div>`;
}

/** The topic list: the open ones, newest first, then the closed ones folded. */
export function sujetListView(sujets: Sujet[], ctx: PanelContext): string {
  const open = sujets.filter((s) => s.status !== "closed").sort(byRecent);
  const closed = sujets.filter((s) => s.status === "closed").sort(byRecent);
  const row = (s: Sujet) => sujetRow(s, ctx);
  const closedBlock = closed.length
    ? `<details class="closed"><summary>${t(closed.length > 1 ? "panel.closed.other" : "panel.closed.one", { n: closed.length })}</summary><ul class="rows">${closed.map(row).join("")}</ul></details>`
    : "";
  return `<div class="view" data-key="">
${topBar()}
<header class="head"><h1>${t("panel.open.title")} <span class="count">${open.length}</span></h1>${ctx.note ? `<p class="muted">${escapeHtml(ctx.note)}</p>` : ""}</header>
<ul class="rows">${open.map(row).join("") || `<li class="muted empty">${t("panel.open.empty")}</li>`}</ul>
${closedBlock}
</div>`;
}

// ------------------------------------------------------------------ page

const CSS = `
:root{--bg:#fbfbfa;--fg:#1d1d1f;--muted:#6e6e73;--line:#e2e2de;--soft:#efefeb;--accent:#a8520c;--accent-bg:#fbeadb;--blue:#1f5fbf;--blue-bg:#e4edfa;--link:#1f5fbf;--warn:#9b2c1f;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#1e1e20;--fg:#e7e7ea;--muted:#9c9ca3;--line:#343437;--soft:#2a2a2d;--accent:#f0a35e;--accent-bg:#3b2a1b;--blue:#86b4ff;--blue-bg:#1c2a3f;--link:#8ab4ff;--warn:#ff8a7a}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{margin:0;background:var(--bg);color:var(--fg)}
body{font:13px/1.45 -apple-system,BlinkMacSystemFont,"Helvetica Neue",Helvetica,sans-serif;padding:10px 12px 48px;-webkit-font-smoothing:antialiased;overflow-wrap:anywhere}
a{color:var(--link);text-decoration:none}
a:hover{text-decoration:underline}
.bar{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px;font-size:12px}
.bar button{font:inherit;color:var(--muted);background:transparent;border:1px solid var(--line);border-radius:6px;padding:2px 8px;cursor:pointer}
.bar button:hover{color:var(--fg);border-color:var(--muted)}
.bar button:disabled{opacity:.5;cursor:default}
.title-row{display:flex;gap:8px;align-items:flex-start}
.letter{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;padding:0 5px;border-radius:6px;background:var(--soft);color:var(--fg);font-weight:700;font-size:12.5px}
.status-gate .letter{background:var(--accent);color:#fff}
.status-waiting .letter{background:var(--blue-bg);color:var(--blue)}
.status-closed .letter{color:var(--muted)}
h1{font-size:15px;line-height:1.3;margin:1px 0 0;font-weight:650}
.head h1 .count{font-size:13px}
.meta{display:flex;flex-wrap:wrap;gap:3px 8px;align-items:center;margin:7px 0 0;color:var(--muted);font-size:12px}
.badge{display:inline-block;padding:1px 7px;border-radius:999px;background:var(--soft);color:var(--fg);font-size:11.5px;font-weight:600}
.status-gate .badge{background:var(--accent-bg);color:var(--accent)}
.status-waiting .badge{background:var(--blue-bg);color:var(--blue)}
section{border-top:1px solid var(--line);margin-top:12px;padding-top:9px}
h2{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin:0 0 6px;font-weight:650}
h2 a,h2 .count{text-transform:none;letter-spacing:0;font-size:12px;font-weight:500}
.count{color:var(--muted);font-weight:400}
dl{margin:0}
dt{font-size:11.5px;color:var(--muted);margin-top:8px}
dt:first-child{margin-top:0}
dd{margin:1px 0 0;white-space:pre-wrap}
.muted{color:var(--muted)}
.small{font-size:11.5px}
.warn{color:var(--warn);margin:10px 0 0}
ul{margin:0;padding:0;list-style:none}
.links li{padding:1px 0}
.session{margin:6px 0 0}
code{font:11.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--soft);padding:1px 4px;border-radius:4px}
.msgs{display:flex;flex-direction:column;gap:9px}
.msg-head{display:flex;justify-content:space-between;gap:8px;font-size:12px}
.from{font-weight:600}
.at{color:var(--muted);font-variant-numeric:tabular-nums;flex:none}
.msg-text{white-space:pre-wrap}
details{margin-bottom:9px}
summary{cursor:pointer;color:var(--muted);font-size:12px}
details .msgs,details .rows{margin-top:8px}
.md{overflow-wrap:break-word}
.md p,.md ul,.md ol,.md pre,.md blockquote,.md .table{margin:0 0 8px}
.md ul{list-style:disc;padding-left:18px}
.md ol{list-style:decimal;padding-left:20px}
.md li{margin:1px 0}
.md h3,.md h4,.md h5,.md h6{margin:12px 0 4px;font-size:13px;font-weight:650}
.md h3{font-size:14px}
.md hr{border:0;border-top:1px solid var(--line);margin:10px 0}
.md pre{background:var(--soft);padding:8px;border-radius:6px;overflow-x:auto}
.md pre code{background:none;padding:0;white-space:pre}
.md blockquote{border-left:3px solid var(--line);padding-left:8px;color:var(--muted)}
.table{overflow-x:auto}
table{border-collapse:collapse;font-size:12px}
th,td{border:1px solid var(--line);padding:3px 6px;text-align:left;vertical-align:top;overflow-wrap:normal}
th{background:var(--soft)}
.path{margin:4px 0 0}
.rows{display:flex;flex-direction:column}
.row{display:flex;gap:8px;padding:7px 4px;border-bottom:1px solid var(--line);color:var(--fg)}
.row:hover{background:var(--soft);text-decoration:none}
.row-body{display:flex;flex-direction:column;min-width:0}
.row-title{font-weight:600}
.row-sub{color:var(--muted);font-size:12px}
.empty{padding:8px 0}
.head p{margin:6px 0 0}
.sujets{margin-bottom:0}
.sujets summary{font-size:11px;letter-spacing:.05em;text-transform:uppercase;font-weight:650}
.sujets summary .count{text-transform:none;letter-spacing:0}
#toast{position:fixed;left:12px;right:12px;bottom:10px;padding:6px 10px;border-radius:6px;background:var(--fg);color:var(--bg);font-size:12px}
`;

/** A string as a JavaScript literal that is safe inside a <script> element. */
const jsString = (s: string) => JSON.stringify(s).replace(/</g, "\\u003c");

/** The panel's script; its few visible words are written into it as JSON strings, in the profile's locale. */
const js = (serverDown: string, linkFailed: string) => `
(function () {
  var app = document.getElementById("app");
  var toast = document.getElementById("toast");
  var version = app.getAttribute("data-version");
  var timer;
  function flash(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(function () { toast.hidden = true; }, 2500);
  }
  function show(search, opts) {
    opts = opts || {};
    var y = window.scrollY;
    return fetch("/fragment" + search, { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
      .then(function (html) {
        // a foldable section opened or closed by the user stays so when the same view redraws
        var before = app.querySelector(".view");
        var beforeKey = before ? before.getAttribute("data-key") : null;
        var opened = {};
        app.querySelectorAll("details[id]").forEach(function (d) { opened[d.id] = d.open; });
        app.innerHTML = html;
        var after = app.querySelector(".view");
        if (after && after.getAttribute("data-key") === beforeKey) {
          app.querySelectorAll("details[id]").forEach(function (d) { if (d.id in opened) d.open = opened[d.id]; });
        }
        if (opts.push) history.pushState(null, "", "/" + search);
        window.scrollTo(0, opts.keepScroll ? y : 0);
      })
      .catch(function () { flash(${serverDown}); });
  }
  function currentSearch() {
    var q = new URLSearchParams(location.search);
    q.delete("refresh");
    var s = q.toString();
    return s ? "?" + s : "";
  }
  document.addEventListener("click", function (ev) {
    var el = ev.target instanceof Element ? ev.target : null;
    if (!el) return;
    var refresh = el.closest("[data-refresh]");
    if (refresh) {
      ev.preventDefault();
      refresh.disabled = true;
      var q = new URLSearchParams(currentSearch());
      q.set("refresh", "1");
      show("?" + q.toString(), { keepScroll: true });
      return;
    }
    var a = el.closest("a");
    if (!a) return;
    if (a.hasAttribute("data-nav")) {
      ev.preventDefault();
      show(new URL(a.href).search, { push: true });
      return;
    }
    if (/^https?:/.test(a.getAttribute("href") || "")) {
      ev.preventDefault();
      fetch("/api/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: a.href }) })
        .then(function (r) { if (!r.ok) flash(${linkFailed}); })
        .catch(function () { flash(${linkFailed}); });
    }
  });
  window.addEventListener("popstate", function () { show(currentSearch()); });
  // the board's tab does not follow the iTerm2 focus: only the panel does
  function onBoard() { return new URLSearchParams(location.search).has("board"); }
  // SSE stream, reopened after the Mac sleeps: the previous connection stays half open and silent.
  // The server sends a "ping" every 15 s; 40 s without anything, or a clock jump, and it reopens then redraws.
  var events = null, lastBeat = Date.now(), lastTickAt = Date.now();
  function connect() {
    if (events) { try { events.close(); } catch (e) {} }
    lastBeat = Date.now();
    events = new EventSource("/events");
    ["open", "ping", "hello", "focus", "update", "board"].forEach(function (n) { events.addEventListener(n, function () { lastBeat = Date.now(); }); });
    events.addEventListener("open", function () { show(currentSearch(), { keepScroll: true }); });
    events.addEventListener("hello", function (e) {
      var d = JSON.parse(e.data);
      if (d.version !== version) { version = d.version; if (!currentSearch()) show(""); }
    });
    events.addEventListener("focus", function (e) {
      version = JSON.parse(e.data).version;
      if (onBoard()) return;
      if (location.search) history.replaceState(null, "", "/");
      show("");
    });
    events.addEventListener("update", function () { show(currentSearch(), { keepScroll: true }); });
    events.addEventListener("board", function () { if (onBoard()) show(currentSearch(), { keepScroll: true }); });
  }
  connect();
  setInterval(function () {
    var now = Date.now(), slept = now - lastTickAt > 20000;
    lastTickAt = now;
    if (slept || now - lastBeat > 40000) connect();
  }, 5000);
  window.addEventListener("online", connect);
})();
`;

/** The whole page: `view` (sujetView, sujetListView or boardView) in a shell that follows the focus through SSE. `extraCss` is added for the board. */
export function panelPage(view: string, version: string, extraCss = ""): string {
  return `<!doctype html>
<html lang="${locale()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Strato</title>
<style>${CSS}${extraCss}</style>
</head>
<body>
<main id="app" data-version="${escapeHtml(version)}">${view}</main>
<div id="toast" role="status" hidden></div>
<script>${js(jsString(t("panel.js.serverDown")), jsString(t("panel.js.linkFailed")))}</script>
</body>
</html>
`;
}
