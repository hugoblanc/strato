# Declared state and the session inbox

A topic session tells the board what it is doing, and takes the board's messages from an inbox it acknowledges.
Both go through Strato's mod, a Claude Code plugin of function hooks shipped in `scripts/mod/strato-state/`.

## Why

Before the mod, the board reconstructed a session's state from three readers: `~/.claude/sessions/<pid>.json`, the settings hooks' `live/<sessionId>.json`, and the transcript, parsed incrementally.
Each reader lags or guesses: the transcript only shows a tool call once it is written, the hooks see no tool call at all, and a background agent that outlives its turn looks like an idle session.
A message from the board went through a throwaway `claude -p` that called SendMessage: about 15 s, no acknowledgement, and the session read it as a message from another session.

## The mod

| | |
| --- | --- |
| Source | `scripts/mod/strato-state/` (`.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.js`) |
| Shipped | Embedded as text in the binary (`app/mod.ts`), written to `<state>/mod/strato-state/` before a topic session starts, rewritten only when its content hash changes (`<state>/mod/strato-state.sha`) |
| Loaded | `--plugin-dir <state>/mod/strato-state` on the first spawn of a topic session, never on a resume: a bare `claude --bg --resume <id> <message>` keeps every option of the first spawn, while any flag forks a copy under a new id (`resumeArgs`, `firstSpawnArgs` in `claude/model.ts`) |
| Setting | `workers.mod`, on by default; off, new sessions start without it |
| Checked | `strato doctor` writes the folder if needed and runs `claude plugin validate` on it (a warning, never fatal); `mod.test.ts` runs `claude plugin validate` and `claude plugin test` when `claude` is on the PATH |

The hooks module is JavaScript so that Bun can embed it as text; `tsconfig.json` beside it checks it against the declarations the engine lays in `.claude-plugin/types/` at load.
Every hook only observes and has a `.catch` that passes the event on: a failing hook costs the session nothing.

## Declared state

The mod writes `<state>/live/<sessionId>.mod.json` on every transition and at least every 15 s (`beat`):

```json
{ "source": "mod", "v": 1, "sessionId": "…", "status": "working", "since": 0, "step": { "tool": "Bash", "input": { "command": "sleep 20", "description": "…" }, "at": 0 },
  "stepAt": 0, "trail": [], "lastText": "…", "lastTextAt": 0, "agents": [{ "id": "…", "type": "Explore", "description": "…", "status": "running", "step": null }],
  "waiting": null, "beat": 0, "turnId": "…", "error": false }
```

- `status`: `working` from `turn.start`, `idle` at `turn.complete` of the main loop, `waiting` on a permission ask (`tool.check` answering `ask`, `classic.PermissionRequest`), `ended` at `session.end`.
- `step` and `trail`: the main loop's tool calls, before they run (`tool.call`); the label is built by the board (`activityLabel`), so it follows the board's language.
- `agents`: merged by `agentId` from `agent.spawn`'s result and `classic.SubagentStart`; done at `classic.SubagentStop` or their own `turn.complete`. A running agent stays across turns: an idle session may still have background agents at work.
- On `session.start` (a new process, including after the supervisor restarts a killed session) the mod reads its previous file back: last answer and agents, running agents marked stopped.

The board (`server/serve.ts`) uses the file for a topic session when its beat is younger than 60 s or it says `ended`: status, since, current step, last answer and sub-agents come from it.
Otherwise, and for sessions started before the mod, the earlier readers stand unchanged.
The status line's tooltip says which: "state declared by the session" or "state reconstructed from Claude Code's files".
The mod's file system has no rename, so a read can catch a write halfway: the reader keeps the last whole declaration (`readModState`).
`session.end` is not reliable (missing on `kill -9`): a silent session goes stale after 60 s and falls back on its own.

## Inbox

`POST /api/send` (and the card refresh) to a session with a fresh, not ended declaration:

1. The server appends `{ id, text, at }` to `<state>/mailbox/<sessionId>.ndjson` (not `inbox/`, which holds the listener's messages and is pruned by age), dropping the messages already acknowledged as submitted.
2. The mod polls it every 2 s. While the session works it writes `{ id, state: "queued", at }` to `<state>/mailbox/<sessionId>.acks`; once idle it submits the first pending message as the person's prompt (`$.prompt.submit({ text, asUser: true })`, one per turn) and writes `submitted`.
3. The server waits up to 20 s for an ack and answers "taken" (`submitted`) or "accepted, runs after the current turn" (`queued`).
4. No ack: the server takes the message back from the file and uses the earlier routes (SendMessage relay, or a bare resume), and its answer says the session did not acknowledge it.

A message is never deleted by the mod: one not submitted stays in the file for the session's next start.
Closing a topic deletes its declaration and mailbox (`purgeLive`).

## Limits

- A message the mod picks up in the instant the server withdraws it after a timeout can be delivered twice.
- A message acknowledged as queued in a session that is then stopped runs only when the session is resumed.
- The foreground `claude --resume` of the board's terminal (`commands/dive.ts`) passes no option, but whether a foreground resume reloads a `--bg` session's plugin folder is not verified.
- Timers pause while the machine sleeps: the beat goes stale and the board falls back until the session's next event.
