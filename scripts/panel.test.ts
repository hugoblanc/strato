import { describe, expect, test } from "bun:test";
import { cleanSessionName, type SessionContext, sujetForFocus, sujetForSessionName, type Sujet, type ThreadDump } from "./lib.ts";
import { escapeHtml, inlineMarkdown, markdownToHtml, panelPage, RECENT_MESSAGES, sessionView, sujetListView, sujetView, textToHtml } from "./panel.ts";

const base: Sujet = {
  key: "CX:1",
  threads: ["CX:1"],
  letter: "A",
  title: "t",
  channel: "#acme-requests",
  permalink: "https://acme.slack.com/archives/CX/p1757500000000100",
  asker: "Peter",
  sessionId: "s",
  shortId: "abc",
  name: "n",
  status: "gate",
  gate: "draft",
  waiting: "",
  next: "",
  summary: "",
  createdAt: "2026-09-14T10:00:00Z",
  updatedAt: "2026-09-14T10:00:00Z",
  history: [],
};
const sujet = (o: Partial<Sujet>): Sujet => ({ ...base, ...o });

const I = sujet({ key: "C0ACMESUP01:1789404732.437429", letter: "I", title: "Création de compte bloquée", name: "#acme-support · Mallory · Création de compte bloquée" });
const F = sujet({ key: "C0ACMESLS01:1789390274.707559", letter: "F", title: "Pas de risk hold sur une candidature", name: "#sales · Grace · Pas de risk hold sur une candidature", status: "closed" });
const E = sujet({ key: "C0ACMEREQ01:1789116445.077179", letter: "E", title: "Initech alertes en double facturées", name: "#acme-requests · Gary Jay Lindgren · Initech alertes en double facturé…" });

describe("iTerm2 session name", () => {
  test("no state glyph or leading spaces, no trailing (claude)", () => {
    expect(cleanSessionName("✳ Acme Slack thread evaluation (claude)")).toBe("Acme Slack thread evaluation");
    expect(cleanSessionName("◑ I · Création de compte bloquée (claude)")).toBe("I · Création de compte bloquée");
    expect(cleanSessionName("  ● #sales · Grace · x (claude)  ")).toBe("#sales · Grace · x");
    expect(cleanSessionName("⠂ travail en cours")).toBe("travail en cours");
    expect(cleanSessionName("✳️ Export CSV")).toBe("Export CSV");
    expect(cleanSessionName("(claude)")).toBe("");
  });
});

describe("session -> topic", () => {
  test("exact topic name, glyph and (claude) included", () => {
    expect(sujetForSessionName("#sales · Grace · Pas de risk hold sur une candidature (claude)", [I, F, E])?.key).toBe(F.key);
    expect(sujetForSessionName("◐ #sales · Grace · Pas de risk hold sur une candidature (claude)", [I, F, E])?.key).toBe(F.key);
  });

  test("tab opened by dive: '<letter> · title'", () => {
    expect(sujetForSessionName("I · Création de compte bloquée (claude)", [I, F, E])?.key).toBe(I.key);
    expect(sujetForSessionName("✳ E · Initech alertes en double facturées (claude)", [I, F, E])?.key).toBe(E.key);
  });

  test("with a shared letter: the matching title, then the open topic", () => {
    const oldI = sujet({ key: "CZ:1", letter: "I", title: "Ancien sujet", name: "#x · Niaj · Ancien sujet", status: "closed", updatedAt: "2026-09-15T09:00:00Z" });
    expect(sujetForSessionName("I · Création de compte bloquée", [oldI, I])?.key).toBe(I.key);
    expect(sujetForSessionName("I · Ancien sujet", [oldI, I])?.key).toBe("CZ:1");
    // titre tronqué à 40 caractères par dive
    const long = sujet({ key: "CL:1", letter: "L", title: "Un titre bien plus long que quarante caractères au total" });
    expect(sujetForSessionName("L · Un titre bien plus long que quarante car…", [long])?.key).toBe("CL:1");
    // aucun titre ne correspond : le sujet ouvert
    expect(sujetForSessionName("I · autre chose", [oldI, I])?.key).toBe(I.key);
  });

  test("topic name contained in the session name, including a name truncated with '…'", () => {
    expect(sujetForSessionName("✳ reprise #acme-support · Mallory · Création de compte bloquée (claude)", [I, F])?.key).toBe(I.key);
    expect(sujetForSessionName("#acme-requests · Gary Jay Lindgren · Initech alertes en double facturées (claude)", [I, E])?.key).toBe(E.key);
  });

  test("nothing matches: null, the pane shows the list", () => {
    expect(sujetForSessionName("✳ Export CSV (claude)", [I, F, E])).toBeNull();
    expect(sujetForSessionName("Z · Création de compte bloquée", [F, E])).toBeNull();
    expect(sujetForSessionName("", [I])).toBeNull();
    expect(sujetForSessionName("◐ (claude)", [I])).toBeNull();
    expect(sujetForSessionName("less", [I, sujet({ name: "" })])).toBeNull();
  });

  test("focus: the name first, then the tab dive opened for that session", () => {
    const tabs = { "SESSION-1": I.key };
    expect(sujetForFocus("✳ Claude a renommé la session (claude)", "SESSION-1", [I, F], tabs)?.key).toBe(I.key);
    expect(sujetForFocus("#sales · Grace · Pas de risk hold sur une candidature", "SESSION-1", [I, F], tabs)?.key).toBe(F.key);
    expect(sujetForFocus("zsh", "SESSION-2", [I, F], tabs)).toBeNull();
    expect(sujetForFocus("zsh", undefined, [I, F], tabs)).toBeNull();
  });
});

const ctx = { timeOf: (iso: string) => iso.slice(5, 16) };

describe("text and markdown", () => {
  test("a third party's text is escaped, its links open the browser, without the trailing punctuation", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    const html = textToHtml("<script>alert(1)</script> voir https://x.io/a?b=1&c=2.");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('<a href="https://x.io/a?b=1&amp;c=2" data-open>https://x.io/a?b=1&amp;c=2</a>.');
  });

  test("inline markdown: code, link, bold", () => {
    expect(inlineMarkdown("un `<b>` et **gras** et [le ticket](https://linear.app/t/ENG-1)")).toBe(
      'un <code>&lt;b&gt;</code> et <strong>gras</strong> et <a href="https://linear.app/t/ENG-1" data-open>le ticket</a>',
    );
  });

  test("blocks: shifted headings, paragraphs one line per sentence, lists, table, code, quote", () => {
    const html = markdownToHtml(
      [
        "# Rapport",
        "Première phrase.",
        "Deuxième phrase.",
        "",
        "- un",
        "  suite de un",
        "- deux",
        "1. premier",
        "",
        "| Qui | Quoi |",
        "| --- | :-: |",
        "| Zoé | `x` |",
        "",
        "```sql",
        "select '<1>'",
        "```",
        "> cité",
        "---",
        "#hashtag seul",
      ].join("\n"),
    );
    expect(html).toContain("<h3>Rapport</h3>");
    expect(html).toContain("<p>Première phrase.<br>Deuxième phrase.</p>");
    expect(html).toContain("<ul><li>un suite de un</li><li>deux</li></ul>");
    expect(html).toContain("<ol><li>premier</li></ol>");
    expect(html).toContain("<thead><tr><th>Qui</th><th>Quoi</th></tr></thead><tbody><tr><td>Zoé</td><td><code>x</code></td></tr></tbody>");
    expect(html).toContain("<pre><code>select &#39;&lt;1&gt;&#39;</code></pre>");
    expect(html).toContain("<blockquote><p>cité</p></blockquote>");
    expect(html).toContain("<hr>");
    expect(html).toContain("<p>#hashtag seul</p>");
  });
});

describe("pane views", () => {
  const G = sujet({
    key: "C0ACMESLS01:1789390274.707559",
    threads: ["C0ACMESLS01:1789390274.707559", "linear:ENG-2636"],
    letter: "G",
    title: "Hold <par> pièce d'identité",
    channel: "#sales",
    asker: "Grace",
    status: "gate",
    gate: "draft",
    waiting: "",
    ask: "Pourquoi pas de hold",
    action: "#sales, thread\nTexte exact du draft.",
    shortId: "6d902ef5",
    report: "/r/G.md",
    updatedAt: "2026-09-15T11:44:00Z",
  });
  const messages = Array.from({ length: RECENT_MESSAGES + 2 }, (_, i) => ({ at: `09-14 18:${String(i).padStart(2, "0")}`, from: i % 2 ? "Mallory" : "Alice", text: `message ${i}\nligne 2` }));
  const thread: ThreadDump = { key: G.key, permalink: "https://acme.slack.com/archives/C0ACMESLS01/p1789390274707559", messages };

  test("a topic: header, card, links, last messages, report", () => {
    const html = sujetView(G, [thread], "# Diagnostic\nLe même homme.", ctx);
    expect(html).toContain('<span class="letter">G</span><h1>Hold &lt;par&gt; pièce d&#39;identité</h1>');
    expect(html).toContain('<span class="badge">gate/draft</span>');
    expect(html).toContain("<dt>Demande</dt><dd>Pourquoi pas de hold</dd>");
    expect(html).toContain("<dt>Pourquoi Alice</dt><dd><span class=\"muted\">non renseigné</span></dd>");
    expect(html).toContain("<dd>#sales, thread\nTexte exact du draft.</dd>");
    expect(html).toContain('href="https://linear.app/acme/issue/ENG-2636" data-open>ENG-2636</a>');
    expect(html).toContain("data-open>Slack #sales · ");
    expect(html).toContain("<summary>2 messages plus anciens</summary>");
    expect(html).toContain(`message ${RECENT_MESSAGES + 1}\nligne 2`);
    expect(html).toContain("<h3>Diagnostic</h3>");
    expect(html).toContain("/r/G.md");
    expect(html).toContain("claude attach 6d902ef5");
    expect(html).toContain('href="/?liste" data-nav>tous les sujets</a>');
  });

  test("a draft's destination: the typed target the gate sends to comes first, the session's words only describe it", () => {
    const task = { id: "t1", kind: "draft" as const, ask: "a", proposal: "", draft: "Done.", createdAt: G.createdAt, updatedAt: G.updatedAt, status: "open" as const, origin: "task" as const };
    const both = sujetView({ ...G, tasks: [{ ...task, to: "slack:C0ACMEANN01", draftTo: "DM Grace" }] }, [], null, ctx);
    expect(both).toContain('<dd>C0ACMEANN01, <a href="https://acme.slack.com/archives/C0ACMEANN01" data-open>https://acme.slack.com/archives/C0ACMEANN01</a> (DM Grace)</dd>');
    const words = sujetView({ ...G, tasks: [{ ...task, draftTo: "DM Grace" }] }, [], null, ctx);
    expect(words).toContain("<dd>DM Grace</dd>");
  });

  test("without a report or Slack, the pane says so", () => {
    const html = sujetView(G, [], null, { ...ctx, slackError: "aucun token Slack" });
    expect(html).toContain("pas de rapport");
    expect(html).toContain('<p class="warn">aucun token Slack</p>');
  });

  test("the list: open topics from newest to oldest, closed ones folded, clickable rows", () => {
    const older = sujet({ key: "CO:1", letter: "B", title: "ancien", updatedAt: "2026-09-13T10:00:00Z" });
    const html = sujetListView([older, G, F], { ...ctx, note: "aucun sujet pour la session « <zsh> »" });
    expect(html.indexOf("Hold &lt;par&gt;")).toBeLessThan(html.indexOf("ancien"));
    expect(html).toContain(`href="/?sujet=${encodeURIComponent(G.key)}" data-nav`);
    expect(html).toContain('Sujets ouverts <span class="count">2</span>');
    expect(html).toContain("<summary>1 sujet fermé</summary>");
    expect(html).toContain("« &lt;zsh&gt; »");
    expect(html).toContain("tous les sujets");
  });

  test("the page is standalone, light and dark, and follows the focus through SSE", () => {
    const page = panelPage(sujetListView([G], ctx), "boot.3");
    expect(page).toContain("prefers-color-scheme:dark");
    expect(page).toContain('new EventSource("/events")');
    expect(page).toContain('data-version="boot.3"');
    expect(page).not.toMatch(/<script[^>]+src=/);
    expect(page).not.toContain("<link");
    expect(page).not.toMatch(/https?:\/\//);
  });

  test("no em dash in what the pane shows", () => {
    const all = [sujetView(G, [thread], "# r", ctx), sujetListView([G, F], ctx), panelPage("", "v"), sessionView({ name: "s", context: sessionCtx, threads: [], sujets: [G, F] }, ctx)].join("\n");
    expect(all).not.toContain(String.fromCharCode(0x2014));
  });
});

const sessionCtx: SessionContext = {
  sessionId: "3c1436e8-c03e-42e4-9d39-06ba09696854",
  cwd: "/Users/alice/dev/acme/api",
  branch: "feat/export-csv",
  title: "Export CSV",
  firstRequest: { text: "regarde le ticket <linear> sur les export csv", at: "2026-09-15T08:00:00Z" },
  lastAgent: { text: "Draft prêt :\nhttps://linear.app/acme/issue/OPS-262", at: "2026-09-15T09:30:00Z" },
  slackThreads: [
    { key: I.key, url: "https://acme.slack.com/archives/C0ACMESUP01/p1789404732437429", workspace: "acme" },
    { key: "C0NEW:1789400000.000100", url: "https://acme.slack.com/archives/C0NEW/p1789400000000100", workspace: "acme" },
    { key: "C9:1789400000.000200", url: "https://globex.slack.com/archives/C9/p1789400000000200", workspace: "globex" },
  ],
  linearIssues: ["OPS-262", "ENG-2636"],
  trail: [],
  turnAt: null,
  master: false,
};

describe("view of a session without a topic", () => {
  const ten = Array.from({ length: 10 }, (_, i) => ({ at: `09-15 10:0${i}`, from: "Grace", text: `msg ${i}` }));
  const threads: ThreadDump[] = [{ key: I.key, permalink: "https://acme.slack.com/archives/C0ACMESUP01/p1789404732437429", channel: "#acme-support", messages: ten }];
  const G2 = sujet({ key: "CG:1", threads: ["CG:1", "linear:ENG-2636"], letter: "G", title: "Hold par pièce", status: "gate" });

  test("header, starting request, last message, cited threads, tickets, folded topics", () => {
    const html = sessionView({ name: "Export CSV", context: sessionCtx, threads, sujets: [I, F, G2] }, ctx);
    expect(html).toContain("<h1>Export CSV</h1>");
    expect(html).toContain("<span>api</span><code>feat/export-csv</code>");
    expect(html).toContain("conversation <code>3c1436e8-c03e-42e4-9d39-06ba09696854</code>");
    expect(html).toContain("<h2>Demande de départ");
    expect(html).toContain("regarde le ticket &lt;linear&gt; sur les export csv");
    expect(html).toContain("<h2>Dernier message de l'agent");
    expect(html).toContain('data-open>https://linear.app/acme/issue/OPS-262</a>');
    // les 8 derniers messages du thread, les 2 plus anciens seulement comptés
    expect(html).toContain("msg 9");
    expect(html).toContain("msg 2<");
    expect(html).not.toContain("msg 1<");
    expect(html).toContain("2 messages plus anciens non affichés");
    expect(html).toContain("data-open>Slack #acme-support · ");
    expect(html).toContain(`href="/?sujet=${encodeURIComponent(I.key)}" data-nav>sujet I</a>`);
    // un thread non lu dit pourquoi
    expect(html).toContain("thread non lu");
    expect(html).toContain("workspace globex, que Strato ne lit pas");
    expect(html).toContain('href="https://linear.app/acme/issue/ENG-2636" data-open>ENG-2636</a>');
    expect(html).toContain(`href="/?sujet=${encodeURIComponent(G2.key)}" data-nav>sujet G</a>`);
    expect(html).toContain('<details id="sujets-ouverts" class="sujets"><summary>Sujets ouverts <span class="count">2</span></summary>');
    expect(html).not.toContain("Pas de risk hold sur une candidature");
  });

  test("the master: badge and unfolded topics; without a request or message, the pane says so", () => {
    const empty = { ...sessionCtx, master: true, firstRequest: null, lastAgent: null, slackThreads: [], linearIssues: [], branch: null };
    const html = sessionView({ name: "aiguilleur", context: empty, threads: [], sujets: [I] }, ctx);
    expect(html).toContain('<details id="sujets-ouverts" class="sujets" open>');
    expect(html).toContain("master de Strato");
    expect(html).toContain("aucune demande humaine trouvée");
    expect(html).toContain("pas encore de message de l'agent");
    expect(html).toContain("Création de compte bloquée");
    expect(html).not.toContain("Tickets Linear");
  });

  test("without a Slack token, a cited thread shows the error", () => {
    const html = sessionView({ name: "x", context: sessionCtx, threads: [], sujets: [] }, { ...ctx, slackError: "aucun token Slack" });
    expect(html).toContain('<p class="muted">aucun token Slack</p>');
  });
});
