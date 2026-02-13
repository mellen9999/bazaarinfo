import type { BazaarCard, CardCache } from '@bazaarinfo/shared'
import { buildIndex, searchCards, findExact } from '@bazaarinfo/shared'
import type Fuse from 'fuse.js'
import { resolve } from 'path'

const CACHE_PATH = resolve(import.meta.dir, '../../../cache/items.json')

let items: BazaarCard[] = []
let index: Fuse<BazaarCard>

export async function loadStore() {
  const cache: CardCache = await Bun.file(CACHE_PATH).json()
  // dedupe by Id (page boundary overlaps)
  const seen = new Set<string>()
  items = cache.items.filter((i) => {
    if (seen.has(i.Id)) return false
    seen.add(i.Id)
    return true
  })
  index = buildIndex(items)
  console.log(`loaded ${items.length} items (cached ${cache.fetchedAt})`)
}

export function getItems() {
  return items
}

export function search(query: string, limit = 5) {
  return searchCards(index, query, limit)
}

export function exact(name: string) {
  return findExact(items, name)
}

export function byHero(hero: string) {
  const lower = hero.toLowerCase()
  return items.filter((i) => i.Heroes.some((h) => h.toLowerCase() === lower))
}
