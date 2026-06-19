import * as store from '../store'
import type { Enemy, EncounterType, ShopItem } from './types'
import { tierPrice } from './combat'

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

export function getFloorType(floor: number): EncounterType {
  if (floor === 3 || floor === 5) return 'shop'
  if (floor === 6 || floor === 10) return 'boss'
  if (floor === 9) return 'event'
  return 'combat'
}

export function floorToDay(floor: number): number {
  const map = [0, 1, 1, 2, 3, 4, 4, 5, 5, 6, 7]
  return map[Math.min(floor, 10)] ?? 7
}

export function generateEnemies(season: number, floor: number): Enemy[] {
  const rng = mulberry32(((season * 1009 + floor * 997) >>> 0))
  const day = floorToDay(floor)
  const pool = store.monstersByDay(day)
  const isBossFloor = getFloorType(floor) === 'boss'

  if (pool.length === 0) {
    const hp = 60 + floor * 25
    return [{
      name: `Floor ${floor} Creature`,
      hp, maxHp: hp,
      items: [], statusEffects: [],
      isBoss: isBossFloor, stunned: false,
    }]
  }

  if (isBossFloor) {
    const boss = pool[Math.floor(rng() * pool.length)]
    const baseHp = (boss.MonsterMetadata as { health?: number } | undefined)?.health ?? (200 + floor * 30)
    const hp = Math.floor(baseHp * 1.5)
    const boardItems = ((boss.MonsterMetadata as { board?: { title: string }[] } | undefined)?.board ?? []).map((b: { title: string }) => b.title)
    return [{
      name: boss.Title,
      hp, maxHp: hp,
      items: boardItems, statusEffects: [],
      isBoss: true, stunned: false,
    }]
  }

  const count = floor >= 5 ? 2 : 1
  const enemies: Enemy[] = []
  for (let i = 0; i < count; i++) {
    const m = pool[Math.floor(rng() * pool.length)]
    const baseHp = (m.MonsterMetadata as { health?: number } | undefined)?.health ?? (80 + floor * 15)
    const variance = 0.7 + rng() * 0.6
    const hp = Math.max(20, Math.floor(baseHp * variance))
    const boardItems = ((m.MonsterMetadata as { board?: { title: string }[] } | undefined)?.board ?? []).map((b: { title: string }) => b.title)
    enemies.push({
      name: m.Title,
      hp, maxHp: hp,
      items: boardItems, statusEffects: [],
      isBoss: false, stunned: false,
    })
  }
  return enemies
}

const TIER_FOR_FLOOR: Record<number, string> = {
  1: 'Bronze', 2: 'Bronze', 3: 'Bronze',
  4: 'Silver', 5: 'Silver',
  6: 'Gold', 7: 'Gold',
  8: 'Diamond', 9: 'Diamond', 10: 'Diamond',
}

const USEFUL_TAGS = new Set([
  'weapon', 'Weapon', 'armor', 'Armor', 'shield', 'Shield',
  'heal', 'Heal', 'regeneration', 'Regeneration',
  'poison', 'Poison', 'freeze', 'Freeze', 'slow', 'Slow',
  'burn', 'Burn', 'fire', 'Fire', 'haste', 'Haste',
])

export function generateShop(season: number, floor: number): ShopItem[] {
  const rng = mulberry32(((season * 2003 + floor * 1009 + 42) >>> 0))
  const targetTier = TIER_FOR_FLOOR[Math.min(floor, 10)] ?? 'Bronze'

  const all = store.getItems()
  const pool = all.filter((c) =>
    c.BaseTier === targetTier &&
    (c.Tags ?? []).some((t: string) => USEFUL_TAGS.has(t))
  )

  if (pool.length === 0) return []

  const shop: ShopItem[] = []
  const seen = new Set<string>()
  let attempts = 0
  while (shop.length < 4 && attempts < 30) {
    attempts++
    const card = pool[Math.floor(rng() * pool.length)]
    if (!card || seen.has(card.Title)) continue
    seen.add(card.Title)
    shop.push({ name: card.Title, price: tierPrice(card.BaseTier) })
  }
  return shop
}

export function enemyReward(enemy: Enemy, floor: number): { xp: number; gold: number } {
  const base = enemy.isBoss ? 3 : 1
  return {
    xp: (10 + floor * 5) * base,
    gold: (5 + floor * 2) * base,
  }
}

export function lootDrop(season: number, floor: number, enemyIndex: number): string | null {
  const rng = mulberry32(((season * 7919 + floor * 6271 + enemyIndex * 4133) >>> 0))
  // 40% chance of item drop (60% for bosses handled separately)
  if (rng() > 0.40) return null

  const targetTier = TIER_FOR_FLOOR[Math.min(floor, 10)] ?? 'Bronze'
  const all = store.getItems()
  const pool = all.filter((c) =>
    c.BaseTier === targetTier &&
    (c.Tags ?? []).some((t: string) => USEFUL_TAGS.has(t))
  )
  if (pool.length === 0) return null
  return pool[Math.floor(rng() * pool.length)]?.Title ?? null
}

export function bossLootDrop(season: number, floor: number): string | null {
  const rng = mulberry32(((season * 9007 + floor * 5003) >>> 0))
  // bosses always drop something
  const tierMap: Record<number, string> = { 6: 'Gold', 10: 'Diamond' }
  const tier = tierMap[floor] ?? TIER_FOR_FLOOR[Math.min(floor, 10)] ?? 'Gold'
  const all = store.getItems()
  const pool = all.filter((c) =>
    c.BaseTier === tier &&
    (c.Tags ?? []).some((t: string) => USEFUL_TAGS.has(t))
  )
  if (pool.length === 0) return null
  return pool[Math.floor(rng() * pool.length)]?.Title ?? null
}
