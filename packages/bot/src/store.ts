import type { BazaarCard, CardCache, Monster } from '@bazaarinfo/shared'
import { buildIndex, searchCards, findExact, searchPrefix } from '@bazaarinfo/shared'
import type Fuse from 'fuse.js'
import { resolve } from 'path'
import { log } from './log'

export const CACHE_PATH = resolve(import.meta.dir, '../../../cache/items.json')

// slang/common names → actual item names
const ALIASES: Record<string, string> = {
  beetle: 'BLU-B33TL3',
  wasp: 'GRN-W4SP',
  spider: 'BLK-SP1D3R',
  firefly: 'RED-F1R3FLY',
  mantis: 'YLW-M4NT1S',
  ufo: 'Boosted Saucer',
  saucer: 'Boosted Saucer',
  pyg: 'Pygmalien',
}

let items: BazaarCard[] = []
let skills: BazaarCard[] = []
let monsters: Monster[] = []
let allCards: BazaarCard[] = []
let index: Fuse<BazaarCard>
let enchantmentNames: string[] = []

function dedup<T extends { Id: string }>(cards: T[]): T[] {
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
  monsters = dedup(cache.monsters ?? [])
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
  log(`loaded ${items.length} items + ${skills.length} skills + ${monsters.length} monsters (cached ${cache.fetchedAt})`)
}

export async function reloadStore() {
  try {
    const cache: CardCache = await Bun.file(CACHE_PATH).json()
    loadCache(cache)
    log(`reloaded ${items.length} items + ${skills.length} skills + ${monsters.length} monsters (cached ${cache.fetchedAt})`)
  } catch (e) {
    log(`reload failed, keeping existing data: ${e}`)
  }
}

function resolveAlias(query: string): string {
  return ALIASES[query.toLowerCase()] ?? query
}

const SCORE_GATE = 0.15

export function search(query: string, limit = 5) {
  const resolved = resolveAlias(query)
  // try alias exact match first
  if (resolved !== query) {
    const aliased = findExact(allCards, resolved)
    if (aliased) return [aliased]
  }
  const scored = searchCards(index, resolved, limit)
  const results = scored.filter((r) => r.score <= SCORE_GATE).map((r) => r.item)
  // fallback to prefix match for short partial queries
  if (results.length === 0) return searchPrefix(allCards, resolved, limit)
  return results
}

export function exact(name: string) {
  const resolved = resolveAlias(name)
  return findExact(allCards, resolved)
}

export function byHero(hero: string) {
  const lower = hero.toLowerCase()
  return allCards.filter((i) => i.Heroes.some((h) => h.toLowerCase() === lower))
}

export function getEnchantments(): string[] {
  return enchantmentNames
}

function findByTitle<T extends { Title: { Text: string } }>(list: T[], query: string): T | undefined {
  const lower = query.toLowerCase()
  return list.find((x) => x.Title.Text.toLowerCase() === lower)
    ?? list.find((x) => x.Title.Text.toLowerCase().startsWith(lower))
    ?? list.find((x) => x.Title.Text.toLowerCase().includes(lower))
}

export function findMonster(query: string): Monster | undefined {
  return findByTitle(monsters, query)
}

export function findCard(name: string): BazaarCard | undefined {
  const lower = name.toLowerCase()
  return allCards.find((c) => c.Title.Text.toLowerCase() === lower)
}

export function byTag(tag: string): BazaarCard[] {
  const lower = tag.toLowerCase()
  return items.filter((c) =>
    c.HiddenTags.some((t) => t.toLowerCase() === lower),
  )
}

export function monstersByDay(day: number): Monster[] {
  return monsters.filter((m) => m.MonsterMetadata.day === day)
}

export function findSkill(query: string): BazaarCard | undefined {
  return findByTitle(skills, query)
}

export function getItems(): BazaarCard[] { return items }
export function getMonsters(): Monster[] { return monsters }
export function getSkills(): BazaarCard[] { return skills }
export function getAllCards(): BazaarCard[] { return allCards }
