import { expect, mock, test } from 'claude-code/testing'

const STATE = '/acme/state'
const SID = 'sess-acme-1'
const LIVE = `${STATE}/live/${SID}.mod.json`
const BOX = `${STATE}/mailbox/${SID}.ndjson`
const ACKS = `${STATE}/mailbox/${SID}.acks`

/** The world beneath the mod: an in-memory file system, the session's id, and the prompts it submits. */
function world(on: any, files: Record<string, string> = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { STRATO_STATE: STATE })
  const submitted: any[] = []
  on('session.id', async () => ({ value: SID }))
  on('fs.exists', async ($: any, e: any) => ({ value: e.path in files }))
  on('fs.read', async ($: any, e: any) => {
    if (!(e.path in files)) throw new Error(`ENOENT ${e.path}`)
    return { value: files[e.path] }
  })
  on('fs.write', async ($: any, e: any) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('prompt.submit', async ($: any, e: any) => {
    submitted.push(e)
    return { text: e.text }
  })
  on('session.start', async ($: any, e: any) => ({ cwd: e.cwd }))
  on('turn.start', async ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', async ($: any, e: any) => ({ text: e.answer }))
  on('tool.call', async () => ({ result: { stdout: '' }, text: '' }))
  on('agent.spawn', async () => ({ model: 'haiku', agentId: 'agent-ann' }))
  on('classic.SubagentStart', async () => ({}))
  on('classic.SubagentStop', async () => ({}))
  const live = () => JSON.parse(files[LIVE])
  return { clock, files, submitted, live }
}

test('declares the turn, its current step and its last answer', async ($: any, on: any) => {
  const w = world(on)
  await $.session.start({ cwd: '/acme', surface: null, isInteractive: false })
  expect(w.live().status).toBe('idle')
  await $.turn.start({ turnId: 't1', text: 'go' })
  await $.tool.call({ tool: 'Bash', command: 'sleep 20', description: 'Wait twenty seconds', tool_use_id: 'tu1' })
  await w.clock.settle()
  const during = w.live()
  expect(during.status).toBe('working')
  expect(during.source).toBe('mod')
  expect(during.step.tool).toBe('Bash')
  expect(during.step.input.command).toBe('sleep 20')
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'Done, Ann.', durationMs: 10, isAborted: false })
  await w.clock.settle()
  const after = w.live()
  expect(after.status).toBe('idle')
  expect(after.step).toBe(null)
  expect(after.lastText).toBe('Done, Ann.')
})

test('one sub-agent per agentId, whichever event names it first', async ($: any, on: any) => {
  const w = world(on)
  await $.session.start({ cwd: '/acme', surface: null, isInteractive: false })
  await $.turn.start({ turnId: 't1', text: 'go' })
  await $.classic.SubagentStart({ agent_id: 'agent-ann', agent_type: 'general-purpose' })
  await $.agent.spawn({ tool_use_id: 'tu2', prompt: 'look', description: 'Read the Acme thread', subagentType: 'general-purpose' })
  await w.clock.settle()
  const agents = w.live().agents
  expect(agents.length).toBe(1)
  expect(agents[0].id).toBe('agent-ann')
  expect(agents[0].description).toBe('Read the Acme thread')
  expect(agents[0].status).toBe('running')
  await $.classic.SubagentStop({ agent_id: 'agent-ann', agent_type: 'general-purpose', stop_hook_active: false, last_assistant_message: 'ok', agent_transcript_path: '' })
  await w.clock.settle()
  expect(w.live().agents[0].status).toBe('done')
})

test('an inbox message is queued while the session works, submitted once it is idle, and acknowledged', async ($: any, on: any) => {
  const w = world(on, { [BOX]: `${JSON.stringify({ id: 'm1', text: 'Zoé says go', at: 1 })}\n` })
  await $.session.start({ cwd: '/acme', surface: null, isInteractive: false })
  await $.turn.start({ turnId: 't1', text: 'go' })
  await w.clock.advance(2_100)
  expect(w.submitted.length).toBe(0)
  expect(w.files[ACKS]).toContain('"state":"queued"')
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok', durationMs: 10, isAborted: false })
  await w.clock.advance(2_100)
  expect(w.submitted.length).toBe(1)
  expect(w.submitted[0].text).toBe('Zoé says go')
  expect(w.submitted[0].origin).toEqual({ kind: 'plugin', name: 'strato-state', asUser: true })
  expect(w.files[ACKS]).toContain('"state":"submitted"')
  // never twice, whatever the next passes find
  await w.clock.advance(10_000)
  expect(w.submitted.length).toBe(1)
})
