import { expect, mock, test } from 'claude-code/testing'

type Written = { path: string; body: Record<string, unknown> }

const PID = 4242
const FILE = `/run/user/1000/claude-strip/${PID}.json`

// Stand-ins for the engine's own nouns, so the mod runs against what it would see.
function engine(on: Parameters<Parameters<typeof test>[1]>[1], label = 'fixing OTA asset paths') {
  const writes: Written[] = []
  const models: string[] = []
  const clock = mock.clock(on)
  mock.env(on, { XDG_RUNTIME_DIR: '/run/user/1000' })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }) as never)
  on('classic.PermissionRequest', () => ({}) as never)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: `${PID}\n`, stderr: '' } }) as never)
  on('session.root', () => ({ value: '/home/ww/Work/native-cards' }))
  on('fs.write', (_$, e) => {
    writes.push({ path: e.path, body: JSON.parse(e.text) })
    return { value: undefined }
  })
  on('model.complete', (_$, e) => {
    models.push(typeof e.prompt === 'string' ? e.prompt : '')
    return { value: { isAnswered: true, text: label, usage: {} } } as never
  })
  return { clock, writes, models, last: () => writes[writes.length - 1]?.body }
}

test('session.start publishes the project under the claude pid', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/home/ww/Work/native-cards', surface: 'terminal', isInteractive: true })

  expect(world.writes[0]?.path).toBe(FILE)
  expect(world.last()).toMatchObject({ pid: PID, project: 'native-cards', phase: 'idle', running: 0 })
})

test('a prompt marks the session working and seeds the task from it', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'fix the   OTA asset paths please' })

  expect(world.last()).toMatchObject({ phase: 'working', task: 'fix the OTA asset paths please' })
})

test('a long first prompt is truncated for the strip', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'x'.repeat(200) })

  expect(String(world.last()?.task).length).toBeLessThanOrEqual(48)
  expect(String(world.last()?.task).endsWith('…')).toBe(true)
})

test('a permission dialog marks the session waiting until the tool call ends', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'run it' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as never)

  expect(world.last()).toMatchObject({ phase: 'waiting' })
})

test('turn.complete goes idle and Haiku rewrites the task after turn 1', async ($, on) => {
  const world = engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'ota paths are broken' })
  await $.turn.complete({ reason: 'answer' } as never)
  await world.clock.advance(0)

  expect(world.models).toHaveLength(1)
  expect(world.models[0]).toContain('ota paths are broken')
  expect(world.last()).toMatchObject({ phase: 'idle', turns: 1, task: 'fixing OTA asset paths' })
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
