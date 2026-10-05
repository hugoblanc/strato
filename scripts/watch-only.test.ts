/**
 * A second installation dedicated to one alerts channel: `slack.watchOnly`, polled (`watch`, no Socket Mode), with the
 * alerts posted by bots and incoming webhooks. Real processes against the fake Slack of ingest-fixture.ts: the poll
 * path must keep the bot messages of the watched channel, name their author, raise them as requests, and raise
 * nothing else but the follow-ups of the topics this installation tracks.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { events, FIXTURE, goldenRig, runUntil, stdout } from "./ingest-fixture.ts";
import { cleanupRigs } from "./test-rig.ts";

afterEach(cleanupRigs);

const ALERTS = "C0ACMEALERT";
const link = (channel: string, ts: string, thread?: string) => `https://acme.slack.com/archives/${channel}/p${ts.replace(".", "")}${thread ? `?thread_ts=${thread}&cid=${channel}` : ""}`;

/** Alerts as a notifier posts them: an incoming webhook (username, no user), an app (bot profile, blocks only). */
const ALERT_MESSAGES = [
  {
    ts: "1790000240.000100",
    type: "message",
    subtype: "bot_message",
    username: "Acme Monitor",
    bot_id: "B0ACMEMON01",
    text: "",
    attachments: [{ fallback: "[Firing] Checkout card testing per store: store_acme01 declines 212 > 150", title: "Checkout card testing per store" }],
    channel: { id: ALERTS, name: "acme-alerts" },
    permalink: link(ALERTS, "1790000240.000100"),
  },
  {
    ts: "1790000250.000100",
    type: "message",
    bot_id: "B0ACMEMON02",
    bot_profile: { name: "Acme Pager" },
    text: "",
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "*[Firing]* Jobs daily payout run missing" } }],
    channel: { id: ALERTS, name: "acme-alerts" },
    permalink: link(ALERTS, "1790000250.000100"),
  },
];

/** The fixture of the golden replay, plus the alerts channel and its bot messages in the search results. */
function alertsRig(slack: Record<string, unknown>) {
  const r = goldenRig();
  const fixture = { ...FIXTURE, channels: { ...FIXTURE.channels, [ALERTS]: { name: "acme-alerts" } }, search: [...FIXTURE.search, ...ALERT_MESSAGES] };
  writeFileSync(join(r.dir, "fixture.json"), JSON.stringify(fixture));
  writeFileSync(
    join(r.state, "config.json"),
    JSON.stringify({ owner: { name: "Alice" }, slack: { team: "Acme", workspace: "acme", me: "UALICE", subteams: ["SACME"], ignoreAuthors: [], ignoreChannels: [], teammates: ["Bob"], ...slack }, refresh: { auto: false }, gc: { everyMinutes: 0 } }),
  );
  return r;
}

const kinds = (lines: string[]) => lines.filter((l) => /^\[strato\] [a-z]+ · /.test(l)).map((l) => l.split(" · ").slice(0, 3).join(" · "));

describe("watch-only installation, polled", () => {
  test("watch: the alerts of the watched channel come out as requests, named; DMs and mentions do not; follow-ups do", async () => {
    const r = alertsRig({ watchChannels: [ALERTS], watchOnly: true });
    const out = await runUntil(r, ["watch", "1"], (o) => o.includes("payout run missing"));
    const lines = stdout(out);
    expect(kinds(lines)).toEqual([
      // a follow-up in the thread of a topic this installation tracks (the golden fixture's topic A)
      "[strato] suite · #acme-support · Bob",
      "[strato] moi · #acme-support · Alice Martin",
      "[strato] canal · #acme-alerts · Acme Monitor",
      "[strato] canal · #acme-alerts · Acme Pager",
    ]);
    // the quoted text is neutralized for the master: brackets become parentheses
    expect(out).toContain("« (Firing) Checkout card testing per store: store_acme01 declines 212 > 150 »");
    expect(out).toContain("« *(Firing)* Jobs daily payout run missing »");
    expect(out).not.toMatch(/\[strato\] (dm|mention|fil) · /);
    // the requests are logged like any other: one line per alert, the author's name kept
    const logged = events(r).filter((e) => e.includes('"kind":"canal"'));
    expect(logged).toHaveLength(2);
    expect(logged.join("\n")).toContain('"from":"Acme Monitor"');
    // nothing set aside for the digest either: outside the watched channel, items are ignored, not filed
    expect(events(r).some((e) => e.includes('"type":"info"') && !e.includes(ALERTS))).toBe(false);
  }, 30_000);

  test("a notifier in ignoreAuthors goes to the digest, as in any installation", async () => {
    const r = alertsRig({ watchChannels: [ALERTS], watchOnly: true, ignoreAuthors: ["Acme Monitor"] });
    const out = await runUntil(r, ["watch", "1"], (o) => o.includes("payout run missing"));
    expect(kinds(stdout(out))).not.toContain("[strato] canal · #acme-alerts · Acme Monitor");
    expect(events(r).some((e) => e.includes('"kind":"bot"') && e.includes('"from":"Acme Monitor"'))).toBe(true);
  }, 30_000);

  test("without watchOnly, the same poll raises the bot alerts and everything the owner always got", async () => {
    const r = alertsRig({ watchChannels: [ALERTS] });
    const out = await runUntil(r, ["watch", "1"], (o) => o.includes("payout run missing"));
    const lines = kinds(stdout(out));
    expect(lines).toContain("[strato] canal · #acme-alerts · Acme Monitor");
    expect(lines).toContain("[strato] dm · DM · Bob");
    expect(lines).toContain("[strato] mention · #acme-sales · Bob");
  }, 30_000);

  test("doctor says what the installation raises, and asks for a channel when watchOnly has none", async () => {
    const r = alertsRig({ watchChannels: [], watchOnly: true });
    const out = await runUntil(r, ["doctor"], () => false);
    expect(out).toContain("slack.watchChannels (slack.watchOnly is on: without a watched channel, nothing is ever raised)");
    expect(out).toContain("triggers : watched channels only (slack.watchOnly) -, tracked threads · DMs and mentions are not raised");
  }, 30_000);
});
