// Use cases. Everything outside core is reached through Ports.

import { asAgentPrompt, assemble } from './assemble'
import { activeLayer, addToolLine, addTurn, closeFrom, openLayer, refreshChain, rerouteTurn, resolveTurn } from './chain'
import type { Ports } from './ports'
import { decide } from './strategy'
import type { Answer, CancelSignal, Settings, Strategy } from './types'

export type OpenOutcome = { ok: true; depth: number } | { ok: false; code: 'max-depth'; maxDepth: number }

/** Why a question was not asked; an adapter words it. */
export type AskRefusal = 'no-thread' | 'busy'

/** Opens a layer on `topic`: a new chain's L1, or one under the deepest layer. */
export async function open(ports: Ports, settings: Settings, topic: string): Promise<OpenOutcome> {
  const anchorN = await ports.transcript.length()
  let outcome: OpenOutcome = { ok: false, code: 'max-depth', maxDepth: settings.maxDepth }
  await ports.doc.update(doc => {
    const opened = openLayer(doc, {
      topic,
      anchorN,
      model: settings.defaultModel,
      maxDepth: settings.maxDepth,
      now: ports.clock.now(),
      id: ports.clock.id(),
    })
    if ('error' in opened) return doc
    outcome = { ok: true, depth: opened.depth }
    return opened.doc
  })
  return outcome
}

/** Closes layer `depth` (the deepest when absent) and every layer below it; resolves the depth closed. */
export async function close(ports: Ports, depth?: number): Promise<number | undefined> {
  const deepest = activeLayer(await ports.doc.get())?.depth
  if (deepest === undefined) return undefined
  const from = Math.min(depth ?? deepest, deepest)
  await ports.doc.update(doc => closeFrom(doc, from, ports.clock.now()))
  return from
}

/** Moves the snapshot to the main conversation as it is now; resolves the move, or undefined when nothing moved. */
export async function refresh(ports: Ports): Promise<{ from: number; to: number } | undefined> {
  const chain = (await ports.doc.get()).active
  if (!chain) return undefined
  const to = await ports.transcript.length()
  if (to === chain.anchorN) return undefined
  const from = chain.anchorN
  await ports.doc.update(doc => refreshChain(doc, to, ports.clock.now()))
  return { from, to }
}

const failure = (err: unknown): Answer => ({ ok: false, reason: 'api-error', detail: err instanceof Error ? err.message : String(err) })

/**
 * Asks `question` in the active layer and resolves once the answer, an error
 * or an abort is recorded. The strategy follows design §5: a fork when the
 * layer runs on the main model, the plugin's own agent for another model,
 * one tool-less completion in light mode. A fork with nothing to fork falls
 * back to the agent; a spawn the harness refuses falls back to light mode.
 */
export async function ask(
  ports: Ports,
  settings: Settings,
  question: string,
  signal?: CancelSignal,
): Promise<{ ok: boolean; refusal?: AskRefusal }> {
  // Follow mode: every question first catches the snapshot up (never mid-answer).
  if (settings.contextMode === 'follow') {
    const current = activeLayer(await ports.doc.get())
    if (current && !current.turns.some(t => t.status === 'pending')) await refresh(ports)
  }
  const before = await ports.doc.get()
  const chain = before.active
  const layer = activeLayer(before)
  if (!chain || !layer) return { ok: false, refusal: 'no-thread' }
  if (layer.turns.some(t => t.status === 'pending')) return { ok: false, refusal: 'busy' }

  const mainModel = await ports.transcript.mainModel()
  const model = layer.model === 'inherit' ? mainModel : layer.model
  const effort = layer.effort
  const decision = decide({
    preferred: settings.defaultStrategy,
    light: layer.light === true,
    layerModel: layer.model,
    ...(effort !== undefined ? { layerEffort: effort } : {}),
    mainModel,
  })
  const main = await ports.transcript.snapshot()
  const turnId = ports.clock.id()
  const prompt = (strategy: Strategy) =>
    assemble({ chain, question, main, snapshot: strategy === 'fork' ? 'soft' : 'hard', tools: strategy !== 'light' })

  await ports.doc.update(doc =>
    addTurn(doc, {
      id: turnId,
      q: question,
      now: ports.clock.now(),
      anchorN: prompt(decision.strategy).anchorN,
      strategy: decision.strategy,
      model,
      notes: decision.notes,
    }),
  )

  const run = async (strategy: Strategy): Promise<Answer> => {
    const built = prompt(strategy)
    try {
      const withEffort = effort !== undefined ? { effort } : {}
      if (strategy === 'light') return await ports.model.complete({ model, ...withEffort, system: built.system, blocks: built.blocks, signal })
      return await ports.agent.run({
        kind: strategy === 'fork' ? 'fork' : 'custom',
        // The layer's own choice, not the resolved id: 'inherit' leaves the model to the agent type.
        ...(strategy === 'agent' ? { ...(layer.model !== 'inherit' ? { model: layer.model } : {}), ...withEffort } : {}),
        prompt: asAgentPrompt(built, strategy === 'fork'),
        description: `subthread L${layer.depth}`,
        onTool: line => void ports.doc.update(doc => addToolLine(doc, turnId, line)),
        signal,
      })
    } catch (err) {
      return failure(err)
    }
  }

  let strategy = decision.strategy
  let answer = await run(strategy)
  if (!answer.ok && answer.reason === 'nothing-to-fork' && strategy === 'fork') {
    strategy = 'agent'
    await ports.doc.update(doc => rerouteTurn(doc, turnId, strategy, model, { code: 'nothing-to-fork' }))
    answer = await run(strategy)
  }
  if (!answer.ok && answer.reason === 'denied' && strategy !== 'light') {
    const detail = answer.detail
    strategy = 'light'
    await ports.doc.update(doc =>
      rerouteTurn(doc, turnId, strategy, model, detail !== undefined ? { code: 'spawn-refused', detail } : { code: 'spawn-refused' }),
    )
    answer = await run(strategy)
  }
  await ports.doc.update(doc => resolveTurn(doc, turnId, answer))
  return { ok: answer.ok }
}
