/** The focus mode: the mode parameter, the list rows built from the CardView, and what one click may send from a row. */
import { describe, expect, test } from "bun:test";
import { type BoardInput, boardPage, buildBoard, classify, focusRow, focusView, modeOf, rowAction } from "./board.ts";
import type { Sujet, Task } from "./lib.ts";
import { cardTasks, PREVIEW_MAX, previewFits } from "./views/card.ts";

const LINK = "https://acme.slack.com/archives/C0ACMEREQ01/p1788788755025729";
const base: Sujet = {
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
};
const sujet = (o: Partial<Sujet>): Sujet => ({ ...base, ...o });
const task = (o: Partial<Task>): Task => ({
  id: "t1",
  kind: "draft",
  ask: "Ann asks for the deploy date",
  proposal: "",
  action: "post the draft",
  draft: "",
  draftTo: `#acme-requests, ${LINK}`,
  createdAt: "2026-09-21T09:00:00Z",
  updatedAt: "2026-09-21T09:00:00Z",
  status: "open",
  origin: "task",
  ...o,
});
const timeOf = (iso: string) => iso.slice(11, 16);
const ctx = { timeOf, now: Date.parse("2026-09-21T12:00:00Z") };
const input = (o: Partial<BoardInput>): BoardInput => ({ sujets: [], events: [], live: new Map(), running: new Map(), sessions: [], otherSessions: 0, now: new Date("2026-09-21T12:00:00Z"), timeOf, ...o });
const first = (s: Sujet) => cardTasks(s, ctx.now)[0];
const LONG = "Monday at 10:00, after the freeze. ".repeat(5).trim();

describe("the mode", () => {
  test("focus only when asked; anything else is the flow mode", () => {
    expect(modeOf(new URLSearchParams("mode=focus"))).toBe("focus");
    expect(modeOf(new URLSearchParams("mode=flow"))).toBe("flow");
    expect(modeOf(new URLSearchParams("mode=FOCUS"))).toBe("flow");
    expect(modeOf(new URLSearchParams(""))).toBe("flow");
  });
  test("the page carries the mode, the switch, and the full-width layout in focus", () => {
    const flow = boardPage("", "", "flow");
    expect(flow).toContain('data-mode="flow"');
    expect(flow).toMatch(/<a href="\/board\?mode=flow" data-mode-switch="flow" aria-current="page"/);
    expect(flow).toContain('<main id="app" class="mx-auto max-w-[1080px] px-5 pb-24 pt-8">');
    const focus = boardPage("", "", "focus");
    expect(focus).toMatch(/<a href="\/board\?mode=focus" data-mode-switch="focus" aria-current="page"/);
    expect(focus).toContain('<main id="app" class="w-full">');
    // a URL without mode follows the browser's memory; a URL with one wins
    expect(focus).toContain('localStorage.getItem("strato-mode") === "focus"');
  });
});

describe("what fits a row's preview", () => {
  test("two lines and the length limit at most", () => {
    expect(previewFits("Monday.")).toBe(true);
    expect(previewFits("a\nb")).toBe(true);
    expect(previewFits("a\nb\nc")).toBe(false);
    expect(previewFits("x".repeat(PREVIEW_MAX))).toBe(true);
    expect(previewFits("x".repeat(PREVIEW_MAX + 1))).toBe(false);
    expect(previewFits("  ")).toBe(false);
  });
});

describe("one click from a row", () => {
  test("a short draft: Send, on the same plan hash as the detail's form, with the raw text it posts", () => {
    const s = sujet({ tasks: [task({ draft: "Hi <@U0ANN00001>, Monday 10:00." })] as never });
    const a = rowAction(s, first(s));
    expect(a?.kind).toBe("post");
    expect(a?.text).toBe("Hi <@U0ANN00001>, Monday 10:00.");
    const html = focusView(buildBoard(input({ sujets: [s] })), ctx);
    const shas = [...html.matchAll(/<form [^>]*data-draft[^>]*data-sha="([0-9a-f]+)"/g)].map((m) => m[1]);
    expect(shas.length).toBe(2);
    expect(shas[0]).toBe(shas[1]);
    expect(html).toMatch(/<form [^>]*data-draft data-preview [^>]*data-postable="1">/);
    expect(html).toContain("<textarea hidden data-draft-edit>Hi &lt;@U0ANN00001&gt;, Monday 10:00.</textarea>");
  });
  test("a draft too long for two lines: the row only opens it, and never carries a Send", () => {
    const s = sujet({ tasks: [task({ draft: LONG })] as never });
    expect(rowAction(s, first(s))).toBeNull();
    const row = focusRow(classify(s, [], null, "idle", timeOf), ctx);
    expect(row).not.toContain(" data-post ");
    expect(row).toContain("data-open-task=");
    expect(row).toContain("line-clamp-2");
  });
  test("a draft whose action does more than post, an old-format draft, or an audience: Open", () => {
    const via = sujet({ tasks: [task({ draft: "Merged.", action: "merge api!14 then post the draft" })] as never });
    expect(rowAction(via, first(via))).toBeNull();
    const legacy = sujet({ tasks: [task({ draft: "", action: "Merged." })] as never });
    expect(rowAction(legacy, first(legacy))).toBeNull();
  });
  test("an action: Go, its whole text in the preview; an action that would post unseen words: Open", () => {
    const s = sujet({ gate: "merge", tasks: [task({ kind: "action", ask: "Merge?", action: "merge api!12", draft: "", draftTo: "" })] as never });
    expect(rowAction(s, first(s))).toEqual({ kind: "go", text: "merge api!12" });
    const row = focusRow(classify(s, [], null, "idle", timeOf), ctx);
    expect(row).toContain(`data-go="${s.key}" data-task="t1"`);
    expect(row).toMatch(/data-row-preview>merge api!12<\/p>/);
    const unseen = sujet({ tasks: [task({ kind: "action", ask: "Tell Zoé", action: "send a message to Zoé", draft: "", draftTo: "" })] as never });
    expect(rowAction(unseen, first(unseen))).toBeNull();
  });
  test("a decision with a short proposal: Approve writes the same message as the detail's", () => {
    const s = sujet({ gate: "decision", tasks: [task({ kind: "decision", ask: "Refund Ann?", proposal: "Yes, by a credit note.", action: "", draft: "", draftTo: "" })] as never });
    const a = rowAction(s, first(s));
    expect(a?.kind).toBe("validate");
    const html = focusView(buildBoard(input({ sujets: [s] })), ctx);
    const msgs = [...html.matchAll(/data-validate data-key="[^"]*" data-task="t1" data-msg="([^"]*)"/g)].map((m) => m[1]);
    expect(msgs.length).toBe(2);
    expect(msgs[0]).toBe(msgs[1]);
    expect(msgs[0]).toContain("Yes, by a credit note.");
    // without a session there is nobody to approve to
    expect(rowAction({ ...s, sessionId: null }, first(s))).toBeNull();
  });
  test("a decision without proposal has nothing to send: Open", () => {
    const s = sujet({ gate: "decision", tasks: [task({ kind: "decision", ask: "Which day?", action: "", draft: "", draftTo: "" })] as never });
    expect(rowAction(s, first(s))).toBeNull();
  });
});

describe("a list row", () => {
  const tasks = [
    task({ id: "t1", draft: "Monday.", createdAt: "2026-09-20T09:00:00Z" }),
    task({ id: "t2", kind: "action", ask: "Merge the fix?", action: "merge api!1042", draft: "", draftTo: "", createdAt: "2026-09-21T10:00:00Z" }),
    task({ id: "t3", kind: "decision", ask: "Tell Zoé?", action: "", draft: "", draftTo: "", createdAt: "2026-09-21T10:30:00Z" }),
    task({ id: "t4", kind: "decision", ask: "Close it?", action: "", draft: "", draftTo: "", createdAt: "2026-09-21T11:00:00Z" }),
  ];
  test("the first two open tasks with their kind; only the first acts, the second opens; the rest counted", () => {
    const row = focusRow(classify(sujet({ tasks: tasks as never }), [], null, "idle", timeOf), ctx);
    expect(row).toContain("Ann asks for the deploy date");
    expect(row).toContain("Merge the fix?");
    expect(row).not.toContain("Tell Zoé?");
    expect(row).toContain("+2 autres tâches");
    expect(row.match(/ data-post class/g)?.length).toBe(1);
    // the second task's Go stays in the detail
    expect(row).not.toContain("data-go=");
    expect(row).toContain(`data-open-task="tb-${base.key}#t2"`);
    expect(row).not.toContain(`data-open-task="tb-${base.key}#t1"`);
  });
  test("a row is a selectable line, never a card: no panel, no form to write to the session", () => {
    const row = focusRow(classify(sujet({ tasks: tasks as never }), [], null, "idle", timeOf), ctx);
    expect(row).toContain('data-row=""');
    expect(row).not.toContain("data-panel");
    expect(row).not.toContain("data-send");
  });
  test("without task, the session's last word, else where the card stands", () => {
    const quiet = sujet({ status: "waiting", gate: "none", waiting: "Zoé", summary: "Waiting for Zoé's numbers." });
    const said = { text: "Zoé sent the **file**.", at: "2026-09-21T11:30:00Z" };
    expect(focusRow(classify(quiet, [], null, "idle", timeOf, null, null, said), ctx)).toContain('data-row-word>Zoé sent the <strong class="font-semibold text-ink">file</strong>.</p>');
    expect(focusRow(classify(quiet, [], null, "idle", timeOf), ctx)).toContain("data-row-word>Waiting for Zoé&#39;s numbers.</p>");
  });
  test("the thread's last message: who and an excerpt", () => {
    const events = [{ at: "2026-09-21T11:50:00Z", type: "slack", kind: "mention", key: base.key, from: "Zoé", channel: "#acme-requests", permalink: LINK, text: "any news on the date?" }];
    const row = focusRow(classify(sujet({ tasks: tasks as never }), events as never, null, "idle", timeOf), ctx);
    expect(row).toMatch(/data-said><span[^>]*>Zoé<\/span><q[^>]*>any news on the date\?<\/q>/);
  });
});

describe("the focus view", () => {
  const a = sujet({ tasks: [task({ draft: "Monday." })] as never });
  const b = sujet({ key: "C0ACMEREQ01:1788788999.000100", threads: ["C0ACMEREQ01:1788788999.000100"], letter: "B", title: "Quota", status: "waiting", gate: "none", waiting: "Zoé" });
  const m = () => buildBoard(input({ sujets: [a, b] }));
  test("one detail per open topic, only the selected one shown; the first row by default", () => {
    const html = focusView(m(), ctx);
    expect(html.match(/data-detail /g)?.length).toBe(2);
    expect(html).toContain(`<article id="detail-${a.key}" data-detail data-key="${a.key}" class=`);
    expect(html).toContain(`<article id="detail-${b.key}" data-detail data-key="${b.key}" hidden class=`);
    const sel = focusView(m(), ctx, b.key);
    expect(sel).toContain(`<article id="detail-${b.key}" data-detail data-key="${b.key}" class=`);
    expect(focusView(m(), ctx, "gone:1")).toContain(`<article id="detail-${a.key}" data-detail data-key="${a.key}" class=`);
  });
  test("the detail is the flow card's body, context open and instruction form shown", () => {
    const html = focusView(m(), ctx);
    expect(html).toContain(`<div id="card-${a.key}" data-panel class="cursor-auto">`);
    expect(html).toContain(`<div id="write-${a.key}" data-panel class="cursor-auto">`);
    expect(html).not.toContain(`data-toggle="write-${a.key}"`);
  });
  test("blocks as in the flow mode, with their counts; each id once", () => {
    const html = focusView(m(), ctx);
    expect(html.indexOf('id="bloc-attend"')).toBeLessThan(html.indexOf('id="bloc-attente"'));
    expect(html).not.toContain('id="bloc-travail"');
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((x) => x[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(html).toContain('data-view="board" data-mode="focus" data-attend="1"');
  });
  test("both modes keep the board-wide actions", () => {
    const html = focusView(m(), ctx);
    expect(html).toContain("data-revalidate-all");
    expect(html).toContain(">Tout revérifier</button>");
    expect(html).toContain("data-sync");
  });
});
