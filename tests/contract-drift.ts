// Type-level only: fails `tsc -p .` when the contract and core drift.
import type { SessionDoc } from '../core/types'
import type { BetterSubchatDoc } from '../types'

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
export const contractMatchesCore: Same<SessionDoc, BetterSubchatDoc> = true
