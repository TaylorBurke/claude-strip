import type { EngineInterface, Register } from 'claude-code'

type Phase = 'idle' | 'working' | 'waiting' | 'ended'

const MAX_RECENT = 4
const MAX_PROMPT_CHARS = 300
const MAX_TASK_CHARS = 48

const SYSTEM =
  'You label coding sessions for a tiny status strip. Reply with ONLY a 3-6 word ' +
  'lowercase phrase starting with a verb ending in -ing, naming what the user is ' +
  'working on. No punctuation, no quotes, no preamble.'

// Module state starts over on a hot reload; session.start refills it.
let useHaiku = true
let file = ''
let pid = 0
let project = ''
let cwd = ''
let task = ''
let phase: Phase = 'idle'
let running = 0
let turns = 0
let recent: string[] = []
let isSummarizing = false

function squash(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

async function publish($: EngineInterface): Promise<void> {
  if (!file) return
  const body = { pid, project, cwd, task, phase, running, turns, updatedAt: await $.clock.now() }
  await $.fs.write(file, JSON.stringify(body))
}

async function summarize($: EngineInterface): Promise<void> {
  if (!useHaiku || isSummarizing || recent.length === 0) return
  isSummarizing = true
  try {
    const prompt =
      `Previous label: ${task || '(none)'}\nRecent user prompts, oldest first:\n` +
      recent.map((p, i) => `${i + 1}. ${p}`).join('\n')
    const r = await $.model.complete({ model: 'haiku', system: SYSTEM, prompt, maxTokens: 24, effort: 'low' })
    if (r.isAnswered) {
      const label = squash(r.text.replace(/["'.]/g, ''), MAX_TASK_CHARS)
      if (label) task = label
    }
  } finally {
    isSummarizing = false
  }
  await publish($)
}

export const register: Register = (on, options) => {
  useHaiku = options.useHaiku !== false
  const every = Math.max(1, Number(options.summarizeEvery) || 3)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const runtime = (await $.env.get('XDG_RUNTIME_DIR')) ?? '/tmp'
    // sh is a child of the claude process, so $PPID is the pid the strip matches to a window.
    const ppid = await $.process.run(['sh', '-c', 'echo $PPID'])
    pid = Number.parseInt(ppid.stdout.trim(), 10) || 0
    const root = await $.session.root()
    cwd = e.cwd
    project = root.split('/').filter(Boolean).pop() ?? cwd
    file = pid ? `${runtime}/claude-strip/${pid}.json` : ''
    await publish($)
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    recent = [...recent, squash(e.text, MAX_PROMPT_CHARS)].slice(-MAX_RECENT)
    if (!task) task = squash(e.text, MAX_TASK_CHARS)
    phase = 'working'
    await publish($)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    running += 1
    await publish($)
    try {
      return await next(e)
    } finally {
      running = Math.max(0, running - 1)
      // No event marks the person's approval, so waiting clears when the approved tool finishes.
      if (phase === 'waiting') phase = 'working'
      await publish($)
    }
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    phase = 'waiting'
    await publish($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    phase = 'idle'
    running = 0
    turns += 1
    await publish($)
    if (turns === 1 || turns % every === 0) void summarize($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear') {
      phase = 'ended'
      await publish($)
    }
    return next(e)
  })
}
