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
// The session's id, so the strip can be tied to the window another tool shows for the same
// session. A /clear swaps it without a session.start, so it is read again on every publish.
let sessionId = ''
let project = ''
let cwd = ''
let task = ''
let phase: Phase = 'idle'
let running = 0
let turns = 0
let recent: string[] = []
let lastAnswer = ''
let isSummarizing = false
// When Haiku last wrote the title (ms), and whether it ever has: until then the title is only the
// first prompt. Afterwards it is refreshed at most once per interval, while the session works.
let lastSummaryAt = 0
let titled = false
let summaryEveryMs = 150_000
// Share of the context window in use, 0-100; -1 until the engine reports one.
let contextPct = -1

function squash(text: string, max: number): string {
  // Pasted text arrives wrapped in <pasted_content ...> tags; they say nothing about the work.
  const flat = text.replace(/<\/?pasted_content[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

async function refreshSessionId($: EngineInterface): Promise<void> {
  try {
    const id = await $.session.id()
    if (typeof id === 'string' && id) sessionId = id
  } catch {
    // keep the last id
  }
}

async function publish($: EngineInterface): Promise<void> {
  if (!file) return
  await refreshSessionId($)
  const body = { pid, sessionId, project, cwd, task, phase, running, turns, context: contextPct, updatedAt: await $.clock.now() }
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
    lastSummaryAt = await $.clock.now()
    const prompt =
      `Project: ${project}\nPrevious title: ${task || '(none)'}\n` +
      `Recent user prompts, oldest first:\n${recent.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n` +
      `Assistant's latest reply (start of it):\n${lastAnswer || '(none yet)'}`
    const r = await $.model.complete({ model: 'haiku', system: SYSTEM, prompt, maxTokens: 64, effort: 'low' })
    if (r.isAnswered) {
      const label = squash(r.text.replace(/["'.]/g, ''), MAX_TASK_CHARS)
      if (label) {
        task = label
        titled = true
      }
    }
  } finally {
    isSummarizing = false
  }
  await publish($)
}

// Title work runs in the background; a failure must never surface as an unhandled rejection.
function background(work: Promise<void>): void {
  work.catch(() => {})
}

// A refresh while the session works: only if the interval since the last one has passed.
async function refreshIfDue($: EngineInterface): Promise<void> {
  if (isSummarizing || !useHaiku) return
  if ((await $.clock.now()) - lastSummaryAt >= summaryEveryMs) await summarize($)
}

export const register: Register = (on, options) => {
  useHaiku = options.useHaiku !== false
  const minutes = Number(options.summarizeEveryMinutes)
  summaryEveryMs = Math.max(0.5, minutes > 0 ? minutes : 2.5) * 60_000

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
    // The first prompt of a session gets a real title at once, not after the first long turn.
    if (!titled) background(summarize($))
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
      // A long turn keeps the title current: re-written when the interval has passed.
      background(refreshIfDue($))
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
    background(refreshIfDue($))
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
