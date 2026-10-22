// What core needs from a harness. An adapter implements these; core never
// sees the harness's own types.

import type { Answer, CancelSignal, Effort, MainMessage, PromptBlock, SessionDoc } from './types'

export interface TranscriptPort {
  /** The main conversation so far, oldest first. */
  snapshot(): Promise<MainMessage[]>
  length(): Promise<number>
  /** The model the main conversation runs on, as a model id or alias. */
  mainModel(): Promise<string>
}

export interface ModelPort {
  /** One tool-less completion; aborting `signal` must stop the request. */
  complete(req: { model: string; effort?: Effort; system: string; blocks: PromptBlock[]; signal?: CancelSignal }): Promise<Answer>
}

/** Runs one subagent turn with tools, under the session's own permissions. */
export interface AgentPort {
  run(req: {
    /** 'fork' inherits the main context and model; 'custom' is the plugin's own agent type. */
    kind: 'fork' | 'custom'
    model?: string
    effort?: Effort
    prompt: string
    /** A few words the harness may show for the running agent; never side-thread content. */
    description: string
    onTool: (summary: string) => void
    signal?: CancelSignal
  }): Promise<Answer>
}

/** The session document, read and written as a whole. */
export interface DocPort {
  get(): Promise<SessionDoc>
  update(fn: (doc: SessionDoc) => SessionDoc): Promise<SessionDoc>
}

export interface ClockPort {
  now(): number
  id(): string
}

export type Ports = {
  transcript: TranscriptPort
  model: ModelPort
  agent: AgentPort
  doc: DocPort
  clock: ClockPort
}
