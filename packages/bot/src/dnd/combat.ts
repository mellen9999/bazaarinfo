import * as store from '../store'
import {
  getModifier, getProfBonus, CLASS_ATK_STAT, CLASS_WEAPON, sneakAttackDice, getCharAC,
  type Character, type Enemy, type AbilityScores,
} from './types'

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

// Roll a d20 seeded on sequence — deterministic per combat action
export function d20Roll(seed: number): number {
  const rng = mulberry32(seed >>> 0)
  rng(); rng() // warm up
  return Math.floor(rng() * 20) + 1
}

// Roll Nd(die) seeded on a secondary seed
function rollDice(count: number, die: number, seed: number): number[] {
  const rng = mulberry32((seed + 1337) >>> 0)
  rng(); rng()
  return Array.from({ length: count }, () => Math.floor(rng() * die) + 1)
}

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
  onHitStatus: string | null
}

// D&D named item bonuses take priority; fall back to Bazaar card lookup for legacy items
export function getItemBonus(itemName: string): ItemBonus {
  const n = itemName.toLowerCase()
  if (n.startsWith('+2')) return { damage: 2, armor: 0, onUseHeal: 0, onHitStatus: null }
  if (n.startsWith('+1')) return { damage: 1, armor: 0, onUseHeal: 0, onHitStatus: null }
  if (n === 'ring of protection' || n === 'cloak of protection' || n === 'cloak of displacement') return { damage: 0, armor: 1, onUseHeal: 0, onHitStatus: null }
  if (n === 'scroll of protection') return { damage: 0, armor: 2, onUseHeal: 0, onHitStatus: null }
  if (n === 'potion of healing') return { damage: 0, armor: 0, onUseHeal: 8, onHitStatus: null }
  if (n === 'potion of greater healing') return { damage: 0, armor: 0, onUseHeal: 18, onHitStatus: null }
  if (n === 'potion of superior healing') return { damage: 0, armor: 0, onUseHeal: 38, onHitStatus: null }

  // legacy Bazaar card lookup for old inventory items
  const card = store.findCard(itemName)
  if (!card) return { damage: 0, armor: 0, onUseHeal: 0, onHitStatus: null }
  const tags = (card.Tags ?? []).map((t: string) => t.toLowerCase())
  let damage = 0, armor = 0, onUseHeal = 0
  let onHitStatus: string | null = null
  if (tags.some((t: string) => t === 'weapon')) damage = TIER_DMG[card.BaseTier] ?? 3
  if (tags.some((t: string) => t === 'armor' || t === 'shield')) armor = 5
  if (tags.some((t: string) => t === 'heal' || t === 'regeneration')) onUseHeal = 30
  if (!onHitStatus && tags.some((t: string) => t === 'poison')) onHitStatus = 'poisoned'
  if (!onHitStatus && tags.some((t: string) => t === 'freeze' || t === 'slow')) onHitStatus = 'restrained'
  if (!onHitStatus && tags.some((t: string) => t === 'burn' || t === 'fire')) onHitStatus = 'burning'
  return { damage, armor, onUseHeal, onHitStatus }
}

function inventoryAcBonus(inventory: string[]): number {
  return inventory.reduce((sum, item) => sum + getItemBonus(item).armor, 0)
}

function inventoryDamageBonus(inventory: string[]): number {
  return inventory.reduce((sum, item) => sum + getItemBonus(item).damage, 0)
}

export interface AttackOutcome {
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
  sneakAttackDice?: number
  actuallySick?: boolean
}

export function resolvePlayerAttack(
  char: Character,
  enemy: Enemy,
  sequence: number,
  hasAdvantage: boolean,
  hasDisadvantage: boolean,
  damageMult = 1.0,
): AttackOutcome {
  const atkStat = CLASS_ATK_STAT[char.class] ?? 'str'
  const atkMod = getModifier(char.stats[atkStat as keyof AbilityScores] ?? 10)
  const prof = getProfBonus(char.level)
  const weapon = CLASS_WEAPON[char.class] ?? { name: 'Weapon', die: 8, count: 1 }
  const acBonus = inventoryAcBonus(char.inventory)
  const charAC = getCharAC(char.class, char.stats, acBonus)

  // roll d20 (advantage = roll twice take higher, disadvantage = take lower)
  let roll = d20Roll(sequence)
  if (hasAdvantage && !hasDisadvantage) {
    const roll2 = d20Roll(sequence + 50000)
    roll = Math.max(roll, roll2)
  } else if (hasDisadvantage && !hasAdvantage) {
    const roll2 = d20Roll(sequence + 50000)
    roll = Math.min(roll, roll2)
  }

  const isCrit = roll === 20
  const isFumble = roll === 1
  const attackTotal = roll + atkMod + prof
  const hit = isCrit || (!isFumble && attackTotal >= enemy.ac)

  if (!hit) {
    return {
      d20Roll: roll, attackTotal, targetAC: enemy.ac,
      hit: false, crit: false, fumble: isFumble,
      damage: 0, damageDiceStr: '',
      weaponName: weapon.name,
    }
  }

  // damage roll: on crit, double the dice
  const diceCount = isCrit ? weapon.count * 2 : weapon.count
  const rolls = rollDice(diceCount, weapon.die, sequence)
  const dmgBonus = inventoryDamageBonus(char.inventory)
  const rageDmg = char.class === 'Barbarian' && char.rageTurnsLeft > 0 ? 2 : 0
  let totalDmg = rolls.reduce((s, r) => s + r, 0) + atkMod + dmgBonus + rageDmg
  let diceStr = `${diceCount}d${weapon.die}+${atkMod + dmgBonus + rageDmg}`

  // Rogue: Sneak Attack (if advantage — needs an ally in melee or hidden)
  let saCount = 0
  if (char.class === 'Rogue' && hasAdvantage) {
    saCount = sneakAttackDice(char.level)
    const saDice = isCrit ? saCount * 2 : saCount
    const saRolls = rollDice(saDice, 6, sequence + 99999)
    const saDmg = saRolls.reduce((s, r) => s + r, 0)
    totalDmg += saDmg
    diceStr += `+${saDice}d6(sneak)`
  }

  totalDmg = Math.max(1, Math.floor(totalDmg * damageMult))

  // actuallySick: natural 20 kills a boss
  const actuallySick = isCrit && enemy.isBoss && totalDmg >= enemy.hp

  // status application on hit
  let statusApplied: string | undefined
  if (char.class === 'Wizard') statusApplied = 'burning'
  else if (char.class === 'Rogue' && roll >= 15) statusApplied = 'poisoned'
  else {
    for (const item of char.inventory) {
      const bonus = getItemBonus(item)
      if (bonus.onHitStatus && roll >= 15) { statusApplied = bonus.onHitStatus; break }
    }
  }

  return {
    d20Roll: roll, attackTotal, targetAC: enemy.ac,
    hit: true, crit: isCrit, fumble: false,
    damage: totalDmg, damageDiceStr: diceStr,
    weaponName: weapon.name,
    statusApplied,
    sneakAttackDice: saCount > 0 ? saCount : undefined,
    actuallySick: actuallySick || undefined,
  }
}

export interface EnemyAttackResult {
  d20Roll: number
  attackTotal: number
  targetAC: number
  hit: boolean
  crit: boolean
  damage: number
  damageDiceStr: string
}

export function resolveEnemyAttack(
  enemy: Enemy,
  target: Character,
  sequence: number,
  damageScale = 1.0,
): EnemyAttackResult {
  const acBonus = inventoryAcBonus(target.inventory)
  const targetAC = getCharAC(target.class, target.stats, acBonus) + (target.defending ? 2 : 0)

  const roll = d20Roll(sequence + 500)
  const isCrit = roll === 20
  const isFumble = roll === 1
  const attackTotal = roll + enemy.hitBonus

  if (isFumble || (!isCrit && attackTotal < targetAC)) {
    return { d20Roll: roll, attackTotal, targetAC, hit: false, crit: false, damage: 0, damageDiceStr: '' }
  }

  const diceCount = isCrit ? enemy.damageCount * 2 : enemy.damageCount
  const rolls = rollDice(diceCount, enemy.damageDie, sequence + 500)
  let dmg = Math.max(1, Math.floor((rolls.reduce((s, r) => s + r, 0) + enemy.damageMod) * damageScale))
  const diceStr = `${diceCount}d${enemy.damageDie}+${enemy.damageMod}`
  return { d20Roll: roll, attackTotal, targetAC, hit: true, crit: isCrit, damage: dmg, damageDiceStr: diceStr }
}

// status tick damage for players (array of effects)
export function statusTickDamage(effects: string[]): number {
  let dmg = 0
  const poisonCount = effects.filter((e) => e === 'poisoned' || e === 'poison').length
  if (poisonCount > 0) dmg += poisonCount * 6
  if (effects.includes('burning') || effects.includes('burn')) dmg += 8
  return dmg
}

// single-effect tick for enemies
export function singleStatusTick(effect: string): number {
  if (effect === 'burning' || effect === 'burn') return 8
  if (effect === 'poisoned' || effect === 'poison') return 6
  return 0
}

const MEAT_KEYWORDS = ['glutton', 'feast', 'flesh', 'meat', 'carnivore', 'blood', 'bone', 'ration']

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
