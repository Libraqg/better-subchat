// Builds what a side-thread question is sent with (design §2.2):
// system rules, the main conversation snapshot 1..N, every layer's history,
// then the question. The snapshot block comes first and is marked for the
// prompt cache, so later turns of the same chain read it back cheaply.

import type { Chain, MainMessage, PromptBlock } from './types'

/** Characters of the main conversation kept in one prompt; older messages are dropped first. */
export const MAIN_BUDGET = 400_000
const TOOL_FIELD = 300

export const SYSTEM = [
  'You are answering inside a side thread of a main conversation between a user and an AI coding assistant.',
  'The user opened this side thread to ask about something in the main conversation without disturbing it.',
  'Answer only the side-thread question. Do not continue, redo or take over the main conversation\'s task.',
  'Be concise and concrete; quote the main conversation where it helps.',
].join('\n')

/** Added when the answer may use tools. */
export const TOOL_RULES = [
  'You may use tools to read files, search and run commands when that helps answer the question.',
  'Do not change files or state unless the side-thread question explicitly asks you to.',
].join('\n')

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text)

export const serializeMain = (messages: MainMessage[], budget = MAIN_BUDGET): string => {
  const lines = messages.map((m, i) => {
    const tools = (m.tools ?? [])
      .map(t => {
        const input = t.input ? ` ${clip(t.input, TOOL_FIELD)}` : ''
        const result = t.result ? `\n    → ${clip(t.result, TOOL_FIELD)}` : ''
        return `  [tool ${t.name}]${input}${result}`
      })
      .join('\n')
    return `[${i + 1}] ${m.role}: ${m.text}${tools ? `\n${tools}` : ''}`
  })
  let used = 0
  let from = lines.length
  while (from > 0) {
    const size = (lines[from - 1] ?? '').length + 1
    if (used + size > budget) break
    used += size
    from -= 1
  }
  const omitted = from > 0 ? `(messages 1–${from} omitted for length)\n` : ''
  return omitted + lines.slice(from).join('\n')
}

const quote = (text: string) => (text ? `"${clip(text.replace(/\s+/g, ' ').trim(), 200)}"` : '(no selection)')

export type Assemble = {
  chain: Chain
  question: string
  /** The main conversation as it stands now; the prompt keeps 1..chain.anchorN. */
  main: MainMessage[]
  /**
   * 'hard' sends messages 1..N; 'soft' sends none because the answerer already
   * holds the whole main conversation (a fork), and asks it to stop at N.
   */
  snapshot?: 'hard' | 'soft'
  /** The answer may use tools. */
  tools?: boolean
}

export type Assembled = { system: string; blocks: PromptBlock[]; anchorN: number; isCompacted: boolean }

export const assemble = ({ chain, question, main, snapshot: mode = 'hard', tools = false }: Assemble): Assembled => {
  const depth = chain.layers.length
  const isCompacted = main.length < chain.anchorN
  const anchorN = Math.min(chain.anchorN, main.length)
  const snapshot = main.slice(0, anchorN)

  const last = snapshot.at(-1)
  const header = [
    `This is side thread level ${depth}. The main conversation snapshot runs through message ${anchorN}.`,
    ...(mode === 'soft'
      ? [
          `You already hold the main conversation. Treat it as ending at message ${anchorN}${last ? `, the ${last.role} message that begins ${quote(last.text)}` : ''}: anything after that point has not been seen in this side thread.`,
        ]
      : []),
    ...chain.layers.map(layer => `L${layer.depth} was opened on the selected text ${quote(layer.topic)}.`),
    ...chain.refreshes.map(
      r => `The snapshot was refreshed from message ${r.from} to ${r.to}; answers given before that had not seen messages ${r.from + 1}–${r.to}.`,
    ),
    ...(isCompacted ? ['The main conversation was compacted since this thread opened; message numbers may have shifted.'] : []),
  ].join('\n')

  const history = chain.layers
    .map(layer => {
      const turns = layer.turns
        .filter(turn => turn.status === 'done' && turn.a !== undefined)
        .map(turn => `Q: ${turn.q}\nA: ${turn.a}`)
        .join('\n\n')
      return `<layer depth="${layer.depth}">\n${turns || '(no answered questions yet)'}\n</layer>`
    })
    .join('\n')

  const blocks: PromptBlock[] = [
    ...(mode === 'hard'
      ? [{ text: `<main_conversation through="${anchorN}">\n${serializeMain(snapshot) || '(empty)'}\n</main_conversation>`, cache: true as const }]
      : []),
    { text: `<side_thread>\n${header}\n${history}\n</side_thread>` },
    { text: `Side-thread question (level ${depth}):\n${question}` },
  ]
  return { system: tools ? `${SYSTEM}\n${TOOL_RULES}` : SYSTEM, blocks, anchorN, isCompacted }
}

/** One prompt string for a subagent: its rules first (a fork keeps the main system prompt), then the blocks. */
export const asAgentPrompt = (assembled: Assembled, withRules: boolean): string =>
  [...(withRules ? [`<side_thread_rules>\n${assembled.system}\n</side_thread_rules>`] : []), ...assembled.blocks.map(b => b.text)].join('\n\n')
