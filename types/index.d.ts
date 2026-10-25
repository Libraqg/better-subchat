// PluginState contract (adapter-owned). The engine requires this file to be
// self-contained, so the shapes below mirror core/types.ts by hand; keep the
// two in step (tests/contract-drift.ts asserts both ways under tsc).

export type BetterSubchatUsage = { in: number; out: number; cacheRead: number; cacheWrite: number }

export type BetterSubchatEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type BetterSubchatNote =
  | { code: 'fork-model' }
  | { code: 'fork-effort' }
  | { code: 'nothing-to-fork' }
  | { code: 'spawn-refused'; detail?: string }

export type BetterSubchatTurn = {
  id: string
  q: string
  a?: string
  status: 'pending' | 'done' | 'error' | 'aborted'
  error?: string
  strategy: 'fork' | 'agent' | 'light'
  model: string
  usage?: BetterSubchatUsage
  tools?: string[]
  notes?: BetterSubchatNote[]
  note?: string
  anchorN: number
  at: number
}

export type BetterSubchatLayer = {
  depth: number
  topic: string
  model: string
  effort?: BetterSubchatEffort
  light?: boolean
  turns: BetterSubchatTurn[]
  createdAt: number
  closedAt?: number
}

export type BetterSubchatChain = {
  id: string
  anchorN: number
  refreshes: { from: number; to: number; at: number }[]
  layers: BetterSubchatLayer[]
  openedAt: number
  closedAt?: number
}

export type BetterSubchatDoc = {
  v: 1
  sessionId: string
  active?: BetterSubchatChain
  archived: BetterSubchatChain[]
  notes?: { id: string; from: string; text: string; at: number }[]
  pendingBackflow?: { from: string; text: string; turnId?: string }
}

declare module 'claude-code' {
  interface PluginState {
    'better-subchat': {
      /** The session's side-thread document: active chain and archive. */
      doc: BetterSubchatDoc
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
