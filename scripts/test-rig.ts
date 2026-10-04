/**
 * Rig for the integration tests: a temporary state folder, a temporary HOME and a fake `claude` binary at the head
 * of the PATH. Commands run in real `strato.ts` processes; nothing touches Slack, the real sessions or the real state folder.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SCRIPTS = import.meta.dir;
export const CLI = join(SCRIPTS, "strato.ts");
export const KEY = "C0ACME0001:1759219200.000100";
export const LINK = "https://acme.slack.com/archives/C0ACME0001/p1759219200000100";

/**
 * Fake `claude`: `agents --json` returns agents.json (empty at first); `--bg …` records the call, waits FAKE_SPAWN_DELAY
 * seconds, declares the session alive in agents.json and prints "backgrounded · sN" like the real one.
 */
const FAKE_CLAUDE = `#!/bin/sh
D="$FAKE_CLAUDE_DIR"
if [ "$1" = "agents" ]; then
  if [ -f "$D/agents.json" ]; then cat "$D/agents.json"; else echo "[]"; fi
  exit 0
fi
if [ "$1" = "--bg" ]; then
  shift
  echo "$1" >> "$D/kinds.log"
  printf '%s\\n---\\n' "$*" >> "$D/spawns.log"
  sleep "\${FAKE_SPAWN_DELAY:-0}"
  n=$(wc -l < "$D/kinds.log" | tr -d ' ')
  if [ "$1" = "--resume" ]; then sid="$2"; else sid="sess-acme-$n"; fi
  echo "[{\\"id\\":\\"s$n\\",\\"sessionId\\":\\"$sid\\",\\"status\\":\\"busy\\",\\"name\\":\\"acme\\"}]" > "$D/agents.json"
  echo "backgrounded · s$n"
  exit 0
fi
exit 0
`;

export interface Rig {
  dir: string;
  state: string;
  env: Record<string, string>;
}
const rigs: string[] = [];
/** Call in afterEach: removes the rig folders the test created. */
export function cleanupRigs(): void {
  for (const d of rigs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "strato-state-"));
  rigs.push(dir);
  const state = join(dir, "state");
  for (const d of [state, join(dir, "ws"), join(dir, "home"), join(dir, "bin")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(dir, "bin", "claude"), FAKE_CLAUDE);
  chmodSync(join(dir, "bin", "claude"), 0o755);
  writeFileSync(join(state, "config.json"), JSON.stringify({ owner: { name: "Alice" }, slack: { team: "Acme", workspace: "acme", me: "UALICE" } }));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${join(dir, "bin")}:${process.env.PATH}`,
    HOME: join(dir, "home"),
    STRATO_STATE: state,
    STRATO_WORKSPACE: join(dir, "ws"),
    STRATO_SLACK_TOKEN: "",
    SLACK_MCP_XOXP_TOKEN: "",
    FAKE_CLAUDE_DIR: dir,
    // a test server never fetches the skill's upstream (app/update.ts)
    STRATO_UPDATE_CHECK: "off",
  };
  return { dir, state, env };
}

export function sujet(over: Record<string, unknown> = {}) {
  const at = "2026-09-30T08:00:00Z";
  return {
    key: KEY,
    threads: [KEY],
    letter: "A",
    title: "Relecture acme",
    channel: "#acme",
    permalink: LINK,
    asker: "Alice",
    sessionId: "sess-acme-0",
    shortId: "s0",
    name: "acme · Alice · A",
    status: "waiting",
    gate: "none",
    waiting: "",
    next: "",
    summary: "",
    createdAt: at,
    updatedAt: at,
    history: [],
    ...over,
  };
}

export const writeSujets = (r: Rig, list: unknown[]) => writeFileSync(join(r.state, "sujets.json"), JSON.stringify(list));
export const readSujets = (r: Rig) => (existsSync(join(r.state, "sujets.json")) ? (JSON.parse(readFileSync(join(r.state, "sujets.json"), "utf8")) as Record<string, any>[]) : []);
export const lines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);

export async function run(r: Rig, args: string[], extra: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn([process.execPath, ...args], { cwd: SCRIPTS, env: { ...r.env, ...extra }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}
export const cli = (r: Rig, args: string[], extra: Record<string, string> = {}) => run(r, [CLI, ...args], extra);

/** Starts `serve` on a free port with the rig's state, waits until it answers, and returns how to stop it. */
export async function startServe(r: Rig, extra: { preload?: string; env?: Record<string, string> } = {}): Promise<{ port: number; stop: () => Promise<void> }> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port as number;
  probe.stop(true);
  const p = Bun.spawn([process.execPath, ...(extra.preload ? ["--preload", extra.preload] : []), CLI, "serve", "--port", String(port)], {
    cwd: SCRIPTS,
    env: { ...r.env, ...extra.env },
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

/** A POST from the board: with the page's origin, as the browser sends it. */
export const postBoard = (port: number, path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` }, body: JSON.stringify(body) });
