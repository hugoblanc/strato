export interface Due {
  /** ISO, converted from local time. */
  at: string;
  text: string;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
function localStamp(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * The deadlines of a card, field `due`: entries separated by "|", in the local time of the person served.
 * Accepted formats: "18:00 text" or "18h text" (the day of writing), "demain 10:00 text" (French for tomorrow),
 * "30/09 10:00 text", "2026-09-30 10:00 text". `set` rewrites them all in the last format, so that a card read
 * the next day does not shift "18:00" by one day.
 */
export function normalizeDue(raw: string, now: Date): string {
  return raw
    .split("|")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => {
      const d = dueDate(e, now);
      return d ? `${localStamp(d.at)} ${d.text}`.trim() : e;
    })
    .join(" | ");
}

function dueDate(e: string, now: Date): { at: Date; text: string } | null {
  let m = e.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2})[:h](\d{2})?\s*(.*)$/);
  if (m) return { at: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +(m[5] ?? 0)), text: m[6] };
  m = e.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2})[:h](\d{2})?\s*(.*)$/);
  if (m) return { at: new Date(now.getFullYear(), +m[2] - 1, +m[1], +m[3], +(m[4] ?? 0)), text: m[5] };
  m = e.match(/^(demain|aujourd'hui|ce soir)?\s*(\d{1,2})[:h](\d{2})?\b\s*(.*)$/i);
  if (m && +m[2] < 24) {
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (m[1]?.toLowerCase() === "demain" ? 1 : 0), +m[2], +(m[3] ?? 0));
    return { at, text: m[4] };
  }
  return null;
}

/** The readable deadlines of an already normalized card, in order. An entry without a date is ignored. */
export function parseDue(raw: string | undefined): Due[] {
  if (!raw) return [];
  const out: Due[] = [];
  for (const e of raw.split("|").map((x) => x.trim())) {
    const m = e.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})\s*(.*)$/);
    if (!m) continue;
    out.push({ at: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).toISOString(), text: m[6] || "échéance" });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
