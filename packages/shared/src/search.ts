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

// last-resort multi-word match: every query word must appear (exact, or a prefix either
// direction) as some word in the card's title. catches "champion belt" -> "Championship
// Belt" when fuse's whole-string fuzzy and the strict prefix both miss (fuse scores the
// joined string poorly across the "ship" gap + space). cold path only (fuse already
// missed), so splitting 1k titles per call is fine. ranked by count of exact word hits.
export function searchAllWords(cards: BazaarCard[], query: string, limit = 5): BazaarCard[] {
  const qWords = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 2)
  if (qWords.length < 2) return [] // single-word queries are already handled by fuse/prefix
  const wordMatch = (qw: string, tw: string) =>
    tw === qw || (qw.length >= 3 && tw.startsWith(qw)) || (tw.length >= 3 && qw.startsWith(tw)) || (qw.length >= 4 && tw.includes(qw))
  const out: { card: BazaarCard; hits: number }[] = []
  for (const c of cards) {
    const tWords = c.Title.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s\-]+/)
    let ok = true
    let hits = 0
    for (const qw of qWords) {
      const tw = tWords.find((t) => wordMatch(qw, t))
      if (!tw) { ok = false; break }
      if (tw === qw) hits++
    }
    if (ok) out.push({ card: c, hits })
  }
  out.sort((a, b) => b.hits - a.hits)
  return out.slice(0, limit).map((o) => o.card)
}

// build once at startup, pass to searchPrefix to avoid per-call allocations
export function buildLowercaseTitles(cards: BazaarCard[]): string[] {
  return cards.map((c) => c.Title.toLowerCase())
}

// "Bubble Gum" -> "bubblegum". chat types item names without the spaces, and fuzzy
// search ranks a wrong-but-single-word title above the right one ("bubblegum" hit
// "Bubblegum Floor", so the bot told chat no Bubble Gum existed).
export function squashName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// keyed by exact lowercase title AND by squashed title. squashed keys go in first so
// a real title always outranks another item's squashed form, and any squashed key that
// two different cards share is dropped rather than guessed at — ambiguous input falls
// through to fuzzy search instead of silently resolving to the wrong card.
export function buildTitleMap(cards: BazaarCard[]): Map<string, BazaarCard> {
  const squashed = new Map<string, BazaarCard>()
  const collided = new Set<string>()
  for (const c of cards) {
    const key = squashName(c.Title)
    if (!key) continue
    const prev = squashed.get(key)
    if (prev && prev !== c) collided.add(key)
    else squashed.set(key, c)
  }
  for (const key of collided) squashed.delete(key)
  for (const c of cards) squashed.set(c.Title.toLowerCase(), c)
  return squashed
}

/**
 * O(1) exact lookup when titleMap is provided.
 * Always pass titleMap — the fallback is O(n) with per-element allocations.
 */
export function findExact(cards: BazaarCard[], name: string, titleMap?: Map<string, BazaarCard>) {
  const lower = name.toLowerCase()
  if (titleMap) return titleMap.get(lower) ?? titleMap.get(squashName(lower))
  return cards.find((c) => c.Title.toLowerCase() === lower)
    ?? cards.find((c) => squashName(c.Title) === squashName(lower))
}
