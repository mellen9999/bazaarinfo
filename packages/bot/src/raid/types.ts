import type { BazaarCard } from '@bazaarinfo/shared'

export type RunStatus = 'active' | 'won' | 'lost'

export interface BoardItem {
  title: string
  tier: string
  size: string
  cooldownMs: number
  tags: string[]
}

export interface ShopItem {
  shopSlot: number
  card: BazaarCard
}

export interface RaidSlot {
  position: number       // 0..9
  username: string | null  // null = NPC
  boardItems: BoardItem[]  // accumulated picks
  submittedThisDay: number | null  // shopSlot or null
}

export interface SimResult {
  winner: 'party' | 'monster'
  margin: number           // [0,1]
  partyItems: string[]
  monsterItems: string[]
}

export interface Resolution {
  day: number
  narrative: string
  outcome: 'win' | 'loss'
  combatLog: object
  createdAt: number
}

export interface VoteOption {
  label: string
  monsterHint: string  // flavour hint for which monster path
}

export interface RaidState {
  raidId: number
  channel: string
  hero: string
  day: number
  hp: number
  gold: number
  wins: number
  losses: number
  status: RunStatus
  lastResolvedAt: number  // ms timestamp
  enabled: boolean
  slots: RaidSlot[]
  lastResolution: Resolution | null
  pendingVote: { options: [VoteOption, VoteOption]; tally: Map<string, string> } | null
}
