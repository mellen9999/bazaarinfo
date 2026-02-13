import type { BazaarCard, CardCache } from '@bazaarinfo/shared'
import { buildIndex, searchCards, findExact, searchPrefix } from '@bazaarinfo/shared'
import type Fuse from 'fuse.js'
import { resolve } from 'path'
import { log } from './log'

export const CACHE_PATH = resolve(import.meta.dir, '../../../cache/items.json')

let items: BazaarCard[] = []
let skills: BazaarCard[] = []
let allCards: BazaarCard[] = []
let index: Fuse<BazaarCard>
let enchantmentNames: string[] = []

function dedup(cards: BazaarCard[]): BazaarCard[] {
  const seen = new Set<string>()
  return cards.filter((i) => {
    if (seen.has(i.Id)) return false
    seen.add(i.Id)
    return true
  })
}

function loadCache(cache: CardCache) {
  items = dedup(cache.items)
  skills = dedup(cache.skills ?? [])
  allCards = [...items, ...skills]
  index = buildIndex(allCards)

  // extract all enchantment names from item data
  const enchSet = new Set<string>()
  for (const item of items) {
    if (item.Enchantments) for (const key of Object.keys(item.Enchantments)) enchSet.add(key.toLowerCase())
  }
  enchantmentNames = [...enchSet].sort()
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
  log(`loaded ${items.length} items + ${skills.length} skills (cached ${cache.fetchedAt})`)
}

export async function reloadStore() {
  try {
    const cache: CardCache = await Bun.file(CACHE_PATH).json()
    loadCache(cache)
    log(`reloaded ${items.length} items + ${skills.length} skills (cached ${cache.fetchedAt})`)
  } catch (e) {
    log(`reload failed, keeping existing ${items.length} items: ${e}`)
  }
}

export function search(query: string, limit = 5) {
  const results = searchCards(index, query, limit)
  // fallback to prefix match for short partial queries
  if (results.length === 0) return searchPrefix(allCards, query, limit)
  return results
}

export function exact(name: string) {
  return findExact(allCards, name)
}

export function byHero(hero: string) {
  const lower = hero.toLowerCase()
  return allCards.filter((i) => i.Heroes.some((h) => h.toLowerCase() === lower))
}

export function getEnchantments(): string[] {
  return enchantmentNames
}
