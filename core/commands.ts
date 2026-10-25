// Parses the arguments of `/better-subchat` (alias `/sc`).

export type Command =
  | { kind: 'open'; question?: string }
  | { kind: 'new' }
  | { kind: 'effort'; effort?: string }
  | { kind: 'close' }
  | { kind: 'up' }
  | { kind: 'refresh' }
  | { kind: 'model'; model?: string }
  | { kind: 'list' }
  | { kind: 'settings' }

const WORDS = ['new', 'close', 'up', 'refresh', 'model', 'effort', 'list', 'settings'] as const

export const parseCommand = (args: string): Command => {
  const text = args.trim()
  if (text === '') return { kind: 'open' }
  const [head = '', ...rest] = text.split(/\s+/)
  const word = WORDS.find(w => w === head.toLowerCase())
  if (word === undefined) return { kind: 'open', question: text }
  if (word === 'model') return rest.length > 0 ? { kind: 'model', model: rest.join(' ') } : { kind: 'model' }
  if (word === 'effort') return rest.length > 0 ? { kind: 'effort', effort: rest.join(' ').toLowerCase() } : { kind: 'effort' }
  // A known word followed by more text reads as a question ("up to which line?").
  if (rest.length > 0) return { kind: 'open', question: text }
  return { kind: word }
}

/** The one line a command leaves in the main conversation (design decision ④). */
export const ignoreLine = (depth: number) =>
  `↳ better-subchat: handled in side thread L${depth}; the main conversation should ignore this line.`
