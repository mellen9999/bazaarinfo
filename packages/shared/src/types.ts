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
  Type: 'Item' | 'Skill'
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
  fetchedAt: string
}
