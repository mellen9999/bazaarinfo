export interface TooltipText {
  Text: string
}

export interface Tooltip {
  Content: TooltipText
  TooltipType: 'Active' | 'Passive'
}

export type TierName = 'Bronze' | 'Silver' | 'Gold' | 'Diamond' | 'Legendary'

export interface TierData {
  AbilityIds: string[]
  AuraIds: string[]
  OverrideAttributes: Record<string, number>
  ActiveTooltips: number[]
}

export type ReplacementValue =
  | { Fixed: number }
  | Partial<Record<TierName, number>>

export interface Enchantment {
  Tags: string[]
  HiddenTags: string[]
  Localization: {
    Tooltips: Tooltip[]
  }
  TooltipReplacements: Record<string, ReplacementValue>
  DisplayTags: string[]
}

export interface DropSource {
  id: string
  title: string
  href: string
  tier: string
  available: boolean
}

export type ItemSize = 'Small' | 'Medium' | 'Large'

export interface BazaarCard {
  Id: string
  Type: 'Item' | 'Skill' | 'Monster'
  Title: TooltipText
  Description: string | null
  Size: ItemSize
  BaseTier: TierName
  Tiers: Partial<Record<TierName, TierData>>
  BaseAttributes: Record<string, number>
  Tooltips: Tooltip[]
  TooltipReplacements: Record<string, ReplacementValue>
  DisplayTags: string[]
  HiddenTags: string[]
  Tags: string[]
  Heroes: string[]
  Enchantments: Record<string, Enchantment>
  Art: string
  ArtLarge: string
  ArtBlur: string
  Uri: string
  DroppedBy: DropSource[] | null
  Quests: unknown
  Transform: unknown
  _originalTitleText: string
}

export interface MonsterBoardEntry {
  baseId: string
  title: string
  size: ItemSize
  tierOverride: TierName
  type: 'Item' | 'Skill'
  url: string
  art: string
  artBlur: string
}

export interface MonsterMetadata {
  available: string
  day: number | null
  health: number
  board: MonsterBoardEntry[]
}

export interface Monster {
  Id: string
  Type: 'CombatEncounter'
  Title: TooltipText
  Description: string | null
  Size: ItemSize
  Tags: string[]
  DisplayTags: string[]
  HiddenTags: string[]
  Heroes: string[]
  Uri: string
  MonsterMetadata: MonsterMetadata
}

export interface CardCache {
  items: BazaarCard[]
  skills: BazaarCard[]
  monsters: Monster[]
  fetchedAt: string
}
