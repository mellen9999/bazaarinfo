import Fuse from 'fuse.js'
import type { BazaarCard } from './types'

const fuseOptions: Fuse.IFuseOptions<BazaarCard> = {
  keys: [
    { name: 'Title.Text', weight: 2 },
    { name: 'Tags', weight: 0.5 },
    { name: 'Heroes', weight: 0.5 },
  ],
  threshold: 0.3,
  includeScore: true,
}

export function buildIndex(cards: BazaarCard[]) {
  return new Fuse(cards, fuseOptions)
}

export function searchCards(index: Fuse<BazaarCard>, query: string, limit = 5) {
  const results = index.search(query, { limit })
  return results.map((r) => r.item)
}

// prefix search fallback for short partial queries
export function searchPrefix(cards: BazaarCard[], query: string, limit = 5): BazaarCard[] {
  const lower = query.toLowerCase()
  return cards
    .filter((c) => c.Title.Text.toLowerCase().startsWith(lower))
    .slice(0, limit)
}

export function findExact(cards: BazaarCard[], name: string) {
  const lower = name.toLowerCase()
  return cards.find((c) => c.Title.Text.toLowerCase() === lower)
}
