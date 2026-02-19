import Fuse from 'fuse.js'
import type { BazaarCard } from './types'

const fuseOptions: Fuse.IFuseOptions<BazaarCard> = {
  keys: [
    { name: 'Title', weight: 2 },
    { name: 'Tags', weight: 0.5 },
    { name: 'Heroes', weight: 0.5 },
  ],
  threshold: 0.2,
  includeScore: true,
}

export function buildIndex(cards: BazaarCard[]) {
  return new Fuse(cards, fuseOptions)
}

export type ScoredCard = { item: BazaarCard; score: number }

export function searchCards(index: Fuse<BazaarCard>, query: string, limit = 5): ScoredCard[] {
  const results = index.search(query, { limit })
  return results.map((r) => ({ item: r.item, score: r.score ?? 1 }))
}

// prefix search fallback for short partial queries
export function searchPrefix(cards: BazaarCard[], query: string, limit = 5): BazaarCard[] {
  const lower = query.toLowerCase()
  return cards
    .filter((c) => c.Title.toLowerCase().startsWith(lower))
    .slice(0, limit)
}

export function buildTitleMap(cards: BazaarCard[]): Map<string, BazaarCard> {
  const map = new Map<string, BazaarCard>()
  for (const c of cards) map.set(c.Title.toLowerCase(), c)
  return map
}

export function findExact(cards: BazaarCard[], name: string, titleMap?: Map<string, BazaarCard>) {
  if (titleMap) return titleMap.get(name.toLowerCase())
  const lower = name.toLowerCase()
  return cards.find((c) => c.Title.toLowerCase() === lower)
}
