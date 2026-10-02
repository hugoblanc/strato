/**
 * What `strato context` prints (docs/design/providers.md, section 9): a thread read through its tool, as plain text a
 * session reads. Every string that comes from the tool is third-party text: it is flattened where it is one line,
 * neutralized (`untrusted`: no square bracket, no guillemet, so it can imitate neither a `[strato]` line nor a quote),
 * and every line of a message is indented, so no third party can start a line of this output.
 *
 * Pure: the command (commands/context.ts) reads the threads and prints these lines.
 */
import type { ContextResult } from "../providers/sdk.ts";
import { oneLine, untrusted } from "./text.ts";

/** One line of third-party text, safe to print. */
const safe = (s: string) => untrusted(oneLine(s)).trim();

/** "2026-10-02 10:42", local time. */
export function contextTime(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** What the command knows of a thread before reading it: its key, its tool's name, its link checked against the tool's hosts. */
export interface ContextHead {
  key: string;
  tool: string;
  /** The thread's link, already checked (core/links.ts `checkedLink`), or null. */
  link: string | null;
}

/**
 * What is wrong with a provider's answer to `context`, or null when it has the shape of a ContextResult. Checked before
 * anything renders it: an external provider's answer is whatever its process wrote. The detail names a field.
 */
export function contextProblem(r: unknown): string | null {
  const c = r as Partial<ContextResult> | null;
  if (!c || typeof c !== "object") return "not an object";
  if (!c.conversation || typeof c.conversation !== "object" || typeof c.conversation.label !== "string") return "conversation.label";
  if (c.title !== undefined && typeof c.title !== "string") return "title";
  if (c.fields !== undefined && (!c.fields || typeof c.fields !== "object" || Object.values(c.fields).some((v) => typeof v !== "string"))) return "fields";
  if (typeof c.complete !== "boolean") return "complete";
  if (!Array.isArray(c.items)) return "items";
  const bad = c.items.findIndex((x) => !x || typeof x.id !== "string" || typeof x.author !== "string" || typeof x.time !== "number" || typeof x.text !== "string");
  return bad >= 0 ? `items[${bad}]` : null;
}

/**
 * The lines of one thread: a header with the tool, the conversation, the title, the link and the key; the ticket's
 * fields; one block per item, oldest first, `[time] author: text`, the text's lines indented; a line when the read
 * stopped at its cap; an end line.
 */
export function contextLines(head: ContextHead, r: ContextResult, max: number): string[] {
  const title = r.title ? ` · ${safe(r.title)}` : "";
  const out = [`== ${safe(head.tool)} · ${safe(r.conversation.label) || "-"}${title} · ${head.link ?? "-"} · key=${head.key}`];
  const fields = Object.entries(r.fields ?? {}).map(([k, v]) => `${safe(k)}: ${safe(v)}`);
  if (fields.length) out.push(`fields: ${fields.join(" · ")}`);
  if (!r.complete) out.push(`(older items not shown: the read stopped at the ${max} most recent)`);
  for (const it of r.items) {
    const [first, ...rest] = untrusted(it.text).replace(/\r\n?/g, "\n").split("\n");
    out.push(`[${contextTime(it.time)}] ${safe(it.author) || "?"}: ${oneLine(first)}`);
    for (const line of rest) out.push(`  ${oneLine(line)}`);
  }
  if (!r.items.length) out.push("(no item)");
  out.push(`== end of ${head.key}`);
  return out;
}
