export type TierName = 'Bronze' | 'Silver' | 'Gold' | 'Diamond' | 'Legendary'

export type ReplacementValue =
  | { Fixed: number }
  | Partial<Record<TierName, number>>

export interface DumpTooltip {
  text: string
  type: string
}

export interface DumpEnchantment {
  tooltips: DumpTooltip[]
  tooltipReplacements?: Record<string, ReplacementValue>
  tags?: string[]
}

export type ItemSize = 'Small' | 'Medium' | 'Large'

export interface BazaarCard {
  Type: 'Item' | 'Skill' | 'EventEncounter'
  Title: string
  Size: ItemSize
  BaseTier: TierName
  Tiers: TierName[]
  Heroes: string[]
  Tags: string[]
  HiddenTags: string[]
  DisplayTags: string[]
  Tooltips: DumpTooltip[]
  TooltipReplacements: Record<string, ReplacementValue>
  Enchantments: Record<string, DumpEnchantment>
  Shortlink: string
  ArtKey?: string
  Cooldown?: number | Partial<Record<TierName, number>>
}

export interface MonsterBoardEntry {
  title: string
  tier: TierName
  id: string
}

export interface MonsterMetadata {
  available: string
  day: number | null
  health: number
  board: MonsterBoardEntry[]
  skills: MonsterBoardEntry[]
}

export interface Monster {
  Type: 'CombatEncounter'
  Title: string
  Size: ItemSize
  Tags: string[]
  DisplayTags: string[]
  HiddenTags: string[]
  Heroes: string[]
  MonsterMetadata: MonsterMetadata
  Shortlink: string
}

export interface CardCache {
  items: BazaarCard[]
  skills: BazaarCard[]
  monsters: Monster[]
  events?: BazaarCard[]
  fetchedAt: string
}

// --- hearthstone battlegrounds live board ---
//
// The wire shape between the companion (which reads it out of Hearthstone's own log),
// the EBS (which validates and stores it) and the bot (which answers chat from it).
// It lives here because those three must agree on it exactly — two copies that drift
// would show up as a board quietly going blank, not as a build error.
//
// Card IDs are carried raw (e.g. "BGS_071"); the bot resolves them to names against the
// card set it refreshes daily, so a rotation never needs a new companion build.

export interface HsMinion {
  id: string
  pos: number
  atk: number
  hp: number
  tier?: number
  golden?: boolean
  kw?: string[]
}

export interface HsHero {
  id: string
  hp: number
  armor?: number
  tier?: number
  place?: number
}

export interface HsState {
  turn: number
  /** in the shop, or mid-combat. The opponent is only meaningful in 'combat'. */
  phase: 'shop' | 'combat'
  board: HsMinion[]
  hero?: HsHero
  opponent?: { hero: HsHero; board?: HsMinion[] }
  /** the other seats, by leaderboard place — the game log names all eight */
  lobby?: HsHero[]
}
