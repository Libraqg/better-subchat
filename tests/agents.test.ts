// The subagent half of the adapter against a fake engine: the test kit never
// lets a test hook hand the plugin an agentId, so these drive agents.ts directly.
import { describe, expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { agentFinished, agentUsedTool, isAwaited, isOurs, isSideThreadDelivery, runAgent, takeAllowWindow, toolLine } from '../hooks/adapter/agents'

type Row = { role: 'user' | 'assistant'; text: string; toolUses: { tool_use_id: string; tool: string; input: Record<string, unknown> }[] }
type Fake = { spawns: unknown[]; stops: string[]; onSpawn?: (id: string) => void; transcript?: Row[] }

const fakeEngine = (fake: Fake, id: string) =>
  ({
    agent: {
      spawn: async (args: unknown) => {
        fake.spawns.push(args)
        fake.onSpawn?.(id)
        return { model: 'claude-test', agentId: id }
      },
    },
    clock: { every: () => ({ cancel: () => {} }) },
    session: { messages: async () => fake.transcript ?? [] },
    tool: {
      call: async (args: { task_id: string }) => {
        fake.stops.push(args.task_id)
        return { result: {} }
      },
    },
  }) as unknown as EngineInterface

/** Lets the spawn and its bookkeeping settle. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const USAGE = { in: 3, out: 4, cacheRead: 500, cacheWrite: 0, model: 'claude-haiku' }

describe('runAgent', () => {
  test('resolves with the answer of its own agent, relaying tool lines meanwhile', async () => {
    const fake: Fake = { spawns: [], stops: [] }
    const lines: string[] = []
    const running = runAgent(fakeEngine(fake, 'a1'), {
      kind: 'custom',
      model: 'haiku',
      prompt: 'p',
      description: 'better-subchat L1',
      onTool: line => lines.push(line),
      autoModeSpawn: false,
    })
    await flush()
    expect(isOurs('a1')).toBe(true)
    agentUsedTool('a1', 'tu-1', toolLine('Read', { file_path: '/repo/src/reducer.ts' }))
    agentUsedTool('a1', 'tu-1', toolLine('Read', { file_path: '/repo/src/reducer.ts' }))
    agentFinished('a1', { reason: 'answer', answer: 'it is pure', usage: USAGE })

    const answer = await running
    expect(answer).toEqual({ ok: true, text: 'it is pure', model: 'claude-haiku', usage: { in: 3, out: 4, cacheRead: 500, cacheWrite: 0 } })
    expect(lines).toEqual(['Read /repo/src/reducer.ts'])
    expect(fake.spawns[0]).toEqual({ prompt: 'p', description: 'better-subchat L1', subagentType: 'better-subchat:subchat', model: 'haiku' })
  })

  test('tool lines come from the agent transcript after the side-thread prompt, once each', async () => {
    const fake: Fake = {
      spawns: [],
      stops: [],
      transcript: [
        { role: 'user', text: 'main conversation', toolUses: [{ tool_use_id: 'old', tool: 'Bash', input: { command: 'ls' } }] },
        { role: 'user', text: '<side_thread>\nq', toolUses: [] },
        { role: 'assistant', text: '', toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: '/a.ts' } }] },
        { role: 'assistant', text: '', toolUses: [{ tool_use_id: 't2', tool: 'Grep', input: { pattern: 'closeFrom' } }] },
      ],
    }
    const lines: string[] = []
    fake.onSpawn = id => agentFinished(id, { reason: 'answer', answer: 'done' })
    await runAgent(fakeEngine(fake, 'a7'), { kind: 'fork', prompt: 'p', description: 'd', onTool: line => lines.push(line), autoModeSpawn: false })
    expect(lines).toEqual(['Read /a.ts', 'Grep closeFrom'])
  })

  test('a spawn names only a model alias; a full model id is refused before spawning', async () => {
    const fake: Fake = { spawns: [], stops: [] }
    const refused = await runAgent(fakeEngine(fake, 'a8'), {
      kind: 'custom',
      model: 'claude-opus-5-5',
      prompt: 'p',
      description: 'd',
      onTool: () => {},
      autoModeSpawn: false,
    })
    expect(refused).toEqual({ ok: false, reason: 'denied', detail: 'unsupported-model' })
    expect(fake.spawns.length).toBe(0)

    fake.onSpawn = id => agentFinished(id, { reason: 'answer', answer: 'ok' })
    await runAgent(fakeEngine(fake, 'a9'), { kind: 'custom', effort: 'high', prompt: 'p', description: 'd', onTool: () => {}, autoModeSpawn: false })
    expect(fake.spawns[0]).toEqual({ prompt: 'p', description: 'd', subagentType: 'better-subchat:subchat-high' })
  })

  test('an ending seen before the spawn resolves is kept for it', async () => {
    const fake: Fake = { spawns: [], stops: [] }
    fake.onSpawn = id => {
      expect(isAwaited(id)).toBe(true)
      agentFinished(id, { reason: 'answer', answer: 'fast' })
    }
    const answer = await runAgent(fakeEngine(fake, 'a2'), { kind: 'fork', prompt: 'p', description: 'd', onTool: () => {}, autoModeSpawn: false })
    expect(answer).toEqual({ ok: true, text: 'fast' })
    expect((fake.spawns[0] as { subagentType: string }).subagentType).toBe('fork')
  })

  test('Stop calls TaskStop and the turn reads as stopped', async () => {
    const fake: Fake = { spawns: [], stops: [] }
    const stop = new AbortController()
    const running = runAgent(fakeEngine(fake, 'a3'), { kind: 'fork', prompt: 'p', description: 'd', onTool: () => {}, signal: stop.signal, autoModeSpawn: false })
    await flush()
    stop.abort()
    expect(fake.stops).toEqual(['a3'])
    agentFinished('a3', { reason: 'aborted', answer: '' })
    expect(await running).toEqual({ ok: false, reason: 'aborted' })
  })

  test('an agent that ends aborted on its own reads as interrupted or refused', async () => {
    const fake: Fake = { spawns: [], stops: [] }
    fake.onSpawn = id => agentFinished(id, { reason: 'aborted', answer: '' })
    const answer = await runAgent(fakeEngine(fake, 'a4'), { kind: 'fork', prompt: 'p', description: 'd', onTool: () => {}, autoModeSpawn: false })
    expect(answer.ok).toBe(false)
    if (!answer.ok) expect(answer.detail).toBe('interrupted-or-rejected')
  })

  test('the auto-mode window opens for a spawn only when allowed, and only once', async () => {
    const fake: Fake = { spawns: [], stops: [] }
    const seen: boolean[] = []
    fake.onSpawn = id => {
      seen.push(takeAllowWindow(), takeAllowWindow())
      agentFinished(id, { reason: 'answer', answer: 'x' })
    }
    await runAgent(fakeEngine(fake, 'a5'), { kind: 'fork', prompt: 'p', description: 'd', onTool: () => {}, autoModeSpawn: true })
    await runAgent(fakeEngine(fake, 'a6'), { kind: 'fork', prompt: 'p', description: 'd', onTool: () => {}, autoModeSpawn: false })
    expect(seen).toEqual([true, false, false, false])
    expect(takeAllowWindow()).toBe(false)
  })
})

describe('isSideThreadDelivery', () => {
  test('a hand-back from this plugin, or a notice naming its agent, is kept out; the person is never', async () => {
    const fake: Fake = { spawns: [], stops: [] }
    fake.onSpawn = id => agentFinished(id, { reason: 'answer', answer: 'x' })
    await runAgent(fakeEngine(fake, 'a10'), { kind: 'fork', prompt: 'p', description: 'd', onTool: () => {}, autoModeSpawn: false })

    expect(isSideThreadDelivery({ kind: 'peer', handback: true, plugin: 'better-subchat' } as { kind: string }, 'report')).toBe(true)
    expect(isSideThreadDelivery({ kind: 'task-notification' }, 'task a10 finished')).toBe(true)
    expect(isSideThreadDelivery({ kind: 'peer', handback: true, plugin: 'other' } as { kind: string }, 'report')).toBe(false)
    expect(isSideThreadDelivery({ kind: 'peer' }, 'hello')).toBe(false)
    expect(isSideThreadDelivery({ kind: 'composer' }, 'why did a10 fail?')).toBe(false)
  })
})
