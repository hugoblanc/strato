/** The flow mode's sheet: `sel` opens a topic's detail, rendered by the focus mode's renderer, and its card keeps one line. */
import { afterEach, describe, expect, test } from "bun:test";
import { type BoardInput, boardPage, boardView, buildBoard, focusDetail, focusView } from "./board.ts";
import type { Sujet, Task } from "./lib.ts";
import { cleanupRigs, KEY, rig, startServe, sujet as rigSujet, writeSujets } from "./test-rig.ts";

afterEach(cleanupRigs);

const T = "2026-09-21T09:00:00Z";
const LINK = "https://acme.slack.com/archives/C0ACMEREQ01/p1788788755025729";
const task = (o: Partial<Task>): Task => ({ id: "t1", kind: "draft", ask: "Answer Ann on the deploy date", proposal: "", action: "post the draft", draft: "Monday 10:00.", draftTo: `#acme-requests, ${LINK}`, createdAt: T, updatedAt: T, status: "open", origin: "task", ...o });
const sujet = (o: Partial<Sujet>): Sujet => ({
  key: "C0ACMEREQ01:1788788755.025729",
  threads: ["C0ACMEREQ01:1788788755.025729"],
  letter: "A",
  title: "Deploy date",
  channel: "#acme-requests",
  permalink: LINK,
  asker: "Ann",
  sessionId: "sess-a",
  shortId: "053023ad",
  name: "A",
  status: "gate",
  gate: "draft",
  waiting: "",
  next: "",
  summary: "",
  createdAt: "2026-09-21T07:08:49Z",
  updatedAt: "2026-09-21T11:16:29Z",
  history: [],
  tasks: [task({})] as never,
  ...o,
});
const A = sujet({});
const B = sujet({ key: "C0ACMEREQ01:1788788999.000100", threads: ["C0ACMEREQ01:1788788999.000100"], letter: "B", title: "Refund for Zoé", tasks: [task({ kind: "decision", ask: "Refund Zoé?", proposal: "Yes.", draft: "", action: "" })] as never });
const timeOf = (iso: string) => iso.slice(11, 16);
const ctx = { timeOf, now: Date.parse("2026-09-21T12:00:00Z") };
const model = () => buildBoard({ sujets: [A, B], events: [], live: new Map(), running: new Map(), sessions: [], otherSessions: 0, now: new Date("2026-09-21T12:00:00Z"), timeOf } as BoardInput);
const ids = (html: string) => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);

describe("the sheet in the flow mode", () => {
  test("no sel, or a sel that is not an open topic: no sheet, every card whole, titles open the sheet", () => {
    for (const sel of [null, "C0NOPE:1.2"]) {
      const html = boardView(model(), ctx, sel);
      expect(html).not.toContain("data-sheet ");
      expect(html).not.toContain("data-in-sheet");
      expect(html).toContain(`data-sheet-open="${A.key}"`);
      expect(html).toContain(`data-sheet-open="${B.key}"`);
    }
  });
  test("sel: the sheet holds the focus mode's detail of that topic, as the focus mode renders it", () => {
    const m = model();
    const html = boardView(m, ctx, A.key);
    const line = m.attend.find((l) => l.sujet.key === A.key);
    expect(line).toBeDefined();
    const detail = focusDetail(line!, { ...ctx, now: ctx.now }, true);
    expect(html).toContain(detail);
    expect(html).toMatch(/<div id="sheet" data-sheet data-key="C0ACMEREQ01:1788788755\.025729" class="sheet">/);
    expect(html).toContain('role="dialog" aria-modal="true" aria-label="Deploy date"');
    // the detail's title is the plain link to the report, the card's title opens the sheet
    expect(detail).not.toContain("data-sheet-open");
    expect(detail).toContain(`href="/?sujet=${encodeURIComponent(A.key)}"`);
  });
  test("the card shown in the sheet keeps its place and first line, and no id or form exists twice", () => {
    const html = boardView(model(), ctx, A.key);
    const card = html.slice(html.indexOf(`id="line-${A.key}"`), html.indexOf("</li>", html.indexOf(`id="line-${A.key}"`)));
    expect(card).toContain(`data-row="card-${A.key}"`);
    expect(card).toContain(`data-sheet-open="${A.key}"`);
    expect(card).toContain("data-in-sheet");
    expect(card).not.toContain("data-draft");
    expect(card).not.toContain("data-send");
    const all = ids(html);
    expect(all.length).toBe(new Set(all).size);
    expect(html.match(/<form [^>]*data-draft /g)?.length).toBe(1);
    // the other card stays whole
    expect(html).toContain(`id="send-${B.key}"`);
  });
  test("the focus mode ignores the flow sheet", () => {
    const html = focusView(model(), ctx, A.key);
    expect(html).not.toContain('id="sheet"');
    expect(html).not.toContain("data-sheet-open");
  });
  test("the page ships the sheet's script and styles", () => {
    const page = boardPage("", "", "flow");
    expect(page).toContain("function openSheet(key)");
    expect(page).toContain(".sheet-panel {");
    expect(page).toContain("prefers-reduced-motion");
  });
});

describe("the sheet through serve", () => {
  test("GET /board/fragment?sel= and GET /board?sel= render the sheet of that topic; mode=focus does not", async () => {
    const r = rig();
    writeSujets(r, [rigSujet({ status: "gate", gate: "draft", tasks: [{ id: "t1", kind: "draft", ask: "Answer Ann", proposal: "", action: "post the draft", draft: "Monday.", draftTo: "", createdAt: T, updatedAt: T, status: "open", origin: "task" }] })]);
    const serve = await startServe(r);
    try {
      const get = (q: string) => fetch(`http://127.0.0.1:${serve.port}${q}`).then((x) => x.text());
      const frag = await get(`/board/fragment?sel=${encodeURIComponent(KEY)}`);
      expect(frag).toContain(`<div id="sheet" data-sheet data-key="${KEY}"`);
      expect(frag).toContain(`id="detail-${KEY}" data-detail`);
      expect(frag).toContain("data-in-sheet");
      const page = await get(`/board?sel=${encodeURIComponent(KEY)}`);
      expect(page).toContain(`<div id="sheet" data-sheet data-key="${KEY}"`);
      expect(await get("/board/fragment")).not.toContain('id="sheet"');
      expect(await get(`/board/fragment?mode=focus&sel=${encodeURIComponent(KEY)}`)).not.toContain('id="sheet"');
    } finally {
      await serve.stop();
    }
  });
});
