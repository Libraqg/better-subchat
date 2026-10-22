// Pure state transitions over a SessionDoc. Each returns a new doc.

import type { Answer, Backflow, Chain, Effort, Layer, Note, SavedNote, SessionDoc, Strategy, Turn } from './types'

/** Turns kept across the active chain and the archive; the oldest go first. */
export const MAX_TURNS = 4096

export const emptyDoc = (sessionId: string): SessionDoc => ({ v: 1, sessionId, archived: [] })

export const activeLayer = (doc: SessionDoc): Layer | undefined => doc.active?.layers.at(-1)

/** What a layer is about: the selection it opened on, else its first question; '' before either. */
export const layerSubject = (layer: Layer): string => layer.topic || (layer.turns[0]?.q ?? '')

export type OpenLayer = { topic: string; anchorN: number; model: string; maxDepth: number; now: number; id: string }

export type OpenResult = { doc: SessionDoc; depth: number } | { error: 'max-depth'; depth: number }

/** Opens L1 of a new chain, or a layer under the deepest one of the active chain. */
export const openLayer = (doc: SessionDoc, open: OpenLayer): OpenResult => {
  const chain = doc.active
  const depth = (chain?.layers.length ?? 0) + 1
  if (depth > open.maxDepth) return { error: 'max-depth', depth: depth - 1 }

  const parent = chain?.layers.at(-1)
  const layer: Layer = {
    depth,
    topic: open.topic,
    model: parent?.model ?? open.model,
    ...(parent?.effort !== undefined ? { effort: parent.effort } : {}),
    turns: [],
    createdAt: open.now,
  }
  const next: Chain = chain
    ? { ...chain, layers: [...chain.layers, layer] }
    : { id: open.id, anchorN: open.anchorN, refreshes: [], layers: [layer], openedAt: open.now }

  return { doc: { ...doc, active: next }, depth }
}

/** Closes the deepest layer; closing L1 archives the whole chain. */
export const closeLayer = (doc: SessionDoc, now: number): SessionDoc => closeFrom(doc, doc.active?.layers.length ?? 1, now)

/** Closes layer `depth` and every layer below it; closing L1 archives the whole chain. */
export const closeFrom = (doc: SessionDoc, depth: number, now: number): SessionDoc => {
  const chain = doc.active
  if (!chain) return doc
  if (depth <= 1) {
    const closed: Chain = {
      ...chain,
      closedAt: now,
      layers: chain.layers.map(layer => ({ ...layer, closedAt: layer.closedAt ?? now })),
    }
    return truncate({ ...doc, active: undefined, archived: [...doc.archived, closed] })
  }
  return { ...doc, active: { ...chain, layers: chain.layers.slice(0, depth - 1) } }
}

export type AddTurn = { id: string; q: string; now: number; anchorN: number; strategy: Strategy; model: string; notes?: Note[] }

const mapActive = (doc: SessionDoc, fn: (layer: Layer) => Layer): SessionDoc => {
  const chain = doc.active
  const layer = chain?.layers.at(-1)
  if (!chain || !layer) return doc
  return { ...doc, active: { ...chain, layers: [...chain.layers.slice(0, -1), fn(layer)] } }
}

export const addTurn = (doc: SessionDoc, add: AddTurn): SessionDoc =>
  truncate(
    mapActive(doc, layer => ({
      ...layer,
      turns: [
        ...layer.turns,
        {
          id: add.id,
          q: add.q,
          status: 'pending',
          strategy: add.strategy,
          model: add.model,
          anchorN: add.anchorN,
          at: add.now,
          ...(add.notes !== undefined && add.notes.length > 0 ? { notes: add.notes } : {}),
        },
      ],
    })),
  )

/** Writes an answer into the turn it belongs to, wherever that turn now is. */
export const resolveTurn = (doc: SessionDoc, turnId: string, answer: Answer): SessionDoc =>
  mapTurn(doc, turnId, turn => {
    if (answer.ok) return { ...turn, status: 'done', a: answer.text, model: answer.model ?? turn.model, usage: answer.usage }
    const status = answer.reason === 'aborted' ? 'aborted' : 'error'
    return { ...turn, status, error: answer.detail ? `${answer.reason}: ${answer.detail}` : answer.reason, usage: answer.usage }
  })

/** Tool lines kept per turn; older ones are dropped. */
export const MAX_TOOL_LINES = 20

const mapTurn = (doc: SessionDoc, turnId: string, fn: (turn: Turn) => Turn): SessionDoc => {
  const inChain = (chain: Chain): Chain => ({
    ...chain,
    layers: chain.layers.map(layer => ({ ...layer, turns: layer.turns.map(turn => (turn.id === turnId ? fn(turn) : turn)) })),
  })
  return { ...doc, active: doc.active && inChain(doc.active), archived: doc.archived.map(inChain) }
}

export const addToolLine = (doc: SessionDoc, turnId: string, line: string): SessionDoc =>
  mapTurn(doc, turnId, turn => ({ ...turn, tools: [...(turn.tools ?? []), line].slice(-MAX_TOOL_LINES) }))

/** Switches a turn to another strategy before it is answered (a fallback), noting why. */
export const rerouteTurn = (doc: SessionDoc, turnId: string, strategy: Strategy, model: string, note: Note): SessionDoc =>
  mapTurn(doc, turnId, turn => ({ ...turn, strategy, model, notes: [...(turn.notes ?? []), note] }))

/** Marks every pending turn as failed, e.g. after the work behind it was lost. */
export const failPending = (doc: SessionDoc, reason: string): SessionDoc => {
  const fail = (turn: Turn): Turn => (turn.status === 'pending' ? { ...turn, status: 'error', error: reason } : turn)
  const inChain = (chain: Chain): Chain => ({
    ...chain,
    layers: chain.layers.map(layer => ({ ...layer, turns: layer.turns.map(fail) })),
  })
  return { ...doc, active: doc.active && inChain(doc.active), archived: doc.archived.map(inChain) }
}

export const setLayerModel = (doc: SessionDoc, model: string): SessionDoc => mapActive(doc, layer => ({ ...layer, model }))

export const setLayerEffort = (doc: SessionDoc, effort: Effort | undefined): SessionDoc =>
  mapActive(doc, layer => {
    const { effort: _, ...rest } = layer
    return effort ? { ...rest, effort } : rest
  })

export const setLayerLight = (doc: SessionDoc, light: boolean): SessionDoc =>
  mapActive(doc, layer => {
    const { light: _, ...rest } = layer
    return light ? { ...rest, light: true } : rest
  })


const countTurns = (chains: Chain[]) => chains.reduce((n, c) => n + c.layers.reduce((m, l) => m + l.turns.length, 0), 0)

/**
 * Moves the active chain's snapshot to message `to`, keeping every layer's
 * history and recording the move so later prompts can say what is new.
 */
export const refreshChain = (doc: SessionDoc, to: number, now: number): SessionDoc => {
  const chain = doc.active
  if (!chain || chain.anchorN === to) return doc
  return { ...doc, active: { ...chain, anchorN: to, refreshes: [...chain.refreshes, { from: chain.anchorN, to, at: now }] } }
}

/** Finds a turn anywhere in the document, with the layer it belongs to. */
export const findTurn = (doc: SessionDoc, turnId: string): { layer: Layer; turn: Turn } | undefined => {
  for (const chain of [...(doc.active ? [doc.active] : []), ...doc.archived]) {
    for (const layer of chain.layers) {
      const turn = layer.turns.find(t => t.id === turnId)
      if (turn) return { layer, turn }
    }
  }
  return undefined
}

/** Notes kept per session; the oldest go first. */
export const MAX_NOTES = 200

export const addNote = (doc: SessionDoc, note: SavedNote): SessionDoc => ({ ...doc, notes: [...(doc.notes ?? []), note].slice(-MAX_NOTES) })

export const removeNote = (doc: SessionDoc, id: string): SessionDoc => ({ ...doc, notes: (doc.notes ?? []).filter(n => n.id !== id) })

export const setPendingBackflow = (doc: SessionDoc, backflow: Backflow | undefined): SessionDoc => {
  const { pendingBackflow: _, ...rest } = doc
  return backflow ? { ...rest, pendingBackflow: backflow } : rest
}

/** Drops the oldest archived chains until at most MAX_TURNS turns remain (the active chain is kept whole). */
export const truncate = (doc: SessionDoc): SessionDoc => {
  const activeCount = doc.active ? countTurns([doc.active]) : 0
  const archived = [...doc.archived]
  while (archived.length > 0 && activeCount + countTurns(archived) > MAX_TURNS) archived.shift()
  return archived.length === doc.archived.length ? doc : { ...doc, archived }
}
