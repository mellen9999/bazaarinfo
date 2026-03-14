import Fuse, { type IFuseOptions } from 'fuse.js/basic'
import type { BazaarCard } from './types'

const fuseOptions: IFuseOptions<BazaarCard> = {
  keys: [
    { name: 'Title', weight: 2 },
    { name: 'Tags', weight: 0.5 },
    { name: 'Heroes', weight: 0.5 },
  ],
  threshold: 0.15,       // was 0.2; caller gates at 0.15 anyway, no point scoring 0.15-0.20
  includeScore: true,
  ignoreLocation: true,  // don't penalise matches deep in long strings
  minMatchCharLength: 2, // reject single-char noise before scoring
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
// pass lowercaseTitles (from buildLowercaseTitles) to avoid O(n) allocations per call
export function searchPrefix(
  cards: BazaarCard[],
  query: string,
  limit = 5,
  lowercaseTitles?: string[],
): BazaarCard[] {
  const lower = query.toLowerCase()
  if (lowercaseTitles) {
    const out: BazaarCard[] = []
    for (let i = 0; i < cards.length && out.length < limit; i++) {
      if (lowercaseTitles[i].startsWith(lower)) out.push(cards[i])
    }
    return out
  }
  // fallback: allocates per element — build lowercaseTitles at startup instead
  return cards
    .filter((c) => c.Title.toLowerCase().startsWith(lower))
    .slice(0, limit)
}

// build once at startup, pass to searchPrefix to avoid per-call allocations
export function buildLowercaseTitles(cards: BazaarCard[]): string[] {
  return cards.map((c) => c.Title.toLowerCase())
}

export function buildTitleMap(cards: BazaarCard[]): Map<string, BazaarCard> {
  return new Map(cards.map((c) => [c.Title.toLowerCase(), c]))
}

/**
 * O(1) exact lookup when titleMap is provided.
 * Always pass titleMap — the fallback is O(n) with per-element allocations.
 */
export function findExact(cards: BazaarCard[], name: string, titleMap?: Map<string, BazaarCard>) {
  const lower = name.toLowerCase()
  if (titleMap) return titleMap.get(lower)
  return cards.find((c) => c.Title.toLowerCase() === lower)
}
