// Claude Code implementations of core's ports. Each function that takes `$`
// is declared at the top level, as the engine requires.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { emptyDoc } from '../../core/chain'
import { runAgent } from './agents'
import { scheduleSave } from './persist'
import type { Ports } from '../../core/ports'
import type { Answer, Effort, Lang, MainMessage, PromptBlock, SessionDoc, Usage } from '../../core/types'
import type { AnswerView, Tab } from '../../core/view'

export const docAtom = atom({ plugin: 'better-subchat', key: 'doc' } as const, emptyDoc(''))

/** Completions get room for a full explanation; the API default of 1024 cuts them short. */
const MAX_TOKENS = 8192

export async function mainSnapshot($: EngineInterface): Promise<MainMessage[]> {
  const rows = await $.session.messages()
  return rows.map(row => ({
    role: row.role,
    text: row.text,
    tools: row.toolUses.map(use => ({
      name: use.tool,
      input: JSON.stringify(use.input),
      result: use.text,
    })),
  }))
}

export async function mainLength($: EngineInterface): Promise<number> {
  return (await $.session.messages()).length
}

const toUsage = (u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }): Usage => ({
  in: u.input_tokens,
  out: u.output_tokens,
  cacheRead: u.cache_read_input_tokens,
  cacheWrite: u.cache_creation_input_tokens,
})

export async function complete(
  $: EngineInterface,
  req: { model: string; effort?: Effort; system: string; blocks: PromptBlock[]; signal?: AbortSignal },
): Promise<Answer> {
  const prompt = req.blocks.map(b => (b.cache ? { text: b.text, cache: true as const } : { text: b.text }))
  const r = await $.model.complete(
    { model: req.model, system: req.system, prompt, maxTokens: MAX_TOKENS, ...(req.effort !== undefined ? { effort: req.effort } : {}) },
    req.signal ? { signal: req.signal } : undefined,
  )
  if (r.isAnswered) return { ok: true, text: r.text, model: req.model, usage: toUsage(r.usage) }
  if (r.reason === 'api-error') return { ok: false, reason: 'api-error', detail: `${r.status ?? 'no response'} ${r.error}`, usage: toUsage(r.usage) }
  return { ok: false, reason: r.reason, usage: toUsage(r.usage) }
}

export async function getDoc($: EngineInterface): Promise<SessionDoc> {
  return read($, docAtom)
}

/** Writes through $.state (redrawing the pane) and schedules the save to disk. */
export async function updateDoc($: EngineInterface, fn: (doc: SessionDoc) => SessionDoc): Promise<SessionDoc> {
  let next: SessionDoc | undefined
  await update($, docAtom, doc => (next = fn(doc)))
  const saved = next ?? (await read($, docAtom))
  scheduleSave($, saved)
  return saved
}

/** 0 shows the active (deepest) layer; another depth shows that layer read-only. */
export const viewDepthAtom = atom({ plugin: 'better-subchat', key: 'viewDepth' } as const, 0)

export async function getViewDepth($: EngineInterface): Promise<number> {
  return read($, viewDepthAtom)
}

export async function setViewDepth($: EngineInterface, depth: number) {
  await update($, viewDepthAtom, () => depth)
}

/** How answers are drawn: the person's choice, kept across sessions in $.store. */
export const answerViewAtom = atom({ plugin: 'better-subchat', key: 'answerView' } as const, 'selectable')
const ANSWER_VIEW_KEY = 'answerView'

export async function getAnswerView($: EngineInterface): Promise<AnswerView> {
  return (await read($, answerViewAtom)) === 'formatted' ? 'formatted' : 'selectable'
}

export async function setAnswerView($: EngineInterface, view: AnswerView) {
  await update($, answerViewAtom, () => view)
  await $.store.set(ANSWER_VIEW_KEY, view)
}

export async function loadAnswerView($: EngineInterface) {
  const kept = await $.store.get(ANSWER_VIEW_KEY)
  if (kept === 'formatted' || kept === 'selectable') await update($, answerViewAtom, () => kept)
}

/** Answer fields are keyed by this, so bumping it remounts them with their text. */
export const revisionAtom = atom({ plugin: 'better-subchat', key: 'revision' } as const, 0)

export async function getRevision($: EngineInterface): Promise<number> {
  return read($, revisionAtom)
}

export async function bumpRevision($: EngineInterface) {
  await update($, revisionAtom, n => (n ?? 0) + 1)
}

/** The pane's page. */
export const tabAtom = atom({ plugin: 'better-subchat', key: 'tab' } as const, 'thread')

export async function getTab($: EngineInterface): Promise<Tab> {
  const tab = await read($, tabAtom)
  return tab === 'history' || tab === 'notes' || tab === 'settings' ? tab : 'thread'
}

export async function setTab($: EngineInterface, tab: Tab) {
  await update($, tabAtom, () => tab)
}

/** The closed chain opened in the history page; '' for none. */
export const openChainAtom = atom({ plugin: 'better-subchat', key: 'openChain' } as const, '')

export async function getOpenChain($: EngineInterface): Promise<string> {
  return read($, openChainAtom)
}

export async function setOpenChain($: EngineInterface, id: string) {
  await update($, openChainAtom, () => id)
}

/** The one folded part of the pane that is open: '', `menu:<turn>` or `tools:<turn>`. */
export const unfoldedAtom = atom({ plugin: 'better-subchat', key: 'unfolded' } as const, '')

export async function getUnfolded($: EngineInterface): Promise<string> {
  return read($, unfoldedAtom)
}

/** Opens `part`, or folds it again when it is the one open. */
export async function toggleUnfolded($: EngineInterface, part: string) {
  await update($, unfoldedAtom, open => (open === part ? '' : part))
}

export async function foldAll($: EngineInterface) {
  await update($, unfoldedAtom, () => '')
}

/** The pane's language: the person's choice, kept across sessions in $.store. */
export const langAtom = atom({ plugin: 'better-subchat', key: 'lang' } as const, 'en')
const LANG_KEY = 'lang'

export async function getLang($: EngineInterface): Promise<Lang> {
  return (await read($, langAtom)) === 'zh' ? 'zh' : 'en'
}

export async function setLang($: EngineInterface, lang: Lang) {
  await update($, langAtom, () => lang)
  await $.store.set(LANG_KEY, lang)
}

/** Restores the remembered language, or the configured default the first time. */
export async function loadLang($: EngineInterface, fallback: Lang) {
  const kept = await $.store.get(LANG_KEY)
  await update($, langAtom, () => (kept === 'zh' || kept === 'en' ? kept : fallback))
}

export function makePorts($: EngineInterface, options: { autoModeSpawn: boolean; onLaunched?: () => void }): Ports {
  return {
    transcript: {
      snapshot: () => mainSnapshot($),
      length: () => mainLength($),
      mainModel: () => $.session.model(),
    },
    model: {
      complete: req => {
        options.onLaunched?.()
        return complete($, { ...req, signal: req.signal as AbortSignal | undefined })
      },
    },
    agent: {
      run: req => runAgent($, { ...req, autoModeSpawn: options.autoModeSpawn, ...(options.onLaunched ? { onLaunched: options.onLaunched } : {}) }),
    },
    doc: { get: () => getDoc($), update: fn => updateDoc($, fn) },
    clock: { now: () => Date.now(), id: () => crypto.randomUUID() },
  }
}
