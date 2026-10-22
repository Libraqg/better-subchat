// Picks how a turn is answered (design §5).

import type { Effort, Note, Strategy } from './types'

export type Decision = { strategy: Strategy; notes: Note[] }

export type DecideInput = {
  preferred: Strategy
  /** The layer asked for light mode. */
  light: boolean
  layerModel: string
  layerEffort?: Effort
  mainModel: string
}

/** A fork always runs on the main model at the session's effort; anything else needs the plugin's own agent. */
export const decide = ({ preferred, light, layerModel, layerEffort, mainModel }: DecideInput): Decision => {
  if (light || preferred === 'light') return { strategy: 'light', notes: [] }
  if (preferred !== 'fork') return { strategy: preferred, notes: [] }
  const notes: Note[] = []
  if (layerModel !== 'inherit' && layerModel !== mainModel) notes.push({ code: 'fork-model' })
  if (layerEffort !== undefined) notes.push({ code: 'fork-effort' })
  return notes.length > 0 ? { strategy: 'agent', notes } : { strategy: 'fork', notes }
}
