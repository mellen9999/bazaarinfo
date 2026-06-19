import * as store from '../store'
import type { DndClass, StatusEffect, Character, Enemy } from './types'

// mulberry32 — deterministic seeded RNG (same impl as raid/sim.ts)
function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s |= 0; s = s + 0x6D2B79F5 | 0
    let t = Math.imul(s ^ s >>> 15, 1 | s)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

const NL_PENALTY = 0.05

// Two rolls per call: hit roll and secondary (status/variance) roll
export function diceRolls(sequence: number, nlLifted: boolean): { hit: number; secondary: number } {
  const rng = mulberry32(((sequence * 2654435761) >>> 0))
  rng(); rng() // warm up
  const raw1 = rng()
  const raw2 = rng()
  const adj = nlLifted ? 0 : NL_PENALTY
  return {
    hit: Math.max(0, Math.min(1, raw1 - adj)),
    secondary: Math.max(0, Math.min(1, raw2)),
  }
}

export const CLASS_BASE_DMG: Record<DndClass, number> = {
  Merchant: 8, Rogue: 14, Tinkerer: 11, Brawler: 20, Pyromancer: 16, Veteran: 13,
}

export const CLASS_BASE_HP: Record<DndClass, number> = {
  Merchant: 80, Rogue: 70, Tinkerer: 75, Brawler: 120, Pyromancer: 65, Veteran: 90,
}

export const CLASS_XP_PER_KILL: Record<DndClass, number> = {
  Merchant: 10, Rogue: 12, Tinkerer: 11, Brawler: 8, Pyromancer: 13, Veteran: 10,
}

export const HP_PER_LEVEL = 10

const TIER_DMG: Record<string, number> = {
  Bronze: 3, Silver: 6, Gold: 10, Diamond: 15, Legendary: 22,
}

const TIER_PRICE: Record<string, number> = {
  Bronze: 15, Silver: 30, Gold: 55, Diamond: 90, Legendary: 150,
}

export function tierPrice(tier: string): number {
  return TIER_PRICE[tier] ?? 30
}

export interface ItemBonus {
  damage: number
  armor: number
  onUseHeal: number
  onHitStatus: StatusEffect | null
}

export function getItemBonus(itemName: string): ItemBonus {
  const card = store.findCard(itemName)
  if (!card) return { damage: 0, armor: 0, onUseHeal: 0, onHitStatus: null }

  const tags = (card.Tags ?? []).map((t: string) => t.toLowerCase())
  let damage = 0
  let armor = 0
  let onUseHeal = 0
  let onHitStatus: StatusEffect | null = null

  if (tags.some((t: string) => t === 'weapon')) {
    damage += TIER_DMG[card.BaseTier] ?? 3
  }
  if (tags.some((t: string) => t === 'armor' || t === 'shield')) {
    armor += 5
  }
  if (tags.some((t: string) => t === 'heal' || t === 'regeneration')) {
    onUseHeal = 30
  }

  if (!onHitStatus && tags.some((t: string) => t === 'poison')) onHitStatus = 'poison'
  if (!onHitStatus && tags.some((t: string) => t === 'freeze' || t === 'slow')) onHitStatus = 'freeze'
  if (!onHitStatus && tags.some((t: string) => t === 'burn' || t === 'fire')) onHitStatus = 'burn'
  if (!onHitStatus && tags.some((t: string) => t === 'haste')) onHitStatus = 'haste'

  return { damage, armor, onUseHeal, onHitStatus }
}

export function playerTotalDamage(char: Character): number {
  let dmg = CLASS_BASE_DMG[char.class] + (char.level - 1) * 2
  for (const item of char.inventory) {
    dmg += getItemBonus(item).damage
  }
  if (char.statusEffects.includes('blessed')) dmg = Math.floor(dmg * 1.2)
  return dmg
}

export function playerArmor(char: Character): number {
  let armor = 0
  for (const item of char.inventory) {
    armor += getItemBonus(item).armor
  }
  if (char.defending) armor += 10
  return armor
}

export interface AttackOutcome {
  damage: number
  crit: boolean
  miss: boolean
  krippCursed: boolean
  actuallySick: boolean
  statusApplied: StatusEffect | null
}

export function resolvePlayerAttack(
  char: Character,
  enemy: Enemy,
  sequence: number,
  nlLifted: boolean,
  spellActive?: 'shadowstrike' | 'charge' | 'overclock' | 'inferno' | 'liquidate' | 'adapt',
  damageMult = 1,
): AttackOutcome {
  const { hit, secondary } = diceRolls(sequence, nlLifted)

  const krippCursed = hit < 0.03
  const miss = hit < 0.05 && !spellActive
  const crit = hit > 0.90 || spellActive === 'shadowstrike' || spellActive === 'charge'

  let baseDmg = Math.floor(playerTotalDamage(char) * damageMult)
  if (spellActive === 'overclock') baseDmg = Math.floor(baseDmg * 1.5)
  if (spellActive === 'charge') baseDmg = baseDmg * 3

  let damage = miss || krippCursed ? 0 : (crit ? baseDmg * 2 : baseDmg)

  // actuallySick: crit on boss kill shot
  const actuallySick = crit && enemy.isBoss && !miss && !krippCursed && (enemy.hp - damage) <= 0

  // status application
  let statusApplied: StatusEffect | null = null
  if (!miss && !krippCursed) {
    if (char.class === 'Pyromancer') {
      statusApplied = 'burn'
    } else if (char.class === 'Rogue' && secondary > 0.4) {
      statusApplied = 'poison'
    } else if (spellActive === 'shadowstrike') {
      statusApplied = 'poison'
    } else {
      // check inventory items for status
      for (const item of char.inventory) {
        const bonus = getItemBonus(item)
        if (bonus.onHitStatus && secondary > 0.5) {
          statusApplied = bonus.onHitStatus
          break
        }
      }
    }
  }

  return { damage, crit, miss, krippCursed, actuallySick, statusApplied }
}

export function resolveEnemyAttack(
  enemy: Enemy,
  target: Character,
  floor: number,
  sequence: number,
  nlLifted: boolean,
): { damage: number; miss: boolean } {
  if (enemy.stunned) return { damage: 0, miss: true }

  const { hit } = diceRolls(sequence + 500, nlLifted)
  if (hit < 0.05) return { damage: 0, miss: true }

  let baseDmg = 8 + floor * 3
  for (const itemName of enemy.items) {
    const card = store.findCard(itemName)
    if (card) {
      const tags = (card.Tags ?? []).map((t: string) => t.toLowerCase())
      if (tags.includes('weapon')) baseDmg += 5
    }
  }
  if (enemy.isBoss) baseDmg = Math.floor(baseDmg * 1.5)

  const armor = playerArmor(target)
  const damage = Math.max(1, baseDmg - armor)
  return { damage, miss: false }
}

export function statusTickDamage(effects: StatusEffect[]): number {
  let dmg = 0
  const poisonCount = effects.filter((e) => e === 'poison').length
  if (poisonCount > 0) dmg += poisonCount * 6
  if (effects.includes('burn')) dmg += 8
  return dmg
}

const MEAT_KEYWORDS = ['glutton', 'feast', 'flesh', 'meat', 'carnivore', 'blood', 'bone']

export function hasMeatItems(inventory: string[]): boolean {
  return inventory.some((item) => {
    const lower = item.toLowerCase()
    if (MEAT_KEYWORDS.some((k) => lower.includes(k))) return true
    const card = store.findCard(item)
    if (!card) return false
    const tags = (card.Tags ?? []).map((t: string) => t.toLowerCase())
    return tags.includes('food') || tags.includes('feast')
  })
}
