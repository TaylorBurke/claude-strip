import { expect, mock, test } from 'claude-code/testing'

type Written = { path: string; body: Record<string, unknown> }

const PID = 4242
const FILE = `/run/user/1000/claude-strip/${PID}.json`
const SESSION = '520a9593-0cb7-48dc-97da-2d7724564449'

// Stand-ins for the engine's own nouns, so the mod runs against what it would see.
function engine(on: Parameters<Parameters<typeof test>[1]>[1], label = 'fixing OTA asset paths') {
  const writes: Written[] = []
  let sessionId = SESSION
  const models: string[] = []
  const clock = mock.clock(on)
  mock.env(on, { XDG_RUNTIME_DIR: '/run/user/1000' })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }) as never)
  on('classic.PermissionRequest', () => ({}) as never)
  on('tool.call', () => ({ result: { content: 'ok' } }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 124000, percent: 62 }, rateLimits: [] } }) as never)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: `${PID}\n`, stderr: '' } }) as never)
  on('session.root', () => ({ value: '/home/ww/Work/native-cards' }))
  on('session.id', () => ({ value: sessionId }) as never)
  on('fs.write', (_$, e) => {
    writes.push({ path: e.path, body: JSON.parse(e.text) })
    return { value: undefined }
  })
  on('model.complete', (_$, e) => {
    models.push(typeof e.prompt === 'string' ? e.prompt : '')
    return { value: { isAnswered: true, text: label, usage: {} } } as never
  })
  return { clock, writes, models, last: () => writes[writes.length - 1]?.body, setSession: (id: string) => { sessionId = id } }
}

test('session.start publishes the project under the claude pid', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/home/ww/Work/native-cards', surface: 'terminal', isInteractive: true })

  expect(world.writes[0]?.path).toBe(FILE)
  expect(world.last()).toMatchObject({ pid: PID, project: 'native-cards', phase: 'idle', running: 0 })
})

test('the session id is published, and read again after a /clear changes it', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  expect(world.last()).toMatchObject({ sessionId: SESSION })

  // /clear: the process goes on under a new id, and no session.start fires
  world.setSession('0d6a4f1e-1111-2222-3333-444455556666')
  await $.prompt.submit({ text: 'first prompt after the clear' })
  expect(world.last()).toMatchObject({ sessionId: '0d6a4f1e-1111-2222-3333-444455556666' })
})

test('a prompt marks the session working and seeds the task from it', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'fix the   OTA asset paths please' })

  expect(world.last()).toMatchObject({ phase: 'working', task: 'fix the OTA asset paths please' })
})

test('a normal-length first prompt is stored whole, not cut for the strip', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const prompt = 'fix the OTA asset paths so renamed folders stop blanking cards on the Android preview build'
  await $.prompt.submit({ text: prompt })

  expect(world.last()?.task).toBe(prompt)
})

test('an enormous first prompt is capped so the state file stays small', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'x'.repeat(1000) })

  expect(String(world.last()?.task).length).toBeLessThanOrEqual(240)
  expect(String(world.last()?.task).endsWith('…')).toBe(true)
})

test('a permission dialog marks the session waiting until the tool call ends', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'run it' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as never)

  expect(world.last()).toMatchObject({ phase: 'waiting' })
})

test('the first prompt gets a Haiku title at once, before any turn ends', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'ota paths are broken' })
  await world.clock.advance(0)

  expect(world.models).toHaveLength(1)
  expect(world.models[0]).toContain('ota paths are broken')
  expect(world.last()).toMatchObject({ phase: 'working', task: 'fixing OTA asset paths' })
})

test('pasted-content tags are not part of the title or the prompt sent to Haiku', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: '<pasted_content id="7"> fix the login loop </pasted_content>' })

  expect(world.writes.some((w) => String(w.body.task).includes('pasted_content'))).toBe(false)
  expect(world.writes[1]?.body.task).toBe('fix the login loop')
  expect(world.models[0]).not.toContain('pasted_content')
})

test('a turn end inside the interval does not call Haiku again, one after it does', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'ota paths are broken' })
  await world.clock.advance(0)
  await $.turn.complete({ reason: 'answer', answer: 'Found the stale asset manifest' } as never)
  await world.clock.advance(60_000)

  expect(world.models).toHaveLength(1)
  expect(world.last()).toMatchObject({ phase: 'idle', turns: 1 })

  await world.clock.advance(120_000)
  await $.prompt.submit({ text: 'now the manifest' })
  await $.turn.complete({ reason: 'answer', answer: 'Rewrote the manifest' } as never)
  await world.clock.advance(0)

  expect(world.models).toHaveLength(2)
  expect(world.models[1]).toContain('Rewrote the manifest')
})

test('a long turn refreshes the title after a tool call once the interval has passed', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'ota paths are broken' })
  await world.clock.advance(0)

  await $.tool.call({ name: 'Bash', input: {} } as never)
  await world.clock.advance(30_000)
  expect(world.models).toHaveLength(1)

  await world.clock.advance(150_000)
  await $.tool.call({ name: 'Bash', input: {} } as never)
  await world.clock.advance(0)
  expect(world.models).toHaveLength(2)
})

test('the context fill is published after a turn', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  expect(world.last()).toMatchObject({ context: -1 })

  await $.prompt.submit({ text: 'go' })
  await $.turn.complete({ reason: 'answer', answer: 'done' } as never)
  await world.clock.advance(0)

  expect(world.last()).toMatchObject({ context: 62 })
})

test('a subagent turn does not count or trigger a summary', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'do the thing' })
  await world.clock.advance(0)
  const before = world.models.length
  await $.turn.complete({ reason: 'answer', answer: 'sub report', agentId: 'agent-1' } as never)
  await world.clock.advance(200_000)

  expect(world.models).toHaveLength(before)
  expect(world.last()).toMatchObject({ phase: 'working', turns: 0 })
})

test('with useHaiku off no model call is made', { options: { useHaiku: false } }, async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'ota paths are broken' })
  await $.turn.complete({ reason: 'answer' } as never)

  expect(world.models).toHaveLength(0)
  expect(world.last()).toMatchObject({ task: 'ota paths are broken' })
})

test('session.end marks ended, but a /clear keeps the session alive', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const before = world.writes.length

  await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never)
  expect(world.writes).toHaveLength(before)

  await $.session.end({ reason: 'other', sessionId: 's', resume: {} } as never)
  expect(world.last()).toMatchObject({ phase: 'ended' })
})
