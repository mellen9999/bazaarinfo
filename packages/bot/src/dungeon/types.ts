// the depths — shared-hero offline roguelike. one run per channel; the whole chat
// votes one hero. this is the data model; all mechanics live on a small fixed chassis
// so any AI-flavored archetype is equally balanced.
import type { Build, SpecialKind } from './ai-archetype'

export type Phase = 'idle' | 'recruiting' | 'combat' | 'fork' | 'over'
export type Verb = 'attack' | 'defend' | 'special' | 'flee'
// the enemy's telegraphed NEXT move — shown in the digest so the vote is a real read
export type Intent = 'normal' | 'heavy' | 'guard' | 'special'
export type BuffKind = 'maxhp' | 'atk' | 'special' | 'shield'

export interface Hero {
  title: string
  blurb: string
  build: Build
  specialKind: SpecialKind
  moveName: string
  moveFlavor: string   // contains "{enemy}" — slotted at fire time
  hp: number
  maxHp: number
  atk: number
  special: number      // remaining signature-move charges
  maxSpecial: number
  shield: number       // flat damage absorbed before HP
}

export interface Enemy {
  name: string         // a real Bazaar monster
  hp: number
  maxHp: number
  dmg: number          // base hit
  intent: Intent       // telegraphed next action
  staggered: boolean   // parried last turn -> takes bonus damage next hit
  stunned: boolean     // skips its next action
  isElite: boolean
  isBoss: boolean
  phase: number        // boss phase (1..2); 0 for non-boss
}

export interface ForkOption {
  n: number            // 1 / 2
  label: string
  kind: 'elite' | 'rest' | 'skip'
  buff?: BuffKind      // reward if this path is an elite, granted on the elite's defeat
}

export interface Run {
  channel: string
  phase: Phase
  floor: number                          // 1..5
  hero: Hero | null
  enemy: Enemy | null                    // current single foe (1v1 keeps it legible)
  fork: ForkOption[] | null              // options when phase === 'fork'
  pendingBuff: BuffKind | null           // buff to grant when the current elite dies
  windowEndsAt: number                   // vote-window deadline (ms epoch); 0 = none
  firstVoteAt: number                    // when the first vote of this window landed; 0 = none
  seed: number                           // deterministic RNG counter (resumable + testable)
  startedBy: string
  contributors: Record<string, number>   // username -> killing blows (light credit)
  updatedAt: number
}

export const FLOORS = 5
export const SPECIAL_CHARGES = 3

// build chassis — the only stat variation; AI flavor never touches these numbers.
export const BUILD_STATS: Record<Build, { maxHp: number; atk: number }> = {
  tanky: { maxHp: 42, atk: 6 },
  balanced: { maxHp: 32, atk: 8 },
  aggressive: { maxHp: 24, atk: 11 },
}
