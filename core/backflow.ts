// Backflow (design §2.4): what of a side thread may go back to the main
// conversation, always labelled with where it came from.

import type { Backflow, Lang } from './types'

const clip = (text: string, n: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n)}…` : flat
}

/** The source label every backflow carries, e.g. `[From side thread L2 · about "…"]`. */
export const sourceMarker = (lang: Lang, depth: number, topic: string) => {
  const about = topic.trim() === '' ? '' : lang === 'zh' ? ` · 关于 "${clip(topic, 30)}"` : ` · about "${clip(topic, 30)}"`
  return lang === 'zh' ? `[来自子对话 L${depth}${about}]` : `[From side thread L${depth}${about}]`
}

/** What the main model reads beside the person's next prompt. */
export const backflowContext = (backflow: Backflow) => `${backflow.from}\n${backflow.text}`
