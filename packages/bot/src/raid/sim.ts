import type { BoardItem, SimResult } from './types'

// mulberry32 — same impl as shop.ts so tests can import independently
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
  return (raidId * 2654435761 ^ day * 2246822519) >>> 0
}

const TIER_WEIGHT: Record<string, number> = {
  Bronze: 1, Silver: 2, Gold: 4, Diamond: 8, Legendary: 16,
}
const SIZE_WEIGHT: Record<string, number> = {
  Small: 1, Medium: 2, Large: 4,
}

function hasTag(item: BoardItem, tag: string): boolean {
  return item.tags.some((t) => t.toLowerCase() === tag.toLowerCase())
}

function scoreBoard(items: BoardItem[]): number {
  if (items.length === 0) return 1
  let total = 0
  for (const item of items) {
    const tw = TIER_WEIGHT[item.tier] ?? 1
    const sw = SIZE_WEIGHT[item.size] ?? 1
    const cd = item.cooldownMs > 0 ? item.cooldownMs : 5000
    total += tw * sw * (1000 / cd)
  }

  const weaponCount = items.filter((i) => hasTag(i, 'Weapon')).length
  if (weaponCount >= 3) total *= 1.2

  if (items.length > 0 && items.every((i) => hasTag(i, 'Aquatic'))) total *= 1.3

  return total
}

export function simulate(
  partyBoard: BoardItem[],
  monsterBoard: BoardItem[],
  raidId: number,
  day: number,
): SimResult {
  const rng = mulberry32(hashSeed(raidId, day))
  const noise = () => 1 + (rng() * 0.30 - 0.15)  // ±15%

  const partyScore = scoreBoard(partyBoard) * noise()
  const monsterScore = scoreBoard(monsterBoard) * noise()

  const winner: 'party' | 'monster' = partyScore >= monsterScore ? 'party' : 'monster'
  const maxScore = Math.max(partyScore, monsterScore)
  const margin = maxScore > 0 ? Math.abs(partyScore - monsterScore) / maxScore : 0

  return {
    winner,
    margin: Math.min(1, margin),
    partyItems: partyBoard.map((i) => i.title),
    monsterItems: monsterBoard.map((i) => i.title),
  }
}
