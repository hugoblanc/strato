/**
 * `task`: what a session puts in front of the person served, one task per thing to decide or to send.
 *   task <topic> add kind=draft|action|decision|question ask="…" proposal="…" [action="…"] [draft="…" draftTo="…" | to=<key>] [act=setStatus|assign value="…"] [audience.to="…" audience.cc="…" subject="…" visibility=public|internal]
 *   task <topic> done <id> [note="…"]
 *   task <topic> drop <id> [note="…"]
 *   task <topic> edit <id> key=value…
 * Every write rereads the topic under the lock (updateSujet). Output for the session, in English: `add` prints the
 * id alone on its first line.
 */
import { fail, nowIso, out } from "../app/env.ts";
import { logEvent, requireSujet, updateSujet } from "../app/store.ts";
import { parseAssignments, type Sujet } from "../core/sujet.ts";
import { addTask, closeTask, editTask, openTasks } from "../core/tasks.ts";

const USAGE = "usage: task <topic> add kind=… ask=\"…\" … | done <id> [note=\"…\"] | drop <id> [note=\"…\"] | edit <id> key=value…";

/** Runs `fn` on the topic reread under the lock; a validation error stops the command with its message, nothing written. */
async function write(key: string, fn: (s: Sujet) => Sujet): Promise<Sujet> {
  let error = null as string | null;
  const next = await updateSujet(key, (x) => {
    try {
      return fn(x);
    } catch (e) {
      error = (e as Error).message;
      return null;
    }
  });
  if (error) fail(error);
  if (!next) fail(`topic ${key} disappeared during the write`);
  return next;
}

const openLine = (s: Sujet) => {
  const open = openTasks(s);
  return `${s.letter} · ${s.status} · ${open.length ? `open: ${open.map((x) => `${x.id} (${x.kind})`).join(", ")}` : "no open task"}`;
};

export async function task(args: string[]) {
  const [ref, op, ...rest] = args;
  if (!ref || !op) fail(USAGE);
  const s = requireSujet(ref);
  let kv: Record<string, string>;
  try {
    kv = parseAssignments(op === "add" ? rest : rest.slice(1));
  } catch (e) {
    fail((e as Error).message);
  }
  if (op === "add") {
    let id = "";
    const next = await write(s.key, (x) => {
      const r = addTask(x, kv, nowIso());
      id = r.task.id;
      return r.sujet;
    });
    logEvent({ type: "task-add", key: s.key, task: id });
    out(id);
    out(openLine(next));
    return;
  }
  const id = rest[0];
  if (!id || id.includes("=")) fail(USAGE);
  if (op === "done" || op === "drop") {
    const extra = Object.keys(kv).filter((k) => k !== "note");
    if (extra.length) fail(`only note="…" goes with ${op}, not ${extra.join(", ")}`);
    const next = await write(s.key, (x) => closeTask(x, id, op === "done" ? "done" : "dropped", nowIso(), kv.note));
    logEvent({ type: `task-${op}`, key: s.key, task: id });
    out(`task ${id} ${op === "done" ? "done" : "dropped"} · ${openLine(next)}`);
    return;
  }
  if (op === "edit") {
    const next = await write(s.key, (x) => editTask(x, id, kv, nowIso()));
    logEvent({ type: "task-edit", key: s.key, task: id });
    out(`task ${id} edited · ${openLine(next)}`);
    return;
  }
  fail(USAGE);
}
