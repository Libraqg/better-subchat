// The session document on disk, one JSON file per main session, so side
// threads come back with `claude --resume` / the desktop app's resume.

import type { EngineInterface } from 'claude-code'

import { emptyDoc } from '../../core/chain'
import type { SessionDoc } from '../../core/types'

/** $.fs refuses writes over 4 MiB; stay clear of it by dropping the oldest archived chains. */
const MAX_BYTES = 3_500_000
const SAVE_DELAY_MS = 500

let pending: { cancel: () => void } | undefined

export async function dataDir($: EngineInterface): Promise<string> {
  const own = await $.env.get('CLAUDE_PLUGIN_DATA')
  if (own) return own
  const home = await $.env.get('HOME')
  return `${home ?? '.'}/.claude/plugins/data/subthread`
}

const fileOf = (dir: string, sessionId: string) => `${dir}/${sessionId.replace(/[^\w.-]/g, '_')}.json`

const isDoc = (value: unknown): value is SessionDoc => {
  const doc = value as Partial<SessionDoc> | null
  return doc !== null && typeof doc === 'object' && doc.v === 1 && typeof doc.sessionId === 'string' && Array.isArray(doc.archived)
}

export async function loadDoc($: EngineInterface, sessionId: string): Promise<SessionDoc> {
  const path = fileOf(await dataDir($), sessionId)
  try {
    if (!(await $.fs.exists(path))) return emptyDoc(sessionId)
    const parsed: unknown = JSON.parse(await $.fs.read(path))
    if (isDoc(parsed) && parsed.sessionId === sessionId) return parsed
    $.ui.log(`subthread: ignored an unreadable side-thread file (${path})`)
  } catch (err) {
    $.ui.log(`subthread: could not read side threads: ${err instanceof Error ? err.message : String(err)}`)
  }
  return emptyDoc(sessionId)
}

const fitted = (doc: SessionDoc): string => {
  let text = JSON.stringify(doc)
  let archived = doc.archived
  while (text.length > MAX_BYTES && archived.length > 0) {
    archived = archived.slice(1)
    text = JSON.stringify({ ...doc, archived })
  }
  return text
}

export async function saveDoc($: EngineInterface, doc: SessionDoc) {
  if (doc.sessionId === '') return
  try {
    await $.fs.write(fileOf(await dataDir($), doc.sessionId), fitted(doc))
  } catch (err) {
    $.ui.log(`subthread: could not save side threads: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Saves `doc` shortly, folding a burst of changes into one write. */
export function scheduleSave($: EngineInterface, doc: SessionDoc) {
  pending?.cancel()
  pending = $.clock.after(SAVE_DELAY_MS, () => {
    pending = undefined
    void saveDoc($, doc)
  })
}
