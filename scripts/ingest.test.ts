/**
 * L'entrée Slack de l'écoute : tri, rattrapages, socket, appels à claude. Les modules réseau (app/, commands/) sont
 * importés après avoir posé un dossier d'état jetable, et Slack est remplacé par un faux fetch : aucun appel réel.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useSettings } from "./core/settings.ts";
import { classify, type Config, draftDestination, matchFromEditEvent, nextSyncCursor, type SlackMatch } from "./lib.ts";
import { TEST_SETTINGS } from "./test-setup.ts";

const STATE_DIR = mkdtempSync(join(tmpdir(), "aiguilleur-ingest-"));
process.env.AIGUILLEUR_STATE = STATE_DIR;
// env.ts pose le profil lu dans l'état jetable : on remet celui des tests juste après
const env = await import("./app/env.ts");
useSettings(TEST_SETTINGS);
afterAll(() => useSettings(TEST_SETTINGS));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Remplace Slack : chaque appel passe par `answer(méthode, paramètres)`, qui rend le corps JSON ou lève (réseau coupé). */
type SlackCall = { method: string; params: Record<string, string> };
function fakeSlack(answer: (c: SlackCall) => Record<string, unknown>): SlackCall[] {
  const calls: SlackCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const params = Object.fromEntries(url.searchParams);
    if (init?.body instanceof URLSearchParams) Object.assign(params, Object.fromEntries(init.body));
    const call = { method: url.pathname.replace("/api/", ""), params };
    calls.push(call);
    return Response.json(answer(call));
  }) as typeof fetch;
  return calls;
}
const offline = () => {
  throw new TypeError("fetch failed");
};

const slackApp = await import("./app/slack.ts");

test("the tests' state is the throwaway folder, never an installation's", () => {
  expect(env.STATE).toBe(STATE_DIR);
});

describe("draft destination: channel id", () => {
  const s = { key: "C0ACME0001:1790000000.000100", channel: "#acme" };
  test("an uppercase word is not a channel id", () => {
    expect(draftDestination({ ...s, draftTo: "#acme, fil DASHBOARD, réponse à Bob" })).toEqual({ channel: "C0ACME0001", ts: "1790000000.000100" });
    expect(draftDestination({ ...s, draftTo: "#acme, CHARGEBACKS du mois" })).toEqual({ channel: "C0ACME0001", ts: "1790000000.000100" });
  });
  test("a real id is still recognised", () => {
    expect(draftDestination({ ...s, draftTo: "#acme-risk (C0ACME0009), nouveau message" })).toEqual({ channel: "C0ACME0009", ts: null });
  });
});

const cfg: Config = { me: "UALICE", subteams: ["SACME"], watchChannels: ["C0ACME0002"], ignoreChannels: [], ignoreAuthors: ["Acme Bot"] };
const ROOT = "1790000000.000100";
const REPLY_TS = "1790000100.000200";

describe("channel and name when Slack does not answer", () => {
  const BASE = "https://acme.slack.com";
  test("a DM stays a DM when conversations.info fails, and the failure is not cached", async () => {
    fakeSlack(offline);
    const ev = { type: "message", ts: REPLY_TS, channel: "D0ACME0001", channel_type: "im", user: "UBOB", text: "tu as vu ?" };
    const m = await slackApp.matchFromEvent(ev, BASE, cfg);
    expect(m && classify(m, cfg, new Set())).toBe("dm");
    // un second message du même DM, Slack toujours injoignable : toujours un DM
    const again = await slackApp.matchFromEvent({ ...ev, ts: "1790000200.000300" }, BASE, cfg);
    expect(again && classify(again, cfg, new Set())).toBe("dm");
    // sans channel_type (relecture d'un fil), l'id en D suffit
    expect((await slackApp.channelOf("D0ACME0002")).is_im).toBe(true);
  });

  test("a channel whose conversations.info failed is asked again on the next message", async () => {
    fakeSlack(offline);
    expect((await slackApp.channelOf("C0ACME0004")).name).toBeUndefined();
    const calls = fakeSlack(() => ({ ok: true, channel: { id: "C0ACME0004", name: "acme-sales" } }));
    expect((await slackApp.channelOf("C0ACME0004")).name).toBe("acme-sales");
    expect(calls.map((c) => c.method)).toEqual(["conversations.info"]);
  });

  test("a group DM is read from channel_type", async () => {
    fakeSlack(offline);
    expect((await slackApp.channelOf("C0ACME0005", "mpim")).is_mpim).toBe(true);
  });

  test("users.info failing: the id serves as the name, without being written to users.json", async () => {
    fakeSlack(offline);
    expect(await slackApp.nameOf("UBOB")).toBe("UBOB");
    expect(slackApp.users.has("UBOB")).toBe(false);
    expect(env.readJson<Record<string, string>>(env.F.users, {}).UBOB).toBeUndefined();
    fakeSlack(() => ({ ok: true, user: { profile: { display_name: "Bob" } } }));
    expect(await slackApp.nameOf("UBOB")).toBe("Bob");
    expect(env.readJson<Record<string, string>>(env.F.users, {}).UBOB).toBe("Bob");
  });
});

/** Capture stdout ; `failFirst` fait échouer la première écriture (disque plein, pipe cassé). */
function captureOut(failFirst = false): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = process.stdout.write;
  let pending = failFirst;
  process.stdout.write = ((s: string) => {
    if (pending) {
      pending = false;
      throw new Error("écriture impossible");
    }
    lines.push(String(s).trimEnd());
    return true;
  }) as typeof process.stdout.write;
  return { lines, restore: () => (process.stdout.write = orig) };
}

const watchCmd = await import("./commands/watch.ts");

describe("seen after the line is output", () => {
  const inWatched = (ts: string): SlackMatch => ({ ts, user: "UBOB", text: "le paiement acme bloque", channel: { id: "C0ACME0002" }, permalink: `https://acme.slack.com/archives/C0ACME0002/p${ts.replace(".", "")}` });

  test("an error during output leaves the message unread and says so on stdout", async () => {
    fakeSlack(() => ({ ok: true, user: { profile: { display_name: "Bob" } } }));
    const seen = new Set<string>();
    const m = inWatched("1790000300.000100");
    const cap = captureOut(true);
    try {
      await watchCmd.processMatches([m], cfg, seen, new Set());
    } finally {
      cap.restore();
    }
    expect(seen.has("C0ACME0002:1790000300.000100")).toBe(false);
    expect(cap.lines.some((l) => l.startsWith(`[strato] triage error ${m.permalink}: `))).toBe(true);

    // au passage suivant, le message sort pour de bon et devient lu
    const cap2 = captureOut();
    try {
      await watchCmd.processMatches([m], cfg, seen, new Set());
    } finally {
      cap2.restore();
    }
    expect(cap2.lines.some((l) => l.includes("le paiement acme bloque"))).toBe(true);
    expect(seen.has("C0ACME0002:1790000300.000100")).toBe(true);
  });

  test("a message ignored by triage is marked as read", async () => {
    fakeSlack(offline);
    const seen = new Set<string>();
    await watchCmd.processMatches([{ ts: "1790000400.000100", user: "UBOB", text: "rien", channel: { id: "C0ACME0009" } }], cfg, seen, new Set());
    expect(seen.has("C0ACME0009:1790000400.000100")).toBe(true);
  });
});

describe("mentions outside .text", () => {
  const none = new Set<string>();
  const base = { ts: "1790000500.000100", user: "UBOB", channel: { id: "C0ACME0007" } };
  test("a mention in the blocks (rich_text) is a mention", () => {
    const blocks = [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "regarde " }, { type: "user", user_id: "UALICE" }] }] }];
    expect(classify({ ...base, text: "regarde", blocks }, cfg, none)).toBe("mention");
    const group = [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "usergroup", usergroup_id: "SACME" }] }] }];
    expect(classify({ ...base, text: "", blocks: group }, cfg, none)).toBe("mention");
  });
  test("a mention in the pretext or a section of an attachment is a mention", () => {
    expect(classify({ ...base, text: "alerte", attachments: [{ pretext: "pour <@UALICE>" }] }, cfg, none)).toBe("mention");
    expect(classify({ ...base, text: "alerte", attachments: [{ fallback: "x", blocks: [{ type: "section", text: { type: "mrkdwn", text: "<@UALICE> à toi" } }] }] }, cfg, none)).toBe("mention");
  });
  test("a mention of someone else in the blocks makes a third party in a watched channel", () => {
    const blocks = [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "user", user_id: "UBOB" }] }] }];
    expect(classify({ ...base, channel: { id: "C0ACME0002" }, text: "vu ?", blocks }, cfg, none)).toBe("tiers");
  });
});

describe("message edited to mention the person served", () => {
  const BASE = "https://acme.slack.com";
  const edit = (before: string, after: string, channel = "C0ACME0007") => ({
    type: "message",
    subtype: "message_changed",
    channel,
    message: { type: "message", ts: "1790000600.000100", user: "UBOB", text: after },
    previous_message: { type: "message", ts: "1790000600.000100", user: "UBOB", text: before },
  });

  test("only an edit that adds the mention becomes a message", () => {
    const m = matchFromEditEvent(edit("tu peux regarder ?", "<@UALICE> tu peux regarder ?"), { id: "C0ACME0007" }, BASE, cfg);
    expect(m?.ts).toBe("1790000600.000100");
    expect(m?.previous?.text).toBe("tu peux regarder ?");
    expect(matchFromEditEvent(edit("<@UALICE> tu peux", "<@UALICE> tu peux regarder ?"), { id: "C0ACME0007" }, BASE, cfg)).toBeNull();
    expect(matchFromEditEvent(edit("tu peux", "tu peux regarder ?"), { id: "C0ACME0007" }, BASE, cfg)).toBeNull();
  });

  test("the listener outputs the mention even if the previous version was already read", async () => {
    fakeSlack(({ method }) => (method === "users.info" ? { ok: true, user: { profile: { display_name: "Bob" } } } : { ok: true, channel: { id: "C0ACME0007", name: "acme-general" } }));
    const seen = new Set(["C0ACME0007:1790000600.000100"]);
    const m = await slackApp.matchFromEvent(edit("tu peux regarder ?", "<@UALICE> tu peux regarder ?"), BASE, cfg);
    const cap = captureOut();
    try {
      await watchCmd.processMatches(m ? [m] : [], cfg, seen, new Set());
    } finally {
      cap.restore();
    }
    expect(cap.lines.filter((l) => l.includes("tu peux regarder")).length).toBe(1);
  });

  test("no second line if the previous version was already sent up (watched channel)", async () => {
    fakeSlack(({ method }) => (method === "users.info" ? { ok: true, user: { profile: { display_name: "Bob" } } } : { ok: true, channel: { id: "C0ACME0002", name: "acme-requests" } }));
    const seen = new Set(["C0ACME0002:1790000600.000100"]);
    const m = await slackApp.matchFromEvent(edit("souci paiement", "<@UALICE> souci paiement", "C0ACME0002"), BASE, cfg);
    expect(m).not.toBeNull();
    const cap = captureOut();
    try {
      await watchCmd.processMatches(m ? [m] : [], cfg, seen, new Set());
    } finally {
      cap.restore();
    }
    expect(cap.lines).toEqual([]);
  });
});

const claudeApp = await import("./app/claude.ts");

describe("calls to claude without blocking the listener", () => {
  /** Un faux binaire claude : un script shell dans l'état jetable. */
  const fakeBin = (name: string, body: string) => {
    const path = join(STATE_DIR, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };

  test("claude agents not answering: null after the cap, and the loop keeps running meanwhile", async () => {
    const slow = fakeBin("slow-agents", "sleep 5");
    let ticks = 0;
    const t = setInterval(() => ticks++, 20);
    const started = Date.now();
    const rows = await claudeApp.agentsBySessionAsync({ bin: slow, timeoutMs: 300 });
    clearInterval(t);
    expect(rows).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(ticks).toBeGreaterThan(5);
  });

  test("claude agents answering: the lines are read", async () => {
    const ok = fakeBin("ok-agents", "echo '[]'");
    expect((await claudeApp.agentsBySessionAsync({ bin: ok }))?.size).toBe(0);
  });

  test("claude --bg returns the short id, even if a grandchild keeps the output open", async () => {
    const bg = fakeBin("bg", "echo 'backgrounded · acme42'\nsleep 5 &");
    const started = Date.now();
    expect(await claudeApp.spawnBackgroundAsync(["bonjour"], { bin: bg })).toBe("acme42");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("claude --bg stuck: an error after the cap", async () => {
    const stuck = fakeBin("bg-stuck", "sleep 5");
    const started = Date.now();
    await expect(claudeApp.spawnBackgroundAsync(["bonjour"], { bin: stuck, timeoutMs: 300 })).rejects.toThrow("did not return within");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

/** Une WebSocket factice : rien ne part sur le réseau, le test pilote les frames. */
class FakeWs {
  static last: FakeWs | null = null;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  sent: string[] = [];
  pings = 0;
  closed = false;
  private listeners = new Map<string, (() => void)[]>();
  constructor(readonly url: string) {
    FakeWs.last = this;
  }
  addEventListener(type: string, f: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), f]);
  }
  emit(type: string) {
    for (const f of this.listeners.get(type) ?? []) f();
  }
  send(s: string) {
    this.sent.push(s);
  }
  ping() {
    this.pings++;
  }
  close() {
    this.closed = true;
  }
  terminate() {
    this.closed = true;
  }
}
const FakeWsClass = FakeWs as unknown as new (url: string) => WebSocket;
const openOk = (async () => Response.json({ ok: true, url: "wss://acme.invalid/socket" })) as unknown as typeof fetch;

describe("Socket Mode connection", () => {
  const socket = { ws: null as WebSocket | null };

  test("an HTML page on open: the connection ends 'coupee', with the Retry-After", async () => {
    const html = (async () => new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "retry-after": "7" } })) as unknown as typeof fetch;
    const r = await watchCmd.connexionSocket("xapp-acme", () => {}, socket, { fetch: html });
    expect(r.fin).toBe("coupee");
    expect(r.refus).toContain("HTTP 502");
    expect(r.retryAfterSec).toBe(7);
  });

  test("network down: 'coupee' without a refusal line; revoked token: fatal", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await watchCmd.connexionSocket("xapp-acme", () => {}, socket, { fetch: down })).toEqual({ fin: "coupee" });
    const revoked = (async () => Response.json({ ok: false, error: "token_revoked" })) as unknown as typeof fetch;
    expect((await watchCmd.connexionSocket("xapp-acme", () => {}, socket, { fetch: revoked })).fin).toBe("fatal");
  });

  test("a silent socket is pinged, then closed by the watchdog even without onclose", async () => {
    const r = await watchCmd.connexionSocket("xapp-acme", () => {}, socket, { fetch: openOk, WebSocket: FakeWsClass, silenceMs: 120, checkMs: 10 });
    expect(r.fin).toBe("coupee");
    expect(FakeWs.last?.pings).toBeGreaterThan(0);
    expect(FakeWs.last?.closed).toBe(true);
    expect(socket.ws).toBeNull();
  });

  test("pings from Slack keep the socket alive; an event is acknowledged and forwarded", async () => {
    const events: Record<string, any>[] = [];
    const done = watchCmd.connexionSocket("xapp-acme", (e) => events.push(e), socket, { fetch: openOk, WebSocket: FakeWsClass, silenceMs: 120, checkMs: 10 });
    await Bun.sleep(5);
    const ws = FakeWs.last as FakeWs;
    for (let i = 0; i < 8; i++) {
      ws.emit("ping");
      await Bun.sleep(30);
    }
    expect(ws.closed).toBe(false);
    ws.onmessage?.({ data: JSON.stringify({ envelope_id: "env-1", type: "events_api", payload: { event: { type: "message", ts: "1", channel: "C0ACME0001" } } }) } as MessageEvent);
    expect(ws.sent).toEqual([JSON.stringify({ envelope_id: "env-1" })]);
    expect(events.length).toBe(1);
    ws.onmessage?.({ data: JSON.stringify({ type: "disconnect" }) } as MessageEvent);
    ws.onclose?.({} as CloseEvent);
    expect((await done).fin).toBe("propre");
  });

  test("an opening failure is reported only once, then one line on recovery", () => {
    const lines: string[] = [];
    const suivi = watchCmd.suiviOuverture((l) => lines.push(l));
    suivi.refus("internal_error", false);
    suivi.refus("internal_error", false);
    suivi.refus("réponse illisible de Slack (HTTP 502)", false);
    expect(lines.length).toBe(1);
    suivi.ouverte();
    suivi.ouverte();
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain("back after");
    suivi.refus("token_revoked", true);
    expect(lines[2]).toContain("listener stopped");
  });
});

describe("catch-up cursor", () => {
  const prev = 1_790_000_000;
  const started = 1_790_000_600;
  test("a failed pass does not move the cursor forward", () => {
    expect(nextSyncCursor(prev, started, { ok: false, complete: true })).toBe(prev);
  });
  test("a complete pass moves it to its start", () => {
    expect(nextSyncCursor(prev, started, { ok: true, complete: true, oldestReadSec: prev + 10 })).toBe(started);
  });
  test("an incomplete pass does not go beyond the oldest message read, and never moves back", () => {
    expect(nextSyncCursor(prev, started, { ok: true, complete: false, oldestReadSec: prev + 200 })).toBe(prev + 200);
    expect(nextSyncCursor(prev, started, { ok: true, complete: false, oldestReadSec: prev - 50 })).toBe(prev);
    expect(nextSyncCursor(prev, started, { ok: true, complete: false })).toBe(prev);
  });

  test("a thread unreadable for a transient reason makes the thread catch-up incomplete; an archived channel does not", async () => {
    writeFileSync(env.F.sujets, JSON.stringify([{ key: `C0ACME0001:${ROOT}`, status: "open", createdAt: "2026-09-30T08:00:00Z", updatedAt: "2026-09-30T08:00:00Z", title: "acme", letter: "A" }]));
    try {
      fakeSlack(offline);
      expect((await watchCmd.backfillThreads(cfg, new Set(), new Set(), "https://acme.slack.com", prev)).failed).toBe(1);
      fakeSlack(() => ({ ok: false, error: "is_archived" }));
      expect((await watchCmd.backfillThreads(cfg, new Set(), new Set(), "https://acme.slack.com", prev)).failed).toBe(0);
    } finally {
      writeFileSync(env.F.sujets, "[]");
    }
  });
});

describe("reading a long thread", () => {
  /** Un fil de `n` réponses servi par pages de 200, comme conversations.replies. */
  const longThread = (n: number) => {
    const all = Array.from({ length: n }, (_, i) => ({ ts: `17900${String(i).padStart(5, "0")}.000100`, user: "UBOB", text: `réponse ${i}` }));
    return fakeSlack(({ method, params }) => {
      if (method === "users.info") return { ok: true, user: { profile: { display_name: "Bob" } } };
      if (method === "conversations.info") return { ok: true, channel: { id: params.channel, name: "acme-general" } };
      const from = Number(params.cursor ?? 0);
      const next = from + 200 < all.length ? String(from + 200) : "";
      return { ok: true, messages: all.slice(from, from + 200), response_metadata: { next_cursor: next } };
    });
  };

  test("conversations.replies follows next_cursor beyond 200 messages", async () => {
    longThread(450);
    const dump = await slackApp.threadDump(`C0ACME0001:${ROOT}`);
    expect(dump?.messages.length).toBe(450);
  });

  test("reading stops at 2,000 messages", async () => {
    const calls = longThread(2500);
    const dump = await slackApp.threadDump(`C0ACME0001:${ROOT}`);
    expect(dump?.messages.length).toBe(2000);
    expect(calls.filter((c) => c.method === "conversations.replies").length).toBe(10);
  });
});

describe("DMs of other people who installed the app", () => {
  const BASE = "https://acme.slack.com";
  const cfg2: Pick<Config, "me" | "subteams"> = { me: "UALICE", subteams: [] };
  const dm = (channel: string, ts: string) => ({ type: "message", ts, channel, channel_type: "im", user: "UBOB", text: "tu as vu ?" });
  test("a DM between two colleagues (channel_not_found with the served person's token) is ignored, and the answer cached", async () => {
    const calls = fakeSlack((c) => (c.method === "conversations.info" ? { ok: false, error: "channel_not_found" } : { ok: true }));
    expect(await slackApp.matchFromEvent(dm("D0FOREIGN01", "1790000300.000100"), BASE, cfg2)).toBeNull();
    expect(await slackApp.matchFromEvent(dm("D0FOREIGN01", "1790000300.000200"), BASE, cfg2)).toBeNull();
    expect(calls.filter((c) => c.method === "conversations.info")).toHaveLength(1);
  });
  test("a DM to her goes through, and is checked only once", async () => {
    const calls = fakeSlack((c) => (c.method === "conversations.info" ? { ok: true, channel: { id: c.params.channel, is_im: true } } : { ok: true }));
    const m = await slackApp.matchFromEvent(dm("D0MINE00001", "1790000400.000100"), BASE, cfg2);
    expect(m && classify(m, cfg, new Set())).toBe("dm");
    await slackApp.matchFromEvent(dm("D0MINE00001", "1790000400.000200"), BASE, cfg2);
    expect(calls.filter((c) => c.method === "conversations.info")).toHaveLength(1);
  });
  test("Slack unreachable: the DM is kept, no risk of losing one", async () => {
    fakeSlack(offline);
    const m = await slackApp.matchFromEvent(dm("D0UNKNOWN01", "1790000500.000100"), BASE, cfg2);
    expect(m && classify(m, cfg, new Set())).toBe("dm");
  });
});
