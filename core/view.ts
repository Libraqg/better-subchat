// The pane as plain data: what to show and which controls are live, worded
// in the pane's language. An adapter draws this with its own elements.

import { activeLayer, layerSubject } from './chain'
import { errorText, noteText, strings } from './i18n'
import { decide } from './strategy'
import type { Effort, Lang, Layer, SessionDoc, Strategy, Turn, Usage } from './types'

/** How answers are drawn: formatted Markdown, or plain text the person can select. */
export type AnswerView = 'formatted' | 'selectable'

/** The pane's pages. */
export type Tab = 'thread' | 'history' | 'notes' | 'settings'

export type Crumb = { depth: number; label: string; isViewed: boolean }

export type TurnView = {
  id: string
  q: string
  a?: string
  status: Turn['status']
  error?: string
  notes: string[]
  tools: string[]
  meta?: string
  /** This answer rides along with the next main-conversation prompt. */
  isPending?: boolean
}

export type PaneView =
  | { kind: 'empty'; lang: Lang; hint: string }
  | {
      kind: 'layer'
      lang: Lang
      answerView: AnswerView
      /** Bumped to redraw answer fields from their text, undoing any edit. */
      revision: number
      crumbs: Crumb[]
      status: string
      depth: number
      topic: string
      model: string
      effort?: Effort
      light: boolean
      /** How the next question will be answered, as far as the view can tell. */
      mode: Strategy
      modeNotes: string[]
      turns: TurnView[]
      /** Viewing a layer above the active one: no input, no controls but navigation. */
      isReadOnly: boolean
      isBusy: boolean
      canAsk: boolean
      canGoDeeper: boolean
      canRefresh: boolean
      /** Backflow actions are offered under each answer. */
      backflowEnabled: boolean
      /** An answer waiting to ride along with the next main-conversation prompt. */
      pending?: { from: string; preview: string }
      warning?: string
    }

export type ViewOptions = {
  lang?: Lang
  /** The layer being looked at; the active (deepest) one when absent. */
  viewDepth?: number
  maxDepth: number
  mainLength?: number
  preferred?: Strategy
  answerView?: AnswerView
  revision?: number
  backflowEnabled?: boolean
}

const clip = (text: string, n: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n)}…` : flat
}

export const crumbLabel = (layer: Layer) => {
  const subject = layerSubject(layer)
  return `L${layer.depth}${subject ? ` "${clip(subject, 20)}"` : ''}`
}

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

export const usageLine = (u: Usage, lang: Lang = 'en') =>
  strings(lang).usage(fmt(u.in), fmt(u.out), u.cacheRead ? fmt(u.cacheRead) : undefined)

export const statusLine = (doc: SessionDoc, lang: Lang = 'en'): string | undefined => {
  const layer = activeLayer(doc)
  if (!doc.active || !layer) return undefined
  const s = strings(lang)
  const model = layer.model === 'inherit' ? s.inherit : layer.model
  const extras = [...(layer.effort ? [layer.effort] : []), ...(layer.light ? [s.strategy.light] : [])]
  return `better-subchat: L${layer.depth} · ${s.snapshot}@${doc.active.anchorN} · ${model}${extras.map(x => ` · ${x}`).join('')}`
}

const turnView = (t: Turn, lang: Lang): TurnView => ({
  id: t.id,
  q: t.q,
  a: t.a,
  status: t.status,
  ...(t.error !== undefined ? { error: errorText(lang, t.error) } : {}),
  notes: [...(t.note ? [t.note] : []), ...(t.notes ?? []).map(n => noteText(lang, n))],
  tools: t.tools ?? [],
  ...(t.usage ? { meta: `${t.model} · ${strings(lang).strategy[t.strategy]} · ${usageLine(t.usage, lang)}` } : {}),
})

export const buildView = (doc: SessionDoc, options: ViewOptions): PaneView => {
  const lang = options.lang ?? 'en'
  const s = strings(lang)
  const chain = doc.active
  const active = activeLayer(doc)
  if (!chain || !active) return { kind: 'empty', lang, hint: s.emptyHint }

  const layer = chain.layers.find(l => l.depth === options.viewDepth) ?? active
  const isReadOnly = layer.depth < active.depth
  const isBusy = active.turns.some(t => t.status === 'pending')
  const behind = options.mainLength !== undefined ? options.mainLength - chain.anchorN : 0
  const warning =
    options.mainLength !== undefined && options.mainLength < chain.anchorN ? s.compacted : behind > 0 ? s.behind(behind) : undefined
  // The view does not know the main model's id, so any explicit model reads as "another model".
  const decided = decide({
    preferred: options.preferred ?? 'fork',
    light: layer.light === true,
    layerModel: layer.model,
    ...(layer.effort !== undefined ? { layerEffort: layer.effort } : {}),
    mainModel: 'inherit',
  })
  return {
    kind: 'layer',
    lang,
    answerView: options.answerView ?? 'selectable',
    revision: options.revision ?? 0,
    crumbs: chain.layers.map(l => ({ depth: l.depth, label: crumbLabel(l), isViewed: l.depth === layer.depth })),
    status: statusLine(doc, lang) ?? '',
    depth: layer.depth,
    topic: layer.topic,
    model: layer.model,
    ...(layer.effort !== undefined ? { effort: layer.effort } : {}),
    light: layer.light === true,
    mode: decided.strategy,
    modeNotes: decided.notes.map(n => noteText(lang, n)),
    turns: layer.turns.map(t => ({ ...turnView(t, lang), ...(doc.pendingBackflow?.turnId === t.id ? { isPending: true } : {}) })),
    isReadOnly,
    isBusy,
    canAsk: !isReadOnly && !isBusy,
    canGoDeeper: !isReadOnly && !isBusy && active.depth < options.maxDepth,
    canRefresh: !isBusy && options.mainLength !== undefined && options.mainLength !== chain.anchorN,
    backflowEnabled: options.backflowEnabled === true,
    ...(doc.pendingBackflow ? { pending: { from: doc.pendingBackflow.from, preview: clip(doc.pendingBackflow.text, 120) } } : {}),
    ...(warning !== undefined ? { warning } : {}),
  }
}

export type ChainView = {
  id: string
  summary: string
  /** The chain's layers, only for the one chain opened in the list. */
  layers?: { depth: number; label: string; turns: TurnView[] }[]
}

export type HistoryView = { kind: 'history'; lang: Lang; hint?: string; chains: ChainView[] }

/** Closed chains of the session, newest first; `openId` shows one whole, read-only. */
export const buildHistory = (doc: SessionDoc, lang: Lang, openId?: string): HistoryView => {
  const s = strings(lang)
  const chains = [...doc.archived].reverse().map(chain => {
    const turns = chain.layers.reduce((n, layer) => n + layer.turns.length, 0)
    const view: ChainView = { id: chain.id, summary: s.chainSummary(chain.layers.map(crumbLabel).join(' › '), turns) }
    return chain.id === openId
      ? { ...view, layers: chain.layers.map(layer => ({ depth: layer.depth, label: crumbLabel(layer), turns: layer.turns.map(t => turnView(t, lang)) })) }
      : view
  })
  return { kind: 'history', lang, chains, ...(chains.length === 0 ? { hint: s.noHistory } : {}) }
}

export type NotesView = { kind: 'notes'; lang: Lang; hint?: string; notes: { id: string; from: string; text: string }[] }

export const buildNotes = (doc: SessionDoc, lang: Lang): NotesView => {
  const notes = [...(doc.notes ?? [])].reverse().map(n => ({ id: n.id, from: n.from, text: n.text }))
  return { kind: 'notes', lang, notes, ...(notes.length === 0 ? { hint: strings(lang).noNotes } : {}) }
}
