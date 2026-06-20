import type { Enemy, EncounterType, ShopItem } from './types'
import * as store from '../store'
import type { BazaarCard } from '@bazaarinfo/shared'

// --- Bazaar reskin: real Bazaar monsters/items dress the balanced D&D mechanics.
// All helpers fall back gracefully (return null/[]) when the item cache is empty,
// so the game runs identically on generic D&D content if Bazaar data is missing.
const MAX_DAY = 10

// dungeon floor -> Bazaar "day" (the game's PvE difficulty ramp), clamped
function bazaarMonsterPool(floor: number): { Title: string; health: number }[] {
  const day = Math.min(MAX_DAY, Math.max(1, floor))
  let pool = store.monstersByDay(day)
  for (let d = day + 1; d <= MAX_DAY && pool.length === 0; d++) pool = store.monstersByDay(d)
  for (let d = day - 1; d >= 1 && pool.length === 0; d--) pool = store.monstersByDay(d)
  return pool.map((m) => ({ Title: m.Title, health: m.MonsterMetadata?.health ?? 0 }))
}

// pick `count` distinct real Bazaar monster names for a floor (boss = tankiest)
function bazaarMonsterNames(floor: number, count: number, rng: () => number, boss: boolean): string[] {
  const pool = bazaarMonsterPool(floor)
  if (pool.length === 0) return []
  if (boss) {
    const tankiest = [...pool].sort((a, b) => b.health - a.health)[0]
    return [tankiest.Title]
  }
  const names: string[] = []
  const used = new Set<string>()
  let guard = 0
  while (names.length < count && guard++ < 40) {
    const pick = pool[Math.floor(rng() * pool.length)]
    if (used.has(pick.Title)) continue
    used.add(pick.Title)
    names.push(pick.Title)
  }
  return names
}

// items whose tags give getItemBonus something real (weapon/armor/heal/status)
const COMBAT_TAGS = ['weapon', 'armor', 'shield', 'heal', 'regeneration', 'poison', 'freeze', 'slow', 'burn', 'fire']
function isCombatItem(c: BazaarCard): boolean {
  const tags = (c.Tags ?? []).map((t) => t.toLowerCase())
  return COMBAT_TAGS.some((t) => tags.includes(t))
}

// floor -> which Bazaar tiers can drop
function tiersForFloor(floor: number): string[] {
  if (floor <= 2) return ['Bronze']
  if (floor <= 4) return ['Bronze', 'Silver']
  if (floor <= 6) return ['Silver', 'Gold']
  if (floor <= 8) return ['Gold', 'Diamond']
  return ['Diamond', 'Legendary']
}

function bazaarLootPool(floor: number): string[] {
  const tiers = tiersForFloor(floor)
  return store.getItems()
    .filter((c) => c.Type === 'Item' && tiers.includes(c.BaseTier) && isCombatItem(c))
    .map((c) => c.Title)
}

// mulberry32 — deterministic seeded RNG
function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s |= 0; s = s + 0x6D2B79F5 | 0
    let t = Math.imul(s ^ s >>> 15, 1 | s)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

function rollHp(rng: () => number, count: number, die: number, mod: number): number {
  let total = 0
  for (let i = 0; i < count; i++) total += Math.floor(rng() * die) + 1
  return Math.max(1, total + mod)
}

export function getFloorType(floor: number): EncounterType {
  if (floor === 3 || floor === 5) return 'shop'
  if (floor === 6 || floor === 10) return 'boss'
  if (floor === 9) return 'event'
  return 'combat'
}

// D&D 5e monster templates by floor tier
// hpDie/hpCount/hpMod: hit dice for HP. cr: challenge rating. xpValue: standard D&D 5e XP.
interface MonsterTemplate {
  name: string
  ac: number
  hpDie: number
  hpCount: number
  hpMod: number
  hitBonus: number
  damageDie: number
  damageCount: number
  damageMod: number
  multiattack: number
  cr: number
  xpValue: number
  specialAbility?: string
}

const FLOOR_MONSTERS: Record<number, MonsterTemplate[]> = {
  1: [
    { name: 'Goblin',    ac: 15, hpDie: 6, hpCount: 2, hpMod: 2,  hitBonus: 4, damageDie: 6, damageCount: 1, damageMod: 2, multiattack: 1, cr: 0.25, xpValue: 50 },
    { name: 'Kobold',    ac: 12, hpDie: 6, hpCount: 2, hpMod: 0,  hitBonus: 4, damageDie: 4, damageCount: 1, damageMod: 2, multiattack: 1, cr: 0.125, xpValue: 25 },
    { name: 'Giant Rat', ac: 12, hpDie: 6, hpCount: 1, hpMod: 0,  hitBonus: 4, damageDie: 4, damageCount: 1, damageMod: 0, multiattack: 1, cr: 0.125, xpValue: 25 },
  ],
  2: [
    { name: 'Hobgoblin', ac: 18, hpDie: 8, hpCount: 2, hpMod: 2,  hitBonus: 3, damageDie: 8, damageCount: 1, damageMod: 1, multiattack: 1, cr: 0.5, xpValue: 100 },
    { name: 'Orc',       ac: 13, hpDie: 8, hpCount: 2, hpMod: 6,  hitBonus: 5, damageDie: 12, damageCount: 1, damageMod: 3, multiattack: 1, cr: 0.5, xpValue: 100 },
    { name: 'Bugbear',   ac: 16, hpDie: 8, hpCount: 5, hpMod: 5,  hitBonus: 4, damageDie: 8, damageCount: 2, damageMod: 2, multiattack: 1, cr: 1, xpValue: 200 },
  ],
  4: [
    { name: 'Skeleton',  ac: 13, hpDie: 8, hpCount: 1, hpMod: 4,  hitBonus: 4, damageDie: 6, damageCount: 1, damageMod: 2, multiattack: 1, cr: 0.25, xpValue: 50 },
    { name: 'Zombie',    ac: 8,  hpDie: 8, hpCount: 3, hpMod: 9,  hitBonus: 3, damageDie: 6, damageCount: 1, damageMod: 1, multiattack: 1, cr: 0.25, xpValue: 50, specialAbility: 'fortitude' },
    { name: 'Ghoul',     ac: 13, hpDie: 8, hpCount: 5, hpMod: 5,  hitBonus: 2, damageDie: 6, damageCount: 2, damageMod: 0, multiattack: 2, cr: 1, xpValue: 200, specialAbility: 'paralyze' },
  ],
  6: [ // boss
    { name: 'Fire Giant', ac: 18, hpDie: 12, hpCount: 13, hpMod: 65, hitBonus: 11, damageDie: 6, damageCount: 6, damageMod: 7, multiattack: 2, cr: 9, xpValue: 5000, specialAbility: 'fire_immunity' },
  ],
  7: [
    { name: 'Drow Warrior',  ac: 15, hpDie: 8, hpCount: 3, hpMod: 3,  hitBonus: 4, damageDie: 6, damageCount: 2, damageMod: 2, multiattack: 2, cr: 1, xpValue: 200 },
    { name: 'Gnoll',         ac: 15, hpDie: 8, hpCount: 5, hpMod: 5,  hitBonus: 4, damageDie: 6, damageCount: 1, damageMod: 2, multiattack: 1, cr: 0.5, xpValue: 100 },
    { name: 'Troll',         ac: 15, hpDie: 10, hpCount: 8, hpMod: 16, hitBonus: 6, damageDie: 6, damageCount: 2, damageMod: 4, multiattack: 2, cr: 5, xpValue: 1800, specialAbility: 'regeneration' },
  ],
  8: [
    { name: 'Vampire Spawn', ac: 13, hpDie: 8, hpCount: 11, hpMod: 22, hitBonus: 6, damageDie: 6, damageCount: 2, damageMod: 3, multiattack: 2, cr: 5, xpValue: 1800, specialAbility: 'drain' },
    { name: 'Night Hag',     ac: 17, hpDie: 8, hpCount: 15, hpMod: 45, hitBonus: 7, damageDie: 8, damageCount: 2, damageMod: 4, multiattack: 2, cr: 5, xpValue: 1800, specialAbility: 'nightmare' },
  ],
  10: [ // final boss
    { name: 'Lich', ac: 17, hpDie: 12, hpCount: 18, hpMod: 36, hitBonus: 12, damageDie: 10, damageCount: 4, damageMod: 6, multiattack: 1, cr: 21, xpValue: 33000, specialAbility: 'lair_actions' },
  ],
}

export function generateEnemies(season: number, floor: number): Enemy[] {
  const rng = mulberry32(((season * 1009 + floor * 997) >>> 0))
  const isBossFloor = getFloorType(floor) === 'boss'
  const templates = FLOOR_MONSTERS[floor]

  if (!templates || templates.length === 0) {
    // fallback for unmapped floors
    const hp = 40 + floor * 20
    return [{
      name: `Floor ${floor} Creature`,
      hp, maxHp: hp,
      ac: 10 + floor,
      hitBonus: 2 + floor, damageDie: 6, damageCount: 1, damageMod: floor,
      multiattack: 1, isBoss: isBossFloor, cr: floor / 2, xpValue: floor * 100,
    }]
  }

  if (isBossFloor) {
    const t = templates[Math.floor(rng() * templates.length)]
    const hp = rollHp(rng, t.hpCount, t.hpDie, t.hpMod)
    const bzName = bazaarMonsterNames(floor, 1, rng, true)[0]
    return [{
      name: bzName ?? t.name, hp, maxHp: hp,
      ac: t.ac, hitBonus: t.hitBonus,
      damageDie: t.damageDie, damageCount: t.damageCount, damageMod: t.damageMod,
      multiattack: t.multiattack, isBoss: true, cr: t.cr, xpValue: t.xpValue,
      specialAbility: t.specialAbility,
    }]
  }

  // combat floors: pick 2 enemies, no duplicate special abilities (prevents Troll+Troll etc.)
  const enemies: Enemy[] = []
  const usedSpecials = new Set<string>()
  const bzNames = bazaarMonsterNames(floor, 2, rng, false)  // real Bazaar skin (empty = generic)
  for (let i = 0; i < 2; i++) {
    let t = templates[Math.floor(rng() * templates.length)]
    // retry once to avoid stacking regeneration/fortitude/paralyze
    if (t.specialAbility && usedSpecials.has(t.specialAbility) && templates.length > 1) {
      t = templates[Math.floor(rng() * templates.length)]
    }
    if (t.specialAbility) usedSpecials.add(t.specialAbility)
    const hp = rollHp(rng, t.hpCount, t.hpDie, t.hpMod)
    enemies.push({
      name: bzNames[i] ?? t.name, hp, maxHp: hp,
      ac: t.ac, hitBonus: t.hitBonus,
      damageDie: t.damageDie, damageCount: t.damageCount, damageMod: t.damageMod,
      multiattack: t.multiattack, isBoss: false, cr: t.cr, xpValue: t.xpValue,
      specialAbility: t.specialAbility,
    })
  }
  return enemies
}

// D&D item shop pools by floor tier
const SHOP_POOLS: Record<number, { name: string; price: number }[][]> = {
  1: [
    [ // floor 1
      { name: 'Potion of Healing', price: 50 },
      { name: 'Antitoxin', price: 50 },
      { name: '+1 Weapon', price: 200 },
      { name: 'Cloak of Protection', price: 150 },
    ],
    [ // floor 3
      { name: 'Potion of Healing', price: 50 },
      { name: 'Potion of Greater Healing', price: 100 },
      { name: '+1 Weapon', price: 200 },
      { name: 'Ring of Protection', price: 300 },
    ],
    [ // floor 5
      { name: 'Potion of Greater Healing', price: 100 },
      { name: '+1 Weapon', price: 200 },
      { name: 'Ring of Protection', price: 300 },
      { name: 'Scroll of Protection', price: 150 },
    ],
  ],
}

const TIER_SHOP_PRICE: Record<string, number> = {
  Bronze: 50, Silver: 100, Gold: 175, Diamond: 275, Legendary: 400,
}

// Pick 4 shop items, seeded. Stocks real Bazaar gear (priced by tier) plus a
// guaranteed healing potion; falls back to the D&D pool when no Bazaar data.
export function generateShop(season: number, floor: number): ShopItem[] {
  const rng = mulberry32(((season * 2003 + floor * 1009 + 42) >>> 0))
  const bzPool = bazaarLootPool(floor)

  if (bzPool.length === 0) {
    const poolIdx = floor <= 3 ? 0 : floor <= 4 ? 1 : 2
    const pool = SHOP_POOLS[1][Math.min(poolIdx, 2)]
    const shop: ShopItem[] = []
    const seen = new Set<string>()
    let attempts = 0
    while (shop.length < 4 && attempts < 20) {
      attempts++
      const item = pool[Math.floor(rng() * pool.length)]
      if (!item || seen.has(item.name)) continue
      seen.add(item.name)
      shop.push({ name: item.name, price: item.price })
    }
    return shop
  }

  // always offer healing, then fill with Bazaar gear
  const shop: ShopItem[] = [{ name: floor >= 5 ? 'Potion of Greater Healing' : 'Potion of Healing', price: floor >= 5 ? 100 : 50 }]
  const seen = new Set<string>()
  let attempts = 0
  while (shop.length < 4 && attempts < 30) {
    attempts++
    const name = bzPool[Math.floor(rng() * bzPool.length)]
    if (!name || seen.has(name)) continue
    seen.add(name)
    const card = store.findCard(name)
    const price = TIER_SHOP_PRICE[card?.BaseTier ?? 'Silver'] ?? 100
    shop.push({ name, price })
  }
  return shop
}

export function enemyReward(enemy: Enemy, floor: number): { xp: number; gold: number } {
  const base = enemy.isBoss ? 3 : 1
  return {
    xp: enemy.xpValue > 0 ? enemy.xpValue : (10 + floor * 5) * base,
    gold: (5 + floor * 2) * base,
  }
}

// D&D item loot drops
const LOOT_BY_FLOOR: Record<number, string[]> = {
  1: ['Potion of Healing', 'Antitoxin', '+1 Weapon'],
  2: ['Potion of Healing', '+1 Weapon', 'Cloak of Protection'],
  4: ['Potion of Greater Healing', '+1 Weapon', 'Ring of Protection'],
  6: ['+2 Weapon', 'Ring of Protection', 'Potion of Superior Healing', 'Luck Blade'],
  7: ['+2 Weapon', 'Scroll of Protection', 'Potion of Greater Healing'],
  8: ['+2 Weapon', 'Potion of Superior Healing', 'Luck Blade', 'Staff of Power'],
  10: ['Staff of Power', '+2 Weapon', 'Luck Blade'],
}

function lootPoolFor(floor: number): string[] {
  for (const f of [10, 8, 7, 6, 4, 2, 1]) {
    if (floor >= f && LOOT_BY_FLOOR[f]) return LOOT_BY_FLOOR[f]
  }
  return LOOT_BY_FLOOR[1]
}

export function lootDrop(season: number, floor: number, enemyIndex: number): string | null {
  const rng = mulberry32(((season * 7919 + floor * 6271 + enemyIndex * 4133) >>> 0))
  if (rng() > 0.35) return null
  const bz = bazaarLootPool(floor)
  const pool = bz.length > 0 ? bz : lootPoolFor(floor)
  return pool[Math.floor(rng() * pool.length)] ?? null
}

export function bossLootDrop(season: number, floor: number): string | null {
  const rng = mulberry32(((season * 9007 + floor * 5003) >>> 0))
  const bz = bazaarLootPool(floor)
  const pool = bz.length > 0 ? bz : lootPoolFor(floor)
  return pool[Math.floor(rng() * pool.length)] ?? null
}
