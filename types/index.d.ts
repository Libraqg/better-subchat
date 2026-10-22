// PluginState contract (adapter-owned). The engine requires this file to be
// self-contained, so the shapes below mirror core/types.ts by hand; keep the
// two in step (tests/contract-drift.ts asserts both ways under tsc).

export type SubthreadUsage = { in: number; out: number; cacheRead: number; cacheWrite: number }

export type SubthreadEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type SubthreadNote =
  | { code: 'fork-model' }
  | { code: 'fork-effort' }
  | { code: 'nothing-to-fork' }
  | { code: 'spawn-refused'; detail?: string }

export type SubthreadTurn = {
  id: string
  q: string
  a?: string
  status: 'pending' | 'done' | 'error' | 'aborted'
  error?: string
  strategy: 'fork' | 'agent' | 'light'
  model: string
  usage?: SubthreadUsage
  tools?: string[]
  notes?: SubthreadNote[]
  note?: string
  anchorN: number
  at: number
}

export type SubthreadLayer = {
  depth: number
  topic: string
  model: string
  effort?: SubthreadEffort
  light?: boolean
  turns: SubthreadTurn[]
  createdAt: number
  closedAt?: number
}

export type SubthreadChain = {
  id: string
  anchorN: number
  refreshes: { from: number; to: number; at: number }[]
  layers: SubthreadLayer[]
  openedAt: number
  closedAt?: number
}

export type SubthreadDoc = {
  v: 1
  sessionId: string
  active?: SubthreadChain
  archived: SubthreadChain[]
  notes?: { id: string; from: string; text: string; at: number }[]
  pendingBackflow?: { from: string; text: string; turnId?: string }
}

declare module 'claude-code' {
  interface PluginState {
    subthread: {
      /** The session's side-thread document: active chain and archive. */
      doc: SubthreadDoc
      /** 0 shows the active (deepest) layer; another depth shows that layer read-only. */
      viewDepth: number
      /** The pane's language. */
      lang: 'en' | 'zh'
      /** How answers are drawn; the person's choice, kept across sessions. */
      answerView: 'formatted' | 'selectable'
      /** Bumped to redraw answer fields from their text, undoing an edit. */
      revision: number
      /** The pane's page. */
      tab: 'thread' | 'history' | 'notes' | 'settings'
      /** The closed chain opened in the history page; '' for none. */
      openChain: string
      /** Which folded part of the pane is open: '' for none, `menu:<turn>` or `tools:<turn>`. */
      unfolded: string
    }
  }
}
