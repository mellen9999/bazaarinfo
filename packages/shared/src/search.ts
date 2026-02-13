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
  return index.search(query, { limit }).map((r) => r.item)
}

export function findExact(cards: BazaarCard[], name: string) {
  const lower = name.toLowerCase()
  return cards.find((c) => c.Title.Text.toLowerCase() === lower)
}
