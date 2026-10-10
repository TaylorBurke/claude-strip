import type { EngineInterface, Register } from 'claude-code'

type Phase = 'idle' | 'working' | 'waiting' | 'ended'

const MAX_RECENT = 4
const MAX_PROMPT_CHARS = 300
const MAX_ANSWER_CHARS = 500
// A safety cap only: titles are stored whole and the strip trims to fit its width.
const MAX_TASK_CHARS = 240

const SYSTEM =
  'You write the title shown in a header strip above a coding session, so someone ' +
  'juggling several sessions can tell them apart. Reply with ONLY a specific 8-14 ' +
  'word lowercase phrase starting with a verb ending in -ing. Name the concrete ' +
  'feature, bug, file or system being worked on, not the generic activity. Judge by ' +
  'the whole session, favouring what the assistant is doing now. No quotes, no ' +
  'trailing punctuation, no preamble.'

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
let lastAnswer = ''
let isSummarizing = false
// Share of the context window in use, 0-100; -1 until the engine reports one.
let contextPct = -1

function squash(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

async function publish($: EngineInterface): Promise<void> {
  if (!file) return
  const body = { pid, project, cwd, task, phase, running, turns, context: contextPct, updatedAt: await $.clock.now() }
  await $.fs.write(file, JSON.stringify(body))
}

async function refreshContext($: EngineInterface): Promise<void> {
  try {
    const usage = await $.session.usage()
    contextPct = typeof usage.context.percent === 'number' ? Math.round(usage.context.percent) : -1
  } catch {
    contextPct = -1
  }
}

async function summarize($: EngineInterface): Promise<void> {
  if (!useHaiku || isSummarizing || recent.length === 0) return
  isSummarizing = true
  try {
    const prompt =
      `Project: ${project}\nPrevious title: ${task || '(none)'}\n` +
      `Recent user prompts, oldest first:\n${recent.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n` +
      `Assistant's latest reply (start of it):\n${lastAnswer || '(none yet)'}`
    const r = await $.model.complete({ model: 'haiku', system: SYSTEM, prompt, maxTokens: 64, effort: 'low' })
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
      await refreshContext($)
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
    // Subagent turns also land here; only the main loop moves the strip.
    if (e.agentId) return next(e)
    lastAnswer = squash(e.answer ?? '', MAX_ANSWER_CHARS)
    phase = 'idle'
    running = 0
    turns += 1
    await refreshContext($)
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
