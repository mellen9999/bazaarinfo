export type DndClass = 'Merchant' | 'Rogue' | 'Tinkerer' | 'Brawler' | 'Pyromancer' | 'Veteran'
export type StatusEffect = 'burn' | 'freeze' | 'poison' | 'haste' | 'slow' | 'shield' | 'blessed' | 'cursed'
export type EncounterType = 'combat' | 'shop' | 'event' | 'boss'

export const ALL_CLASSES: DndClass[] = ['Merchant', 'Rogue', 'Tinkerer', 'Brawler', 'Pyromancer', 'Veteran']

export const CLASS_DESC: Record<DndClass, string> = {
  Merchant: 'passive gold/turn, shop discounts',
  Rogue: 'poison stacks, steal gold on kill',
  Tinkerer: 'item synergy bonuses, gadget abilities',
  Brawler: 'high HP, charge for 3x damage',
  Pyromancer: 'burn on every hit, AoE inferno',
  Veteran: 'balanced, equips any item class',
}

export interface Character {
  username: string
  channel: string
  class: DndClass
  level: number
  xp: number
  hp: number
  maxHp: number
  gold: number
  inventory: string[]
  statusEffects: StatusEffect[]
  deaths: number
  totalKills: number
  spellReady: boolean
  defending: boolean
  lastActionAt: number
  respawnAt: number | null
  prestige: number
  achievements: string[]
}

export interface Enemy {
  name: string
  hp: number
  maxHp: number
  items: string[]
  statusEffects: StatusEffect[]
  isBoss: boolean
  stunned: boolean
}

export interface WorldState {
  channel: string
  floor: number
  actionSequence: number
  encounterType: EncounterType
  enemies: Enemy[]
  floorCleared: boolean
  scene: string
  season: number
  enabled: boolean
  nlLifted: boolean
  shopInventory: ShopItem[]
  veganShrineVisited: boolean
}

export interface ShopItem {
  name: string
  price: number
}

export interface CombatResult {
  attacker: string
  targetEnemy: string
  damage: number
  crit: boolean
  miss: boolean
  krippCursed: boolean
  actuallySick: boolean
  statusApplied: StatusEffect | null
  enemyKilled: boolean
  enemyHpAfter: number
}
