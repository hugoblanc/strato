// @ts-check
/**
 * strato-state: a topic session declares its own live state to Strato's board, and takes the board's messages from an
 * inbox it acknowledges.
 *
 * Writes `<state>/live/<sessionId>.mod.json` on every transition and at least every 15 s (the beat the board trusts),
 * and reads `<state>/mailbox/<sessionId>.ndjson`, one JSON message per line `{ id, text, at }`: a message is submitted as
 * the person's prompt once the session is idle, then acknowledged in `<state>/mailbox/<sessionId>.acks`
 * (`{ id, state: "queued" | "submitted", at }` per line). The server prunes the messages acknowledged as submitted;
 * this side never deletes anything (the engine's file system has no delete), so a message the session did not take
 * stays for its next start.
 *
 * Written in JavaScript so that Strato can embed it as text in its binary; `tsconfig.json` checks it against the
 * declarations the engine lays in `.claude-plugin/types/`.
 */

const VERSION = 1
const BEAT_MS = 15_000
const INBOX_MS = 2_000
const TRAIL_MAX = 4
const AGENTS_MAX = 20
const TEXT_MAX = 2_000
const FIELD_MAX = 200
/** The tool input fields worth a step's label (the board builds the label); everything else stays in the transcript. */
const STEP_FIELDS = ['description', 'command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'skill', 'to', 'id', 'search_query', 'subagent_type']

/**
 * @typedef {{ tool: string, input: Record<string, string>, at: number }} Step
 * @typedef {{ id: string, type: string | null, description: string | null, model: string | null, parentId: string | null, status: 'running' | 'done' | 'error' | 'stopped', since: number, lastAt: number, step: Step | null }} Agent
 * @typedef {{ tool: string, input: Record<string, string>, since: number, toolUseId: string | null }} Waiting
 * @typedef {{ id: string, text: string, at?: number }} InboxMessage
 */

const st = {
  /** @type {'working' | 'idle' | 'waiting' | 'ended'} */
  status: 'idle',
  since: Date.now(),
  /** @type {Step | null} */
  step: null,
  stepAt: 0,
  /** @type {Step[]} */
  trail: [],
  lastText: '',
  lastTextAt: 0,
  /** @type {Agent[]} */
  agents: [],
  /** @type {Waiting | null} */
  waiting: null,
  beat: 0,
  /** @type {string | null} */
  turnId: null,
  /** The last main turn ended on an API error. */
  error: false,
}

/** @type {{ state: string, sid: string } | null} */
let where = null
/** @type {Promise<unknown>} */
let chain = Promise.resolve()
let started = false
let polling = false
/** The acks after which a message is never taken again: run, or refused. */
const DONE = new Set(['submitted', 'refused'])
/** Messages this process submitted: never twice, even before their ack is on disk. */
const submitted = new Set()

/** @param {unknown} v @param {number} n */
const clip = (v, n) => {
  const s = typeof v === 'string' ? v : ''
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** @param {string} tool @param {Record<string, unknown>} e @returns {Step} */
function stepOf(tool, e) {
  /** @type {Record<string, string>} */
  const input = {}
  for (const k of STEP_FIELDS) if (typeof e[k] === 'string' && e[k]) input[k] = clip(String(e[k]).split('\n')[0], FIELD_MAX)
  return { tool, input, at: Date.now() }
}

/**
 * The state folder: Strato gives it to every topic session (`STRATO_STATE` in its settings' env); else the mod's own
 * place, `<state>/mod/strato-state`, written there by Strato. Neither: the mod stays silent.
 * @param {import('claude-code').EngineInterface} $
 */
async function locate($) {
  if (where) return where
  const env = await $.env.get('STRATO_STATE')
  const m = $.plugin.root.match(/^(.*)\/mod\/strato-state\/?$/)
  const state = env || (m ? m[1] : '')
  if (!state) return null
  where = { state, sid: await $.session.id() }
  return where
}

/** @param {import('claude-code').EngineInterface} $ */
function flush($) {
  chain = chain
    .then(async () => {
      const w = await locate($)
      if (!w) return
      st.beat = Date.now()
      const { status, since, step, stepAt, trail, lastText, lastTextAt, agents, waiting, beat, turnId, error } = st
      const doc = { source: 'mod', v: VERSION, sessionId: w.sid, status, since, step, stepAt, trail, lastText, lastTextAt, agents, waiting, beat, turnId, error }
      await $.fs.write(`${w.state}/live/${w.sid}.mod.json`, `${JSON.stringify(doc)}\n`)
    })
    .catch(() => {})
  return chain
}

/**
 * What a previous process of this session left: after a restart (`afterRestart`) its running agents died with it and
 * nothing runs; after a reload of this module alone the session goes on as written.
 * @param {import('claude-code').EngineInterface} $ @param {boolean} afterRestart
 */
async function restore($, afterRestart) {
  const w = await locate($)
  if (!w) return
  try {
    const path = `${w.state}/live/${w.sid}.mod.json`
    if (!(await $.fs.exists(path))) return
    const prev = JSON.parse(String(await $.fs.read(path)))
    if (!prev || prev.v !== VERSION) return
    st.lastText = typeof prev.lastText === 'string' ? prev.lastText : ''
    st.lastTextAt = Number(prev.lastTextAt) || 0
    st.agents = Array.isArray(prev.agents) ? prev.agents.slice(-AGENTS_MAX) : []
    if (afterRestart) {
      for (const a of st.agents) if (a.status === 'running') a.status = 'stopped'
      return
    }
    if (['working', 'idle', 'waiting'].includes(prev.status)) st.status = prev.status
    st.since = Number(prev.since) || st.since
    st.step = prev.step ?? null
    st.stepAt = Number(prev.stepAt) || 0
    st.trail = Array.isArray(prev.trail) ? prev.trail.slice(-TRAIL_MAX) : []
    st.waiting = prev.waiting ?? null
    st.turnId = prev.turnId ?? null
  } catch {}
}

/**
 * Timers live as long as this module: started at the session's start, or at the first event after a reload of the
 * module (a reload runs no `session.start`).
 * @param {import('claude-code').EngineInterface} $ @param {boolean} afterRestart
 */
async function start($, afterRestart) {
  if (started) return
  started = true
  await restore($, afterRestart)
  $.clock.every(BEAT_MS, () => void flush($))
  $.clock.every(INBOX_MS, () => void pollInbox($))
}

/** @param {string} id @returns {Agent} */
function agent(id) {
  let a = st.agents.find((x) => x.id === id)
  if (!a) {
    a = { id, type: null, description: null, model: null, parentId: null, status: 'running', since: Date.now(), lastAt: Date.now(), step: null }
    st.agents.push(a)
    // the oldest finished agents go first: a running one is never dropped to make room
    while (st.agents.length > AGENTS_MAX) {
      const i = st.agents.findIndex((x) => x.status !== 'running')
      st.agents.splice(i < 0 ? 0 : i, 1)
    }
  }
  return a
}

/** @param {'working' | 'idle' | 'waiting' | 'ended'} status */
function setStatus(status) {
  if (st.status !== status) st.since = Date.now()
  st.status = status
}

// ------------------------------------------------------------------ inbox

/** @param {string} raw @returns {InboxMessage[]} */
function messagesOf(raw) {
  /** @type {InboxMessage[]} */
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const m = JSON.parse(line)
      if (m && typeof m.id === 'string' && typeof m.text === 'string' && m.text.trim()) out.push(m)
    } catch {}
  }
  return out
}

/** @param {string} raw @returns {Map<string, { state: string, at: number }>} */
function acksOf(raw) {
  const out = new Map()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const a = JSON.parse(line)
      if (a && typeof a.id === 'string' && typeof a.state === 'string' && !DONE.has(out.get(a.id)?.state ?? '')) out.set(a.id, { state: a.state, at: a.at })
    } catch {}
  }
  return out
}

/**
 * The slash command a message is, when it is one the session can run now ("/compact", "/compact keep the plan"):
 * a known name right after the slash at the very start, the rest as its arguments; 'unknown' for a slash and a name
 * the session does not have; null for any other text.
 * @param {import('claude-code').EngineInterface} $
 * @param {string} text
 */
async function commandOf($, text) {
  const m = text.trim().match(/^\/([A-Za-z0-9_:-]+)(?:\s+([\s\S]*))?$/)
  if (!m) return null
  const known = (await $.command.list()).some((c) => c.name === m[1])
  return known ? { command: m[1], args: (m[2] ?? '').trim() } : 'unknown'
}

/**
 * One pass over the inbox: pending messages are acknowledged as queued while the session works, and the first one is
 * submitted once it is idle. One per pass: each makes a turn of its own, and the next waits for that turn's end.
 * @param {import('claude-code').EngineInterface} $
 */
async function pollInbox($) {
  if (polling) return
  polling = true
  try {
    const w = await locate($)
    if (!w) return
    const box = `${w.state}/mailbox/${w.sid}.ndjson`
    if (!(await $.fs.exists(box))) return
    const messages = messagesOf(String(await $.fs.read(box)))
    if (!messages.length) return
    const ackPath = `${w.state}/mailbox/${w.sid}.acks`
    const acks = (await $.fs.exists(ackPath)) ? acksOf(String(await $.fs.read(ackPath))) : new Map()
    const pending = messages.filter((m) => !DONE.has(acks.get(m.id)?.state ?? '') && !submitted.has(m.id))
    if (!pending.length) return
    /** @type {{ id: string, state: string }[]} */
    const fresh = []
    if (st.status !== 'idle') {
      for (const m of pending) if (!acks.has(m.id)) fresh.push({ id: m.id, state: 'queued' })
    } else {
      const m = pending[0]
      submitted.add(m.id)
      const command = await commandOf($, m.text)
      if (command === 'unknown') {
        // the engine takes no prompt that opens with a slash: a name the session does not know is refused, and said
        fresh.push({ id: m.id, state: 'refused' })
      } else if (command) {
        // a slash command the session knows runs as one (/compact): a prompt would hand its text to the model.
        // No status change: a command may make no turn, and this pass holds the inbox until it has run.
        await $.command.run(command)
        fresh.push({ id: m.id, state: 'submitted' })
      } else {
        // the session counts as working at once: the next pass must not submit a second message before turn.start
        setStatus('working')
        await $.prompt.submit({ text: m.text, asUser: true })
        fresh.push({ id: m.id, state: 'submitted' })
      }
    }
    if (!fresh.length) return
    const now = Date.now()
    for (const f of fresh) acks.set(f.id, { state: f.state, at: now })
    // only the acks of messages still in the inbox: the file stays as small as the inbox the server prunes
    const keep = new Set(messages.map((m) => m.id))
    const lines = [...acks].filter(([id]) => keep.has(id)).map(([id, a]) => JSON.stringify({ id, state: a.state, at: a.at }))
    await $.fs.write(ackPath, `${lines.join('\n')}\n`)
    void flush($)
  } catch {
  } finally {
    polling = false
  }
}

// ------------------------------------------------------------------ hooks

/**
 * Every hook only observes: one that fails must cost the session nothing, so its event goes on as if it were absent.
 * `next` is replay-safe here: a call it already made is not run again.
 * @param {any} $ @param {any} e @param {any} next
 */
const pass = ($, e, next) => next(e)

/** @type {import('claude-code').Register} */
export const register = (on) => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    where = null
    st.status = 'idle'
    st.since = Date.now()
    st.step = null
    st.trail = []
    st.waiting = null
    await start($, true)
    await flush($)
    return r
  }).catch(pass)

  on('session.end', async ($, e, next) => {
    setStatus('ended')
    st.step = null
    st.waiting = null
    await flush($)
    // after a /clear the process goes on under another session id: the next write finds it
    await chain
    where = null
    return next(e)
  }).catch(pass)

  on('turn.start', async ($, e, next) => {
    await start($, false)
    if (/** @type {{ agentId?: string }} */ (e).agentId) return next(e)
    setStatus('working')
    st.turnId = e.turnId
    st.step = null
    st.stepAt = Date.now()
    st.trail = []
    st.waiting = null
    st.error = false
    // finished agents of earlier turns go; a background agent still running stays until it stops
    st.agents = st.agents.filter((a) => a.status === 'running')
    void flush($)
    return next(e)
  }).catch(pass)

  on('tool.call', async ($, e, next) => {
    await start($, false)
    const call = /** @type {Record<string, unknown> & { tool: string, agentId?: string, tool_use_id?: string }} */ (/** @type {unknown} */ (e))
    const step = stepOf(String(call.tool), call)
    if (call.agentId) {
      const a = st.agents.find((x) => x.id === call.agentId)
      if (a) {
        a.step = step
        a.lastAt = step.at
      }
    } else {
      st.step = step
      st.stepAt = step.at
      st.trail = [...st.trail, step].slice(-TRAIL_MAX)
    }
    void flush($)
    const r = await next(e)
    // a permission asked for this call was answered: the session works again
    if (st.waiting && (!st.waiting.toolUseId || st.waiting.toolUseId === call.tool_use_id)) {
      st.waiting = null
      if (st.status === 'waiting') setStatus('working')
      void flush($)
    }
    return r
  }).catch(pass)

  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    if (r.decision === 'ask') {
      const input = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (e.input ?? {}))
      const step = stepOf(String(e.tool), input)
      st.waiting = { tool: step.tool, input: step.input, since: Date.now(), toolUseId: e.tool_use_id ?? null }
      setStatus('waiting')
      void flush($)
    }
    return r
  }).catch(pass)

  on('classic.PermissionRequest', async ($, e, next) => {
    const p = /** @type {{ tool_name?: string, tool_input?: Record<string, unknown> }} */ (/** @type {unknown} */ (e))
    if (!st.waiting) {
      const step = stepOf(String(p.tool_name ?? ''), p.tool_input ?? {})
      st.waiting = { tool: step.tool, input: step.input, since: Date.now(), toolUseId: null }
    }
    setStatus('waiting')
    void flush($)
    return next(e)
  }).catch(pass)

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r && r.agentId) {
      const a = agent(r.agentId)
      a.type = e.subagentType ?? a.type
      a.description = e.description ?? a.description
      a.model = r.model ?? a.model
      a.parentId = /** @type {{ parentAgentId?: string }} */ (e).parentAgentId ?? a.parentId
      void flush($)
    }
    return r
  }).catch(pass)

  on('classic.SubagentStart', async ($, e, next) => {
    const p = /** @type {{ agent_id?: string, agent_type?: string }} */ (/** @type {unknown} */ (e))
    if (p.agent_id) {
      const a = agent(p.agent_id)
      a.type = a.type ?? p.agent_type ?? null
      a.status = 'running'
      void flush($)
    }
    return next(e)
  }).catch(pass)

  on('classic.SubagentStop', async ($, e, next) => {
    const p = /** @type {{ agent_id?: string }} */ (/** @type {unknown} */ (e))
    const a = p.agent_id ? st.agents.find((x) => x.id === p.agent_id) : undefined
    if (a && a.status === 'running') {
      a.status = 'done'
      a.lastAt = Date.now()
      a.step = null
      void flush($)
    }
    return next(e)
  }).catch(pass)

  on('turn.complete', async ($, e, next) => {
    await start($, false)
    if (e.agentId) {
      const a = st.agents.find((x) => x.id === e.agentId)
      if (a) {
        a.status = e.reason === 'error' ? 'error' : 'done'
        a.lastAt = Date.now()
        a.step = null
        void flush($)
      }
      return next(e)
    }
    setStatus('idle')
    st.step = null
    st.stepAt = Date.now()
    st.waiting = null
    st.error = e.reason === 'error'
    if (e.answer && e.answer.trim()) {
      st.lastText = clip(e.answer.trim(), TEXT_MAX)
      st.lastTextAt = Date.now()
    }
    void flush($)
    return next(e)
  }).catch(pass)
}
