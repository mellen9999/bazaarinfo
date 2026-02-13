import type { BazaarCard, CardCache } from '@bazaarinfo/shared'
import { buildIndex, searchCards, findExact } from '@bazaarinfo/shared'
import type Fuse from 'fuse.js'
import { resolve } from 'path'
import { log } from './log'

export const CACHE_PATH = resolve(import.meta.dir, '../../../cache/items.json')

let items: BazaarCard[] = []
let index: Fuse<BazaarCard>

function loadCache(cache: CardCache) {
  const seen = new Set<string>()
  items = cache.items.filter((i) => {
    if (seen.has(i.Id)) return false
    seen.add(i.Id)
    return true
  })
  index = buildIndex(items)
}

export async function loadStore() {
  let cache: CardCache
  try {
    cache = await Bun.file(CACHE_PATH).json()
  } catch (err) {
    log(`failed to load cache at ${CACHE_PATH}: ${err}`)
    process.exit(1)
  }
  loadCache(cache)
  log(`loaded ${items.length} items (cached ${cache.fetchedAt})`)
}

export async function reloadStore() {
  try {
    const cache: CardCache = await Bun.file(CACHE_PATH).json()
    loadCache(cache)
    log(`reloaded ${items.length} items (cached ${cache.fetchedAt})`)
  } catch (e) {
    log(`reload failed, keeping existing ${items.length} items: ${e}`)
  }
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
