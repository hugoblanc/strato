import { expect, test } from "bun:test";
import { diveMarkdown, itermTabScript, permalinkOfKey, shellQuote, type Sujet } from "./lib.ts";

test("by default, the tab opens in the starting terminal window, without a split or a less sheet", () => {
  const script = itermTabScript("F · titre", "cd '/t' && claude attach abc", { anchorSessionId: "ANCHOR-1" });
  expect(script).toContain('if unique ID of aSession is "ANCHOR-1" then set w to (contents of aWindow)');
  expect(script).toContain('if w is missing value then error "starting terminal not found"');
  expect(script).toContain("tell w to set t to (create tab with default profile)");
  expect(script).toContain('set name to "F · titre"');
  expect(script).toContain(`write text "cd '/t' && claude attach abc"`);
  expect(script).toContain('return ((id of w) as text) & "," & (unique ID of s)');
  expect(script).not.toContain("split");
  expect(script).not.toContain("less");
  expect(script).not.toContain("current window");
  expect(script).not.toContain("create window");
});

test("--window: the tab goes into the dive window, created if it disappeared, never into the active window", () => {
  const first = itermTabScript("F", "a", { windowId: null });
  expect(first).toContain("create window with default profile");
  expect(first).not.toContain("first window whose id");
  expect(first).not.toContain("current window");
  expect(first).not.toContain("split");

  const again = itermTabScript("G", "a", { windowId: 4242 });
  expect(again).toContain("set w to (first window whose id is 4242)");
  expect(again).toContain("tell w to set t to (create tab with default profile)");
  expect(again).not.toContain("current window");
});

test("the AppleScript escapes quotes and backslashes", () => {
  const script = itermTabScript('F · "x"', 'echo "a\\b"', { anchorSessionId: 'A"1' });
  expect(script).toContain('set name to "F · \\"x\\""');
  expect(script).toContain('write text "echo \\"a\\\\b\\""');
  expect(script).toContain('unique ID of aSession is "A\\"1"');
});

const sujet: Sujet = {
  key: "C0ACMESLS01:1789390274.707559",
  threads: ["C0ACMESLS01:1789390274.707559", "linear:ENG-2636"],
  letter: "F",
  title: "Pas de risk hold sur une candidature",
  channel: "#sales",
  permalink: "https://acme.slack.com/archives/C0ACMESLS01/p1789390274707559",
  asker: "Grace",
  sessionId: "6d902ef5-0000",
  shortId: "6d902ef5",
  name: "F · #sales · Grace",
  status: "waiting",
  gate: "none",
  waiting: "Grace",
  next: "attendre Grace",
  summary: "Réponse postée à Grace.",
  ask: "Pourquoi BLAZE MOTO n'a pas de hold",
  createdAt: "2026-09-14T14:40:40Z",
  updatedAt: "2026-09-14T16:00:00Z",
  history: [],
};

test("a key gives the Slack link of the root message or the Linear link", () => {
  expect(permalinkOfKey("C0ACMESLS01:1789390274.707559")).toBe("https://acme.slack.com/archives/C0ACMESLS01/p1789390274707559");
  expect(permalinkOfKey("linear:ENG-2636")).toBe("https://linear.app/acme/issue/ENG-2636");
  expect(permalinkOfKey("n'importe quoi")).toBeNull();
});

test("the sheet gathers card, threads, report and session", () => {
  const md = diveMarkdown(
    sujet,
    [{ key: sujet.key, permalink: sujet.permalink, messages: [{ at: "09-14 16:40", from: "Grace", text: "Mind checking why there's no risk hold?" }] }],
    "# Rapport\nLe même homme que MHD.",
    "2026-09-15T08:00:00Z",
  );
  expect(md).toContain("# F · Pas de risk hold sur une candidature");
  expect(md).toContain("- Demande : Pourquoi BLAZE MOTO n'a pas de hold");
  expect(md).toContain("- Pourquoi toi : non renseigné");
  expect(md).toContain("- https://linear.app/acme/issue/ENG-2636");
  expect(md).toContain("[09-14 16:40] Grace : Mind checking why there's no risk hold?");
  expect(md).toContain("Le même homme que MHD.");
  expect(md).toContain("claude attach 6d902ef5");
});

test("the sheet says clearly when there is no report", () => {
  expect(diveMarkdown(sujet, [], null, "t")).toContain("pas de rapport");
});

test("single quotes for the shell", () => {
  expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
});
