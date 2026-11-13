import type { EngineInterface, Register } from 'claude-code'

type Phase = 'idle' | 'working' | 'waiting' | 'ended'

const MAX_RECENT = 4
const MAX_PROMPT_CHARS = 300
const MAX_ANSWER_CHARS = 500
// How much of what the assistant has been doing goes to Haiku: its last few messages, each cut.
const MAX_ACTIVITY = 4
const MAX_ACTIVITY_CHARS = 300
// A safety cap only: titles are stored whole and the strip trims to fit its width.
const MAX_TASK_CHARS = 240

const SYSTEM =
  'You write the title shown in a header strip above a coding session, so someone ' +
  'juggling several sessions can tell them apart. Reply with ONLY a lowercase phrase ' +
  'starting with a verb ending in -ing that names the concrete feature, bug, file or ' +
  'system the assistant is working on right now, not the generic activity (6-12 words). ' +
  'When that current subtask is part of a bigger task, and the two differ, follow it ' +
  'with the bigger task in a short parenthetical (3-8 words), for example: ' +
  'disabling failing tests until code changes land (updating testing policy for native-cards). ' +
  'When the current work is the task itself, give the phrase alone, with no parenthetical. ' +
  'Read the bigger task from the previous title and keep it as it is until the user changes ' +
  'what they are after. Judge by what the assistant has been doing most recently. No quotes, ' +
  'no trailing punctuation, no preamble.'

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
// Until Haiku has written one, the title is the prompt, cut. Haiku is asked once per user prompt,
// as soon as the assistant has started to respond (a tool call finishes or the turn ends), so it
// can see what the answer is about. Past `longTaskAfterMs` since the prompt, the task has run
// long, and the title is refreshed every `summaryEveryMs` as it changes gears.
let promptAt = 0
let lastSummaryAt = -1
let summaryEveryMs = 120_000
let longTaskAfterMs = 180_000
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

// What the assistant has been doing lately: its latest few messages, cut, and the tools it used
// with the one-line description it gave each. Falls back to the last reply if the transcript
// cannot be read.
async function recentActivity($: EngineInterface): Promise<string> {
  try {
    const rows = (await $.session.messages()).filter((m) => m.role === 'assistant').slice(-MAX_ACTIVITY)
    const lines = rows.map((m) => {
      const tools = m.toolUses
        .map((t) => {
          const d = typeof t.input?.description === 'string' ? `: ${squash(t.input.description, 80)}` : ''
          return `${t.tool}${d}`
        })
        .join('; ')
      return [squash(m.text, MAX_ACTIVITY_CHARS), tools && `[tools: ${tools}]`].filter(Boolean).join(' ')
    })
    const text = lines.filter(Boolean).join('\n')
    if (text) return text
  } catch {
    // use the last reply
  }
  return lastAnswer || '(nothing yet)'
}

async function summarize($: EngineInterface): Promise<void> {
  if (!useHaiku || isSummarizing || recent.length === 0) return
  isSummarizing = true
  try {
    const now = await $.clock.now()
    lastSummaryAt = now
    const sincePrompt = Math.max(0, Math.round((now - promptAt) / 60_000))
    const prompt =
      `Project: ${project}\nPrevious title: ${task || '(none)'}\n` +
      `Recent user prompts, oldest first:\n${recent.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n` +
      `Minutes since the user's last prompt: ${sincePrompt}\n` +
      `What the assistant has been doing, oldest first:\n${await recentActivity($)}`
    const r = await $.model.complete({ model: 'haiku', system: SYSTEM, prompt, maxTokens: 96, effort: 'low' })
    if (r.isAnswered) {
      // Wrapping quotes and a trailing full stop go; dots inside (file names) stay.
      const label = squash(r.text.replace(/^["'\s]+|["'.\s]+$/g, '').replace(/"/g, ''), MAX_TASK_CHARS)
      if (label) task = label
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

// Called when a tool call finishes or a turn ends, the moments the assistant has visibly
// responded. Once per user prompt, at the first of them; and, for a task that has run past
// `longTaskAfterMs` since the prompt, again every `summaryEveryMs`. Nothing fires without an
// event: an idle session is left alone.
async function refreshIfDue($: EngineInterface): Promise<void> {
  if (isSummarizing || !useHaiku) return
  const now = await $.clock.now()
  if (lastSummaryAt < promptAt) await summarize($)
  else if (now - promptAt >= longTaskAfterMs && now - lastSummaryAt >= summaryEveryMs) await summarize($)
}

export const register: Register = (on, options) => {
  useHaiku = options.useHaiku !== false
  const every = Number(options.summarizeEveryMinutes)
  summaryEveryMs = Math.max(0.5, every > 0 ? every : 2) * 60_000
  const after = Number(options.longTaskAfterMinutes)
  longTaskAfterMs = Math.max(0.5, after > 0 ? after : 3) * 60_000

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
    promptAt = await $.clock.now()
    phase = 'working'
    await publish($)
    // Haiku is asked once the assistant has begun to respond (refreshIfDue), not here.
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
