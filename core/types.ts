// Harness-agnostic data model. Nothing in core/ may import 'claude-code'.

export type Usage = { in: number; out: number; cacheRead: number; cacheWrite: number }

export type TurnStatus = 'pending' | 'done' | 'error' | 'aborted'

/**
 * How a turn is answered: 'fork' a subagent that inherits the main context
 * (and model), 'agent' the plugin's own subagent on a model of the layer's
 * choosing, 'light' one tool-less completion.
 */
export type Strategy = 'fork' | 'agent' | 'light'

/** How hard the model thinks; absent means the session's own. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** The pane's display language. */
export type Lang = 'en' | 'zh'

/** Why a turn ran differently than asked; translated when drawn. */
export type Note =
  | { code: 'fork-model' }
  | { code: 'fork-effort' }
  | { code: 'nothing-to-fork' }
  | { code: 'spawn-refused'; detail?: string }

export type Turn = {
  id: string
  q: string
  a?: string
  status: TurnStatus
  error?: string
  strategy: Strategy
  /** The model actually used: reported by the harness when known, else the one requested. */
  model: string
  usage?: Usage
  /** One line per tool call the answer made, newest last. */
  tools?: string[]
  /** Why the turn ran differently than asked (a fallback, a model note). */
  notes?: Note[]
  /** v0.2 development builds stored notes as English text; shown as is. */
  note?: string
  /** Main conversation length this turn's prompt was built from. */
  anchorN: number
  at: number
}

export type Layer = {
  depth: number
  /** The selection the layer was opened on; empty when nothing was selected. */
  topic: string
  /** 'inherit' or a model alias / id. */
  model: string
  /** Thinking effort for this layer's answers; absent inherits the session's. */
  effort?: Effort
  /** Answer without tools (light mode) regardless of the default strategy. */
  light?: boolean
  turns: Turn[]
  createdAt: number
  closedAt?: number
}

export type Refresh = { from: number; to: number; at: number }

export type Chain = {
  id: string
  /** Snapshot N: the main conversation is read up to and including message N. */
  anchorN: number
  refreshes: Refresh[]
  /** A single chain: layers[k - 1] is L_k. */
  layers: Layer[]
  openedAt: number
  closedAt?: number
}

/** A side-thread answer the person kept as a note: never in the model's context. */
export type SavedNote = { id: string; from: string; text: string; at: number }

/** An answer waiting to ride along with the person's next main-conversation prompt. */
export type Backflow = { from: string; text: string; turnId?: string }

export type SessionDoc = {
  v: 1
  sessionId: string
  active?: Chain
  archived: Chain[]
  notes?: SavedNote[]
  pendingBackflow?: Backflow
}

/** One message of the main conversation, as the harness hands it over. */
export type MainMessage = {
  role: 'user' | 'assistant'
  text: string
  tools?: { name: string; input?: string; result?: string }[]
}

export type PromptBlock = { text: string; cache?: true }

/** The part of a web AbortSignal core relies on; an adapter passes its own and may listen on it. */
export type CancelSignal = { readonly aborted: boolean }

export type Answer =
  | { ok: true; text: string; model?: string; usage?: Usage }
  | {
      ok: false
      reason: 'nothing-to-fork' | 'api-error' | 'empty-reply' | 'aborted' | 'denied' | 'no-permission'
      detail?: string
      usage?: Usage
    }

/** 'snapshot' keeps N until the person refreshes; 'follow' refreshes before every question. */
export type ContextMode = 'snapshot' | 'follow'

export type Settings = {
  defaultModel: string
  maxDepth: number
  defaultStrategy: Strategy
  contextMode: ContextMode
}
