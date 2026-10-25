// Subagents for side threads: spawn, wait for the answer by agentId, relay
// one-line tool summaries, stop on request. Module state is lost on a reload;
// session.start then marks the turn as interrupted.

import type { EngineInterface } from 'claude-code'

import type { Answer, CancelSignal, Effort, Usage } from '../../core/types'

/** The plugin's own agent types: one per thinking effort, since a spawn cannot set it. */
export const AGENT_NAME = 'subchat'
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const agentName = (effort?: Effort) => (effort ? `${AGENT_NAME}-${effort}` : AGENT_NAME)
const agentType = (effort?: Effort) => `better-subchat:${agentName(effort)}`
export const isOwnAgentType = (type: string) => type === agentType() || EFFORTS.some(e => type === agentType(e))

/** The only models a spawn can name (the Agent tool's `model` values); a full id cannot be spawned. */
export const SPAWN_MODELS = ['sonnet', 'opus', 'haiku', 'fable'] as const

/** The answer reads the side thread's own part of its transcript from this marker on. */
const PROMPT_MARK = '<side_thread>'
const POLL_MS = 1500

type Done = { reason: 'answer' | 'aborted' | 'refusal' | 'error'; answer: string; usage?: Usage & { model?: string } }
type Sink = { seen: Set<string>; emit: (line: string) => void }

const ours = new Set<string>()
const waiting = new Map<string, (done: Done) => void>()
const early = new Map<string, Done>()
const sinks = new Map<string, Sink>()
/** Reports a subagent tried to hand back to the main conversation; they become its answer instead. */
const reports = new Map<string, string>()

// Design §13: a one-shot window, opened only right before a spawn the person
// asked for (a question they sent), that lets this plugin's own Agent check
// through when the session's mode would otherwise ask nobody (auto mode).
const ALLOW_MS = 10_000
let allowUntil = 0

// Spawns in flight: an agent can finish before `$.agent.spawn` resolves with
// its id, so endings seen meanwhile are kept (a few) until claimed.
let spawning = 0
const EARLY_MAX = 16

export const isOurs = (agentId: string | undefined): agentId is string => agentId !== undefined && ours.has(agentId)

/** True for an ending this module may be waiting for: one of ours, or any while a spawn is in flight. */
export const isAwaited = (agentId: string | undefined): agentId is string => isOurs(agentId) || (agentId !== undefined && spawning > 0)

export const mentionsOurs = (text: string) => [...ours].some(id => text.includes(id))

/**
 * A delivery that carries one of this plugin's side threads into the main
 * conversation: a subagent's hand-back to its spawner (marked with this
 * plugin's name, so it is caught after a reload too) or any notice naming one
 * of its agents. The person's own typing is never one.
 */
export const isSideThreadDelivery = (origin: { kind: string } | undefined, text: string) => {
  if (origin === undefined || origin.kind === 'composer') return false
  const marked = origin as { handback?: boolean; plugin?: string }
  return (marked.handback === true && marked.plugin === 'better-subchat') || mentionsOurs(text)
}

/**
 * A delivery arriving at the main conversation from one of this plugin's
 * subagents (its hand-back): a peer message naming one of its agents, or
 * marked as this plugin's. Used only to keep such a message out, never to let
 * anything in, so the sender's own claim of a plugin name is enough here.
 */
export const isSideThreadReceive = (origin: { kind: string; plugin?: string }, text: string) =>
  origin.kind === 'peer' && (origin.plugin === 'better-subchat' || mentionsOurs(text))

/** Consumes the window: true at most once per spawn, and only inside it. */
export const takeAllowWindow = () => {
  const isOpen = Date.now() < allowUntil
  allowUntil = 0
  return isOpen
}

/**
 * Keeps the report a subagent tried to hand back (its `SubagentHandback`
 * message, refused so it never reaches the main conversation) as its answer.
 */
export function keepReport(agentId: string, report: string) {
  reports.set(agentId, report)
}

export function agentFinished(agentId: string, ending: Done) {
  // A refused hand-back leaves the report only in that call: it is the answer,
  // whatever the subagent said about the refusal afterwards.
  const report = reports.get(agentId)
  reports.delete(agentId)
  const done: Done = report && ending.reason === 'answer' ? { ...ending, answer: report } : ending
  const resolve = waiting.get(agentId)
  if (resolve) {
    waiting.delete(agentId)
    resolve(done)
  } else {
    early.set(agentId, done)
    if (early.size > EARLY_MAX) early.delete(early.keys().next().value as string)
  }
}

/** One short line for a tool call: its name and the argument that says what it touched. */
export const toolLine = (tool: string, input: Record<string, unknown>) => {
  const key = ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'description'].find(k => typeof input[k] === 'string')
  const arg = key ? String(input[key]).replace(/\s+/g, ' ') : ''
  return `${tool}${arg ? ` ${arg.length > 60 ? `${arg.slice(0, 60)}…` : arg}` : ''}`
}

/** Claude Code's own plumbing in a subagent's run, not work done for the person: never shown as a tool line. */
export const HANDBACK_TOOL = 'SubagentHandback'

/** A tool call seen as it happens (when the engine raises it to this plugin); deduplicated by id. */
export function agentUsedTool(agentId: string, toolUseId: string, line: string) {
  const sink = sinks.get(agentId)
  if (!sink || sink.seen.has(toolUseId) || line.startsWith(HANDBACK_TOOL)) return
  sink.seen.add(toolUseId)
  sink.emit(line)
}

/** Reads the agent's own transcript and relays the tool calls made after the side-thread prompt. */
export async function collectTools($: EngineInterface, agentId: string) {
  const sink = sinks.get(agentId)
  if (!sink) return
  const rows = await $.session.messages({ agentId })
  if (!Array.isArray(rows)) return
  const start = rows.findIndex(row => row.role === 'user' && row.text.includes(PROMPT_MARK))
  for (const row of rows.slice(start + 1)) {
    for (const use of row.toolUses) agentUsedTool(agentId, use.tool_use_id, toolLine(use.tool, use.input))
  }
}

const waitFor = (agentId: string) =>
  new Promise<Done>(resolve => {
    const done = early.get(agentId)
    if (done) {
      early.delete(agentId)
      resolve(done)
    } else {
      waiting.set(agentId, resolve)
    }
  })

export async function stopAgent($: EngineInterface, agentId: string) {
  await $.tool.call({ tool: 'TaskStop', task_id: agentId })
}

const toAnswer = (done: Done, isStopped: boolean): Answer => {
  const usage = done.usage && { in: done.usage.in, out: done.usage.out, cacheRead: done.usage.cacheRead, cacheWrite: done.usage.cacheWrite }
  const extra = usage ? { usage } : {}
  if (done.reason === 'answer') {
    return done.answer === ''
      ? { ok: false, reason: 'empty-reply', ...extra }
      : { ok: true, text: done.answer, ...(done.usage?.model ? { model: done.usage.model } : {}), ...extra }
  }
  if (done.reason === 'aborted') {
    return isStopped ? { ok: false, reason: 'aborted', ...extra } : { ok: false, reason: 'aborted', detail: 'interrupted-or-rejected', ...extra }
  }
  return { ok: false, reason: 'api-error', detail: done.reason === 'refusal' ? 'refused' : 'failed', ...extra }
}

export type RunAgent = {
  kind: 'fork' | 'custom'
  model?: string
  effort?: Effort
  prompt: string
  description: string
  onTool: (line: string) => void
  signal?: CancelSignal
  autoModeSpawn: boolean
  /** Called once the spawn has been made (started or refused), so a hook can return. */
  onLaunched?: () => void
}

export async function runAgent($: EngineInterface, req: RunAgent): Promise<Answer> {
  if (req.signal?.aborted) return { ok: false, reason: 'aborted' }
  const model = req.kind === 'custom' ? req.model : undefined
  if (model !== undefined && !SPAWN_MODELS.some(m => m === model)) return { ok: false, reason: 'denied', detail: 'unsupported-model' }
  if (req.autoModeSpawn) allowUntil = Date.now() + ALLOW_MS
  spawning += 1
  const spawned = await $.agent
    .spawn({
      prompt: req.prompt,
      description: req.description,
      subagentType: req.kind === 'fork' ? 'fork' : agentType(req.effort),
      ...(model !== undefined ? { model } : {}),
    })
    .finally(() => {
      spawning -= 1
      allowUntil = 0
      req.onLaunched?.()
    })
  if (spawned.deny !== undefined) return { ok: false, reason: 'denied', detail: spawned.deny }
  const agentId = spawned.agentId
  if (agentId === undefined) return { ok: false, reason: 'api-error', detail: 'not-started' }

  ours.add(agentId)
  sinks.set(agentId, { seen: new Set(), emit: req.onTool })
  const poll = $.clock.every(POLL_MS, () => void collectTools($, agentId))
  let isStopped = false
  const signal = req.signal as AbortSignal | undefined
  signal?.addEventListener('abort', () => {
    isStopped = true
    void stopAgent($, agentId)
  })
  const done = await waitFor(agentId)
  poll.cancel()
  await collectTools($, agentId).catch(() => undefined)
  sinks.delete(agentId)
  return toAnswer(done, isStopped)
}
