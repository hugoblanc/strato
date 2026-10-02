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
  printf "%s\\n" "$1" >> "$D/kinds.log"
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

/**
 * Runs a module body in a process of its own on the rig's state, and returns what it returns, through JSON. For the
 * code of app/ and providers/host/: importing it in the test process would resolve the state folder there, once for
 * every test file. `imports` maps a name to a path under scripts/ (`{ claude: "app/claude.ts" }`).
 */
export async function inProcess(r: Rig, imports: Record<string, string>, body: string): Promise<any> {
  const path = join(r.dir, `p${Math.random().toString(36).slice(2, 8)}.ts`);
  const lines = Object.entries(imports).map(([name, file]) => `import * as ${name} from ${JSON.stringify(join(SCRIPTS, file))};`);
  writeFileSync(path, [...lines, `const result = await (async () => { ${body} })();`, "process.stdout.write(JSON.stringify(result ?? null));"].join("\n"));
  const res = await run(r, [path]);
  if (res.code !== 0) throw new Error(res.err);
  return JSON.parse(res.out);
}

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

/** The terminal side of `inTerminal`, in Python: its `pty` module is on every machine python3 is. */
const PTY_DRIVER = `
import json, os, select, sys, time
pairs, timeout = [(p.encode(), a.encode() + b"\\n") for p, a in json.loads(sys.argv[1])], float(sys.argv[3])
pid, fd = os.forkpty()
if pid == 0:
    os.execvp(sys.argv[4], sys.argv[4:])
out, answered, deadline = b"", [0] * len(pairs), time.time() + timeout
while True:
    ready, _, _ = select.select([fd], [], [], 0.1)
    if ready:
        try:
            data = os.read(fd, 4096)
        except OSError:
            data = b""
        out += data
        for i, (prompt, answer) in enumerate(pairs):
            while out.count(prompt) > answered[i]:
                os.write(fd, answer)
                answered[i] += 1
        if data:
            continue
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        code = os.waitstatus_to_exitcode(status)
        break
    if time.time() > deadline:
        os.kill(pid, 9)
        os.waitpid(pid, 0)
        code = None
        break
sys.stdout.write(json.dumps({"exit": code, "out": out.decode("utf-8", "replace")}))
`;

/**
 * Drives a program (`argv[0]`, an absolute path) in a pseudo-terminal, as the person's own terminal would run it:
 * each time the output shows `prompt` once more, `answer` is typed; `more` adds other prompts with their answers.
 * Needs python3 (null without it). `exit` is null when the program was still running after `timeoutMs`; it is then
 * killed.
 */
export async function inTerminal(r: Rig, argv: string[], o: { prompt: string; answer: string; more?: [string, string][]; timeoutMs: number; env?: Record<string, string> }): Promise<{ exit: number | null; out: string } | null> {
  const python = Bun.which("python3");
  if (!python) return null;
  const pairs = JSON.stringify([[o.prompt, o.answer], ...(o.more ?? [])]);
  const p = Bun.spawn([python, "-c", PTY_DRIVER, pairs, "", String(o.timeoutMs / 1000), ...argv], { cwd: SCRIPTS, env: { ...r.env, ...o.env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (!out) throw new Error(err);
  return JSON.parse(out) as { exit: number | null; out: string };
}
