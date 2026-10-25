// The adapter end to end, with the engine mocked beneath the plugin.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'better-subchat',
  component: 'Pane',
  requestId: 'better-subchat',
  props: {
    title: 'better-subchat',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

type Drawing = { find: (q: never) => Promise<{ text?: string; props?: Record<string, unknown> } | undefined>; findAll: (q: never) => Promise<{ key?: string; props?: Record<string, unknown> }[]> }

/** An answer as drawn: a selectable field (the default view) or Markdown. */
const findAnswer = async (ui: unknown, text: RegExp) => {
  const drawing = ui as Drawing
  const fields = await drawing.findAll({ type: 'Input' } as never)
  const field = fields.find(f => /^(answer|notetext):/.test(f.key ?? '') && text.test(String(f.props?.value ?? '')))
  return field ?? (await drawing.find({ type: 'Markdown', text } as never))
}

/** A `/sc` run as the person types it in the fullscreen terminal. */
const st = (args: string) =>
  ({ command: 'sc', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } }) as const

const USAGE = { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const LIGHT = { options: { defaultStrategy: 'light' } }

type World = {
  session: { id: string }
  selection: { text: string } | undefined
  prompts: string[]
  spawns: { subagentType?: string; model?: string; prompt: string }[]
  toasts: string[]
  files: Map<string, string>
  main: { role: 'user' | 'assistant'; text: string; toolUses: never[] }[]
  submitted: { text: string; context?: readonly string[] }[]
  settings: { key: string; value: unknown }[]
}

/** Answers every engine call the plugin makes; `spawn` may refuse a subagent spawn. */
const world = (on: On, spawn?: (n: number) => { deny: string }): World => {
  const w: World = {
    session: { id: 'session-1' },
    selection: undefined,
    prompts: [],
    spawns: [],
    toasts: [],
    files: new Map(),
    main: [{ role: 'user', text: 'Explain the reducer.', toolUses: [] }],
    submitted: [],
    settings: [],
  }
  mock.clock(on)
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('agent.register', (_, e) => ({ value: { agent: `better-subchat:${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: w.session.id }))
  on('session.model', () => ({ value: 'claude-test' }))
  on('session.messages', () => ({ value: [...w.main] }))
  on('ui.copy', () => ({ value: { isCopied: false, reason: 'no-surface' } }))
  on('config.set', (_, e) => {
    w.settings.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  on('prompt.submit', (_, e) => {
    w.submitted.push({ text: e.text, ...(e.context ? { context: e.context } : {}) })
    return { text: e.text, ...(e.context ? { context: e.context } : {}) }
  })
  on('ui.selection', () => ({ value: w.selection }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: w.files.has(e.path) }))
  on('fs.read', (_, e) => ({ value: w.files.get(e.path) ?? '' }))
  on('fs.write', (_, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('model.complete', (_, e) => {
    w.prompts.push(e.prompt)
    return { value: { isAnswered: true, text: 'It returns new state.', usage: USAGE } }
  })
  // The kit hands this hook the spawn in the Agent tool's shape and, since
  // only the engine sets agentId, no answer here starts a subagent the plugin
  // can wait on; tests/agents.test.ts covers that half with a fake engine.
  on('agent.spawn', (_, e) => {
    const input = e as unknown as { prompt: string; subagent_type?: string; model?: string }
    w.spawns.push({ subagentType: input.subagent_type, model: input.model, prompt: input.prompt })
    const outcome = spawn?.(w.spawns.length)
    return outcome !== undefined && 'deny' in outcome ? { deny: outcome.deny } : { model: input.model ?? 'claude-test' }
  })
  return w
}

test('light mode: a side thread opens, answers and closes on every surface that takes input', LIGHT, async ($, on) => {
  const w = world(on)
  w.selection = { text: 'pure function of state' }
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ran = await $.command.run(st(''))
    expect(ran.text).toContain('should ignore this line')

    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Button', key: 'crumb:1' })).toBeDefined()

    await ui.input({ key: 'ask', text: 'Why no mutation?' })
    expect(await findAnswer(ui, /It returns new state/)).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /claude-test · light · in 12 · out 7/ })).toBeDefined()

    await ui.press({ key: 'close' })
    expect(await ui.find({ type: 'Text', text: /Run \/sc to open a side thread/ })).toBeDefined()
    await ui.unmount()
  }

  expect(w.prompts.length).toBe(2)
  expect(w.prompts[0]).toContain('Explain the reducer.')
  expect(w.prompts[0]).toContain('"pure function of state"')
  expect(w.spawns.length).toBe(0)
})

test('with no selection (the desktop app), the first question labels the layer', LIGHT, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(st(''))
  expect(w.toasts.at(-1)).toContain('opened L1')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Input', key: 'topic' })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'crumb:1' }))?.text).toBe('[L1]')
  await ui.input({ key: 'ask', text: 'why must the reducer stay pure?' })
  expect((await ui.find({ type: 'Button', key: 'crumb:1' }))?.text).toBe('[L1 "why must the reducer…"]')
  await ui.unmount()
})

test('by default a question asks for a fork with a soft snapshot; another model for the plugin agent', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(st(''))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Select', key: 'model' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /· fork$/ })).toBeDefined()
  await ui.input({ key: 'ask', text: 'read the reducer file' })
  expect(w.spawns[0]?.subagentType).toBe('fork')
  expect(w.spawns[0]?.prompt).toContain('You already hold the main conversation')
  expect(w.spawns[0]?.prompt).toContain('<side_thread_rules>')

  await ui.select({ key: 'model', value: 'haiku' })
  expect(await ui.find({ type: 'Text', text: /· agent$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Fork mode always runs on the main model/ })).toBeDefined()
  await ui.input({ key: 'ask', text: 'again on haiku' })
  expect(w.spawns[1]?.subagentType).toBe('better-subchat:subchat')
  expect(w.spawns[1]?.model).toBe('haiku')
  expect(w.spawns[1]?.prompt).toContain('<main_conversation through="1">')
  expect(w.spawns[1]?.prompt).not.toContain('<side_thread_rules>')
  await ui.unmount()
})

test('a refused spawn falls back to a tool-less answer and says so', async ($, on) => {
  const w = world(on, () => ({ deny: 'auto mode could not evaluate it' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(st(''))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'ask', text: 'q' })
  expect(await ui.find({ type: 'Text', text: /could not start \(auto mode could not evaluate it\)/ })).toBeDefined()
  expect(await findAnswer(ui, /It returns new state/)).toBeDefined()
  expect(w.prompts.length).toBe(1)
  await ui.unmount()
})

test('three levels: New layer goes deeper, a crumb shows an upper layer read-only', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(st(''))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'ask', text: 'q1' })
  await ui.press({ key: 'deeper' })
  await ui.input({ key: 'ask', text: 'q2' })
  await ui.press({ key: 'deeper' })
  expect(await ui.find({ type: 'Button', key: 'crumb:3' })).toBeDefined()

  await ui.press({ key: 'crumb:1' })
  expect(await ui.find({ type: 'Text', text: /Viewing L1 \(read-only\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Input', key: 'ask' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Q {2}q1/ })).toBeDefined()

  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Input', key: 'ask' })).toBeDefined()

  // Closing L2 from its crumb closes L3 with it.
  await ui.press({ key: 'crumb:2' })
  await ui.press({ key: 'close' })
  expect(await ui.find({ type: 'Button', key: 'crumb:2' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Q {2}q1/ })).toBeDefined()
  await ui.unmount()
})

test('side threads are saved per session and come back when that session returns', LIGHT, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(st(''))
  const first = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await first.input({ key: 'ask', text: 'remember me?' })
  await first.unmount()
  await $.session.end({ reason: 'other', sessionId: 'session-1', resume: { id: 'session-1' } })
  const saved = w.files.get('/home/test/.claude/plugins/data/better-subchat/session-1.json')
  expect(saved).toContain('remember me?')

  // Another session starts with nothing; the first one comes back whole.
  w.session.id = 'session-2'
  await $.command.run(st('close'))
  expect(w.toasts.at(-1)).not.toContain('closed')
  w.session.id = 'session-1'
  await $.command.run(st('model'))
  expect(w.toasts.at(-1)).toContain('L1 uses inherit')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Q {2}remember me\?/ })).toBeDefined()
  await ui.unmount()
})

test('with a thread open, /sc brings the pane back; /sc new opens the next level', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(st(''))
  await $.command.run(st(''))
  await $.command.run(st(''))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'crumb:2' })).toBeUndefined()
  expect(w.toasts.filter(t => t.includes('opened L'))).toEqual([expect.stringContaining('opened L1')])

  const ran = await $.command.run(st('new'))
  expect(ran.text).toContain('side thread L2')
  expect(await ui.find({ type: 'Button', key: 'crumb:2' })).toBeDefined()

  // In the terminal a fresh selection still opens the next level.
  w.selection = { text: 'a new selection' }
  await $.command.run(st(''))
  expect(await ui.find({ type: 'Button', key: 'crumb:3' })).toBeDefined()
  await ui.unmount()
})

test('thinking effort per layer picks the matching agent type', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(st(''))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.select({ key: 'effort', value: 'high' })
  expect(await ui.find({ type: 'Text', text: /· agent$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /thinks at the session's effort/ })).toBeDefined()
  await ui.input({ key: 'ask', text: 'think hard' })
  expect(w.spawns[0]?.subagentType).toBe('better-subchat:subchat-high')
  expect(w.spawns[0]?.model).toBeUndefined()

  await $.command.run(st('effort inherit'))
  expect(await ui.find({ type: 'Text', text: /· fork$/ })).toBeDefined()
  await $.command.run(st('effort loud'))
  expect(w.toasts.at(-1)).toContain('"loud" is not an effort')
  await ui.unmount()
})

test('the language setting switches the pane and the toasts to Chinese and back', LIGHT, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(st(''))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab:settings' })
  await ui.select({ key: 'setting:paneLanguage', value: 'zh' })
  await ui.press({ key: 'tab:thread' })
  expect(await ui.find({ type: 'Text', text: /主对话 ›/ })).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'deeper' }))?.text).toBe('新开一层')
  await ui.input({ key: 'ask', text: '为什么？' })
  expect(await ui.find({ type: 'Text', text: /输入 12 · 输出 7/ })).toBeDefined()
  await $.command.run(st('new'))
  expect(w.toasts.at(-1)).toContain('已打开 L2')

  await ui.press({ key: 'tab:settings' })
  await ui.select({ key: 'setting:paneLanguage', value: 'en' })
  await ui.press({ key: 'tab:thread' })
  expect(await ui.find({ type: 'Text', text: /Main ›/ })).toBeDefined()
  await ui.unmount()
})

test('answers are selectable fields that undo edits; a setting switches to formatted text', LIGHT, async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(st(''))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'ask', text: 'Why no mutation?' })
  const field = (await ui.findAll({ type: 'Input' })).find(f => f.key?.startsWith('answer:'))
  expect(field?.props).toMatchObject({ value: 'It returns new state.' })

  // An edit remounts the field under a new key with the answer as it was.
  await ui.input({ key: field?.key ?? '', text: 'edited', kind: 'change' })
  const after = (await ui.findAll({ type: 'Input' })).find(f => f.key?.startsWith('answer:'))
  expect(after?.key).not.toBe(field?.key)
  expect(after?.props).toMatchObject({ value: 'It returns new state.' })

  await ui.press({ key: 'tab:settings' })
  await ui.select({ key: 'setting:answerView', value: 'formatted' })
  await ui.press({ key: 'tab:thread' })
  expect((await ui.findAll({ type: 'Input' })).some(f => f.key?.startsWith('answer:'))).toBe(false)
  expect(await ui.find({ type: 'Markdown', text: /It returns new state/ })).toBeDefined()
  await ui.unmount()
})

const BACKFLOW = { options: { defaultStrategy: 'light', backflowEnabled: true } }

const firstKey = async (ui: unknown, prefix: string) =>
  ((await (ui as Drawing).findAll({ type: 'Button' } as never)).find(b => b.key?.startsWith(prefix))?.key ?? '')

test('backflow is off by default: no actions under an answer', LIGHT, async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(st(''))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'ask', text: 'q' })
  expect(await firstKey(ui, 'next:')).toBe('')
  await ui.unmount()
})

test('an answer sent to the next prompt rides along once, labelled, and can be undone', BACKFLOW, async ($, on) => {
  const w = world(on)
  w.selection = { text: 'pure reducers' }
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(st(''))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'ask', text: 'q' })

  expect(await firstKey(ui, 'next:')).toBe('')
  await ui.press({ key: await firstKey(ui, 'menu:') })
  await ui.press({ key: await firstKey(ui, 'next:') })
  expect(await ui.find({ type: 'Text', text: /Your next prompt carries \[From side thread L1 · about "pure reducers"\]/ })).toBeDefined()
  expect(await firstKey(ui, 'menu:')).toBe('')
  // Undo sits where the person pressed, under the answer, as well as in the preview.
  await ui.press({ key: await firstKey(ui, 'undo:') })
  expect(await ui.find({ type: 'Button', key: 'undo-pending' })).toBeUndefined()
  expect(await firstKey(ui, 'menu:')).not.toBe('')

  await ui.press({ key: await firstKey(ui, 'menu:') })
  await ui.press({ key: await firstKey(ui, 'next:') })
  await $.prompt.submit({ text: 'main question', wait: false, origin: { kind: 'composer' } } as never)
  expect(w.submitted.at(-1)?.context).toEqual(['[From side thread L1 · about "pure reducers"]\nIt returns new state.'])
  await $.prompt.submit({ text: 'another', wait: false, origin: { kind: 'composer' } } as never)
  expect(w.submitted.at(-1)?.context).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'undo-pending' })).toBeUndefined()
  await ui.unmount()
})

test('notes and copy: a note lands on the notes page; Copy is offered only where it can work', BACKFLOW, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(st(''))
  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await terminal.input({ key: 'ask', text: 'q' })
  await terminal.press({ key: await firstKey(terminal, 'menu:') })
  await terminal.press({ key: await firstKey(terminal, 'copy:') })
  expect(w.toasts.at(-1)).toContain('select the answer and press Cmd+C')
  await terminal.unmount()

  // The desktop has no clipboard for plugins: no Copy there; the answer is selected by hand.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: await firstKey(ui, 'menu:') })
  expect(await firstKey(ui, 'copy:')).toBe('')
  await ui.press({ key: await firstKey(ui, 'note:') })
  await ui.press({ key: 'tab:notes' })
  expect(await ui.find({ type: 'Text', text: /\[From side thread L1 · about "q"\]/ })).toBeDefined()
  expect(await findAnswer(ui, /It returns new state/)).toBeDefined()
  await ui.press({ key: await firstKey(ui, 'remove:') })
  expect(await ui.find({ type: 'Text', text: /No notes yet/ })).toBeDefined()
  await ui.unmount()
})

test('refresh appears when the main conversation moved on, and moves the snapshot', LIGHT, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(st(''))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'refresh' })).toBeUndefined()

  w.main.push({ role: 'assistant', text: 'more', toolUses: [] })
  await ui.input({ key: 'ask', text: 'q' })
  expect(await ui.find({ type: 'Text', text: /1 newer message/ })).toBeDefined()
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Button', key: 'refresh' })).toBeUndefined()
  expect(w.toasts.at(-1)).toContain('from message 1 to 2')
  await ui.unmount()
})

test('/sc list shows closed chains to read; /sc settings writes the plugin settings', LIGHT, async ($, on) => {
  const w = world(on)
  w.selection = { text: 'old topic' }
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(st(''))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'ask', text: 'old question' })
  await $.command.run(st('close'))

  await $.command.run(st('list'))
  const chain = await firstKey(ui, 'open:')
  expect(chain).not.toBe('')
  await ui.press({ key: chain })
  expect(await ui.find({ type: 'Text', text: /Q {2}old question/ })).toBeDefined()

  await $.command.run(st('settings'))
  await ui.select({ key: 'setting:contextMode', value: 'follow' })
  await ui.select({ key: 'setting:backflowEnabled', value: 'true' })
  await ui.select({ key: 'setting:maxDepth', value: '7' })
  expect(w.settings).toEqual([
    { key: 'better-subchat.contextMode', value: 'follow' },
    { key: 'better-subchat.backflowEnabled', value: true },
    { key: 'better-subchat.maxDepth', value: 7 },
  ])
  await ui.unmount()
})
