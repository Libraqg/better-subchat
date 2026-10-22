// Draws core's views with the surface's own elements. Layout: pages, crumbs,
// the layer's model / thinking / tools in one row, the turns with their
// actions folded behind ⋯, then the composer and two actions.

import type { EngineInterface, RenderChildren, RenderInput, RenderSurface } from 'claude-code'

import { strings } from '../../core/i18n'
import type { Effort, Lang } from '../../core/types'
import type { AnswerView, HistoryView, NotesView, PaneView, Tab, TurnView } from '../../core/view'

/** One row of the settings page: a field, its value and the values offered. */
export type SettingRow = { field: string; value: string; options: string[] }
/** `prefs` are the person's own (kept in the plugin store); `rows` are the plugin's settings. */
export type SettingsView = { kind: 'settings'; lang: Lang; prefs: SettingRow[]; rows: SettingRow[] }

export type Page = {
  tab: Tab
  lang: Lang
  answerView: AnswerView
  revision: number
  /** The one folded part that is open: '', `menu:<turn>` or `tools:<turn>`. */
  unfolded: string
  body: PaneView | HistoryView | NotesView | SettingsView
}

export type PaneActions = {
  stop: () => void
  /** Closes layer `depth` and every layer below it. */
  close: (depth: number) => void
  goDeeper: () => void
  view: (depth: number) => void
  setModel: (model: string) => void
  setEffort: (effort: Effort | undefined) => void
  setLight: (light: boolean) => void
  /** Redraws the answer fields from their text, undoing an edit. */
  revertAnswers: () => void
  unfold: (part: string) => void
  setTab: (tab: Tab) => void
  refresh: () => void
  toNextPrompt: (turnId: string) => void
  toNote: (turnId: string) => void
  copy: (turnId: string, surface: RenderSurface) => void
  undoPending: () => void
  openChain: (id: string) => void
  removeNote: (id: string) => void
  setPref: (field: string, value: string) => void
  setSetting: (field: string, value: string) => void
}

const MODELS = ['inherit', 'haiku', 'sonnet', 'opus', 'fable']
const EFFORTS = ['inherit', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const TABS: readonly Tab[] = ['thread', 'history', 'notes', 'settings']
/** Tool lines shown before the rest fold behind "+N". */
const TOOLS_SHOWN = 2

/** Rows a field needs to show `text` whole at `columns` cells (a wide character takes two), capped. */
const rowsFor = (text: string, columns: number) => {
  const width = Math.max(10, columns)
  const rows = text.split('\n').reduce((sum, line) => {
    const cells = [...line].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e7f ? 2 : 1), 0)
    return sum + Math.max(1, Math.ceil(cells / width))
  }, 0)
  return Math.min(40, Math.max(1, rows))
}

export function drawPane($: EngineInterface, e: RenderInput<'Pane'>, page: Page, actions: PaneActions) {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button, Markdown } = elements
  // The mobile surface draws no text field or picker: the pane is read-only there.
  const Input = 'Input' in elements ? elements.Input : undefined
  const Select = 'Select' in elements ? elements.Select : undefined
  // Only the terminal can put text on the clipboard for a plugin; elsewhere the
  // answer field is selected and copied by hand.
  const canCopy = e.surface === 'terminal'
  const s = strings(page.lang)
  const shown = (value: string) => (value === 'inherit' ? s.inherit : value)

  const tabs = (
    <Box flexDirection="row" flexWrap="wrap" gap={1}>
      {TABS.map(tab => (
        <Button
          key={`tab:${tab}`}
          plain
          dimColor={tab !== page.tab}
          label={tab === page.tab ? `[${s.tabs[tab]}]` : s.tabs[tab]}
          onPress={() => actions.setTab(tab)}
        />
      ))}
    </Box>
  )

  /** A text the mouse can select (a field that undoes edits), or Markdown. */
  const readable = (key: string, text: string) =>
    Input !== undefined && page.answerView === 'selectable' ? (
      <Input
        key={`${key}:${page.revision}`}
        value={text}
        rows={rowsFor(text, e.props.bodyColumns - 4)}
        submitLabel={s.readOnly}
        onInput={() => actions.revertAnswers()}
        onSubmit={() => actions.revertAnswers()}
      />
    ) : (
      <Markdown text={text} />
    )

  const tools = (t: TurnView) => {
    if (t.tools.length === 0) return undefined
    const rest = t.tools.length - TOOLS_SHOWN
    if (page.unfolded === `tools:${t.id}`) {
      return (
        <Box flexDirection="column">
          {t.tools.map(line => (
            <Text dimColor>⚙ {line}</Text>
          ))}
        </Box>
      )
    }
    return (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        <Text dimColor>⚙ {t.tools.slice(0, TOOLS_SHOWN).join(' · ')}</Text>
        {rest > 0 && <Button key={`tools:${t.id}`} plain dimColor label={s.moreTools(rest)} onPress={() => actions.unfold(`tools:${t.id}`)} />}
      </Box>
    )
  }

  const turn = (t: TurnView, withActions: boolean) => {
    const isDone = t.status === 'done' && t.a !== undefined
    const hasActions = withActions && isDone
    const isMenuOpen = hasActions && page.unfolded === `menu:${t.id}` && t.isPending !== true
    return (
      <Box key={`turn:${t.id}`} flexDirection="column" marginTop={1}>
        <Text bold>Q  {t.q}</Text>
        {t.notes.map(note => (
          <Text color="warning">{note}</Text>
        ))}
        {tools(t)}
        {isDone && readable(`answer:${t.id}`, t.a ?? '')}
        {t.status === 'pending' && (
          <Box flexDirection="row" gap={1}>
            <Text dimColor>{s.thinking}</Text>
            <Button key={`stop:${t.id}`} label={s.stop} onPress={() => actions.stop()} />
          </Box>
        )}
        {t.status === 'aborted' && (
          <Text color="warning">{t.error?.startsWith('aborted: ') ? s.stoppedWhy(t.error.slice('aborted: '.length)) : s.stopped}</Text>
        )}
        {t.status === 'error' && <Text color="error">{s.error(t.error ?? '?')}</Text>}
        {(t.meta !== undefined || hasActions) && (
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            {t.meta !== undefined && <Text dimColor>{t.meta}</Text>}
            {hasActions && t.isPending === true && (
              <Button key={`undo:${t.id}`} variant="primary" label={s.undoNext} onPress={() => actions.undoPending()} />
            )}
            {hasActions && t.isPending !== true && (
              <Button key={`menu:${t.id}`} plain label={s.more} onPress={() => actions.unfold(`menu:${t.id}`)} />
            )}
          </Box>
        )}
        {isMenuOpen && (
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            <Button key={`next:${t.id}`} label={s.toNextPrompt} onPress={() => actions.toNextPrompt(t.id)} />
            <Button key={`note:${t.id}`} label={s.toNote} onPress={() => actions.toNote(t.id)} />
            {canCopy && <Button key={`copy:${t.id}`} label={s.copy} onPress={press => actions.copy(t.id, press.surface)} />}
          </Box>
        )}
      </Box>
    )
  }

  const body = page.body
  const frame = (...children: RenderChildren[]) => (
    <Box flexDirection="column">
      {tabs}
      {children}
    </Box>
  )

  if (body.kind === 'history') {
    return frame(
      body.hint !== undefined && <Text dimColor>{body.hint}</Text>,
      body.chains.map(chain => (
        <Box key={`chain:${chain.id}`} flexDirection="column" marginTop={1}>
          <Button
            key={`open:${chain.id}`}
            plain
            label={chain.layers ? `▾ ${chain.summary}` : `▸ ${chain.summary}`}
            onPress={() => actions.openChain(chain.layers ? '' : chain.id)}
          />
          {chain.layers?.map(layer => (
            <Box key={`layer:${chain.id}:${layer.depth}`} flexDirection="column" marginLeft={2}>
              <Text bold>{layer.label}</Text>
              {layer.turns.map(t => turn(t, false))}
            </Box>
          ))}
        </Box>
      )),
    )
  }

  if (body.kind === 'notes') {
    return frame(
      body.hint !== undefined && <Text dimColor>{body.hint}</Text>,
      body.notes.map(note => (
        <Box key={`noteitem:${note.id}`} flexDirection="column" marginTop={1}>
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            <Text dimColor>{note.from}</Text>
            <Button key={`remove:${note.id}`} plain dimColor label={s.remove} onPress={() => actions.removeNote(note.id)} />
          </Box>
          {readable(`notetext:${note.id}`, note.text)}
        </Box>
      )),
    )
  }

  if (body.kind === 'settings') {
    const select = (row: SettingRow, words: { label: string; options: Record<string, string> } | undefined, onSelect: (value: string) => void) => {
      const label = (value: string) => `${words?.label ?? row.field}: ${words?.options[value] ?? shown(value)}`
      return Select !== undefined ? (
        <Select key={`setting:${row.field}`} options={row.options.map(value => ({ value, label: label(value) }))} value={row.value} onSelect={onSelect} />
      ) : (
        <Text>{label(row.value)}</Text>
      )
    }
    return frame(
      body.prefs.map(row => select(row, s.prefs[row.field], value => actions.setPref(row.field, value))),
      <Box marginTop={1}>
        <Text dimColor>{s.settingsHint}</Text>
      </Box>,
      body.rows.map(row => select(row, s.settingRows[row.field], value => actions.setSetting(row.field, value))),
    )
  }

  if (body.kind === 'empty') return frame(<Text dimColor>{body.hint}</Text>)

  const view = body
  const deepest = view.crumbs.at(-1)?.depth ?? view.depth
  return frame(
    <Box flexDirection="row" flexWrap="wrap" gap={1}>
      <Text bold>{s.main}</Text>
      {view.crumbs.map(c => (
        <Button
          key={`crumb:${c.depth}`}
          plain
          label={c.isViewed ? `[${c.label}]` : c.label}
          onPress={() => actions.view(c.depth === deepest ? 0 : c.depth)}
        />
      ))}
    </Box>,
    !view.isReadOnly && (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {Select !== undefined && (
          <Select
            key="model"
            options={(MODELS.includes(view.model) ? MODELS : [...MODELS, view.model]).map(value => ({ value, label: s.modelOption(shown(value)) }))}
            value={view.model}
            onSelect={value => actions.setModel(value)}
          />
        )}
        {Select !== undefined && (
          <Select
            key="effort"
            options={EFFORTS.map(value => ({ value, label: s.effortOption(shown(value)) }))}
            value={view.effort ?? 'inherit'}
            onSelect={value => actions.setEffort(value === 'inherit' ? undefined : (value as Effort))}
          />
        )}
        <Button key="light" plain label={s.layerTools(!view.light)} onPress={() => actions.setLight(!view.light)} />
        <Text dimColor>· {s.strategy[view.mode]}</Text>
      </Box>
    ),
    !view.isReadOnly && view.modeNotes.map(note => <Text dimColor>{note}</Text>),
    view.warning !== undefined && (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        <Text color="warning">⚠ {view.warning}</Text>
        {view.canRefresh && <Button key="refresh" plain label={s.refreshShort} onPress={() => actions.refresh()} />}
      </Box>
    ),
    view.isReadOnly && (
      <Box flexDirection="row" gap={1}>
        <Text color="warning">{s.viewing(view.depth)}</Text>
        <Button key="back" label={s.back(deepest)} onPress={() => actions.view(0)} />
      </Box>
    ),
    view.turns.length === 0 && !view.isReadOnly && <Text dimColor>{s.askHint}</Text>,
    view.turns.map(t => turn(t, view.backflowEnabled || canCopy)),
    <Box flexDirection="column" marginTop={1}>
      {view.pending !== undefined && (
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Text>{s.pendingBanner(view.pending.from)}</Text>
          <Button key="undo-pending" plain label={s.undo} onPress={() => actions.undoPending()} />
        </Box>
      )}
      {Input !== undefined && view.canAsk && (
        <Input
          key="ask"
          placeholder={s.askPlaceholder}
          submitLabel={s.askSubmit}
          autoFocus
          // register.tsx asks from its ui.input hook for this key; the handler has nothing left to do.
          onSubmit={() => {}}
        />
      )}
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {view.canGoDeeper && <Button key="deeper" label={s.newLayer} onPress={() => actions.goDeeper()} />}
        <Button key="close" label={s.closeLayer(view.depth)} onPress={() => actions.close(view.depth)} />
      </Box>
    </Box>,
  )
}
