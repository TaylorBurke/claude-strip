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
  const systems: string[] = []
  let transcript: unknown[] = []
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
  on('session.messages', () => ({ value: transcript }) as never)
  on('model.complete', (_$, e) => {
    models.push(typeof e.prompt === 'string' ? e.prompt : '')
    systems.push(typeof e.system === 'string' ? e.system : '')
    return { value: { isAnswered: true, text: label, usage: {} } } as never
  })
  return { clock, writes, models, systems, setTranscript: (rows: unknown[]) => { transcript = rows }, last: () => writes[writes.length - 1]?.body, setSession: (id: string) => { sessionId = id } }
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

const WORK = [
  { role: 'user', text: 'fix the ota paths', toolUses: [] },
  { role: 'assistant', text: 'Looking at the asset manifest first.', toolUses: [{ tool: 'Bash', input: { description: 'List the stale asset manifests' } }] },
]

test('the title is not asked for at the prompt, but at the first response to it', async ($, on) => {
  const world = engine(on)
  world.setTranscript(WORK)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'ota paths are broken' })
  await world.clock.advance(0)
  expect(world.models).toHaveLength(0)
  expect(world.last()).toMatchObject({ task: 'ota paths are broken' })

  await $.tool.call({ tool: 'Bash', input: {} } as never)
  await world.clock.advance(0)
  expect(world.models).toHaveLength(1)
  expect(world.models[0]).toContain('ota paths are broken')
  expect(world.models[0]).toContain('Looking at the asset manifest first.')
  expect(world.models[0]).toContain('List the stale asset manifests')
  expect(world.last()).toMatchObject({ task: 'fixing OTA asset paths' })
})

test('a turn that ends without a tool call is also a response', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'what does this flag do' })
  await $.turn.complete({ reason: 'answer', answer: 'It turns the cache off' } as never)
  await world.clock.advance(0)

  expect(world.models).toHaveLength(1)
  expect(world.models[0]).toContain('It turns the cache off')   // no transcript: the last reply stands in
})

test('a second tool call or the turn end in the same prompt does not ask again', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'ota paths are broken' })
  await $.tool.call({ tool: 'Bash', input: {} } as never)
  await world.clock.advance(0)
  await $.tool.call({ tool: 'Read', input: {} } as never)
  await $.turn.complete({ reason: 'answer', answer: 'done' } as never)
  await world.clock.advance(60_000)

  expect(world.models).toHaveLength(1)
})

test('every new user prompt gets a title after its first response, however soon', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'ota paths are broken' })
  await $.turn.complete({ reason: 'answer', answer: 'fixed' } as never)
  await world.clock.advance(5_000)
  await $.prompt.submit({ text: 'now the manifest' })
  await $.turn.complete({ reason: 'answer', answer: 'rewrote it' } as never)
  await world.clock.advance(0)

  expect(world.models).toHaveLength(2)
  expect(world.models[1]).toContain('now the manifest')
})

test('a task that runs past 3 minutes is re-titled every 2 minutes as it changes gears', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'update the testing policy' })
  await world.clock.advance(10_000)
  await $.tool.call({ tool: 'Bash', input: {} } as never)            // first response: title 1
  await world.clock.advance(0)
  expect(world.models).toHaveLength(1)

  await world.clock.advance(100_000)                                 // 1:50 in: not a long task yet
  await $.tool.call({ tool: 'Bash', input: {} } as never)
  await world.clock.advance(0)
  expect(world.models).toHaveLength(1)

  await world.clock.advance(80_000)                                  // 3:10 in, only 3:00 since title 1 but title 1 was 3:00 ago
  await $.tool.call({ tool: 'Bash', input: {} } as never)
  await world.clock.advance(0)
  expect(world.models).toHaveLength(2)
  expect(world.models[1]).toContain('Minutes since the user')

  await world.clock.advance(60_000)                                  // 1:00 after title 2: too soon
  await $.tool.call({ tool: 'Bash', input: {} } as never)
  await world.clock.advance(0)
  expect(world.models).toHaveLength(2)

  await world.clock.advance(70_000)                                  // 2:10 after title 2
  await $.tool.call({ tool: 'Bash', input: {} } as never)
  await world.clock.advance(0)
  expect(world.models).toHaveLength(3)
})

test('an idle session is never re-titled, however long it sits', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'ota paths are broken' })
  await $.turn.complete({ reason: 'answer', answer: 'fixed' } as never)
  await world.clock.advance(0)
  await world.clock.advance(3_600_000)

  expect(world.models).toHaveLength(1)
})

test('the title may lead with the subtask and keep the bigger task in a parenthetical', async ($, on) => {
  const label = 'disabling failing tests until code changes land (updating testing policy for native-cards)'
  const world = engine(on, label)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'update the testing policy' })
  await $.turn.complete({ reason: 'answer', answer: 'ok' } as never)
  await world.clock.advance(0)

  expect(world.last()?.task).toBe(label)
  expect(world.systems[0]).toContain('parenthetical')
  expect(world.systems[0]).toContain('previous title')
})

test('quotes around a title go, but dots inside a file name stay', async ($, on) => {
  const world = engine(on, '"refactoring register.ts so titles follow the work."')
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'go' })
  await $.turn.complete({ reason: 'answer', answer: 'ok' } as never)
  await world.clock.advance(0)

  expect(world.last()?.task).toBe('refactoring register.ts so titles follow the work')
})

test('pasted-content tags are not part of the title or the prompt sent to Haiku', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: '<pasted_content id="7"> fix the login loop </pasted_content>' })
  expect(world.writes.some((w) => String(w.body.task).includes('pasted_content'))).toBe(false)
  expect(world.writes[1]?.body.task).toBe('fix the login loop')

  await $.turn.complete({ reason: 'answer', answer: 'ok' } as never)
  await world.clock.advance(0)
  expect(world.models[0]).not.toContain('pasted_content')
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
  await $.turn.complete({ reason: 'answer', answer: 'sub report', agentId: 'agent-1' } as never)
  await world.clock.advance(200_000)

  expect(world.models).toHaveLength(0)
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
