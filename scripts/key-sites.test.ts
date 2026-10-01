/**
 * The sites that used to split a key on ":" by hand, fed a key of another tool: each one yields that tool's own label
 * or nothing, never a Slack channel (docs/design/providers.md, section 15, seam).
 */
import { describe, expect, test } from "bun:test";
import { classify as boardClassify, lineView } from "./board.ts";
import { draftDestination, eventLine, reportFile, type Sujet, threadOfKey } from "./lib.ts";
import { sujetView } from "./panel.ts";

describe("a key of another tool", () => {
  const KEY = "tickets:T-12";
  const sujet = (o: Partial<Sujet> = {}): Sujet => ({
    key: "C0ACME0001:1759219200.000100",
    threads: ["C0ACME0001:1759219200.000100"],
    letter: "A",
    title: "Devis acme",
    channel: "#acme-requests",
    permalink: "https://acme.slack.com/archives/C0ACME0001/p1759219200000100",
    asker: "Peter",
    sessionId: "s",
    shortId: "s1",
    name: "n",
    status: "waiting",
    gate: "none",
    waiting: "",
    next: "",
    summary: "",
    createdAt: "2026-09-30T08:00:00Z",
    updatedAt: "2026-09-30T08:00:00Z",
    history: [],
    ...o,
  });
  const ctx = { timeOf: (iso: string) => iso.slice(5, 16), now: Date.parse("2026-09-30T12:00:00Z") };

  test("threadOfKey, the event line and the draft destination never read it as a Slack channel", () => {
    expect(threadOfKey(KEY)).toBeNull();
    const open = sujet({ letter: "B", key: "CTICKETS:1759219200.000100", threads: ["CTICKETS:1759219200.000100"] });
    const line = eventLine("mention", { key: KEY, from: "Bob", channel: "Tickets", text: "hi", permalink: "-" }, [open]);
    expect(line).not.toContain("open topics in this channel");
    expect(draftDestination({ key: KEY, draftTo: "", channel: "Tickets" })).toHaveProperty("error");
    expect(reportFile(KEY)).toMatch(/^tickets_T-12-[0-9a-f]{6}\.md$/);
  });

  test("the board and the panel label it with its tool, never as Slack", () => {
    const s = sujet({ threads: ["C0ACME0001:1759219200.000100", KEY] });
    const board = lineView(boardClassify(s, [], null, null, ctx.timeOf), ctx);
    expect(board).toContain("tickets T-12");
    expect(board).not.toContain("Slack tickets");
    const panel = sujetView(s, [{ key: KEY, permalink: KEY, messages: [] }], null, ctx);
    expect(panel).toContain("tickets T-12");
    expect(panel).not.toContain("Slack tickets");
  });
});
