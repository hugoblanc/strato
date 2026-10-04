import { describe, expect, test } from "bun:test";
import {
  agentText,
  CITED_MAX,
  citations,
  claudeRefs,
  cleanHumanText,
  clip,
  emptyTranscript,
  FIRST_REQUEST_MAX,
  foldTranscript,
  humanRequestText,
  itermTtyScript,
  looksLikeClaude,
  parsePs,
  repoLabel,
  sessionContext,
  type TranscriptEntry,
  ttyName,
} from "./lib.ts";

describe("iTerm2 pane -> Claude process", () => {
  test("the AppleScript reads a pane's tty without modifying anything, id escaped", () => {
    const script = itermTtyScript('B721ED91-"x"');
    expect(script).toContain('if unique ID of aSession is "B721ED91-\\"x\\"" then return tty of aSession');
    expect(script).toContain('return ""');
    expect(script).not.toMatch(/create|write text|set name|close|split|select/);
  });

  test("tty: only a terminal name goes through", () => {
    expect(ttyName("/dev/ttys006\n")).toBe("ttys006");
    expect(ttyName("ttys012")).toBe("ttys012");
    expect(ttyName("")).toBeNull();
    expect(ttyName("/dev/ttys006; rm -rf /")).toBeNull();
  });

  const PS = [
    "25214 S+   /bin/sh /usr/bin/command claude --dangerously-skip-permissions",
    "25218 S+   claude --dangerously-skip-permissions",
    "25326 S+   node /Users/alice/.local/bin/dbhub-direct --config .claude/dbhub.toml",
    "",
    "  812 Ss   -zsh",
    "ligne illisible",
  ].join("\n");

  test("ps output: pid, state, command", () => {
    expect(parsePs(PS)).toEqual([
      { pid: 25214, stat: "S+", command: "/bin/sh /usr/bin/command claude --dangerously-skip-permissions" },
      { pid: 25218, stat: "S+", command: "claude --dangerously-skip-permissions" },
      { pid: 25326, stat: "S+", command: "node /Users/alice/.local/bin/dbhub-direct --config .claude/dbhub.toml" },
      { pid: 812, stat: "Ss", command: "-zsh" },
    ]);
  });

  test("what runs Claude Code", () => {
    expect(looksLikeClaude("claude --dangerously-skip-permissions")).toBe(true);
    expect(looksLikeClaude("/Users/alice/.local/share/claude/versions/2.1.272 --resume /x.jsonl -n Line")).toBe(true);
    expect(looksLikeClaude("/bin/sh /usr/bin/command claude --resume 1a3e")).toBe(true);
    expect(looksLikeClaude("node /opt/lib/node_modules/@anthropic-ai/claude-code/cli.js")).toBe(true);
    expect(looksLikeClaude("node /Users/alice/.local/bin/dbhub-direct --config .claude/dbhub.toml")).toBe(false);
    expect(looksLikeClaude("-zsh")).toBe(false);
    expect(looksLikeClaude("vim claude.md")).toBe(false);
  });

  test("candidates: foreground first, the most recent process, then attach and resume", () => {
    expect(claudeRefs(parsePs(PS))).toEqual([{ pid: 25218 }, { pid: 25214 }]);

    const resumed = parsePs(
      ["28245 S+ /bin/sh /usr/bin/command claude --resume 1A3EFB8C-B512-4B20-9211-9C2019F52031", "28249 S+ claude --resume 1a3efb8c-b512-4b20-9211-9c2019f52031"].join("\n"),
    );
    expect(claudeRefs(resumed)).toEqual([{ pid: 28249 }, { sessionId: "1a3efb8c-b512-4b20-9211-9c2019f52031" }, { pid: 28245 }]);

    // un Claude suspendu (hors premier plan) passe après le `claude attach` au premier plan
    const attached = parsePs(["900 Ss -zsh", "700 T claude --dangerously-skip-permissions", "650 S+ claude attach 6d902ef5"].join("\n"));
    expect(claudeRefs(attached)).toEqual([{ pid: 650 }, { shortId: "6d902ef5" }, { pid: 700 }]);

    const versioned = parsePs("35263 S+ /Users/alice/.local/share/claude/versions/2.1.272 --resume /Users/alice/.claude/projects/-Users-x/f2b97262-14b1-4e99-94d5-fc2c4ac11a43.jsonl -n Line");
    expect(claudeRefs(versioned)).toEqual([{ pid: 35263 }, { sessionId: "f2b97262-14b1-4e99-94d5-fc2c4ac11a43" }]);

    expect(claudeRefs(parsePs("812 Ss+ -zsh"))).toEqual([]);
  });
});

describe("text", () => {
  test("repo: last segment of the cwd, named worktree", () => {
    expect(repoLabel("/Users/alice/dev/acme")).toBe("acme");
    expect(repoLabel("/Users/alice/dev/acme/api/")).toBe("api");
    expect(repoLabel("/Users/alice/dev/acme/api/.claude/worktrees/eng-2660")).toBe("api · worktree eng-2660");
  });

  test("clean truncation: at a word, with '…', line breaks kept", () => {
    expect(clip("court", 10)).toBe("court");
    expect(clip("a\n\n\n\nb  \nc", 50)).toBe("a\n\nb\nc");
    const out = clip("mot ".repeat(50).trim(), 30);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out.endsWith("mot…")).toBe(true);
    expect(clip("x".repeat(40), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("human request and agent text", () => {
  test("without what Claude Code injects into the message", () => {
    expect(cleanHumanText("regarde ce thread\n<system-reminder>\nrappel\n</system-reminder>")).toBe("regarde ce thread");
    expect(cleanHumanText("<task-notification>\n<task-id>a1</task-id>\n</task-notification>")).toBe("");
    expect(cleanHumanText("<command-message>aiguilleur</command-message>\n<command-name>/aiguilleur</command-name>")).toBe("");
    expect(
      cleanHumanText(
        "<command-message>investigate</command-message>\n<command-name>/investigate</command-name>\n<command-args>https://acme.slack.com/archives/C1/p1789390274707559</command-args>",
      ),
    ).toBe("/investigate https://acme.slack.com/archives/C1/p1789390274707559");
    expect(cleanHumanText("<local-command-caveat>Caveat</local-command-caveat>\n<local-command-stdout>ok</local-command-stdout>")).toBe("");
    expect(cleanHumanText("<bash-input>ls</bash-input><bash-stdout>a</bash-stdout>")).toBe("");
    expect(cleanHumanText("[Request interrupted by user]")).toBe("");
    expect(cleanHumanText("C'est qui ?[Image #2]\n[Image: source: /tmp/2.png]")).toBe("C'est qui ?[Image #2]");
  });

  test("entries kept or dropped as a human request", () => {
    const u = (o: Partial<TranscriptEntry>): TranscriptEntry => ({ type: "user", message: { content: "fais X" }, ...o });
    expect(humanRequestText(u({ origin: { kind: "human" } }))).toBe("fais X");
    expect(humanRequestText(u({}))).toBe("fais X");
    expect(humanRequestText(u({ isMeta: true }))).toBeNull();
    expect(humanRequestText(u({ isSidechain: true }))).toBeNull();
    expect(humanRequestText(u({ isCompactSummary: true }))).toBeNull();
    expect(humanRequestText(u({ origin: { kind: "task-notification" } }))).toBeNull();
    expect(humanRequestText(u({ toolUseResult: { stdout: "" } }))).toBeNull();
    expect(humanRequestText(u({ message: { content: [{ type: "tool_result", text: "x" }] } }))).toBeNull();
    expect(humanRequestText(u({ message: { content: [{ type: "text", text: "avec image" }, { type: "image" }] } }))).toBe("avec image");
    expect(humanRequestText({ type: "assistant", message: { content: [{ type: "text", text: "x" }] } })).toBeNull();
  });

  test("agent text: text blocks only", () => {
    expect(agentText({ type: "assistant", message: { content: [{ type: "thinking" }, { type: "text", text: " Voilà. " }] } })).toBe("Voilà.");
    expect(agentText({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } })).toBeNull();
    expect(agentText({ type: "assistant", isApiErrorMessage: true, message: { content: [{ type: "text", text: "API Error" }] } })).toBeNull();
    expect(agentText({ type: "assistant", message: { content: [{ type: "text", text: "No response requested." }] } })).toBeNull();
  });

  test("citations: reply link -> thread root, punctuation removed, uppercase tickets only", () => {
    const c = citations(
      "voir https://acme.slack.com/archives/C0ACMECMP01/p1789399982753359?thread_ts=1789398316.911589&cid=C0ACMECMP01. et ENG-2636, OPS-45 ; pas eng-1 ni XENG-2",
    );
    expect(c.slack).toEqual([
      {
        key: "C0ACMECMP01:1789398316.911589",
        url: "https://acme.slack.com/archives/C0ACMECMP01/p1789399982753359?thread_ts=1789398316.911589&cid=C0ACMECMP01",
        workspace: "acme",
      },
    ]);
    expect(c.linear).toEqual(["ENG-2636", "OPS-45"]);
    expect(citations("[lien](https://globex.slack.com/archives/C1/p1789390274707559)").slack).toEqual([
      { key: "C1:1789390274.707559", url: "https://globex.slack.com/archives/C1/p1789390274707559", workspace: "globex" },
    ]);
  });
});

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const human = (text: string, extra: Record<string, unknown> = {}) =>
  line({ type: "user", origin: { kind: "human" }, cwd: "/t/acme", gitBranch: "dev", sessionId: "S1", timestamp: "2026-09-15T10:00:00Z", message: { role: "user", content: text }, ...extra });
const agent = (text: string, timestamp = "2026-09-15T10:05:00Z", extra: Record<string, unknown> = {}) =>
  line({ type: "assistant", cwd: "/t/acme", gitBranch: "dev", sessionId: "S1", timestamp, message: { role: "assistant", content: [{ type: "text", text }] }, ...extra });

describe("context of a transcript", () => {
  const lines = [
    line({ type: "permission-mode", permissionMode: "default" }),
    line({ type: "user", isMeta: true, message: { content: "<local-command-caveat>x</local-command-caveat>" } }),
    human("<command-message>aiguilleur</command-message>\n<command-name>/aiguilleur</command-name>"),
    human("Regarde https://acme.slack.com/archives/C1/p1789390274707559 et ENG-1"),
    line({ type: "user", toolUseResult: {}, message: { content: [{ type: "tool_result", content: "https://acme.slack.com/archives/CT/p1789390274707559 ENG-999" }] } }),
    line({ type: "user", origin: { kind: "task-notification" }, message: { content: "<task-notification>ENG-998 https://acme.slack.com/archives/CN/p1789390274707559</task-notification>" } }),
    agent("J'ai lu le thread https://acme.slack.com/archives/C2/p1789390300000100 et ENG-2."),
    "{ligne coupée",
    line({ type: "ai-title", aiTitle: "Export CSV", sessionId: "S1" }),
    human("Et https://acme.slack.com/archives/C1/p1789390274707559 encore", { gitBranch: "feat/eng-2", cwd: "/t/acme/api" }),
    agent("Fini.", "2026-09-15T11:00:00Z", { gitBranch: "feat/eng-2", cwd: "/t/acme/api" }),
    line({ type: "assistant", isSidechain: true, gitBranch: "autre", message: { content: [{ type: "text", text: "sous-agent ENG-997" }] } }),
  ];

  test("starting request, last text, most recent citations first, branch, cwd, title, master", () => {
    const c = sessionContext(foldTranscript(emptyTranscript(), lines));
    expect(c.firstRequest).toEqual({ text: "Regarde https://acme.slack.com/archives/C1/p1789390274707559 et ENG-1", at: "2026-09-15T10:00:00Z" });
    expect(c.lastAgent).toEqual({ text: "Fini.", at: "2026-09-15T11:00:00Z" });
    expect(c.slackThreads.map((t) => t.key)).toEqual(["C1:1789390274.707559", "C2:1789390300.000100"]);
    expect(c.linearIssues).toEqual(["ENG-2", "ENG-1"]);
    expect(c.branch).toBe("feat/eng-2");
    expect(c.cwd).toBe("/t/acme/api");
    expect(c.title).toBe("Export CSV");
    expect(c.sessionId).toBe("S1");
    expect(c.master).toBe(true);
  });

  test("read in two passes (growing file), the context is the same", () => {
    const once = sessionContext(foldTranscript(emptyTranscript(), lines));
    const st = foldTranscript(emptyTranscript(), lines.slice(0, 5));
    expect(sessionContext(foldTranscript(st, lines.slice(5)))).toEqual(once);
  });

  test("a built-in command (/model) is not the starting request, a skill command is", () => {
    const model = [
      line({ type: "user", isMeta: true, message: { content: "<local-command-caveat>Caveat: local commands</local-command-caveat>" } }),
      line({ type: "user", message: { content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>" } }),
      line({ type: "user", message: { content: "<local-command-stdout>Set model to Opus</local-command-stdout>" } }),
      human("regarde le ticket linear sur les export csv"),
      agent("Je regarde."),
    ];
    expect(sessionContext(foldTranscript(emptyTranscript(), model)).firstRequest?.text).toBe("regarde le ticket linear sur les export csv");
    // coupé juste avant la réponse de la commande : même résultat une fois le reste lu
    const st = foldTranscript(emptyTranscript(), model.slice(0, 2));
    expect(sessionContext(st).firstRequest?.text).toBe("/model opus");
    expect(sessionContext(foldTranscript(st, model.slice(2))).firstRequest?.text).toBe("regarde le ticket linear sur les export csv");

    const skill = [
      human("<command-message>investigate</command-message>\n<command-name>/investigate</command-name>\n<command-args>https://acme.slack.com/archives/C1/p1789390274707559</command-args>"),
      line({ type: "user", isMeta: true, message: { content: [{ type: "text", text: "Base directory for this skill: /x" }] } }),
      agent("Je lis le thread."),
      line({ type: "user", message: { content: "<local-command-stdout>sortie d'un /mcp plus tard</local-command-stdout>" } }),
      human("et ensuite ?"),
    ];
    const c = sessionContext(foldTranscript(emptyTranscript(), skill));
    expect(c.firstRequest?.text).toBe("/investigate https://acme.slack.com/archives/C1/p1789390274707559");
    expect(c.slackThreads.map((t) => t.key)).toEqual(["C1:1789390274.707559"]);
  });

  test("'HEAD' branch and temporary cwd ignored: the last useful ones are kept", () => {
    const c = sessionContext(
      foldTranscript(emptyTranscript(), [
        human("a", { gitBranch: "feat/x", cwd: "/t/acme/api" }),
        agent("b", "2026-09-15T10:06:00Z", { gitBranch: "HEAD", cwd: "/private/tmp/claude-501/x/scratchpad" }),
        agent("c", "2026-09-15T10:07:00Z", { gitBranch: "HEAD", cwd: "/tmp/y" }),
      ]),
    );
    expect(c.branch).toBe("feat/x");
    expect(c.cwd).toBe("/t/acme/api");
    expect(sessionContext(foldTranscript(emptyTranscript(), [human("a", { gitBranch: "HEAD" })])).branch).toBeNull();
  });

  test("at most 5 threads and 5 tickets, the most recently cited", () => {
    const many = Array.from({ length: 7 }, (_, i) => human(`https://acme.slack.com/archives/C${i}/p178939027470755${i} ENG-${i}`));
    const c = sessionContext(foldTranscript(emptyTranscript(), many));
    expect(c.slackThreads).toHaveLength(CITED_MAX);
    expect(c.slackThreads.map((t) => t.key)).toEqual([6, 5, 4, 3, 2].map((i) => `C${i}:1789390274.70755${i}`));
    expect(c.linearIssues).toEqual(["ENG-6", "ENG-5", "ENG-4", "ENG-3", "ENG-2"]);
  });

  test("master: Monitor on aiguilleur.ts watch, not a Write containing the command nor a mere mention", () => {
    const write = line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { content: "bun aiguilleur.ts watch" } }] } });
    expect(sessionContext(foldTranscript(emptyTranscript(), [write])).master).toBe(false);
    const monitor = line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Monitor", input: { command: "bun /x/aiguilleur.ts watch 2>&1" } }] } });
    expect(sessionContext(foldTranscript(emptyTranscript(), [write, monitor])).master).toBe(true);
    expect(sessionContext(foldTranscript(emptyTranscript(), [human("parle-moi de /aiguilleur")])).master).toBe(false);
  });

  test("master: the new name and the legacy one are both recognised", () => {
    const monitor = line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Monitor", input: { command: "bun /x/strato.ts watch 2>&1" } }] } });
    expect(sessionContext(foldTranscript(emptyTranscript(), [monitor])).master).toBe(true);
    for (const name of ["strato", "aiguilleur"]) {
      const cmd = line({ type: "user", message: { content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>` } });
      expect(sessionContext(foldTranscript(emptyTranscript(), [cmd])).master).toBe(true);
    }
  });

  test("a long request is truncated; an empty transcript gives nothing", () => {
    const c = sessionContext(foldTranscript(emptyTranscript(), [human("mot ".repeat(1000))]));
    expect(c.firstRequest?.text.length).toBeLessThanOrEqual(FIRST_REQUEST_MAX);
    expect(sessionContext(emptyTranscript())).toEqual({
      sessionId: null,
      cwd: null,
      branch: null,
      title: null,
      firstRequest: null,
      lastAgent: null,
      trail: [], turnAt: null,
      slackThreads: [],
      linearIssues: [],
      master: false,
    });
  });
});
