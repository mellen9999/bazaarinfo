import type { BazaarCard, TierName } from '@bazaarinfo/shared'
import * as store from '../store'
import type { ShopItem } from './types'

// mulberry32 seeded PRNG — returns [0,1)
function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s |= 0; s = s + 0x6D2B79F5 | 0
    let t = Math.imul(s ^ s >>> 15, 1 | s)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

function hashSeed(raidId: number, day: number): number {
  // simple deterministic hash of two ints
  return (raidId * 2654435761 ^ day * 2246822519) >>> 0
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// days 1-3 → Bronze/Silver, 4-6 → Silver/Gold, 7-9 → Gold/Diamond, 10+ → Legendary
function tiersForDay(day: number): TierName[] {
  if (day <= 3) return ['Bronze', 'Silver']
  if (day <= 6) return ['Silver', 'Gold']
  if (day <= 9) return ['Gold', 'Diamond']
  return ['Legendary']
}

export function getShop(raidId: number, day: number, hero: string): ShopItem[] {
  const rng = mulberry32(hashSeed(raidId, day))
  const tiers = tiersForDay(day)
  const heroItems = store.byHero(hero).filter(
    (c) => c.Type === 'Item' && c.Tiers.some((t) => tiers.includes(t)),
  )

  let pool = heroItems.length >= 8 ? heroItems : store.getItems().filter(
    (c) => c.Type === 'Item' && c.Tiers.some((t) => tiers.includes(t)),
  )

  const shuffled = shuffle(pool, rng)
  return shuffled.slice(0, 8).map((card, i) => ({ shopSlot: i, card }))
}
