/**
 * L'état partagé sous écritures concurrentes : chaque test lance de vrais processus `aiguilleur.ts` (ou un petit
 * script sur store.ts) sur un dossier d'état temporaire, avec un faux binaire `claude` en tête du PATH et un HOME
 * temporaire. Rien ne touche Slack, les vraies sessions ni le vrai .aiguilleur.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { acksPath, inboxMessages, modStatePath } from "./app/mod.ts";
import { mkdirSync } from "node:fs";
import { cleanupRigs, CLI, cli, KEY, LINK, lines, readSujets, type Rig, rig, run, SCRIPTS, sujet, writeSujets } from "./test-rig.ts";

afterEach(cleanupRigs);


/** Un petit script sur store.ts, lancé dans un processus à part (le dossier d'état se fixe à l'import). */
function script(r: Rig, body: string): string {
  const path = join(r.dir, `s${Math.random().toString(36).slice(2, 8)}.ts`);
  writeFileSync(path, `import * as store from ${JSON.stringify(join(SCRIPTS, "app/store.ts"))};\nimport * as env from ${JSON.stringify(join(SCRIPTS, "app/env.ts"))};\n${body}\n`);
  return path;
}

describe("concurrent topic writes", () => {
  test("a set during a resume lasting several seconds is not overwritten", async () => {
    const r = rig();
    writeSujets(r, [sujet()]);
    const send = cli(r, ["send", "A", "Bonjour de Alice"], { FAKE_SPAWN_DELAY: "3" });
    await Bun.sleep(1_000);
    const set = await cli(r, ["set", "A", "next=relire la note de Bob", "ask=valider le devis acme"]);
    expect(set.code).toBe(0);
    const sent = await send;
    expect(sent.code).toBe(0);
    const [s] = readSujets(r);
    expect(s.next).toBe("relire la note de Bob");
    expect(s.ask).toBe("valider le devis acme");
    expect(s.status).toBe("working");
    expect(s.shortId).toBe("s1");
    expect(s.resumingUntil).toBeUndefined();
  }, 20_000);

  test("two simultaneous opens of the same thread launch only one session", async () => {
    const r = rig();
    const open = () => cli(r, ["open", LINK, "--title", "Devis acme", "--from", "Alice", "--channel", "#acme"], { FAKE_SPAWN_DELAY: "2" });
    const [a, b] = await Promise.all([open(), open()]);
    expect([a.code, b.code]).toEqual([0, 0]);
    expect(lines(join(r.dir, "kinds.log")).length).toBe(1);
    const list = readSujets(r);
    expect(list.length).toBe(1);
    expect(list[0].shortId).toBe("s1");
    expect(list[0].sessionId).toBe("sess-acme-1");
    expect(`${a.out}${b.out}`).toContain("already open");
  }, 20_000);

  test("an open whose launch fails removes its reservation", async () => {
    const r = rig();
    writeFileSync(join(r.dir, "bin", "claude"), "#!/bin/sh\nexit 1\n");
    const res = await cli(r, ["open", LINK, "--title", "Devis acme"]);
    expect(res.code).toBe(1);
    expect(readSujets(r)).toEqual([]);
  }, 20_000);

  test("two simultaneous relays to a stopped session resume it only once", async () => {
    const r = rig();
    writeSujets(r, [sujet()]);
    const send = (text: string) => cli(r, ["send", "A", text], { FAKE_SPAWN_DELAY: "2" });
    const [a, b] = await Promise.all([send("premier message"), send("second message")]);
    const resumes = lines(join(r.dir, "kinds.log")).filter((k) => k === "--resume");
    expect(resumes.length).toBe(1);
    // le second relais trouve la session vivante et passe par SendMessage (code 3), comme pour toute session vivante
    expect([a.code, b.code].sort()).toEqual([0, 3]);
    expect(`${a.out}${b.out}`).toContain("SENDMESSAGE acme · Alice · A");
    // the last line says it is not delivered yet: a caller keeping only the last line cannot mistake it for a delivery
    const live = [a, b].find((x) => x.code === 3)!;
    expect(live.out.trim().split("\n").at(-1)).toStartWith("NOT DELIVERED YET");
  }, 30_000);

  test("a session that declares itself through the mod takes a relayed message from its inbox", async () => {
    const r = rig();
    writeSujets(r, [sujet()]);
    const sid = sujet().sessionId!;
    mkdirSync(join(r.state, "live"), { recursive: true });
    const now = Date.now();
    writeFileSync(modStatePath(r.state, sid), JSON.stringify({ source: "mod", v: 1, sessionId: sid, status: "idle", since: now, step: null, stepAt: null, trail: [], lastText: "", lastTextAt: null, agents: [], waiting: null, beat: now, turnId: null, error: false }));
    let stopped = false;
    void (async () => {
      while (!stopped) {
        await Bun.sleep(50);
        const messages = inboxMessages(r.state, sid);
        if (messages.length) writeFileSync(acksPath(r.state, sid), messages.map((m) => `${JSON.stringify({ id: m.id, state: "submitted", at: Date.now() })}\n`).join(""));
      }
    })();
    const res = await cli(r, ["relay", "A", "--kind", "suite", "--from", "Ann", "--text", "thanks"]);
    stopped = true;
    expect(res.code).toBe(0);
    expect(res.out).toContain("delivered · A");
    expect(inboxMessages(r.state, sid)[0]?.text).toContain("thanks");
    expect(lines(join(r.dir, "kinds.log"))).not.toContain("--resume");
  }, 30_000);
});

describe("state lock", () => {
  test("a lock whose holder is dead is taken immediately", async () => {
    const r = rig();
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    writeFileSync(join(r.state, ".lock"), `${dead.pid}-acme`);
    const s = script(r, "const t = Date.now(); await store.withLock(() => {}); console.log(`pris en ${Date.now() - t} ms`);");
    const res = await run(r, [s]);
    expect(res.code).toBe(0);
    expect(Number(res.out.match(/pris en (\d+) ms/)?.[1])).toBeLessThan(2_000);
    expect(existsSync(join(r.state, ".lock"))).toBe(false);
  }, 20_000);

  test("a wait that is too long raises LockTimeout without killing the process", async () => {
    const r = rig();
    // détenteur vivant (ce processus de test), verrou frais : ni mort ni périmé
    writeFileSync(join(r.state, ".lock"), `${process.pid}-acme`);
    const s = script(r, 'try { await store.withLock(() => {}, 300); } catch (e) { console.log(`levé ${(e as Error).name}`); }\nconsole.log("toujours vivant");');
    const res = await run(r, [s]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("levé LockTimeout");
    expect(res.out).toContain("toujours vivant");
    expect(readFileSync(join(r.state, ".lock"), "utf8")).toBe(`${process.pid}-acme`);
  }, 20_000);

  test("several waiters on a stale lock lose no write", async () => {
    const r = rig();
    const lock = join(r.state, ".lock");
    writeFileSync(lock, "");
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lock, old, old);
    const counter = join(r.state, "compteur.json");
    const s = script(
      r,
      `for (let i = 0; i < 15; i++) await store.withLock(() => { const n = env.readJson<number>(${JSON.stringify(counter)}, 0); const until = Date.now() + 2; while (Date.now() < until) {} env.writeJson(${JSON.stringify(counter)}, n + 1); });`,
    );
    const res = await Promise.all(Array.from({ length: 6 }, () => run(r, [s])));
    expect(res.map((x) => x.code)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(JSON.parse(readFileSync(counter, "utf8"))).toBe(90);
    expect(readdirSync(r.state).filter((f) => f.startsWith(".lock"))).toEqual([]);
  }, 30_000);
});

describe("unreadable state files", () => {
  test("an unreadable sujets.json is never overwritten: explicit error and copy", async () => {
    const r = rig();
    const broken = '[{"key": "C0ACME0001:1759219200.000100", "title": "Relecture ac';
    writeFileSync(join(r.state, "sujets.json"), broken);
    const s = script(r, `try { await store.mutateSujets((l) => [...l, ${JSON.stringify(sujet({ key: "C0ACME0001:1759219300.000200" }))} as any]); console.log("écrit"); } catch (e) { console.log(\`levé \${(e as Error).name}\`); }`);
    const res = await run(r, [s]);
    expect(res.out).toContain("levé CorruptState");
    expect(readFileSync(join(r.state, "sujets.json"), "utf8")).toBe(broken);
    const copies = readdirSync(r.state).filter((f) => f.startsWith("sujets.json.corrupt-"));
    expect(copies.length).toBe(1);
    expect(readFileSync(join(r.state, copies[0]), "utf8")).toBe(broken);
  }, 20_000);

  test("the set command on an unreadable sujets.json exits with an error without writing anything", async () => {
    const r = rig();
    writeFileSync(join(r.state, "sujets.json"), "{ cassé");
    const res = await cli(r, ["set", "A", "next=x"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("unreadable");
    expect(res.err).not.toContain("    at ");
    expect(readFileSync(join(r.state, "sujets.json"), "utf8")).toBe("{ cassé");
  }, 20_000);

  test("an unreadable queue (snooze.json) is set aside, then starts from zero", async () => {
    const r = rig();
    writeFileSync(join(r.state, "snooze.json"), "{ cassé");
    const s = script(r, `const p = ${JSON.stringify(join(r.state, "snooze.json"))};\ntry { env.readJson(p, {}); } catch (e) { console.log((e as Error).name); }\nconsole.log(JSON.stringify(env.readJson(p, {})));`);
    const res = await run(r, [s]);
    expect(res.out).toBe("CorruptState\n{}\n");
    expect(readdirSync(r.state).filter((f) => f.startsWith("snooze.json.corrupt-")).length).toBe(1);
  }, 20_000);

  test("outside the state folder, an unreadable JSON returns the default value, without moving anything", async () => {
    const r = rig();
    const foreign = join(r.dir, "home", "session.json");
    writeFileSync(foreign, '{"pid": 12');
    const s = script(r, `console.log(JSON.stringify(env.readJson(${JSON.stringify(foreign)}, { vide: true })));`);
    const res = await run(r, [s]);
    expect(res.out).toBe('{"vide":true}\n');
    expect(readFileSync(foreign, "utf8")).toBe('{"pid": 12');
  }, 20_000);
});

/** Remplace fetch vers slack.com dans le processus serve : chaque appel est noté et répond après 300 ms, sans réseau. */
const FAKE_SLACK = `import { appendFileSync } from "node:fs";
const real = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith("https://slack.com/api/")) return real(input, init);
  const method = url.slice("https://slack.com/api/".length).split("?")[0];
  appendFileSync(process.env.FAKE_SLACK_LOG as string, method + "\\n");
  await Bun.sleep(300);
  const body =
    method === "auth.test" ? { ok: true, team: "Acme", user_id: "UALICE", url: "https://acme.slack.com/" }
    : method === "chat.postMessage" ? { ok: true, ts: "1759219400.000300" }
    : method === "conversations.replies" ? { ok: true, messages: [{ ts: "1759219200.000100" }] }
    : { ok: true };
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}) as typeof fetch;
`;

describe("posting a draft from the board", () => {
  const DRAFT = "Bonjour Bob, c'est validé pour acme.";
  /** Ce que le board envoie : le texte affiché, et le draft et sa destination sur lesquels on s'est décidé. */
  const shown = { key: KEY, taskId: "t1", text: DRAFT, draft: DRAFT, draftTo: LINK };
  const draftSujet = () => sujet({ status: "gate", gate: "draft", draft: DRAFT, draftTo: LINK, action: "poster le draft" });

  async function startServe(r: Rig): Promise<{ port: number; stop: () => Promise<void> }> {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = probe.port as number;
    probe.stop(true);
    writeFileSync(join(r.dir, "fake-slack.ts"), FAKE_SLACK);
    const p = Bun.spawn([process.execPath, "--preload", join(r.dir, "fake-slack.ts"), CLI, "serve", "--port", String(port)], {
      cwd: SCRIPTS,
      env: { ...r.env, STRATO_SLACK_TOKEN: "xoxp-acme-factice", FAKE_SLACK_LOG: join(r.dir, "slack.log") },
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/state`)).ok) break;
      } catch {}
      await Bun.sleep(100);
    }
    return {
      port,
      stop: async () => {
        p.kill();
        await p.exited;
      },
    };
  }
  const post = (port: number, path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` }, body: JSON.stringify(body) });

  test("two simultaneous clicks on Send post only once", async () => {
    const r = rig();
    writeSujets(r, [draftSujet()]);
    const serve = await startServe(r);
    try {
      const [a, b] = await Promise.all([post(serve.port, "/api/post-draft", shown), post(serve.port, "/api/post-draft", shown)]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(lines(join(r.dir, "slack.log")).filter((m) => m === "chat.postMessage").length).toBe(1);
    } finally {
      await serve.stop();
    }
  }, 30_000);

  test("the note to the session survives a serve restart during the undo window", async () => {
    const r = rig();
    writeSujets(r, [draftSujet()]);
    let serve = await startServe(r);
    try {
      expect((await post(serve.port, "/api/post-draft", shown)).status).toBe(200);
      await serve.stop();
      const [s] = readSujets(r);
      expect(s.status).toBe("waiting");
      expect(s.tasks[0]).toMatchObject({ id: "t1", status: "done" });
      expect(s.notify?.text).toContain("I posted the draft of task t1 myself from the board");
      // serve s'arrête avant les 30 s : on avance l'échéance, puis on le relance
      writeSujets(r, [{ ...s, notify: { ...s.notify, at: "2026-09-30T08:00:00Z" } }]);
      serve = await startServe(r);
      for (let i = 0; i < 50 && !lines(join(r.dir, "kinds.log")).includes("--resume"); i++) await Bun.sleep(100);
      expect(lines(join(r.dir, "kinds.log"))).toEqual(["--resume"]);
      expect(readFileSync(join(r.dir, "spawns.log"), "utf8")).toContain("I posted the draft of task t1 myself from the board");
      for (let i = 0; i < 50 && readSujets(r)[0].notify; i++) await Bun.sleep(100);
      expect(readSujets(r)[0].notify).toBeUndefined();
    } finally {
      await serve.stop();
    }
  }, 30_000);
});
