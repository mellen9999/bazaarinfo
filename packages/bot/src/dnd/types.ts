// D&D 5e class system
export const ALL_CLASSES = ['Barbarian', 'Fighter', 'Paladin', 'Rogue', 'Wizard', 'Cleric', 'Sorcerer', 'Monk', 'Warlock'] as const
export type DndClass = typeof ALL_CLASSES[number]

export type EncounterType = 'combat' | 'shop' | 'event' | 'boss'

export interface AbilityScores {
  str: number; dex: number; con: number; int: number; wis: number; cha: number
}

export function getModifier(score: number): number {
  return Math.floor((score - 10) / 2)
}

export function getProfBonus(level: number): number {
  return Math.floor((level - 1) / 4) + 2
}

export const CLASS_BASE_STATS: Record<string, AbilityScores> = {
  Barbarian: { str: 16, dex: 14, con: 15, int: 8,  wis: 10, cha: 8  },
  Fighter:   { str: 16, dex: 13, con: 15, int: 10, wis: 12, cha: 10 },
  Paladin:   { str: 15, dex: 10, con: 14, int: 10, wis: 13, cha: 16 },
  Rogue:     { str: 10, dex: 17, con: 13, int: 13, wis: 14, cha: 12 },
  Wizard:    { str: 8,  dex: 14, con: 12, int: 17, wis: 13, cha: 10 },
  Cleric:    { str: 14, dex: 10, con: 15, int: 12, wis: 16, cha: 13 },
  Sorcerer:  { str: 8,  dex: 14, con: 13, int: 12, wis: 10, cha: 17 },
  Monk:      { str: 13, dex: 16, con: 14, int: 10, wis: 16, cha: 8  },
  Warlock:   { str: 8,  dex: 14, con: 14, int: 13, wis: 12, cha: 16 },
}

export const CLASS_HIT_DIE: Record<string, number> = {
  Barbarian: 12, Fighter: 10, Paladin: 10, Rogue: 8,
  Wizard: 6, Cleric: 8, Sorcerer: 6, Monk: 8, Warlock: 8,
}

export const CLASS_ATK_STAT: Record<string, keyof AbilityScores> = {
  Barbarian: 'str', Fighter: 'str', Paladin: 'str', Rogue: 'dex',
  Wizard: 'int', Cleric: 'wis', Sorcerer: 'cha', Monk: 'dex', Warlock: 'cha',
}

export const CLASS_WEAPON: Record<string, { name: string; die: number; count: number }> = {
  Barbarian: { name: 'Greataxe',       die: 12, count: 1 },
  Fighter:   { name: 'Longsword',      die: 8,  count: 1 },
  Paladin:   { name: 'Longsword',      die: 8,  count: 1 },
  Rogue:     { name: 'Rapier',         die: 8,  count: 1 },
  Wizard:    { name: 'Fire Bolt',      die: 10, count: 1 },
  Cleric:    { name: 'Sacred Flame',   die: 8,  count: 1 },
  Sorcerer:  { name: 'Chaos Bolt',     die: 8,  count: 2 },
  Monk:      { name: 'Unarmed Strike', die: 6,  count: 1 },
  Warlock:   { name: 'Eldritch Blast', die: 10, count: 1 },
}

export const CLASS_SAVE_PROFS: Record<string, [keyof AbilityScores, keyof AbilityScores]> = {
  Barbarian: ['str', 'con'], Fighter:  ['str', 'con'],
  Paladin:   ['wis', 'cha'], Rogue:    ['dex', 'int'],
  Wizard:    ['int', 'wis'], Cleric:   ['wis', 'cha'],
  Sorcerer:  ['con', 'cha'], Monk:     ['str', 'dex'],
  Warlock:   ['wis', 'cha'],
}

export const CLASS_SPELL_SLOTS_LV1: Record<string, number> = {
  Barbarian: 0, Fighter: 0, Paladin: 2, Rogue: 0,
  Wizard: 2, Cleric: 2, Sorcerer: 2, Monk: 0, Warlock: 1,
}

export function calcMaxSpellSlots(cls: string, level: number): number {
  const base = CLASS_SPELL_SLOTS_LV1[cls] ?? 0
  if (base === 0) return 0
  if (cls === 'Warlock') return Math.min(4, 1 + Math.floor(level / 3))
  return Math.min(10, base + Math.floor((level - 1) / 2))
}

export function sneakAttackDice(level: number): number {
  return Math.ceil(level / 2)
}

export function calcMaxHp(cls: string, level: number, conScore: number): number {
  const die = CLASS_HIT_DIE[cls] ?? 8
  const conMod = Math.floor((conScore - 10) / 2)
  if (level === 1) return die + conMod
  return die + conMod + (level - 1) * (Math.floor(die / 2) + 1 + conMod)
}

// AC formula families — every class (builtin or custom) maps to exactly one.
export type AcArchetype = 'unarmored' | 'mail' | 'plate' | 'light' | 'mage' | 'monk' | 'default'

export const BUILTIN_AC_ARCHETYPE: Record<string, AcArchetype> = {
  Barbarian: 'unarmored', Fighter: 'mail', Paladin: 'plate', Rogue: 'light',
  Wizard: 'mage', Cleric: 'mail', Sorcerer: 'mage', Monk: 'monk', Warlock: 'light',
}

// single source of truth for AC math — used by builtins and custom classes alike
export function acFromArchetype(archetype: AcArchetype, stats: AbilityScores, itemAcBonus = 0): number {
  const dex = Math.floor((stats.dex - 10) / 2)
  const con = Math.floor((stats.con - 10) / 2)
  const wis = Math.floor((stats.wis - 10) / 2)
  const base = (() => {
    switch (archetype) {
      case 'unarmored': return 10 + dex + con
      case 'mail':      return 16
      case 'plate':     return 18
      case 'light':     return 11 + Math.min(dex, 2)
      case 'mage':      return 13 + Math.min(dex, 2)
      case 'monk':      return 10 + dex + wis
      default:          return 10 + dex
    }
  })()
  return base + itemAcBonus
}

export function getCharAC(cls: string, stats: AbilityScores, itemAcBonus = 0): number {
  return acFromArchetype(BUILTIN_AC_ARCHETYPE[cls] ?? 'default', stats, itemAcBonus)
}

export const CLASS_DESC: Record<string, string> = {
  Barbarian: 'd12 HP, Rage (+2dmg + resistance), Greataxe 1d12',
  Fighter:   'd10 HP, Action Surge (double attack), Longsword 1d8',
  Paladin:   'd10 HP, Divine Smite (slot→+2d8 radiant on hit), Longsword 1d8',
  Rogue:     'd8 HP, Sneak Attack (auto +Xd6), Rapier 1d8 (finesse)',
  Wizard:    'd6 HP, Fireball (8d6 AoE fire), Fire Bolt cantrip 1d10',
  Cleric:    'd8 HP, Healing Word (bonus heal ally), Sacred Flame 1d8 radiant',
  Sorcerer:  'd6 HP, Wild Magic (2d8 chaos + surge), Chaos Bolt 2d8',
  Monk:      'd8 HP, Flurry of Blows (ki→2 extra strikes), Unarmed 1d6',
  Warlock:   'd8 HP, Hex+Eldritch Blast (curse+1d10 force), 1/short rest',
}

export interface Character {
  username: string
  channel: string
  class: string
  level: number
  xp: number
  hp: number
  maxHp: number
  gold: number
  inventory: string[]
  stats: AbilityScores
  spellSlots: number
  maxSpellSlots: number
  hitDice: number
  maxHitDice: number
  kiPoints: number
  maxKiPoints: number
  rageCharges: number
  rageTurnsLeft: number
  actionSurgeUsed: boolean
  isDying: boolean
  deathSuccesses: number
  deathFailures: number
  statusEffects: string[]
  deaths: number
  totalKills: number
  defending: boolean
  lastActionAt: number
  respawnAt: number | null
  prestige: number
  achievements: string[]
  boons: string[]              // chosen roguelike perks
  pendingBoon: string[]        // current level-up offer (3 ids; empty = none)
  killStreak: number           // consecutive kills without dying (spectacle)
}

export interface Enemy {
  name: string
  hp: number
  maxHp: number
  ac: number
  hitBonus: number
  damageDie: number
  damageCount: number
  damageMod: number
  multiattack: number
  isBoss: boolean
  cr: number
  xpValue: number
  statusEffect?: string
  statusRoundsLeft?: number
  specialAbility?: string
  enraged?: boolean        // boss phase-2 (one-time, triggers at half HP)
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
  shopInventory: ShopItem[]
  veganShrineVisited: boolean
  longRestCounter: number
}

export interface ShopItem {
  name: string
  price: number
}

export interface CombatResult {
  attacker: string
  targetEnemy: string
  enemyMaxHp: number
  d20Roll: number
  attackTotal: number
  targetAC: number
  hit: boolean
  crit: boolean
  fumble: boolean
  damage: number
  damageDiceStr: string
  weaponName: string
  statusApplied?: string
  enemyKilled: boolean
  enemyHpAfter: number
  sneakAttackDice?: number
  actuallySick?: boolean
  comboBonus?: number
  lifesteal?: number
}

export interface EnemyAttackResult {
  enemyName: string
  targetName: string
  d20Roll: number
  attackTotal: number
  targetAC: number
  hit: boolean
  crit: boolean
  damage: number
  damageDiceStr: string
  targetHpAfter: number
  targetMaxHp: number
  targetDied: boolean
}
