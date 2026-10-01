/**
 * The registry and an existing state folder, in separate processes (the state folder is fixed when app/env.ts is
 * imported): accounts resolved to providers, the account's own folder and secrets, long keys mapped back, and a state
 * folder of today, with bare keys, read as before.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupRigs, cli, KEY, LINK, type Rig, rig, run, SCRIPTS, sujet, writeSujets } from "./test-rig.ts";

afterEach(cleanupRigs);

/** Runs a script with the registry and the store imported, in the rig's state; its stdout is JSON. */
async function script(r: Rig, body: string, extra: Record<string, string> = {}): Promise<any> {
  const path = join(r.dir, `s${Math.random().toString(36).slice(2, 8)}.ts`);
  writeFileSync(
    path,
    [
      `import * as registry from ${JSON.stringify(join(SCRIPTS, "providers/registry.ts"))};`,
      `import * as store from ${JSON.stringify(join(SCRIPTS, "app/store.ts"))};`,
      `import * as sujet from ${JSON.stringify(join(SCRIPTS, "core/sujet.ts"))};`,
      `const result = await (async () => { ${body} })();`,
      "process.stdout.write(JSON.stringify(result));",
    ].join("\n"),
  );
  const res = await run(r, [path], extra);
  if (res.code !== 0) throw new Error(res.err);
  return JSON.parse(res.out);
}

const config = (r: Rig, raw: unknown) => writeFileSync(join(r.state, "config.json"), JSON.stringify(raw));

describe("registry", () => {
  test("each account gets its provider, or the reason it has none", async () => {
    const r = rig();
    config(r, {
      owner: { name: "Alice" },
      slack: { team: "Acme", workspace: "acme", me: "UALICE" },
      tracker: { kind: "linear", workspace: "acme", prefixes: ["ENG"] },
      providers: { tickets: { source: { exec: ["./t"] }, accounts: { default: {} } }, nothing: { accounts: { default: {} } } },
    });
    const out = await script(r, "return registry.accounts().map((a) => [a.account.provider, a.account.id, a.provider?.descriptor.id ?? null, a.problem]);");
    expect(out).toEqual([
      ["slack", "default", "slack", null],
      ["linear", "default", "linear", null],
      ["tickets", "default", null, "tickets: external providers are not loaded by this version"],
      ["nothing", "default", null, "nothing: not a built-in tool"],
    ]);
  });

  test("a named Slack account connects with its own token only, and Linear connects nowhere", async () => {
    const r = rig();
    config(r, { owner: { name: "Alice" }, slack: { team: "Acme", workspace: "acme", me: "UALICE" }, tracker: { workspace: "acme", prefixes: ["ENG"] }, providers: { slack: { accounts: { partners: { workspace: "acme-partners" } } } } });
    const out = await script(
      r,
      `
      const codes = [];
      for (const [p, id] of [["slack", "partners"], ["linear", "default"]]) {
        const a = registry.accountOf(p, id);
        try { await a.provider.connect(registry.accountContext(a)); codes.push("connected"); } catch (e) { codes.push([e.code, e.fatal]); }
      }
      return codes;
    `,
      // the default account's token in the environment is never a named account's
      { STRATO_SLACK_TOKEN: "xoxp-acme-default" },
    );
    expect(out).toEqual([
      ["invalid_auth", true],
      ["unsupported", true],
    ]);
  });

  test("a long native id gets a %h key, mapped back from the account's folder", async () => {
    const r = rig();
    const out = await script(r, `
      const a = { provider: "slack", id: "default" };
      const native = "C0ACME0001:" + "1".repeat(300);
      const key = registry.keyFor(a, native);
      return { key, back: registry.nativeOfKey(key)?.native === native, short: registry.keyFor(a, "C0ACME0001:1759219200.000100") };
    `);
    expect(out.key).toMatch(/^slack:%h[a-z2-7]{26}$/);
    expect(out.back).toBe(true);
    expect(out.short).toBe(KEY);
    expect(Object.values(JSON.parse(readFileSync(join(r.state, "providers", "slack-default", "keys.json"), "utf8")))).toEqual([`C0ACME0001:${"1".repeat(300)}`]);
  });

  test("an account reads its declared secrets only, from its file then its legacy variables, and writes them 600", async () => {
    const r = rig();
    const file = join(r.dir, "home", "acme.env");
    writeFileSync(file, "SLACK_USER_TOKEN=xoxp-from-file\nOTHER=nope\n");
    config(r, { owner: { name: "Alice" }, slack: { team: "Acme", workspace: "acme", me: "UALICE", userTokenFile: file } });
    const out = await script(
      r,
      `
      const ctx = registry.accountContext(registry.accountOf("slack", "default"));
      const before = [ctx.secret("SLACK_USER_TOKEN"), ctx.secret("SLACK_APP_TOKEN"), ctx.secret("OTHER")];
      ctx.setSecret("SLACK_APP_TOKEN", "xapp-new");
      let refused = "";
      try { ctx.setSecret("OTHER", "x"); } catch (e) { refused = e.message; }
      return { before, after: ctx.secret("SLACK_APP_TOKEN"), refused };
    `,
      { SLACK_APP_TOKEN: "xapp-from-env" },
    );
    expect(out.before).toEqual(["xoxp-from-file", "xapp-from-env", null]);
    expect(out.after).toBe("xapp-new");
    expect(out.refused).toContain("not a secret of this account");
    expect(readFileSync(file, "utf8")).toBe("SLACK_USER_TOKEN=xoxp-from-file\nOTHER=nope\nSLACK_APP_TOKEN=xapp-new\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("an account's fetch reaches its API hosts only, its store stays in its folder, its logs mask its secrets", async () => {
    const r = rig();
    const out = await script(r, `
      const lines = [];
      const fake = async (input) => new Response("ok " + String(input));
      const ctx = registry.accountContext(registry.accountOf("slack", "default"), { fetchImpl: fake, log: (l) => lines.push(l) });
      const ok = await (await ctx.fetch("https://slack.com/api/auth.test")).text();
      const refused = [];
      for (const u of ["https://evil.example/x", "http://slack.com/api/x"]) {
        try { await ctx.fetch(u); } catch (e) { refused.push(e.message); }
      }
      ctx.store.write("cursor", { at: 1 });
      let escaped = "";
      try { ctx.store.write("../../sujets", []); } catch (e) { escaped = e.message; }
      ctx.secret("SLACK_USER_TOKEN");
      ctx.log("warn", "token xoxp-1234567890 refused");
      ctx.log("debug", "not shown");
      return { ok, refused, cursor: ctx.store.read("cursor", null), escaped, lines, locale: ctx.locale };
    `, { STRATO_SLACK_TOKEN: "xoxp-1234567890" });
    expect(out.ok).toBe("ok https://slack.com/api/auth.test");
    expect(out.refused).toEqual(["slack: evil.example is not among the provider's API hosts", "slack: slack.com is not among the provider's API hosts"]);
    expect(out.cursor).toEqual({ at: 1 });
    expect(existsSync(join(r.state, "providers", "slack-default", "cursor.json"))).toBe(true);
    expect(out.escaped).toContain("store name refused");
    expect(out.lines).toEqual(["[slack] warn: token xoxp… refused"]);
    expect(out.locale).toBe("en");
  });
});

describe("a state folder of today", () => {
  test("bare keys and linear: keys load and are found as before, by key, link, letter and ticket", async () => {
    const r = rig();
    config(r, { owner: { name: "Alice" }, slack: { team: "Acme", workspace: "acme", me: "UALICE" }, tracker: { kind: "linear", workspace: "acme", prefixes: ["ENG"] } });
    const reply = "https://acme.slack.com/archives/C0ACME0001/p1759219260000200?thread_ts=1759219200.000100&cid=C0ACME0001";
    const raw = [sujet(), sujet({ key: "linear:ENG-12", threads: ["linear:ENG-12"], letter: "B", permalink: "https://linear.app/acme/issue/ENG-12", channel: "Linear" })];
    writeSujets(r, raw);
    writeFileSync(join(r.state, "seen.json"), JSON.stringify([`${KEY}`, "C0ACME0001:1759219260.000200"]));
    const out = await script(r, `
      const list = store.loadSujets();
      const find = (ref) => sujet.findSujet(list, ref)?.letter ?? null;
      return { keys: list.map((s) => s.key), byKey: find(${JSON.stringify(KEY)}), byLink: find(${JSON.stringify(LINK)}), byReply: find(${JSON.stringify(reply)}), byLetter: find("a"), byTicket: find("ENG-12"), byTicketLink: find("https://linear.app/acme/issue/ENG-12/x"), byTicketKey: find("linear:ENG-12") };
    `);
    expect(out).toEqual({ keys: [KEY, "linear:ENG-12"], byKey: "A", byLink: "A", byReply: "A", byLetter: "A", byTicket: "B", byTicketLink: "B", byTicketKey: "B" });
    // the CLI reads them as well, and no file of the state folder is rewritten by reading
    const before = ["sujets.json", "seen.json"].map((f) => readFileSync(join(r.state, f), "utf8"));
    const card = await cli(r, ["card", "A"]);
    expect(card.code).toBe(0);
    expect(["sujets.json", "seen.json"].map((f) => readFileSync(join(r.state, f), "utf8"))).toEqual(before);
  });
});
