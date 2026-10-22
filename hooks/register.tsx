// Claude Code adapter: wires engine events to core. All side-thread logic
// lives in ../core; this file only translates.

import type { CommandRunInput, EngineInterface, PluginOptions, Register, RenderSurface } from 'claude-code'

import { SYSTEM, TOOL_RULES } from '../core/assemble'
import { backflowContext, sourceMarker } from '../core/backflow'
import {
  activeLayer,
  addNote,
  failPending,
  findTurn,
  layerSubject,
  removeNote,
  setLayerEffort,
  setLayerLight,
  setLayerModel,
  setPendingBackflow,
} from '../core/chain'
import { ignoreLine, parseCommand } from '../core/commands'
import { ask, close, open, refresh } from '../core/engine'
import { strings } from '../core/i18n'
import type { ContextMode, Effort, Lang, Settings, Strategy } from '../core/types'
import { buildHistory, buildNotes, buildView, statusLine } from '../core/view'
import type { Tab } from '../core/view'
import { EFFORTS, agentFinished, agentName, agentUsedTool, isAwaited, isOurs, isOwnAgentType, isSideThreadDelivery, takeAllowWindow, toolLine } from './adapter/agents'
import { drawPane } from './adapter/pane'
import type { SettingRow } from './adapter/pane'
import { loadDoc, saveDoc } from './adapter/persist'
import {
  bumpRevision,
  foldAll,
  getAnswerView,
  getDoc,
  getLang,
  getOpenChain,
  getRevision,
  getTab,
  getUnfolded,
  getViewDepth,
  loadAnswerView,
  loadLang,
  makePorts,
  mainLength,
  setAnswerView,
  setLang,
  setOpenChain,
  setTab,
  setViewDepth,
  toggleUnfolded,
  updateDoc,
} from './adapter/ports'

const PANE = 'subthread'
const COMMANDS = ['subthread', 'st'] as const

type Config = Settings & { autoModeSpawn: boolean; language: Lang; backflowEnabled: boolean }

const STRATEGIES: readonly Strategy[] = ['fork', 'agent', 'light']

const configFrom = (options: PluginOptions): Config => {
  const model = options.defaultModel
  const depth = Number(options.maxDepth)
  const strategy = STRATEGIES.find(s => s === options.defaultStrategy)
  return {
    defaultModel: typeof model === 'string' && model.trim() !== '' ? model.trim() : 'inherit',
    // At least the three levels the design promises; a mistyped value falls back to 5.
    maxDepth: Number.isFinite(depth) && depth >= 3 ? Math.floor(depth) : 5,
    defaultStrategy: strategy ?? 'fork',
    contextMode: options.contextMode === 'follow' ? 'follow' : 'snapshot',
    autoModeSpawn: options.autoModeSpawn !== false,
    backflowEnabled: options.backflowEnabled === true,
    language: options.language === 'zh' ? 'zh' : 'en',
  }
}

/** The settings page: each userConfig field the pane can change, with the values it offers. */
const settingRows = (config: Config): SettingRow[] => {
  const models = ['inherit', 'haiku', 'sonnet', 'opus', 'fable']
  const contextModes: ContextMode[] = ['snapshot', 'follow']
  return [
    { field: 'contextMode', value: config.contextMode, options: contextModes },
    { field: 'defaultModel', value: config.defaultModel, options: models.includes(config.defaultModel) ? models : [...models, config.defaultModel] },
    { field: 'defaultStrategy', value: config.defaultStrategy, options: [...STRATEGIES] },
    { field: 'maxDepth', value: String(config.maxDepth), options: ['3', '4', '5', '6', '7', '8', '9'] },
    { field: 'backflowEnabled', value: String(config.backflowEnabled), options: ['true', 'false'] },
    { field: 'autoModeSpawn', value: String(config.autoModeSpawn), options: ['true', 'false'] },
  ]
}

/** A picked value in the type its userConfig field holds. */
const settingValue = (field: string, value: string): string | number | boolean =>
  field === 'maxDepth' ? Number(value) : field === 'backflowEnabled' || field === 'autoModeSpawn' ? value === 'true' : value

const toEffort = (word: string): Effort | 'inherit' | undefined =>
  word === 'inherit' ? 'inherit' : EFFORTS.find(e => e === word)

// The running question, so the pane's Stop can abort it. Lost on a reload,
// where session.start marks the turn as interrupted.
let running: AbortController | undefined

async function say($: EngineInterface) {
  return strings(await getLang($)).toast
}

async function refreshStatus($: EngineInterface) {
  $.ui.status(statusLine(await getDoc($), await getLang($)))
}

/** Loads this session's side threads when the session changed under the document (a resume, a /clear). */
async function ensureSession($: EngineInterface) {
  const id = await $.session.id()
  const doc = await getDoc($)
  if (doc.sessionId === id) return
  if (doc.sessionId !== '') await saveDoc($, doc)
  const loaded = await loadDoc($, id)
  await updateDoc($, () => loaded)
  await setViewDepth($, 0)
}

/**
 * Asks `question` and resolves once its answer has been launched (a subagent
 * spawned or refused, a completion sent), not when it is answered. Callers are
 * hooks that await this: a spawn made while one of this plugin's hooks runs is
 * the only kind its own tool.check hook sees (the auto-mode window, design §13),
 * and the hook must not wait out the whole answer on its budget.
 */
async function startAsk($: EngineInterface, config: Config, question: string) {
  const text = question.trim()
  if (text === '') return
  const controller = new AbortController()
  running = controller
  await setViewDepth($, 0)
  let launched: () => void = () => {}
  const isLaunched = new Promise<void>(resolve => (launched = resolve))
  const answered = ask(makePorts($, { ...config, onLaunched: () => launched() }), config, text, controller.signal).then(async result => {
    if (running === controller) running = undefined
    if (result.refusal !== undefined) {
      const t = await say($)
      $.ui.toast(result.refusal === 'busy' ? t.busy : t.noThread)
    }
    await refreshStatus($)
  })
  await Promise.race([isLaunched, answered])
}

function stopAsk() {
  running?.abort()
  running = undefined
}

async function closeFrom($: EngineInterface, config: Config, depth?: number) {
  stopAsk()
  const closed = await close(makePorts($, config), depth)
  await setViewDepth($, 0)
  if (!(await getDoc($)).active) await $.ui.close({ id: PANE })
  const t = await say($)
  if (closed !== undefined) $.ui.toast(closed === 1 ? t.closedThread : t.closedFrom(closed))
  await refreshStatus($)
}

async function openLayer($: EngineInterface, config: Config, topic: string) {
  const opened = await open(makePorts($, config), config, topic)
  const t = await say($)
  if (!opened.ok) {
    $.ui.toast(t.maxDepth(opened.maxDepth))
    return undefined
  }
  await setViewDepth($, 0)
  $.ui.toast(topic === '' ? t.openedPlain(opened.depth) : t.opened(opened.depth))
  await refreshStatus($)
  return opened.depth
}

async function showPane($: EngineInterface) {
  const placed = await $.ui.open({ id: PANE, title: 'subthread' })
  if (!placed.isPlaced) $.ui.toast((await say($)).notShown(placed.reason))
}

async function setModel($: EngineInterface, model: string) {
  await updateDoc($, doc => setLayerModel(doc, model))
  await refreshStatus($)
}

async function setEffort($: EngineInterface, effort: Effort | undefined) {
  await updateDoc($, doc => setLayerEffort(doc, effort))
  await refreshStatus($)
}

async function setLight($: EngineInterface, light: boolean) {
  await updateDoc($, doc => setLayerLight(doc, light))
  await refreshStatus($)
}


async function refreshSnapshot($: EngineInterface, config: Config) {
  const moved = await refresh(makePorts($, config))
  const t = await say($)
  $.ui.toast(moved ? t.refreshed(moved.from, moved.to) : t.upToDate)
  await refreshStatus($)
}

/** The answer of `turnId`, labelled with the layer it came from (design §2.4). */
async function backflowOf($: EngineInterface, turnId: string) {
  const found = findTurn(await getDoc($), turnId)
  if (!found?.turn.a) return undefined
  return { from: sourceMarker(await getLang($), found.layer.depth, layerSubject(found.layer)), text: found.turn.a, turnId }
}

async function toNextPrompt($: EngineInterface, turnId: string) {
  const backflow = await backflowOf($, turnId)
  if (!backflow) return
  await foldAll($)
  await updateDoc($, doc => setPendingBackflow(doc, backflow))
  $.ui.toast((await say($)).toNextPrompt)
}

async function toNote($: EngineInterface, turnId: string) {
  const backflow = await backflowOf($, turnId)
  if (!backflow) return
  await foldAll($)
  await updateDoc($, doc => addNote(doc, { id: crypto.randomUUID(), from: backflow.from, text: backflow.text, at: Date.now() }))
  $.ui.toast((await say($)).noted)
}

async function copyAnswer($: EngineInterface, turnId: string, surface: RenderSurface) {
  const backflow = await backflowOf($, turnId)
  if (!backflow) return
  await foldAll($)
  const copied = await $.ui.copy({ text: `${backflow.from}\n${backflow.text}`, surface })
  const t = await say($)
  $.ui.toast(copied.isCopied ? t.copied : t.copyFailed)
}

async function setSetting($: EngineInterface, field: string, value: string) {
  const set = await $.config.set({ key: `subthread.${field}`, value: settingValue(field, value) })
  const t = await say($)
  $.ui.toast(set.deny === undefined ? t.settingSet : t.settingDenied(set.deny))
}

/** The person's own preferences, kept in the plugin store: how answers are drawn, the pane's language. */
async function setPref($: EngineInterface, field: string, value: string) {
  if (field === 'answerView' && (value === 'selectable' || value === 'formatted')) await setAnswerView($, value)
  if (field === 'paneLanguage' && (value === 'en' || value === 'zh')) {
    await setLang($, value)
    await refreshStatus($)
  }
}

async function showTab($: EngineInterface, tab: Tab) {
  await setTab($, tab)
  await showPane($)
}

async function runCommand($: EngineInterface, e: CommandRunInput, config: Config) {
  await ensureSession($)
  const command = parseCommand(e.args)
  const current = activeLayer(await getDoc($))
  const t = await say($)
  let depth = current?.depth ?? 1

  if (command.kind === 'open' || command.kind === 'new') {
    const selected = (await $.ui.selection())?.text.trim() ?? ''
    // With a thread open, plain /st only brings the pane back. A new layer
    // takes /st new, the pane's button, or a fresh selection (terminal).
    const wantsLayer = current === undefined || command.kind === 'new' || selected !== ''
    if (wantsLayer && current !== undefined && current.depth >= config.maxDepth) {
      $.ui.toast(t.maxDepth(config.maxDepth))
    } else if (wantsLayer) {
      const opened = await openLayer($, config, selected)
      if (opened !== undefined) depth = opened
    }
    await showPane($)
    if (command.kind === 'open' && command.question !== undefined) await startAsk($, config, command.question)
    return { text: ignoreLine(depth) }
  }

  if (command.kind === 'close') {
    await closeFrom($, config, 1)
  } else if (command.kind === 'up') {
    await closeFrom($, config)
  } else if (current === undefined && (command.kind === 'model' || command.kind === 'effort')) {
    $.ui.toast(t.noThread)
  } else if (command.kind === 'model' && current !== undefined) {
    if (command.model === undefined) {
      $.ui.toast(t.model(depth, current.model))
    } else {
      await setModel($, command.model)
      $.ui.toast(t.modelSet(depth, command.model))
    }
  } else if (command.kind === 'effort' && current !== undefined) {
    const effort = command.effort === undefined ? undefined : toEffort(command.effort)
    if (command.effort === undefined) {
      $.ui.toast(t.effort(depth, current.effort ?? 'inherit'))
    } else if (effort === undefined) {
      $.ui.toast(t.effortBad(command.effort))
    } else {
      await setEffort($, effort === 'inherit' ? undefined : effort)
      $.ui.toast(t.effort(depth, effort))
    }
  } else if (command.kind === 'refresh') {
    if (current === undefined) $.ui.toast(t.noThread)
    else await refreshSnapshot($, config)
  } else if (command.kind === 'list') {
    await showTab($, 'history')
  } else if (command.kind === 'settings') {
    await showTab($, 'settings')
  }
  return { text: ignoreLine(depth) }
}

export const register: Register = (on, options) => {
  const config = configFrom(options)

  on('session.start', async ($, e, next) => {
    for (const name of COMMANDS) {
      await $.command.register({
        name,
        description: name === 'st' ? 'Alias of /subthread' : 'Ask about the selection in a side thread that stays out of the main conversation',
        argumentHint: '[question] | new | close | up | refresh | model <name> | effort <level> | list | settings',
      })
    }
    // One agent type per effort, since a spawn cannot set it; all hidden from the model.
    for (const effort of [undefined, ...EFFORTS]) {
      await $.agent.register({
        name: agentName(effort),
        description: 'Answers a side-thread question for the subthread plugin. Started only by the plugin.',
        prompt: `${SYSTEM}\n${TOOL_RULES}`,
        // No nested agents, and no hand-back: the answer comes back through
        // turn.complete and must never be delivered to the main conversation.
        disallowedTools: ['Agent', 'SubagentHandback'],
        model: 'inherit',
        ...(effort !== undefined ? { effort } : {}),
      })
    }
    await loadLang($, config.language)
    await loadAnswerView($)
    await ensureSession($)
    await updateDoc($, doc => failPending(doc, 'interrupted'))
    await refreshStatus($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await saveDoc($, await getDoc($))
    return next(e)
  })

  // The plugin's agent types are for the plugin alone.
  on('agent.offer', ($, e, next) => (isOwnAgentType(e.agent) ? { isOffered: false } : next(e)))

  // Design §13: let this plugin's own spawn through an `ask` verdict once,
  // inside the window a question the person sent opened. Never a `deny`,
  // never another plugin's or the model's Agent call, never a subagent's tools.
  on('tool.check', { tool: 'Agent' }, async ($, e, next) => {
    const verdict = await next(e)
    if (e.agentId !== undefined || next.origin.plugin !== 'subthread') return verdict
    if (!takeAllowWindow() || verdict.decision !== 'ask') return verdict
    return { decision: 'allow' as const, reason: 'subthread: a side-thread question the person sent' }
  }).catch(($, e, next) => next(e))

  // Tool lines as they happen, where the engine raises them here; agents.ts
  // also reads them from the agent's own transcript, deduplicated by id.
  on('tool.call', async ($, e, next) => {
    if (isOurs(e.agentId)) agentUsedTool(e.agentId, e.tool_use_id, toolLine(String(e.tool), e as unknown as Record<string, unknown>))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (isAwaited(e.agentId)) {
      const u = e.usage
      agentFinished(e.agentId, {
        reason: e.reason,
        answer: e.answer,
        ...(u
          ? {
              usage: {
                in: u.input_tokens,
                out: u.output_tokens,
                cacheRead: u.cache_read_input_tokens,
                cacheWrite: u.cache_creation_input_tokens,
                model: u.model,
              },
            }
          : {}),
      })
    }
    return next(e)
  })

  // A side thread never reports into the main conversation (design decision ②):
  // a subagent the plugin spawned hands its report back to the main loop as a
  // peer message, which is dropped here before the main model reads it.
  //
  // Backflow (design §2.4) is the one way in, and only when the person asked:
  // an answer they sent "to the next prompt" rides along with their next own
  // prompt as context, labelled with its source, and is then cleared.
  on('prompt.submit', async ($, e, next) => {
    if (isSideThreadDelivery(e.origin, e.text)) return { drop: (await say($)).dropped }
    const pending = e.origin?.kind === 'composer' && e.command === undefined ? (await getDoc($)).pendingBackflow : undefined
    if (!pending) return next(e)
    const result = await next({ ...e, context: [...(e.context ?? []), backflowContext(pending)] })
    if (result.drop === undefined) await updateDoc($, doc => setPendingBackflow(doc, undefined))
    return result
  }).catch(($, e, next) => next(e))

  // Should such a delivery still reach the transcript (one folded into a
  // running turn), its words are replaced before any request carries them.
  on('session.append', async ($, e, next) => {
    if (e.agentId !== undefined || (e.door !== 'delivery' && e.door !== 'queue' && e.door !== 'prompt')) return next(e)
    const content = e.message.content
    const text = typeof content === 'string' ? content : content.map(block => (block.type === 'text' ? block.text : '')).join('\n')
    if (!isSideThreadDelivery(e.origin as { kind: string }, text)) return next(e)
    return next({ ...e, message: { ...e.message, content: [{ type: 'text', text: '[subthread: a side-thread report was kept out of the main conversation]' }] } })
  }).catch(($, e, next) => next(e))

  // A question typed in the pane is asked from this hook, not the Input's own
  // handler, so its spawn happens inside one of this plugin's hooks (see startAsk).
  on('ui.input', { plugin: 'subthread', element: 'ask' }, async ($, e, next) => {
    if (e.kind === 'submit') await startAsk($, config, e.value)
    return next(e)
  })

  on('command.run', { command: 'subthread' }, ($, e) => runCommand($, e, config))
  on('command.run', { command: 'st' }, ($, e) => runCommand($, e, config))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const doc = await getDoc($)
    const lang = await getLang($)
    const tab = await getTab($)
    const answerView = await getAnswerView($)
    const revision = await getRevision($)
    const body =
      tab === 'history'
        ? buildHistory(doc, lang, await getOpenChain($))
        : tab === 'notes'
          ? buildNotes(doc, lang)
          : tab === 'settings'
            ? {
                kind: 'settings' as const,
                lang,
                prefs: [
                  { field: 'answerView', value: answerView, options: ['selectable', 'formatted'] },
                  { field: 'paneLanguage', value: lang, options: ['en', 'zh'] },
                ],
                rows: settingRows(config),
              }
            : buildView(doc, {
                lang,
                viewDepth: await getViewDepth($),
                maxDepth: config.maxDepth,
                ...(doc.active ? { mainLength: await mainLength($) } : {}),
                preferred: config.defaultStrategy,
                answerView,
                revision,
                backflowEnabled: config.backflowEnabled,
              })
    const unfolded = await getUnfolded($)
    return drawPane($, e, { tab, lang, answerView, revision, unfolded, body }, {
      stop: () => stopAsk(),
      close: depth => void closeFrom($, config, depth),
      goDeeper: () => void openLayer($, config, ''),
      view: depth => void setViewDepth($, depth),
      setModel: model => void setModel($, model),
      setEffort: effort => void setEffort($, effort),
      setLight: light => void setLight($, light),
      revertAnswers: () => void bumpRevision($),
      unfold: part => void toggleUnfolded($, part),
      setTab: next => void setTab($, next),
      refresh: () => void refreshSnapshot($, config),
      toNextPrompt: turnId => void toNextPrompt($, turnId),
      toNote: turnId => void toNote($, turnId),
      copy: (turnId, surface) => void copyAnswer($, turnId, surface),
      undoPending: () => void updateDoc($, doc => setPendingBackflow(doc, undefined)),
      openChain: id => void setOpenChain($, id),
      removeNote: id => void updateDoc($, doc => removeNote(doc, id)),
      setPref: (field, value) => void setPref($, field, value),
      setSetting: (field, value) => void setSetting($, field, value),
    })
  })
}
