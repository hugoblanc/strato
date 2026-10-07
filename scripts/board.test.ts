import { describe, expect, test } from "bun:test";
import { actionCard, ago, badge, type BoardEvent, masterCommand, type BoardInput, type BoardSession, boardPage, boardView, buildBoard, classify, pinLine, pinOf, gateLabel, isQuickGo, lastMessageOf, lineView, mrTitle, postedLine, sessionLine, settledChip, span } from "./board.ts";
import { postOnlyAction, type Sujet , freshness, gateSince } from "./lib.ts";

const base: Sujet = {
  key: "C0ACMECMP01:1788788755.025729",
  threads: ["C0ACMECMP01:1788788755.025729"],
  letter: "F",
  title: "Demande de changement de banque",
  channel: "#acme-compliance",
  permalink: "https://acme.slack.com/archives/C0ACMECMP01/p1788788755025729",
  asker: "Grace",
  sessionId: "sess-f",
  shortId: "053023ad",
  name: "F · #acme-compliance · Grace · Demande de changement de banque",
  status: "gate",
  gate: "draft",
  waiting: "",
  next: "Alice choisit la date",
  summary: "50 demandes attendent, la plus ancienne depuis 74 jours.",
  createdAt: "2026-09-21T07:08:49Z",
  updatedAt: "2026-09-21T07:16:29Z",
  history: [],
};
const sujet = (o: Partial<Sujet>): Sujet => ({ ...base, ...o });
const timeOf = (iso: string) => iso.slice(11, 16);
const ctx = { timeOf, now: Date.parse("2026-09-21T12:00:00Z") };
const input = (o: Partial<BoardInput>): BoardInput => ({ sujets: [], events: [], live: new Map(), running: new Map(), sessions: [], otherSessions: 0, now: new Date("2026-09-21T12:00:00Z"), timeOf, ...o });

const slack = (o: Partial<BoardEvent>): BoardEvent => ({ at: "2026-09-21T08:00:00Z", type: "slack", kind: "suite", key: base.key, from: "Heidi", channel: "#acme-compliance", permalink: "https://acme.slack.com/archives/C0ACMECMP01/p1788800000000000?thread_ts=1788788755.025729", ...o });

describe("relaunch banner", () => {
  test("the command starts from the installation's working folder", () => {
    expect(masterCommand()).toBe(`cd '/Users/alice/dev/acme' && claude -n strato "/strato"`);
  });
});

describe("lastMessageOf", () => {
  test("takes the last Slack event of one of the topic's threads, and ignores the others", () => {
    const s = sujet({ threads: [base.key, "linear:ENG-2545", "CX:2"] });
    const events: BoardEvent[] = [
      slack({ at: "2026-09-21T08:00:00Z", from: "Heidi" }),
      slack({ at: "2026-09-21T09:00:00Z", from: "Peter", key: "CX:2" }),
      slack({ at: "2026-09-21T10:00:00Z", from: "Ailleurs", key: "CZ:9" }),
      { at: "2026-09-21T11:00:00Z", type: "session", key: base.key, attention: "tour terminé" },
    ];
    expect(lastMessageOf(s, events)?.from).toBe("Peter");
  });
  test("null without an event", () => {
    expect(lastMessageOf(base, [])).toBeNull();
  });
});

describe("classify", () => {
  test("a session that is churning wins over everything: in progress, even with a gate and a message after the card", () => {
    const l = classify(base, [slack({ at: "2026-09-21T09:30:00Z" })], { attention: "tour terminé", at: 0 }, "busy", timeOf);
    expect(l.bloc).toBe("travail");
    expect(l.verdict).toBe("travaille en ce moment");
    expect(l.running).toBe("busy");
  });
  test("a third party's message after the card sends the topic to review, even with a gate", () => {
    const l = classify(base, [slack({ at: "2026-09-21T09:30:00Z" })], { attention: "tour terminé", at: 0 }, "idle", timeOf);
    expect(l.bloc).toBe("revoir");
    // le bloc dit « après la carte », le badge dit qui et depuis quand
    expect(l.verdict).toBe("Heidi a écrit");
    expect(l.waitingSince).toBe("2026-09-21T09:30:00Z");
    expect(l.tone).toBe("warn");
  });
  test("a reply from Alice after the card: to review, muted", () => {
    const l = classify(base, [slack({ at: "2026-09-21T09:30:00Z", kind: "moi", from: "Alice Martin" })], null, null, timeOf);
    expect(l.bloc).toBe("revoir");
    expect(l.verdict).toContain("tu as répondu");
    expect(l.tone).toBe("muted");
  });
  test("a message older than the card changes nothing", () => {
    const l = classify(base, [slack({ at: "2026-09-21T07:00:00Z" })], null, null, timeOf);
    expect(l.bloc).toBe("attend");
    expect(l.verdict).toBe("relire le draft");
    expect(l.lastMessage?.from).toBe("Heidi");
  });
  test("a session blocked on a permission wins over the gate", () => {
    const l = classify(base, [], { attention: "attend une autorisation", at: 0 }, "waiting", timeOf);
    expect(l.bloc).toBe("attend");
    expect(l.verdict).toBe("session bloquée : attend une autorisation");
    expect(l.tone).toBe("warn");
  });
  test("waiting on the Claude Code side without a hook declaration: blocked too", () => {
    const l = classify(base, [], null, "waiting", timeOf);
    expect(l.bloc).toBe("attend");
    expect(l.verdict).toContain("session bloquée");
  });
  test("topic waiting: in progress, with who we are waiting on", () => {
    const l = classify(sujet({ status: "waiting", gate: "none", waiting: "Marvin" }), [], null, "idle", timeOf);
    expect(l.bloc).toBe("attente");
    expect(l.verdict).toBe("attend Marvin");
  });
  test("preparing with a finished turn and no gate: waiting on you, flagged", () => {
    const l = classify(sujet({ status: "preparing", gate: "none" }), [], { attention: "tour terminé", at: 0 }, "idle", timeOf);
    expect(l.bloc).toBe("attend");
    expect(l.verdict).toContain("arrêtée sans porte");
  });
  test("working and Claude Code busy: the session is working", () => {
    const l = classify(sujet({ status: "working", gate: "none" }), [], null, "busy", timeOf);
    expect(l.verdict).toBe("travaille en ce moment");
    expect(l.tone).toBe("clear");
  });
  test("working but Claude Code idle: the card is wrong, the session waits for Alice", () => {
    const l = classify(sujet({ status: "working", gate: "none" }), [], null, "idle", timeOf);
    expect(l.bloc).toBe("attend");
    expect(l.verdict).toContain("arrêtée sans porte");
  });
  test("working without a live session: dead without a gate", () => {
    const l = classify(sujet({ status: "working", gate: "none" }), [], null, null, timeOf);
    expect(l.bloc).toBe("attend");
    expect(l.verdict).toContain("morte");
  });
});

describe("buildBoard", () => {
  const A = sujet({ key: "CA:1", threads: ["CA:1"], letter: "A", sessionId: "sa", updatedAt: "2026-09-21T06:00:00Z" });
  const B = sujet({ key: "CB:1", threads: ["CB:1"], letter: "B", sessionId: "sb", updatedAt: "2026-09-21T09:00:00Z" });
  const C = sujet({ key: "CC:1", threads: ["CC:1"], letter: "C", sessionId: "sc", status: "working", gate: "none", updatedAt: "2026-09-21T08:00:00Z" });
  const D = sujet({ key: "CD:1", threads: ["CD:1"], letter: "D", status: "closed", gate: "none", updatedAt: "2026-09-21T10:00:00Z" });
  const E = sujet({ key: "CE:1", threads: ["CE:1"], letter: "E", status: "closed", gate: "none", updatedAt: "2026-09-18T10:00:00Z" });

  test("three blocks, only today's closed topics", () => {
    const m = buildBoard(input({ sujets: [A, B, C, D, E], events: [slack({ key: "CB:1", at: "2026-09-21T09:30:00Z" })], running: new Map([["sc", "busy"]]) }));
    expect(m.attend.map((l) => l.sujet.letter)).toEqual(["A"]);
    expect(m.revoir.map((l) => l.sujet.letter)).toEqual(["B"]);
    expect(m.travail.map((l) => l.sujet.letter)).toEqual(["C"]);
    expect(m.closedToday.map((s) => s.letter)).toEqual(["D"]);
  });
  test("waiting on you: oldest first", () => {
    const m = buildBoard(input({ sujets: [B, A] }));
    expect(m.attend.map((l) => l.sujet.letter)).toEqual(["A", "B"]);
  });
  test("the live declaration and the Claude Code status are read by sessionId", () => {
    const m = buildBoard(input({ sujets: [A, B], live: new Map([["sa", { attention: "attend une autorisation", at: 0 }]]), running: new Map([["sb", "busy"]]) }));
    expect(m.attend[0]?.verdict).toContain("bloquée");
    expect(m.travail[0]?.sujet.letter).toBe("B");
    expect(m.travail[0]?.verdict).toBe("travaille en ce moment");
  });
  test("the master goes first among sessions", () => {
    const s = (id: string, master: boolean): BoardSession => ({
      sessionId: id,
      name: id,
      status: "idle",
      kind: "interactive",
      cwd: "/x/acme",
      branch: null,
      startedAt: "2026-09-21T08:00:00Z",
      context: { sessionId: id, cwd: "/x/acme", branch: null, title: null, firstRequest: null, lastAgent: null, trail: [], turnAt: null, slackThreads: [], linearIssues: [], master },
    });
    const m = buildBoard(input({ sessions: [s("a", false), s("m", true)], otherSessions: 2 }));
    expect(m.sessions.map((x) => x.sessionId)).toEqual(["m", "a"]);
    expect(m.otherSessions).toBe(2);
  });
});

describe("pin", () => {
  const A = sujet({ key: "CA:1", threads: ["CA:1"], letter: "A", sessionId: "sa", updatedAt: "2026-09-21T06:00:00Z" });
  const B = sujet({ key: "CB:1", threads: ["CB:1"], letter: "B", sessionId: "sb", updatedAt: "2026-09-21T07:00:00Z" });
  const C = sujet({ key: "CC:1", threads: ["CC:1"], letter: "C", sessionId: "sc", updatedAt: "2026-09-21T08:00:00Z" });
  const W = sujet({ key: "CW:1", threads: ["CW:1"], letter: "W", sessionId: "sw", status: "working", gate: "none", updatedAt: "2026-09-21T09:00:00Z" });
  const letters = (ls: { sujet: Sujet }[]) => ls.map((l) => l.sujet.letter);
  // the person pressed Go on B, second in "waiting on you": its session wakes up and works
  const after = buildBoard(input({ sujets: [A, B, C, W], running: new Map([["sb", "busy"], ["sw", "busy"]]) }));

  test("a line acted on keeps its block and index while its state changes", () => {
    expect(letters(after.attend)).toEqual(["A", "C"]);
    expect(letters(after.travail)).toEqual(["W", "B"]);
    const m = pinLine(after, { key: "CB:1", bloc: "attend", index: 1 });
    expect(letters(m.attend)).toEqual(["A", "B", "C"]);
    expect(letters(m.travail)).toEqual(["W"]);
    const b = m.attend[1];
    expect(b?.bloc).toBe("travail");
    expect(b?.verdict).toBe("travaille en ce moment");
    expect(b?.pin).toEqual({ shownIn: "attend", quick: false, held: true });
  });
  test("it moves where it belongs once unpinned", () => {
    const m = pinLine(after, null);
    expect(m).toBe(after);
    expect(letters(m.attend)).toEqual(["A", "C"]);
    expect(letters(m.travail)).toEqual(["W", "B"]);
  });
  test("the page shows it in place with its new state, and the tab counts only what really waits on you", () => {
    const html = boardView(pinLine(after, { key: "CB:1", bloc: "attend", index: 1 }), ctx);
    const attend = html.slice(html.indexOf('id="bloc-attend"'), html.indexOf('id="bloc-revoir"'));
    expect([...attend.matchAll(/<li[^>]*data-letter="(\w)"/g)].map((x) => x[1])).toEqual(["A", "B", "C"]);
    expect(attend).toContain("data-held");
    expect(attend).toContain("data-held-note");
    expect(attend).toContain("Au travail");
    expect(html).toContain('data-attend="2"');
    expect(boardView(after, ctx)).not.toContain("data-held");
  });
  test("the index is clamped to the block's length", () => {
    const m = pinLine(after, { key: "CB:1", bloc: "attend", index: 9 });
    expect(letters(m.attend)).toEqual(["A", "C", "B"]);
  });
  test("a line still where it belongs is pinned without the cue", () => {
    const m = pinLine(after, { key: "CA:1", bloc: "attend", index: 0 });
    expect(letters(m.attend)).toEqual(["A", "C"]);
    expect(m.attend[0]?.pin?.held).toBe(false);
    expect(boardView(m, ctx)).not.toContain("data-held");
  });
  test("a line that left the blocks (closed, snoozed) or an unknown key changes nothing", () => {
    expect(pinLine(after, { key: "CZ:9", bloc: "attend", index: 0 })).toBe(after);
  });
  test("pinOf reads the request and refuses what it cannot place", () => {
    expect(pinOf(new URLSearchParams("pin=CB%3A1&pinBloc=attend&pinIndex=1"))).toEqual({ key: "CB:1", bloc: "attend", index: 1, quick: false });
    expect(pinOf(new URLSearchParams("pin=CB:1&pinBloc=attend&pinIndex=0&pinQuick=1"))?.quick).toBe(true);
    expect(pinOf(new URLSearchParams("pin=CB:1&pinBloc=travail&pinIndex=0&pinQuick=1"))?.quick).toBe(false);
    expect(pinOf(new URLSearchParams(""))).toBeNull();
    expect(pinOf(new URLSearchParams("pin=CB:1&pinBloc=sessions&pinIndex=1"))).toBeNull();
    expect(pinOf(new URLSearchParams("pin=CB:1&pinBloc=attend&pinIndex=-1"))).toBeNull();
    expect(pinOf(new URLSearchParams("pin=CB:1&pinBloc=attend"))).toBeNull();
  });
});

describe("rendering", () => {
  test("a row carries the letter, the verdict, the links, the folded card and the message form", () => {
    const s = sujet({ threads: [base.key, "linear:ENG-2545"], ask: "Grace <relance>" });
    const html = lineView(classify(s, [], null, null, timeOf), ctx);
    expect(html).toContain(">F</span>");
    expect(html).toContain("Relire le draft");
    expect(html).toContain("https://linear.app/acme/issue/ENG-2545");
    expect(html).toContain("https://acme.slack.com/archives/C0ACMECMP01/p1788788755025729");
    expect(html).toContain("claude attach 053023ad");
    expect(html).toContain(`id="card-${base.key}"`);
    expect(html).toContain("Grace &lt;relance&gt;");
    expect(html).toContain(">Rapport</a>");
    expect(html).not.toContain("carte et rapport");
    expect(html).toContain(`data-send data-key="${base.key}"`);
    expect(html).toContain("Écrire à F");
    expect(html).toContain(`data-row="card-${base.key}"`);
  });
  test("no form without a session", () => {
    expect(lineView(classify(sujet({ sessionId: null }), [], null, null, timeOf), ctx)).not.toContain("data-send");
  });
  test("a churning session has a pulsing dot", () => {
    expect(lineView(classify(base, [], null, "busy", timeOf), ctx)).toContain("animate-ping");
    expect(lineView(classify(base, [], null, "idle", timeOf), ctx)).not.toContain("animate-ping");
  });
  test("the last message says who, where, in their words, and its quote and its age link to the message", () => {
    const html = lineView(classify(base, [slack({ at: "2026-09-21T07:00:00Z", text: "any news on the bank change?" })], null, null, timeOf), ctx);
    expect(html).toContain('<span class="shrink-0 font-semibold text-ink">Heidi</span>');
    // the quote itself opens the message, not only its age
    expect(html).toMatch(/<a href="https:\/\/acme\.slack\.com\/archives\/C0ACMECMP01\/p1788800000000000[^"]*" data-open[^>]*><q class="italic">any news on the bank change\?<\/q><\/a>/);
    expect(html).toMatch(/<a href="https:\/\/acme\.slack\.com\/archives\/C0ACMECMP01\/p1788800000000000[^"]*" data-open[^>]*><time[^>]*>5 h<\/time><\/a>/);
  });
  test("the page has the three blocks with their counts, the sessions and today's closed topics, without big counters on top", () => {
    const m = buildBoard(input({ sujets: [base, sujet({ key: "CD:1", threads: ["CD:1"], letter: "D", status: "closed", gate: "none", updatedAt: "2026-09-21T10:00:00Z" })], otherSessions: 3 }));
    const html = boardView(m, { ...ctx, readAt: "21/09 12:00" });
    expect(html).not.toContain('text-[46px]');
    expect(html).toContain("T'attend");
    expect(html).toContain("À revoir");
    expect(html).toContain("Au travail");
    expect(html).toContain("On attend quelqu'un");
    expect(html).not.toContain("En cours");
    expect(html).toContain("3 autres sessions acme");
    expect(html).toContain("1 sujet fermé aujourd'hui");
    // plus de phrase d'accroche en tête
    expect(html).not.toContain("sujets ouverts");
    expect(html).not.toContain("sujet ouvert,");
    expect(html).toContain('data-view="board"');
  });
  test("the shell loads Tailwind and the board script", () => {
    const html = boardPage("<p>x</p>");
    expect(html).toContain("@tailwindcss/browser@4");
    expect(html).toContain('id="app"');
    expect(html).toContain("/board/fragment");
    expect(html).toContain("/api/send");
  });
  test("a session outside Strato shows its citations and its state", () => {
    const x: BoardSession = {
      sessionId: "s1",
      name: "acme-5f",
      status: "busy",
      kind: "interactive",
      cwd: "/Users/alice/dev/acme/api",
      branch: "feat/board",
      startedAt: "2026-09-21T08:00:00Z",
      context: {
        sessionId: "s1",
        cwd: "/x",
        branch: null,
        title: "Descriptor Umbrella",
        firstRequest: { text: "regarde ce thread", at: null },
        lastAgent: { text: "fini", at: "2026-09-21T09:00:00Z" },
        trail: [], turnAt: null,
        slackThreads: [{ key: "C0ACMEDEV01:1789632704.323769", url: "https://acme.slack.com/archives/C0ACMEDEV01/p1789632704323769", workspace: "acme" }],
        linearIssues: ["ENG-2700"],
        master: false,
      },
    };
    const html = sessionLine(x, ctx);
    expect(html).toContain("Descriptor Umbrella");
    expect(html).toContain("travaille");
    expect(html).toContain("animate-ping");
    expect(html).toContain("feat/board");
    expect(html).toContain("ENG-2700");
    expect(html).toContain("Slack C0ACMEDEV01");
    expect(html).toContain('dernier tour <time datetime="2026-09-21T09:00:00Z" title="09:00" class="tabular-nums">il y a 3 h</time>');
  });
});

describe("declared blocking versus Claude Code status", () => {
  test("'waiting for an answer' declared by a hook does not block a session Claude Code reports idle", () => {
    const l = classify(base, [], { attention: "attend une réponse", at: 0 }, "idle", timeOf);
    expect(l.bloc).toBe("attend");
    expect(l.verdict).toBe("relire le draft");
  });
  test("the same declaration blocks when Claude Code does not report idle", () => {
    expect(classify(base, [], { attention: "attend une autorisation", at: 0 }, "waiting", timeOf).verdict).toContain("bloquée");
    expect(classify(base, [], { attention: "attend une réponse", at: 0 }, null, timeOf).verdict).toContain("bloquée");
  });
});

describe("tones", () => {
  test("working is green, waiting on someone else is blue", () => {
    expect(classify(base, [], null, "busy", timeOf).tone).toBe("clear");
    expect(classify(sujet({ status: "waiting", gate: "none", waiting: "Marvin" }), [], null, "idle", timeOf).tone).toBe("wait");
  });
});

describe("taken by a teammate", () => {
  test("a teammate answered in the thread: in progress, not for Alice, even with a draft gate", () => {
    const l = classify(base, [slack({ at: "2026-09-21T09:00:00Z", from: "Bob" })], null, "idle", timeOf, null, null, null, ["Bob", "Carol"]);
    expect(l.bloc).toBe("attente");
    expect(l.verdict).toBe("Bob a pris le sujet");
    expect(l.waitingSince).toBe("2026-09-21T09:00:00Z");
    expect(l.tone).toBe("muted");
  });
  test("without a configured team, the draft gate stays", () => {
    expect(classify(base, [slack({ at: "2026-09-21T07:00:00Z", from: "Bob" })], null, "idle", timeOf).bloc).toBe("attend");
  });
});

test("a topic waiting on you says what it waits for, without opening the card", () => {
  const html = lineView(classify(sujet({ next: "Zoé choisit la date" }), [], null, "idle", timeOf), ctx);
  expect(html).toContain("Bloqué sur");
  expect(html).toContain("Zoé choisit la date");
  const enCours = lineView(classify(sujet({ status: "waiting", gate: "none", waiting: "Marvin" }), [], null, "idle", timeOf), ctx);
  expect(enCours).not.toContain("<span class=\"font-semibold\">Bloqué sur</span>");
});

describe("draft card in the action column", () => {
  test("the draft shows with its destination, its length, Send, Edit and Copy", () => {
    const html = lineView(classify(sujet({ draft: "Hey Grace, rule works for me.\nOne thing: name check stays.", draftTo: "#acme-compliance, thread p1788788755025729" }), [], null, "idle", timeOf), ctx);
    expect(html).toContain("→ #acme-compliance");
    expect(html).toContain("car.");
    expect(html).toContain('data-postable="1"');
    expect(html).toContain("data-post");
    expect(html).toContain("data-edit");
    expect(html).toContain("data-copy");
    expect(html).toContain("rule works for me.");
    expect(html).toContain("max-h-80");
  });
  test("without a draft field, a draft gate falls back to the action text", () => {
    const html = lineView(classify(sujet({ action: "Poster dans #x : Hello there" }), [], null, "idle", timeOf), ctx);
    expect(html).toContain("carte d'avant le champ draft");
  });
  test("destination in another channel without a link: Send greyed out, reason shown", () => {
    const html = lineView(classify(sujet({ draft: "Hello", draftTo: "#compliance-requests, fil de Brunhilde" }), [], null, "idle", timeOf), ctx);
    expect(html).toContain('data-postable="0"');
    expect(html).toContain("il manque le lien du fil");
  });
  test("a decision gate with a draft stays in 'A decision'", () => {
    const l = classify(sujet({ gate: "decision", draft: "notice", draftTo: "#acme-exec (C0ACMEEXC01), nouveau message" }), [], null, "idle", timeOf);
    expect(isQuickGo(l)).toBe(false);
    expect(lineView(l, ctx)).toContain('data-postable="1"');
    expect(lineView(l, ctx)).toContain("→ #acme-exec, nouveau message");
  });
  test("gate without a draft but with an action: Go card", () => {
    const html = lineView(classify(sujet({ gate: "merge", action: "merger la MR !979 vers dev" }), [], null, "idle", timeOf), ctx);
    expect(html).toContain("Sur ton go");
    expect(html).not.toContain("Action sur go");
    expect(html).toContain("data-go=");
  });
  test("neither draft nor gate: nothing at the top of the column", () => {
    const html = lineView(classify(sujet({ status: "waiting", gate: "none", waiting: "X", action: "y" }), [], null, "idle", timeOf), ctx);
    expect(html).not.toContain("data-post");
    expect(html).not.toContain("data-go=");
  });
});

describe("Slack listening", () => {
  test("a recent tick: nothing to say; an old or missing tick: red banner", () => {
    const now = new Date("2026-09-23T15:00:00Z");
    const fresh = buildBoard(input({ now, lastTick: "2026-09-23T14:55:00Z" }));
    expect(fresh.listener.alive).toBe(true);
    expect(boardView(fresh, ctx)).not.toContain("L'écoute Slack ne tourne pas");
    const stale = buildBoard(input({ now, lastTick: "2026-09-22T13:09:00Z" }));
    expect(stale.listener.alive).toBe(false);
    expect(boardView(stale, ctx)).toContain("L'écoute Slack ne tourne pas depuis 13:09");
    expect(buildBoard(input({ now })).listener.alive).toBe(false);
  });
  test("deaf socket: message caught by search and nothing delivered for more than 30 min, banner with the app link", () => {
    const now = new Date("2026-09-23T15:00:00Z");
    const t = now.getTime();
    const deaf = buildBoard(input({ now, lastTick: "2026-09-23T14:58:00Z", slackAppId: "A0ACME00001", socket: { lastEventAt: t - 3 * 3600_000, missedAt: t - 60_000, missed: 2 } }));
    expect(deaf.listener.deaf).toBe(true);
    const html = boardView(deaf, ctx);
    expect(html).toContain("Slack ne livre plus les événements");
    expect(html).toContain("https://api.slack.com/apps/A0ACME00001/event-subscriptions");
    const ok = buildBoard(input({ now, lastTick: "2026-09-23T14:58:00Z", socket: { lastEventAt: t - 5 * 60_000, missedAt: t - 60_000, missed: 1 } }));
    expect(ok.listener.deaf).toBe(false);
    expect(boardView(ok, ctx)).not.toContain("Slack ne livre plus");
  });
});

describe("review requested from the master", () => {
  const now = new Date("2026-09-29T10:30:00Z");
  const alive = { now, lastTick: "2026-09-29T10:28:00Z" };
  test("live listener and nothing running: menu of the three windows", () => {
    const html = boardView(buildBoard(input(alive)), ctx);
    expect(html).toContain('data-revue="14d"');
    expect(html).not.toContain("data-revue-status");
  });
  test("without a listener: greyed-out button with the reason", () => {
    const html = boardView(buildBoard(input({ now })), ctx);
    expect(html).not.toContain('data-revue="14d"');
    expect(html).toContain("personne pour recevoir la demande");
  });
  test("received by the master: in progress, button greyed out", () => {
    const m = buildBoard(input({ ...alive, revue: { id: "r1", kind: "revue", since: "14d", at: "2026-09-29T10:20:00Z", deliveredAt: "2026-09-29T10:20:02Z" } }));
    expect(m.revue?.state).toBe("running");
    const html = boardView(m, ctx);
    expect(html).toContain("reçue à 10:20 et y travaille");
    expect(html).not.toContain('data-revue="14d"');
  });
  test("summary shown, then removed after a day", () => {
    const req = { id: "r1", kind: "revue" as const, since: "3d", at: "2026-09-29T09:00:00Z", deliveredAt: "2026-09-29T09:00:01Z", doneAt: "2026-09-29T09:20:00Z", summary: "2 sessions relancées, 1 sujet ouvert." };
    expect(boardView(buildBoard(input({ ...alive, revue: req })), ctx)).toContain("finie à 09:20 : 2 sessions relancées, 1 sujet ouvert.");
    expect(buildBoard(input({ now: new Date("2026-09-30T10:00:00Z"), revue: req })).revue).toBeNull();
  });
  test("no summary after 45 min: left unanswered, and it can be asked again", () => {
    const m = buildBoard(input({ ...alive, revue: { id: "r1", kind: "revue", since: "24h", at: "2026-09-29T09:30:00Z", deliveredAt: "2026-09-29T09:30:01Z" } }));
    expect(m.revue?.state).toBe("stale");
    expect(boardView(m, ctx)).toContain('data-revue="24h"');
  });
});

describe("delivery and due dates", () => {
  const now = new Date(2026, 8, 29, 17, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  const at = (h: number, m = 0, d = 29) => `2026-09-${pad(d)} ${pad(h)}:${pad(m)}`;
  const withMr = (o: Partial<BoardInput> = {}) =>
    input({
      now,
      sujets: [sujet({ status: "waiting", waiting: "Zoé", due: `${at(16)} notice #acme-exec | ${at(18)} merger les MR de Zoé | ${at(10, 0, 30)} point Ivan` })],
      deliveries: new Map([[base.key, [{ repo: "api", iid: 1042, title: "fix payouts", url: "https://gitlab.com/x", stage: "dev" as const, label: "sur dev", blocker: "attend la release dev → main", at: "2026-09-29T08:00:00Z" }]]]),
      ...o,
    });
  test("the row shows the MR and the due dates, combined", () => {
    const m = buildBoard(withMr());
    const html = boardView(m, ctx);
    expect(html).toContain("api!1042");
    expect(html).toContain("attend la release dev → main");
    expect(m.attente[0].dues?.map((d) => d.state)).toEqual(["past", "soon", "later"]);
    expect(m.attente[0].dues?.[2].day).toBe("demain");
    expect(html).toContain("dépassée");
  });
  test("a topic with many threads shows the two most recent, the older ones fold behind +N", () => {
    const threads = [1, 2, 3, 4, 5].map((i) => `C0ACMECMP01:178878${i}000.000100`);
    const html = boardView(buildBoard(input({ now, sujets: [sujet({ status: "waiting", waiting: "Zoé", threads })] })), ctx);
    expect(html).toContain("+3 plus anciens");
    const head = html.slice(0, html.indexOf("+3 plus anciens"));
    expect(head).toContain("p1788785000000100");
    expect(head).toContain("p1788784000000100");
    expect(head).not.toContain("p1788781000000100");
    expect(html).toMatch(/id="threads-[^"]+" data-panel hidden/);
  });
  test("MRs in prod for more than an hour fold into one line, the moving ones keep their row", () => {
    const mr = (iid: number, stage: "prod" | "dev", title: string) => ({ repo: "api", iid, title, url: `https://gitlab.com/x/${iid}`, stage, label: stage === "prod" ? "en prod" : "sur dev", blocker: null, at: "2026-09-21T08:00:00Z" });
    const html = boardView(buildBoard(withMr({ deliveries: new Map([[base.key, [mr(1, "prod", "first shipped"), mr(2, "prod", "second shipped"), mr(3, "dev", "still moving")]]]) })), ctx);
    expect(html).toContain("2 en prod");
    expect(html).toContain("api!1");
    expect(html).toContain("api!2");
    expect(html).toContain(">still moving<");
    expect(html).not.toContain(">first shipped<");
  });
  test("the radar lists MRs not yet in prod and due dates within 36 h", () => {
    const html = boardView(buildBoard(withMr()), ctx);
    expect(html).toContain("data-radar");
    expect(html).toContain("Vers la prod");
    expect(html).toContain('data-jump="' + base.key + '"');
    const none = boardView(buildBoard(input({ now, sujets: [sujet({ status: "waiting" })] })), ctx);
    expect(none).not.toContain("data-radar");
  });
  test("the pill reads the heartbeat and the socket health", () => {
    const m = buildBoard(input({ now, lastTick: new Date(now.getTime() - 30_000).toISOString(), heartbeat: 60, socket: { lastEventAt: now.getTime() - 60_000, syncedAt: now.getTime() - 120_000, missedAt: 0, missed: 0, wokeAt: 0 } }));
    expect(m.sync.beat).toBe(60_000);
    expect(boardView(m, ctx)).toContain(`data-tick="${now.getTime() - 30_000}"`);
  });
});

describe("step plan", () => {
  const planned = sujet({ steps: "done: Globex débloqué | now: poster le draft | todo: ouvrir le ticket extension", blocker: "ton go pour poster", draft: "Hello Grace, unblocked.", draftTo: "#acme-helpdesk" });
  test("a 'Just a go' does not repeat the blocker on the row, the card lists the plan with the current step", () => {
    const html = lineView(classify(planned, [], null, "idle", timeOf), ctx);
    expect(html).not.toContain("data-blocker");
    // the plan is read first: one strip on the card, the current step in bold
    expect(html).toContain("data-plan");
    expect(html).toMatch(/<li class="inline-flex items-baseline gap-1.5 font-semibold text-ink"><span class="text-accent" aria-hidden="true">●<\/span><span>poster le draft<\/span><\/li>/);
    expect(html).toContain("ouvrir le ticket extension");
  });
  test("without a plan or blocker, the row falls back to next", () => {
    expect(lineView(classify(sujet({ next: "Zoé choisit la date" }), [], null, "idle", timeOf), ctx)).toContain("data-blocker>Zoé choisit la date");
  });
});

test("draft gate without text: 'Draft missing' warning", () => {
  const html = lineView(classify(sujet({ action: "", draft: "", steps: "now: poster le draft à Niaj", blocker: "ton go pour poster" }), [], null, "idle", timeOf), ctx);
  expect(html).toContain("Draft manquant");
  expect(lineView(classify(sujet({ status: "waiting", gate: "none", waiting: "X", action: "" }), [], null, "idle", timeOf), ctx)).not.toContain("Draft manquant");
});

describe("activity trail on the row", () => {
  const trail = [
    { text: "Relit la carte", at: "2026-09-28T06:40:36Z" },
    { text: "Poste le draft dans le fil de Ivan", at: "2026-09-28T06:40:41Z" },
  ];
  test("working session: the steps of the turn, the last one in progress", () => {
    const l = classify(sujet({ status: "working" }), [], null, "busy", timeOf, null, null, null, [], trail);
    const html = lineView(l, ctx);
    expect(html).toContain("Ce que fait la session");
    expect(html).toContain("Poste le draft dans le fil de Ivan");
    expect(html).toContain("animate-ping");
  });
  test("idle session: no trail, the card and the last word are enough", () => {
    const l = classify(sujet({ status: "working" }), [], null, "idle", timeOf, null, null, null, [], trail);
    expect(lineView(l, ctx)).not.toContain("Ce que fait la session");
  });
});

describe("sub-agent tree on the row", () => {
  const agent = (id: string, status: "running" | "done", children: any[] = []) => ({
    id, label: `agent ${id}`, kind: "Explore", model: "opus", parentId: null, status,
    startedAt: "2026-09-28T08:35:00Z", lastAt: "2026-09-28T08:40:00Z", step: status === "running" ? { text: "lit le fil Slack", at: "2026-09-28T08:40:00Z" } : null, children,
  });
  test("idle session with a working background agent: in progress, not 'stopped without a gate', with the tree", () => {
    const tree = [agent("a", "done", [agent("a1", "running")]), agent("b", "done")];
    const l = classify(sujet({ status: "working" }), [], null, "idle", timeOf, null, null, null, [], [], tree);
    expect(l.bloc).toBe("travail");
    expect(l.verdict).toBe("un sous-agent au travail");
    const html = lineView(l, ctx);
    expect(html).toContain("Sous-agents · 1 en cours sur 3");
    expect(html).toContain("agent a1");
    expect(html).toContain("lit le fil Slack");
    expect(html).toContain("agent-tree");
  });
  test("all finished and session idle: no tree, the card takes over again", () => {
    const l = classify(sujet({ status: "working" }), [], null, "idle", timeOf, null, null, null, [], [], [agent("a", "done")]);
    expect(l.verdict).toBe("session arrêtée sans porte : lis son dernier mot");
    expect(lineView(l, ctx)).not.toContain("Sous-agents");
  });
});

describe("waiting on you, split in two: just a go, a decision", () => {
  test("a gate with a draft goes to 'Just a go', a gate without an action to 'A decision'", () => {
    const quick = sujet({ key: "C1:1.1", letter: "A", draft: "ok", status: "gate", gate: "draft" });
    const decide = sujet({ key: "C2:2.2", letter: "B", status: "gate", gate: "decision", action: "", draft: "" });
    const html = boardView(buildBoard(input({ sujets: [quick, decide], running: new Map([["sess-f", "idle"]]), lastTick: "2026-09-21T11:58:00Z" })), ctx);
    expect(html).toContain("Juste un go");
    expect(html).toContain("Une décision");
    expect(html.indexOf("Juste un go")).toBeLessThan(html.indexOf("Une décision"));
    expect(html).toContain('data-attend="2"');
  });
});

describe("snooze", () => {
  test("a snoozed topic leaves the blocks; a message from someone else after the snooze brings it back", () => {
    const s = sujet({ key: "C1:1.1", draft: "ok" });
    const snoozed = new Map([["C1:1.1", { until: "2026-09-21T15:00:00Z", since: "2026-09-21T11:00:00Z" }]]);
    const m = buildBoard(input({ sujets: [s], snoozed, running: new Map([["sess-f", "idle"]]) }));
    expect(m.attend.length).toBe(0);
    expect(m.paused.length).toBe(1);
    expect(boardView(m, ctx)).toContain("1 sujet en pause");
    const events = [{ at: "2026-09-21T11:30:00Z", type: "slack", kind: "suite", key: "C1:1.1", from: "Grace", permalink: "https://x/p1" }];
    const woken = buildBoard(input({ sujets: [s], snoozed, events: events as any, running: new Map([["sess-f", "idle"]]) }));
    expect(woken.paused.length).toBe(0);
  });
});

describe("readable drafts", () => {
  test("Slack mentions, channels and links made readable, text escaped", async () => {
    const { slackToHtml, buildBoard } = await import("./board.ts");
    buildBoard(input({ users: { U0GRACE0001: "Grace" } }));
    const html = slackToHtml("<@U0GRACE0001> ok ? <https://docs.acme.io/x|Partner staff access> <b>");
    expect(html).toContain("@Grace");
    expect(html).toContain('href="https://docs.acme.io/x"');
    expect(html).toContain(">Partner staff access</a>");
    expect(html).toContain("&lt;b&gt;");
    expect(slackToHtml("<@U0INCONNU1>")).toContain("@U0INCONNU1");
    expect(slackToHtml("<https://x.io/a?b=1&c=2|lien>")).toContain(">lien</a>");
  });

  test("the card textarea keeps the raw text, Slack markup included: Edit, Cancel and Copy start from it", () => {
    const raw = "Salut <@U0GRACE0001>, voir <https://x.io/a?b=1&c=2|la doc> dans <#C0CCCCCCCC3|acme-risk>";
    const html = actionCard(classify(sujet({ draft: raw, action: "poster le draft" }), [], null, "idle", timeOf));
    const ta = html.match(/<textarea[^>]*data-draft-edit[^>]*>([\s\S]*?)<\/textarea>/)?.[1] ?? "";
    const decoded = ta.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    expect(decoded).toBe(raw);
  });
});

describe("draft sent", () => {
  test("a row says the draft is posted, with the link, for 24 h", async () => {
    const { postedLine } = await import("./board.ts");
    const s = sujet({ draft: "", gate: "none", status: "waiting", posted: "2026-09-29T13:20:00Z https://acme.slack.com/archives/C1/p1" });
    const now = Date.parse("2026-09-29T14:00:00Z");
    expect(postedLine(s, ctx, now)).toContain("voir le message");
    expect(postedLine(s, ctx, now + 2 * 86_400_000)).toBe("");
    // a new draft waiting on the card (an open draft task) hides the line
    const fresh = { id: "t2", kind: "draft" as const, ask: "x", draft: "nouveau draft", draftTo: "#x", createdAt: "2026-09-29T13:30:00Z", updatedAt: "2026-09-29T13:30:00Z", status: "open" as const, origin: "task" as const };
    expect(postedLine(sujet({ ...s, status: "gate", tasks: [fresh] }), ctx, now)).toBe("");
  });

  test("Undo is rendered by the server while the message can be withdrawn, with its countdown", async () => {
    const { postedLine } = await import("./board.ts");
    const s = sujet({ draft: "", gate: "none", status: "waiting", posted: "2026-09-29T13:20:00Z https://acme.slack.com/archives/C1/p1" });
    const now = Date.parse("2026-09-29T13:20:03Z");
    const html = postedLine(s, ctx, now, now + 27_000);
    expect(html).toContain(`data-unpost="${base.key}"`);
    expect(html).toContain(`data-undo-until="${now + 27_000}"`);
    expect(html).toContain("Annuler (27 s)");
    expect(postedLine(s, ctx, now, now - 1)).not.toContain("data-unpost");
    expect(postedLine(s, ctx, now)).not.toContain("data-unpost");
  });

  test("the undo window passed by the server reaches the row", () => {
    const s = sujet({ draft: "", gate: "none", status: "waiting", posted: `${new Date().toISOString()} https://acme.slack.com/archives/C1/p1` });
    const until = Date.now() + 20_000;
    const m = buildBoard(input({ sujets: [s], now: new Date(), undo: new Map([[s.key, { until, taskId: "t1" }]]) }));
    const line = [...m.attend, ...m.revoir, ...m.travail, ...m.attente][0];
    expect(line.undoUntil).toBe(until);
    expect(line.undoTask).toBe("t1");
    expect(lineView(line, ctx)).toContain(`data-undo-until="${until}"`);
    expect(lineView(line, ctx)).toContain(`data-unpost="${s.key}" data-task="t1"`);
  });
});

describe("menus that survive a redraw", () => {
  test("the snooze and review menus have a stable id, whose open state the script keeps", () => {
    const s = sujet({ draft: "Ok", action: "poster le draft" });
    expect(lineView(buildBoard(input({ sujets: [s] })).attend[0], ctx)).toContain(`id="more-${s.key}" data-snooze-menu data-menu`);
    const html = boardView(buildBoard(input({ sujets: [s], lastTick: "2026-09-21T11:58:00Z" })), ctx);
    expect(html).toContain('id="revue-menu" data-revue-menu');
  });
});

describe("dropping a draft", () => {
  test("the draft task carries its Done and Drop buttons", () => {
    const html = lineView(buildBoard(input({ sujets: [sujet({ draft: "Ok, Trent keeps both then.", draftTo: "DM Grace https://acme.slack.com/archives/D0ACMEGRC01/p1790671900425729" })] })).attend[0], ctx);
    expect(html).toContain('data-task-op="drop" data-key="C0ACMECMP01:1788788755.025729" data-task="t1"');
    expect(html).toContain('data-task-op="done"');
    expect(html).toContain(">Abandonner</button>");
    expect(html).toContain(">Fait</button>");
  });
});

describe("Send only if the action boils down to posting", () => {
  test("simple action: Send; compound or unknown action: Go through the session", () => {
    expect(postOnlyAction({ draft: "ok", action: "poster le draft dans #acme-requests, https://acme.slack.com/archives/C1/p1788788755025729" })).toBe(true);
    expect(postOnlyAction({ draft: "ok", action: "" })).toBe(true);
    // the English default policy writes "post the draft in <draftTo>"
    expect(postOnlyAction({ draft: "ok", action: "post the draft in #support, https://acme.slack.com/archives/C1/p1788788755025729" })).toBe(true);
    expect(postOnlyAction({ draft: "ok", action: "merge api!12 then post the draft in #support" })).toBe(false);
    expect(postOnlyAction({ draft: "ok", action: "post the draft and create the ticket" })).toBe(false);
    expect(postOnlyAction({ draft: "c'est en prod", action: "merger la PR #64 puis poster le draft dans #produit" })).toBe(false);
    expect(postOnlyAction({ draft: "c'est en prod", action: "poster le draft puis merger la PR #64" })).toBe(false);
    expect(postOnlyAction({ draft: "ok", action: "poster le draft et créer le ticket" })).toBe(false);
    expect(postOnlyAction({ draft: "ok", action: "lancer le script de backfill" })).toBe(false);
    // carte d'avant le champ draft : action porte le texte même, qui part tel quel
    expect(postOnlyAction({ draft: "", action: "Salut, c'est corrigé et en prod." })).toBe(true);
  });

  test("the card shows Go instead of Send when the action is compound", () => {
    const at = "2026-09-29T15:00:00Z";
    const draftTo = "#acme-requests, https://acme.slack.com/archives/C0ACMECMP01/p1788788755025729";
    const post = classify(sujet({ status: "gate", gate: "draft", draft: "c'est en prod", draftTo, action: "poster le draft dans #acme-requests", updatedAt: at }), [], null, "idle", timeOf);
    const both = classify(sujet({ status: "gate", gate: "draft", draft: "c'est en prod", draftTo, action: "merger la PR #64 puis poster le draft dans #acme-requests", updatedAt: at }), [], null, "idle", timeOf);
    expect(actionCard(post)).toContain("data-post ");
    expect(actionCard(post)).toContain('data-postable="1"');
    expect(actionCard(both)).not.toContain("data-post ");
    expect(actionCard(both)).toContain('data-go="');
    expect(actionCard(both)).toContain('data-postable="0"');
    expect(actionCard(both)).toContain("Go, la session exécute");
  });
});

describe("Send posts the displayed draft, not the one reread from disk", () => {
  const draftTo = "#acme-requests, https://acme.slack.com/archives/C0ACMECMP01/p1788788755025729";
  const card = sujet({ draft: "Salut <@U0GRACE0001>,\\nc'est en prod.", draftTo, action: "poster le draft" });
  test("the draft card carries its raw destination, which the client sends back", () => {
    expect(actionCard(classify(card, [], null, "idle", timeOf))).toContain(`data-draft-to="${draftTo}"`);
  });
  test("same draft and same destination: nothing blocks, edited text included", async () => {
    const { draftConflict } = await import("./board.ts");
    expect(draftConflict(card, { taskId: "t1", text: "Salut <@U0GRACE0001>,\nc'est en prod.", draft: "Salut <@U0GRACE0001>,\r\nc'est en prod.\n", draftTo })).toBeNull();
    expect(draftConflict(card, { taskId: "t1", text: "autre chose", draft: "Salut <@U0GRACE0001>,\nc'est en prod.", draftTo })).toBeNull();
    // un autre champ de la carte a bougé (résumé) : pas de raison de refuser
    expect(draftConflict({ ...card, summary: "neuf", updatedAt: "2026-09-30T10:00:00Z" }, { taskId: "t1", text: "x", draft: "Salut <@U0GRACE0001>,\nc'est en prod.", draftTo })).toBeNull();
  });
  test("draft rewritten, destination changed or stale page: refused", async () => {
    const { draftConflict } = await import("./board.ts");
    const sent = { taskId: "t1", text: "Salut", draft: "Salut <@U0GRACE0001>,\nc'est en prod.", draftTo };
    expect(draftConflict({ ...card, draft: "texte réécrit par la session" }, sent)).toContain("le draft a changé");
    expect(draftConflict({ ...card, draftTo: "DM Grace" }, sent)).toContain("destination");
    // tâche fermée entre-temps (postée à la main, abandonnée) ou une autre tâche
    expect(draftConflict({ ...card, draft: "-", action: "-", gate: "none" }, sent)).toContain("n'est plus ouverte");
    expect(draftConflict(card, { ...sent, taskId: "t2" })).toContain("n'est plus ouverte");
    // l'ancien client n'envoyait que la clé, ou pas la tâche : le serveur postait ce qu'il relisait
    expect(draftConflict(card, {})).toContain("recharge");
    expect(draftConflict(card, { text: "Salut", draft: "Salut", draftTo })).toContain("recharge");
  });
});

describe("missing draft", () => {
  test("no warning right after a send, even if the step still says 'post'", async () => {
    const { draftMissing } = await import("./board.ts");
    const sent = sujet({ draft: "", status: "waiting", gate: "none", steps: "done: enquête | now: poster le draft | todo: suivre", posted: "2026-09-29T15:43:09Z https://x" });
    expect(draftMissing(sent)).toBe("");
    expect(draftMissing(sujet({ draft: "", status: "gate", gate: "draft" }))).toContain("Draft manquant");
  });
});


describe("relative ages", () => {
  // heure locale, comme l'affichage : le 30/09 à 15:00
  const now = new Date(2026, 8, 30, 15, 0).getTime();
  const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).toISOString();
  test("today: ago, in; yesterday and tomorrow with the time; beyond that the date", () => {
    expect(ago(at(30, 14, 59, ), now)).toBe("il y a 1 min");
    expect(ago(new Date(now - 20_000).toISOString(), now)).toBe("à l'instant");
    expect(ago(at(30, 14, 48), now)).toBe("il y a 12 min");
    expect(ago(at(30, 11, 30), now)).toBe("il y a 3 h");
    expect(ago(at(30, 0, 5), now)).toBe("il y a 14 h");
    expect(ago(at(30, 15, 40), now)).toBe("dans 40 min");
    expect(ago(at(30, 18, 0), now)).toBe("dans 3 h");
    expect(ago(at(29, 14, 2), now)).toBe("hier 14:02");
    expect(ago(new Date(2026, 9, 1, 10, 0).toISOString(), now)).toBe("demain 10:00");
    expect(ago(at(28, 9, 0), now)).toBe("28/09");
    expect(ago(new Date(2026, 9, 2, 10, 0).toISOString(), now)).toBe("02/10 10:00");
    expect(ago("pas une date", now)).toBe("pas une date");
  });
  test("short durations for badges", () => {
    expect(span(20_000)).toBe("< 1 min");
    expect(span(48 * 60_000)).toBe("48 min");
    expect(span(3 * 3600_000 + 59 * 60_000)).toBe("3 h");
    expect(span(5 * 86_400_000 + 3600_000)).toBe("5 j");
    expect(span(-5)).toBe("< 1 min");
  });
  test("the card's own date is only on hover of the status: one age on the line", () => {
    const html = lineView(classify(sujet({ updatedAt: "2026-09-21T11:48:00Z" }), [], null, "idle", timeOf), ctx);
    expect(html).toContain("carte écrite à 11:48");
    expect(html).not.toContain("il y a 12 min");
  });
});

describe("badges", () => {
  test("action label depending on the gate, no more 'gate X'", () => {
    expect(gateLabel("draft")).toBe("relire le draft");
    expect(gateLabel("release")).toBe("go prod");
    expect(gateLabel("merge")).toBe("go merge");
    expect(gateLabel("decision")).toBe("décider");
    expect(gateLabel("question")).toBe("répondre");
    expect(gateLabel("ticket")).toBe("porte ticket");
    expect(gateLabel("none")).toBe("ton go");
  });
  test("the waiting age in the badge: gate and waiting on a third party", () => {
    const gate = lineView(classify(sujet({ gate: "release", updatedAt: "2026-09-21T11:12:00Z" }), [], null, "idle", timeOf), ctx);
    const text = (h: string) => h.replace(/<[^>]+>/g, "");
    expect(text(gate)).toContain("Go prod· 48 min");
    const wait = lineView(classify(sujet({ status: "waiting", gate: "none", waiting: "Grace", updatedAt: "2026-09-16T11:00:00Z" }), [], null, "idle", timeOf), ctx);
    expect(text(wait)).toContain("Attend Grace· 5 j");
  });
  test("cut at 32 characters, suffix included and never cut, full text in title", () => {
    const long = "session morte sans porte : un message la relance";
    const html = badge(long, "warn", false, " · 3 h");
    // le texte visible du badge, forme et balise d'âge retirées
    const shown = html.replace(/<span class="shape[^>]*><\/span>/, "").replace(/<[^>]+>/g, "");
    expect(shown.length).toBeLessThanOrEqual(32);
    expect(shown.endsWith("… · 3 h")).toBe(true);
    expect(html).toContain(`title="${long} · 3 h"`);
    expect(badge("go prod", "accent", false, " · 48 min")).not.toContain("title=");
  });
  test("the gate badge is neutral: amber is reserved for the block and the 'On your go' box", () => {
    expect(badge("go prod", "accent")).toContain("bg-soft text-ink");
    expect(badge("go prod", "accent")).not.toContain("accent");
  });
});

describe("a single filled button per card", () => {
  const go = sujet({ gate: "merge", action: "merger la MR !979 vers dev", draft: "" });
  const draft = sujet({ draft: "Hello", draftTo: "#acme-compliance, https://acme.slack.com/archives/C0ACMECMP01/p1788788755025729", action: "poster le draft" });
  const decide = sujet({ gate: "decision", action: "", draft: "" });
  test("the session pane writes through a secondary 'Écrire à <letter>' button, never filled", () => {
    const html = lineView(classify(go, [], null, "idle", timeOf), ctx);
    expect(html).toContain("Écrire à F");
    expect(html).not.toContain("bg-ink");
    expect(html.match(/bg-accent px-3/g)?.length).toBe(1);
  });
  test("Go and Send carry their 'g g' key", () => {
    expect(actionCard(classify(go, [], null, "idle", timeOf))).toMatch(/>Go<span[^>]*>g g<\/span><\/button>/);
    expect(actionCard(classify(draft, [], null, "idle", timeOf))).toMatch(/<span data-label>Envoyer<\/span><span[^>]*>g g<\/span>/);
  });
  test("no 'go' chip when the card already has Go or Send; it stays for a decision", () => {
    const chips = (s: Sujet) => [...lineView(classify(s, [], null, "idle", timeOf), ctx).matchAll(/data-chip="([^"]*)"/g)].map((m) => m[1]);
    expect(chips(go)).not.toContain("go");
    expect(chips(draft)).not.toContain("go");
    expect(chips(decide)).toContain("go");
  });
  test("'it's settled' is the board's own close with ✅, armed like the menu's 'Réglé ✅', not a message to the session", () => {
    const html = lineView(classify(decide, [], null, "idle", timeOf), ctx);
    expect(html).toMatch(/<button type="button" data-confirm="settle" data-key="[^"]+" title="[^"]*"[^>]*>c(?:&#39;|')est réglé ✅<\/button>/);
    expect(html).not.toMatch(/data-chip="C(?:&#39;|')est réglé/);
    const page = boardPage("");
    expect(page).toContain('arm(cid2, tr(action === "settle" ? "board.js.settle.confirm"');
    expect(page).toContain('"board.js.settle.confirm":"Fermer et poser ✅ ?"');
  });
  test("the '…' menu: 'Réglé ✅' then 'Fermer sans ✅' on a Slack topic, a single 'Fermer' on a ticket", () => {
    const menu = (s: Sujet) => lineView(classify(s, [], null, "idle", timeOf), ctx).match(/<details[^>]*data-menu>[\s\S]*?<\/details>/)?.[0] ?? "";
    const slack = menu(decide);
    expect(slack).toMatch(/data-confirm="settle"[^>]*>Réglé ✅<\/button><button type="button" data-confirm="close"[^>]*>Fermer sans ✅<\/button>/);
    const ticket = menu(sujet({ key: "linear:ENG-12", threads: ["linear:ENG-12"], gate: "decision", action: "", draft: "" }));
    expect(ticket).toMatch(/data-confirm="close"[^>]*>Fermer<\/button>/);
    expect(ticket).not.toContain('data-confirm="settle"');
  });
  test("on a ticket (no settled marker) the chip only closes, and says nothing of ✅", () => {
    const html = settledChip({ key: "linear:ENG-12" });
    expect(html).toContain('data-confirm="close"');
    expect(html).not.toContain("✅");
    expect(settledChip({ key: base.key })).toContain('data-confirm="settle"');
  });
});

describe("a single wording of the action", () => {
  test("the blocker disappears when the action box says it, and stays for 'A decision'", () => {
    const go = lineView(classify(sujet({ gate: "merge", action: "merger la MR !979", blocker: "ton go pour merger" }), [], null, "idle", timeOf), ctx);
    expect(go).toContain("data-gocard");
    expect(go).not.toContain("data-blocker");
    const decide = lineView(classify(sujet({ gate: "decision", action: "", draft: "", blocker: "choisir 5 % ou 0 %" }), [], null, "idle", timeOf), ctx);
    expect(decide).toContain("data-blocker>choisir 5 % ou 0 %");
    expect(decide).not.toContain("text-accent-ink\"><span class=\"font-semibold\">Bloqué sur");
  });
  test("'Draft posted' in 'Waiting on you': grey, no lamp, no 'rest of the thread' on a gated card", () => {
    const s = sujet({ draft: "", gate: "release", status: "gate", action: "lancer la release", posted: "2026-09-21T11:40:00Z https://acme.slack.com/archives/C1/p1" });
    const now = Date.parse("2026-09-21T12:00:00Z");
    const quiet = postedLine(s, ctx, now, now + 20_000, "attend");
    expect(quiet).toContain("text-muted");
    expect(quiet).not.toContain("lamp");
    expect(quiet).not.toContain("la suite du fil");
    expect(quiet).toContain("Annuler (20 s)");
    expect(quiet).toContain("il y a 20 min");
    const loud = postedLine(sujet({ ...s, status: "waiting", gate: "none" }), ctx, now, null, "attente");
    expect(loud).toContain("lamp-green");
    expect(loud).toContain("la carte attend la suite du fil");
  });
});

describe("the reason before the button", () => {
  const s = sujet({ gate: "merge", action: "merger", ask: "Ivan demande si le fix peut partir.", proposal: "Merger vers dev maintenant.", summary: "Le gel venait d'un statut mal lu." });
  test("the need and the proposal before the action box; the summary folded in the context, a single folding level", () => {
    const html = lineView(classify(s, [], null, "idle", timeOf), ctx);
    const panel = html.indexOf(`id="card-${base.key}"`);
    expect(html.indexOf("Ivan demande si le fix peut partir.")).toBeLessThan(html.indexOf("data-gocard"));
    expect(html.indexOf("Merger vers dev maintenant.")).toBeLessThan(html.indexOf("data-gocard"));
    expect(html.indexOf("Le gel venait d")).toBeGreaterThan(panel);
    expect(html).toContain(`data-toggle="card-${base.key}"`);
    expect(html).not.toContain(">Détails</button>");
  });
  test("a single label column in the context", () => {
    const html = lineView(classify(sujet({ ...s, due: "2026-09-21 18:00 release", why: "Ivan te tague", unverified: "rien" }), [], null, "idle", timeOf), ctx);
    // toutes les lignes à étiquette (dt) partagent la même grille
    const grids = [...html.matchAll(/<div class="(grid [^"]*)"[^>]*><dt/g)].map((m) => m[1]);
    expect(grids.length).toBeGreaterThan(3);
    expect(new Set(grids).size).toBe(1);
  });
  test("the origin thread is the link of the meta line, not repeated in the footer", () => {
    const html = lineView(classify(sujet({ threads: [base.key, "linear:ENG-2545"] }), [], null, "idle", timeOf), ctx);
    expect(html).toMatch(/Grace dans <a href="https:\/\/acme\.slack\.com\/archives\/C0ACMECMP01\/p1788788755025729"[^>]*>#acme-compliance<\/a>/);
    expect(html.match(/>#acme-compliance<\/a>/g)?.length).toBe(1);
  });
  test("the session's last word only when it is newer than the card", () => {
    const newer = { text: "Je merge sur ton go.", at: "2026-09-21T11:00:00Z" };
    const html = lineView(classify(sujet({ gate: "decision", action: "" }), [], null, "idle", timeOf, null, null, newer), ctx);
    expect(html).toContain("data-word");
    expect(html).toContain("Je merge sur ton go.");
    const older = { ...newer, at: "2026-09-21T06:00:00Z" };
    expect(lineView(classify(sujet({ gate: "decision", action: "" }), [], null, "idle", timeOf, null, null, older), ctx)).not.toContain("data-word");
  });
  test("the session's state is said once, in the status line", () => {
    const since = "2026-09-21T11:21:00Z";
    const gate = lineView(classify(sujet({ gate: "merge", action: "merger" }), [], null, "idle", timeOf, null, since), ctx);
    expect(gate.match(/data-status-kind=/g)?.length).toBe(1);
    expect(gate).not.toContain("attend ton go");
    expect(gate).not.toMatch(/data-pane[^l]/);
    const idle = lineView(classify(sujet({ status: "waiting", gate: "none", waiting: "X" }), [], null, "idle", timeOf, null, since), ctx);
    expect(idle).toContain('data-status-kind="wait"');
    expect(idle).not.toContain("au repos");
  });
});

describe("blocks", () => {
  test("'In progress' becomes 'Working' and 'Waiting on someone', longest wait first", () => {
    const work = sujet({ key: "CW:1", threads: ["CW:1"], letter: "W", sessionId: "sw", status: "working", gate: "none" });
    const w1 = sujet({ key: "C1:1", threads: ["C1:1"], letter: "B", sessionId: "s1", status: "waiting", gate: "none", waiting: "Grace", updatedAt: "2026-09-21T10:00:00Z" });
    const w2 = sujet({ key: "C2:1", threads: ["C2:1"], letter: "C", sessionId: "s2", status: "waiting", gate: "none", waiting: "Hooli", updatedAt: "2026-09-16T10:00:00Z" });
    const m = buildBoard(input({ sujets: [work, w1, w2], running: new Map([["sw", "busy"], ["s1", "idle"], ["s2", "idle"]]) }));
    expect(m.travail.map((l) => l.sujet.letter)).toEqual(["W"]);
    expect(m.attente.map((l) => l.sujet.letter)).toEqual(["C", "B"]);
    const html = boardView(m, ctx);
    expect(html).toContain('id="bloc-travail"');
    expect(html).toContain('id="bloc-attente"');
    expect(html).toContain("lamp lamp-blue lit");
    expect(html.indexOf('data-letter="C"')).toBeLessThan(html.indexOf('data-letter="B"'));
  });
  test("a block's explanation is in title, the shortcuts are no longer shown", () => {
    const html = boardView(buildBoard(input({ sujets: [base] })), ctx);
    expect(html).toMatch(/title="une porte ouverte par la session[^"]*">T'attend<\/span>/);
    expect(html).not.toContain("<kbd>j</kbd>");
  });
  test("the radar is folded into a one-line summary under 'Waiting on you'", () => {
    const now = new Date(2026, 8, 29, 17, 0);
    const s = sujet({ status: "waiting", waiting: "Zoé", due: "2026-09-29 16:00 notice | 2026-09-29 18:00 merge" });
    const deliveries = new Map([[base.key, [{ repo: "api", iid: 1042, title: "Draft: fix payouts", url: "https://gitlab.com/x", stage: "review" as const, label: "en revue", blocker: null, at: null }]]]);
    const html = boardView(buildBoard(input({ now, sujets: [s], deliveries })), { ...ctx, now: now.getTime() });
    expect(html).toMatch(/<details class="group" id="radar" data-radar>/);
    expect(html).toContain("1 MR vers la prod · 2 échéances &lt; 36 h");
    expect(html).toContain("dont 1 dépassée");
    expect(html.indexOf('id="bloc-attend"')).toBeLessThan(html.indexOf('id="radar"'));
    expect(html.indexOf('id="radar"')).toBeLessThan(html.indexOf('id="bloc-revoir"'));
    expect(html).not.toContain("Draft: fix payouts");
    expect(html).toContain(">fix payouts</span>");
  });
  test("an MR title loses its 'Draft:' prefix", () => {
    expect(mrTitle("Draft: fix(payouts): relire")).toBe("fix(payouts): relire");
    expect(mrTitle("[Draft] x")).toBe("x");
    expect(mrTitle("fix: draft mode")).toBe("fix: draft mode");
  });
});

describe("bar and colours", () => {
  const page = boardPage("");
  test("links outside the waiting blue, in both themes", () => {
    const links = [...page.matchAll(/--color-link: (#[0-9a-f]{6})/g)].map((m) => m[1]);
    const waits = [...page.matchAll(/--color-wait: (#[0-9a-f]{6})/g)].map((m) => m[1]);
    expect(links.length).toBe(3);
    for (const l of links) expect(waits).not.toContain(l);
  });
  test("Refresh as tertiary, 'list' instead of 'pane', terminal button anchored in the bar", () => {
    expect(page).toMatch(/<button type="button" data-refresh class="[^"]*text-muted[^"]*"[^>]*>Rafraîchir<\/button>/);
    expect(page).toContain(">liste</a>");
    expect(page).not.toContain(">volet</a>");
    expect(page).not.toMatch(/id="drawer-show"[^>]*fixed/);
    expect(page.indexOf('id="drawer-show"')).toBeLessThan(page.indexOf("</nav>"));
  });
  test("short and readable placeholder", () => {
    const html = lineView(classify(base, [], null, "idle", timeOf), ctx);
    expect(html).toContain('placeholder="Consigne à la session…"');
    expect(html).toContain("placeholder:text-muted ");
    expect(html).not.toContain("placeholder:text-muted/60");
  });
  test("only four text sizes in the card rendering", () => {
    const html = boardView(buildBoard(input({ sujets: [base, sujet({ key: "C9:1", threads: ["C9:1"], letter: "Z", status: "waiting", gate: "none", waiting: "X" })] })), ctx);
    const sizes = new Set([...html.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)].map((m) => m[1]));
    for (const s of sizes) expect(["11.5", "12.5", "13.5", "15", "17"]).toContain(s);
  });
});

describe("freshness of what waits on you", () => {
  const H = 3_600_000;
  test("from green to red, then darker and darker beyond a day", () => {
    expect(freshness(0)).toEqual({ h: 120, k: 0 });
    expect(freshness(2 * H).h).toBeGreaterThan(30);
    expect(freshness(2 * H).h).toBeLessThan(80);
    expect(freshness(24 * H)).toEqual({ h: 0, k: 0 });
    expect(freshness(48 * H)).toEqual({ h: 0, k: 0.5 });
    expect(freshness(10 * 24 * H)).toEqual({ h: 0, k: 1 });
  });
  test("the age starts at the beginning of the gate: a relaunch that goes back through working does not reset it", () => {
    const history = [
      { at: "2026-09-29T10:00:00Z", what: "status=waiting gate=none" },
      { at: "2026-09-30T08:00:00Z", what: "status=gate gate=draft draft=Bonjour" },
      { at: "2026-10-01T07:06:00Z", what: "status=working" },
      { at: "2026-10-01T07:07:00Z", what: "status=gate gate=draft draft=Bonjour Bob" },
    ];
    expect(gateSince({ status: "gate", updatedAt: "2026-10-01T07:07:00Z", history })).toBe("2026-09-30T08:00:00Z");
    // un draft posté (waiting) clôt l'attente : la porte suivante repart de zéro
    const after = [...history, { at: "2026-10-01T08:00:00Z", what: "status=waiting" }, { at: "2026-10-01T09:00:00Z", what: "status=gate gate=decision" }];
    expect(gateSince({ status: "gate", updatedAt: "2026-10-01T09:00:00Z", history: after })).toBe("2026-10-01T09:00:00Z");
    expect(gateSince({ status: "gate", updatedAt: "2026-10-01T09:00:00Z", history: [] })).toBe("2026-10-01T09:00:00Z");
  });
});
