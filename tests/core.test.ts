// core/ with fake ports: no engine involved beyond the test runner itself.
import { describe, expect, test } from 'claude-code/testing'

import { assemble, serializeMain } from '../core/assemble'
import { addNote, addTurn, closeLayer, emptyDoc, openLayer, resolveTurn, setLayerEffort } from '../core/chain'
import { ignoreLine, parseCommand } from '../core/commands'
import { ask, open, refresh } from '../core/engine'
import { sourceMarker } from '../core/backflow'
import type { Ports } from '../core/ports'
import type { Answer, MainMessage, PromptBlock, SessionDoc } from '../core/types'
import { errorText, noteText, strings } from '../core/i18n'
import { decide } from '../core/strategy'
import { buildHistory, buildNotes, buildView, statusLine } from '../core/view'

const MAIN: MainMessage[] = [
  { role: 'user', text: 'Why does useEffect run twice?' },
  { role: 'assistant', text: 'Strict mode mounts twice in development.', tools: [{ name: 'Read', input: '{"file":"a.tsx"}', result: 'ok' }] },
  { role: 'user', text: 'Later message after the snapshot.' },
]

type AgentCall = { kind: 'fork' | 'custom'; model?: string; effort?: string; prompt: string }

const fakePorts = (
  main: MainMessage[],
  reply: (blocks: PromptBlock[]) => Answer,
  agentReply: (call: AgentCall, onTool: (line: string) => void) => Answer = () => ({ ok: true, text: 'from agent' }),
) => {
  let doc: SessionDoc = emptyDoc('s1')
  let n = 0
  const sent: { model: string; blocks: PromptBlock[] }[] = []
  const agents: AgentCall[] = []
  const ports: Ports = {
    transcript: { snapshot: async () => main, length: async () => main.length, mainModel: async () => 'main-model' },
    model: {
      complete: async req => {
        sent.push({ model: req.model, blocks: req.blocks })
        return reply(req.blocks)
      },
    },
    agent: {
      run: async req => {
        const call = { kind: req.kind, model: req.model, effort: req.effort, prompt: req.prompt }
        agents.push(call)
        return agentReply(call, req.onTool)
      },
    },
    doc: {
      get: async () => doc,
      update: async fn => (doc = fn(doc)),
    },
    clock: { now: () => 1000, id: () => `id${++n}` },
  }
  return { ports, sent, agents, doc: () => doc }
}

const LIGHT = { defaultModel: 'inherit', maxDepth: 1, defaultStrategy: 'light', contextMode: 'snapshot' } as const
const FORK = { defaultModel: 'inherit', maxDepth: 3, defaultStrategy: 'fork', contextMode: 'snapshot' } as const

describe('commands', () => {
  test('parses words, questions and model names', async () => {
    expect(parseCommand('')).toEqual({ kind: 'open' })
    expect(parseCommand('  close ')).toEqual({ kind: 'close' })
    expect(parseCommand('what is a closure?')).toEqual({ kind: 'open', question: 'what is a closure?' })
    expect(parseCommand('up to which line?')).toEqual({ kind: 'open', question: 'up to which line?' })
    expect(parseCommand('model haiku')).toEqual({ kind: 'model', model: 'haiku' })
    expect(parseCommand('new')).toEqual({ kind: 'new' })
    expect(parseCommand('effort High')).toEqual({ kind: 'effort', effort: 'high' })
    expect(ignoreLine(2)).toContain('ignore')
  })
})

describe('chain', () => {
  test('opens L1, refuses past max depth, and archives on close', async () => {
    const first = openLayer(emptyDoc('s1'), { topic: 'sel', anchorN: 2, model: 'inherit', maxDepth: 1, now: 1, id: 'c1' })
    expect('doc' in first).toBe(true)
    if (!('doc' in first)) return
    expect(first.depth).toBe(1)
    expect(first.doc.active?.anchorN).toBe(2)

    const second = openLayer(first.doc, { topic: 'x', anchorN: 3, model: 'inherit', maxDepth: 1, now: 2, id: 'c2' })
    expect('error' in second).toBe(true)

    const closed = closeLayer(first.doc, 5)
    expect(closed.active).toBeUndefined()
    expect(closed.archived.length).toBe(1)
    expect(closed.archived[0]?.closedAt).toBe(5)
  })

  test('a new layer inherits the model of the one above', async () => {
    const one = openLayer(emptyDoc('s1'), { topic: '', anchorN: 0, model: 'haiku', maxDepth: 3, now: 1, id: 'c1' })
    if (!('doc' in one)) throw new Error('open failed')
    const two = openLayer(one.doc, { topic: '', anchorN: 0, model: 'opus', maxDepth: 3, now: 2, id: 'c1' })
    if (!('doc' in two)) throw new Error('open failed')
    expect(two.doc.active?.layers[1]?.model).toBe('haiku')
  })
})

describe('assemble', () => {
  test('keeps messages 1..N, caches the snapshot, and lists answered turns only', async () => {
    const opened = openLayer(emptyDoc('s1'), { topic: 'Strict mode', anchorN: 2, model: 'inherit', maxDepth: 1, now: 1, id: 'c1' })
    if (!('doc' in opened)) throw new Error('open failed')
    let doc = addTurn(opened.doc, { id: 't1', q: 'first?', now: 1, anchorN: 2, strategy: 'light', model: 'm' })
    doc = resolveTurn(doc, 't1', { ok: true, text: 'first answer' })
    doc = addTurn(doc, { id: 't2', q: 'pending?', now: 2, anchorN: 2, strategy: 'light', model: 'm' })
    const chain = doc.active
    if (!chain) throw new Error('no chain')

    const out = assemble({ chain, question: 'second?', main: MAIN })
    expect(out.anchorN).toBe(2)
    expect(out.blocks[0]?.cache).toBe(true)
    expect(out.blocks[0]?.text).toContain('Strict mode mounts twice')
    expect(out.blocks[0]?.text).not.toContain('Later message')
    expect(out.blocks[1]?.text).toContain('first answer')
    expect(out.blocks[1]?.text).not.toContain('pending?')
    expect(out.blocks[1]?.text).toContain('"Strict mode"')
    expect(out.blocks[2]?.text).toContain('second?')
    expect(out.isCompacted).toBe(false)
  })

  test('flags a compacted main conversation and drops the oldest past the budget', async () => {
    const opened = openLayer(emptyDoc('s1'), { topic: '', anchorN: 10, model: 'inherit', maxDepth: 1, now: 1, id: 'c1' })
    if (!('doc' in opened) || !opened.doc.active) throw new Error('open failed')
    expect(assemble({ chain: opened.doc.active, question: 'q', main: MAIN }).isCompacted).toBe(true)

    const long = serializeMain(MAIN, 60)
    expect(long).toContain('omitted for length')
    expect(long).toContain('Later message')
  })
})

describe('engine', () => {
  test('opens a layer at the main length and records an answer with usage', async () => {
    const fake = fakePorts(MAIN, () => ({ ok: true, text: 'because', usage: { in: 10, out: 5, cacheRead: 100, cacheWrite: 0 } }))
    expect(await open(fake.ports, LIGHT, 'sel')).toEqual({ ok: true, depth: 1 })
    expect(await ask(fake.ports, LIGHT, 'why?')).toEqual({ ok: true })

    expect(fake.sent[0]?.model).toBe('main-model')
    const turn = fake.doc().active?.layers[0]?.turns[0]
    expect(turn?.status).toBe('done')
    expect(turn?.a).toBe('because')
    expect(turn?.anchorN).toBe(3)
    expect(statusLine(fake.doc())).toBe('better-subchat: L1 · snapshot@3 · inherit')
  })

  test('records an abort and an error, and refuses a second question while one runs', async () => {
    const fake = fakePorts(MAIN, () => ({ ok: false, reason: 'aborted' }))
    await open(fake.ports, LIGHT, '')
    expect(await ask(fake.ports, LIGHT, 'q')).toEqual({ ok: false })
    expect(fake.doc().active?.layers[0]?.turns[0]?.status).toBe('aborted')

    const broken = fakePorts(MAIN, () => {
      throw new Error('blocked model')
    })
    await open(broken.ports, LIGHT, '')
    await ask(broken.ports, LIGHT, 'q')
    expect(broken.doc().active?.layers[0]?.turns[0]?.error).toContain('blocked model')

    const slow = fakePorts(MAIN, () => ({ ok: true, text: 'x' }))
    await open(slow.ports, LIGHT, '')
    await slow.ports.doc.update(doc => addTurn(doc, { id: 'p', q: 'running', now: 1, anchorN: 3, strategy: 'light', model: 'm' }))
    expect((await ask(slow.ports, LIGHT, 'another')).ok).toBe(false)
  })
})

describe('view', () => {
  test('empty without a chain; busy while a turn runs', async () => {
    expect(buildView(emptyDoc('s1'), { maxDepth: 1 }).kind).toBe('empty')
    const opened = openLayer(emptyDoc('s1'), { topic: 'a long selected sentence that goes on', anchorN: 1, model: 'inherit', maxDepth: 1, now: 1, id: 'c1' })
    if (!('doc' in opened)) throw new Error('open failed')
    const busy = addTurn(opened.doc, { id: 't', q: 'q', now: 1, anchorN: 1, strategy: 'light', model: 'm' })
    const view = buildView(busy, { maxDepth: 1 })
    expect(view.kind).toBe('layer')
    if (view.kind !== 'layer') return
    expect(view.isBusy).toBe(true)
    expect(view.canAsk).toBe(false)
    expect(view.crumbs[0]?.label).toBe('L1 "a long selected sent…"')
  })
})

describe('strategy', () => {
  test('fork on the main model, agent for another model, light when asked', async () => {
    expect(decide({ preferred: 'fork', light: false, layerModel: 'inherit', mainModel: 'm' }).strategy).toBe('fork')
    const other = decide({ preferred: 'fork', light: false, layerModel: 'haiku', mainModel: 'm' })
    expect(other.strategy).toBe('agent')
    expect(other.notes).toEqual([{ code: 'fork-model' }])
    const deeper = decide({ preferred: 'fork', light: false, layerModel: 'inherit', layerEffort: 'high', mainModel: 'm' })
    expect(deeper).toEqual({ strategy: 'agent', notes: [{ code: 'fork-effort' }] })
    expect(decide({ preferred: 'fork', light: true, layerModel: 'inherit', mainModel: 'm' }).strategy).toBe('light')
    expect(decide({ preferred: 'agent', light: false, layerModel: 'inherit', mainModel: 'm' }).strategy).toBe('agent')
  })
})

describe('tools and fallbacks', () => {
  test('a fork gets a soft snapshot with the rules; tool lines land on the turn', async () => {
    const fake = fakePorts(MAIN, () => ({ ok: true, text: 'unused' }), (_call, onTool) => {
      onTool('Read src/a.ts')
      return { ok: true, text: 'read it', model: 'main-model' }
    })
    await open(fake.ports, FORK, 'Strict mode')
    await ask(fake.ports, FORK, 'what does a.ts do?')

    const call = fake.agents[0]
    expect(call?.kind).toBe('fork')
    expect(call?.prompt).toContain('<side_thread_rules>')
    expect(call?.prompt).toContain('You already hold the main conversation')
    expect(call?.prompt).not.toContain('<main_conversation')
    await Promise.resolve()
    const turn = fake.doc().active?.layers[0]?.turns[0]
    expect(turn?.strategy).toBe('fork')
    expect(turn?.tools).toEqual(['Read src/a.ts'])
    expect(turn?.a).toBe('read it')
  })

  test('another model runs the custom agent with a hard snapshot', async () => {
    const fake = fakePorts(MAIN, () => ({ ok: true, text: 'unused' }))
    await open(fake.ports, { ...FORK, defaultModel: 'haiku' }, '')
    await ask(fake.ports, FORK, 'q')
    expect(fake.agents[0]?.kind).toBe('custom')
    expect(fake.agents[0]?.model).toBe('haiku')
    expect(fake.agents[0]?.prompt).toContain('<main_conversation through="3">')
    expect(fake.doc().active?.layers[0]?.turns[0]?.notes).toEqual([{ code: 'fork-model' }])
  })

  test('nothing to fork falls back to the agent; a refused spawn falls back to light', async () => {
    const empty = fakePorts(MAIN, () => ({ ok: true, text: 'light' }), call =>
      call.kind === 'fork' ? { ok: false, reason: 'nothing-to-fork' } : { ok: true, text: 'agent answer' },
    )
    await open(empty.ports, FORK, '')
    await ask(empty.ports, FORK, 'q')
    const first = empty.doc().active?.layers[0]?.turns[0]
    expect(empty.agents.map(a => a.kind)).toEqual(['fork', 'custom'])
    expect(first?.strategy).toBe('agent')
    expect(first?.a).toBe('agent answer')

    const refused = fakePorts(MAIN, () => ({ ok: true, text: 'light answer' }), () => ({ ok: false, reason: 'denied', detail: 'auto mode' }))
    await open(refused.ports, FORK, '')
    await ask(refused.ports, FORK, 'q')
    const turn = refused.doc().active?.layers[0]?.turns[0]
    expect(turn?.strategy).toBe('light')
    expect(turn?.a).toBe('light answer')
    expect(turn?.notes).toEqual([{ code: 'spawn-refused', detail: 'auto mode' }])
  })
})

describe('layers', () => {
  test('three levels: each sees the layers above; upper layers view read-only', async () => {
    const fake = fakePorts(MAIN, () => ({ ok: true, text: 'unused' }), call => ({ ok: true, text: `answer ${call.prompt.length}` }))
    await open(fake.ports, FORK, 'first topic')
    await ask(fake.ports, FORK, 'q1')
    expect(await open(fake.ports, FORK, 'second topic')).toEqual({ ok: true, depth: 2 })
    await ask(fake.ports, FORK, 'q2')
    expect(await open(fake.ports, FORK, 'third topic')).toEqual({ ok: true, depth: 3 })
    expect((await open(fake.ports, FORK, 'fourth')).ok).toBe(false)

    await ask(fake.ports, FORK, 'q3')
    const prompt = fake.agents[2]?.prompt ?? ''
    expect(prompt).toContain('Q: q1')
    expect(prompt).toContain('Q: q2')
    expect(prompt).toContain('"third topic"')
    expect(prompt).toContain('level 3')

    const top = buildView(fake.doc(), { viewDepth: 1, maxDepth: 3 })
    if (top.kind !== 'layer') throw new Error('no layer')
    expect(top.isReadOnly).toBe(true)
    expect(top.canAsk).toBe(false)
    expect(top.turns[0]?.q).toBe('q1')
    const deepest = buildView(fake.doc(), { maxDepth: 3 })
    if (deepest.kind !== 'layer') throw new Error('no layer')
    expect(deepest.canGoDeeper).toBe(false)
    expect(deepest.crumbs.map(c => c.isViewed)).toEqual([false, false, true])
  })
})

describe('effort and language', () => {
  test('effort reaches the agent and the completion; a new layer inherits it', async () => {
    const fake = fakePorts(MAIN, () => ({ ok: true, text: 'x' }))
    await open(fake.ports, FORK, '')
    await fake.ports.doc.update(doc => setLayerEffort(doc, 'max'))
    await ask(fake.ports, FORK, 'q')
    expect(fake.agents[0]?.kind).toBe('custom')
    expect(fake.agents[0]?.effort).toBe('max')
    // An inherited model is left to the agent type, never sent as the resolved id.
    expect(fake.agents[0]?.model).toBeUndefined()
    await open(fake.ports, FORK, '')
    expect(fake.doc().active?.layers[1]?.effort).toBe('max')
  })

  test('the pane speaks Chinese when asked; notes and errors are translated', async () => {
    expect(buildView(emptyDoc('s1'), { maxDepth: 3, lang: 'zh' })).toEqual({ kind: 'empty', lang: 'zh', hint: strings('zh').emptyHint })
    expect(noteText('zh', { code: 'spawn-refused', detail: 'x' })).toContain('子代理没能启动（x）')
    expect(errorText('zh', 'aborted: interrupted-or-rejected')).toBe('aborted: 子对话被中断，或者某次工具调用被拒绝')
    expect(errorText('en', 'api-error: 529 overloaded')).toBe('the request failed: 529 overloaded')
    const raw = '<tool_use_error>InputValidationError: [\n {\n  "code": "invalid_value"\n }\n]</tool_use_error>'
    expect(noteText('en', { code: 'spawn-refused', detail: raw })).toBe('A subagent could not start (InputValidationError: [), so this answer has no tools.')
    expect(noteText('zh', { code: 'spawn-refused', detail: 'unsupported-model' })).toContain('子代理只能使用 sonnet')
    const opened = openLayer(emptyDoc('s1'), { topic: '', anchorN: 1, model: 'inherit', maxDepth: 3, now: 1, id: 'c' })
    if (!('doc' in opened)) throw new Error('open failed')
    expect(statusLine(opened.doc, 'zh')).toBe('better-subchat: L1 · 快照@1 · 继承')
  })
})

describe('refresh and follow', () => {
  test('refresh moves N, keeps history and tells later prompts what is new', async () => {
    const main = MAIN.slice(0, 2)
    const fake = fakePorts(main, () => ({ ok: true, text: 'a1' }))
    await open(fake.ports, LIGHT, '')
    await ask(fake.ports, LIGHT, 'q1')
    main.push({ role: 'user', text: 'new main message' })
    expect(await refresh(fake.ports)).toEqual({ from: 2, to: 3 })
    expect(await refresh(fake.ports)).toBeUndefined()
    await ask(fake.ports, LIGHT, 'q2')
    const chain = fake.doc().active
    expect(chain?.anchorN).toBe(3)
    expect(chain?.layers[0]?.turns.map(t => t.a)).toEqual(['a1', 'a1'])
    const prompt = fake.sent[1]?.blocks.map(b => b.text).join('\n') ?? ''
    expect(prompt).toContain('refreshed from message 2 to 3')
    expect(prompt).toContain('new main message')
  })

  test('follow mode refreshes before every question; snapshot mode does not', async () => {
    const main = MAIN.slice(0, 1)
    const fake = fakePorts(main, () => ({ ok: true, text: 'x' }))
    await open(fake.ports, LIGHT, '')
    main.push({ role: 'assistant', text: 'later' })
    await ask(fake.ports, LIGHT, 'q')
    expect(fake.doc().active?.anchorN).toBe(1)
    await ask(fake.ports, { ...LIGHT, contextMode: 'follow' }, 'q')
    expect(fake.doc().active?.anchorN).toBe(2)
  })
})

describe('backflow, history and notes', () => {
  test('a source marker names the layer and its topic', async () => {
    expect(sourceMarker('en', 2, 'the reducer must stay pure and never mutate')).toBe('[From side thread L2 · about "the reducer must stay pure and…"]')
    expect(sourceMarker('zh', 1, '')).toBe('[来自子对话 L1]')
  })

  test('history lists closed chains newest first and opens one whole; notes list newest first', async () => {
    let doc = emptyDoc('s1')
    for (const [id, topic] of [['c1', 'first'], ['c2', 'second']] as const) {
      const opened = openLayer(doc, { topic, anchorN: 1, model: 'inherit', maxDepth: 3, now: 1, id })
      if (!('doc' in opened)) throw new Error('open failed')
      doc = addTurn(opened.doc, { id: `t-${id}`, q: `q ${topic}`, now: 1, anchorN: 1, strategy: 'light', model: 'm' })
      doc = resolveTurn(doc, `t-${id}`, { ok: true, text: `a ${topic}` })
      doc = closeLayer(doc, 2)
    }
    const history = buildHistory(doc, 'en', 'c1')
    expect(history.chains.map(c => c.id)).toEqual(['c2', 'c1'])
    expect(history.chains[0]?.summary).toBe('L1 "second" · 1 question')
    expect(history.chains[0]?.layers).toBeUndefined()
    expect(history.chains[1]?.layers?.[0]?.turns[0]?.a).toBe('a first')
    expect(buildHistory(emptyDoc('s'), 'zh').hint).toContain('还没有')

    doc = addNote(doc, { id: 'n1', from: '[From side thread L1]', text: 'one', at: 1 })
    doc = addNote(doc, { id: 'n2', from: '[From side thread L1]', text: 'two', at: 2 })
    expect(buildNotes(doc, 'en').notes.map(n => n.text)).toEqual(['two', 'one'])
  })
})
