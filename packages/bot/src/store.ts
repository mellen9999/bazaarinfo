import type { BazaarCard, CardCache, Monster } from '@bazaarinfo/shared'
import { buildIndex, searchCards, findExact, searchPrefix } from '@bazaarinfo/shared'
import Fuse from 'fuse.js'
import { resolve } from 'path'
import { log } from './log'

export const CACHE_PATH = resolve(import.meta.dir, '../../../cache/items.json')

// slang/common names → actual item names
export const ALIASES: Record<string, string> = {
  beetle: 'BLU-B33TL3',
  wasp: 'GRN-W4SP',
  spider: 'BLK-SP1D3R',
  firefly: 'RED-F1R3FLY',
  mantis: 'YLW-M4NT1S',
  ufo: 'Boosted Saucer',
  saucer: 'Boosted Saucer',
  pyg: 'Pygmalien',
  // core items by mechanic tag (title doesn't hint at the tag)
  'flying core': 'Launcher Core',
  'flight core': 'Launcher Core',
  'fire core': 'Ignition Core',
  'burn core': 'Ignition Core',
  'shield core': 'Armored Core',
  'speed core': 'Companion Core',
  'haste core': 'Companion Core',
  'crit core': 'Critical Core',
  'damage core': 'Combat Core',
  'weapon core': 'Weaponized Core',
  'destroy core': 'Oblivion Core',
  'regen core': 'Primal Core',
  'lava core': 'Magma Core',
  // punny/stylized names people won't guess
  'tommy gun': 'Tommoo Gun',
  pterodactyl: 'Terry-Dactyl',
  ptero: 'Terry-Dactyl',
  bulldozer: 'Bill Dozer',
  penguin: 'PenFT',
  'mama saur': 'Momma-Saur',
  'swiss army knife': 'Chris Army Knife',
  // community shorthand (confirmed from player discussions)
  oj: 'Orange Julian',
  bob: 'Beast of Burden',
  eels: 'Electric Eels',
  // common alternate names
  blueprint: 'Schematics',
  blueprints: 'Schematics',
  'gravity well': 'Unstable Grav Well',
}

let items: BazaarCard[] = []
let skills: BazaarCard[] = []
let monsters: Monster[] = []
let allCards: BazaarCard[] = []
let index: Fuse<BazaarCard>
let monsterIndex: Fuse<Monster>
let enchantmentNames: string[] = []
let heroNames: string[] = []
let tagNames: string[] = []

function dedup<T extends { Title: string }>(cards: T[]): T[] {
  const seen = new Set<string>()
  return cards.filter((i) => {
    if (seen.has(i.Title)) return false
    seen.add(i.Title)
    return true
  })
}

function loadCache(cache: CardCache) {
  items = dedup(cache.items)
  skills = dedup(cache.skills ?? [])
  monsters = dedup(cache.monsters ?? [])
  allCards = [...items, ...skills]
  index = buildIndex(allCards)
  monsterIndex = new Fuse(monsters, {
    keys: [{ name: 'Title', weight: 1 }],
    threshold: 0.25,
    includeScore: true,
  })

  // extract all enchantment names from item data
  const enchSet = new Set<string>()
  for (const item of items) {
    if (item.Enchantments) for (const key of Object.keys(item.Enchantments)) enchSet.add(key.toLowerCase())
  }
  enchantmentNames = [...enchSet].sort()

  // extract distinct hero names (filter data labels that aren't real heroes)
  const FAKE_HEROES = new Set(['???', 'Common'])
  const heroSet = new Set<string>()
  for (const card of allCards) {
    for (const h of card.Heroes) if (!FAKE_HEROES.has(h)) heroSet.add(h)
  }
  heroNames = [...heroSet].sort()

  // extract distinct tag names (both hidden + display)
  const tagSet = new Set<string>()
  for (const card of items) {
    for (const t of card.HiddenTags) tagSet.add(t)
    for (const t of card.DisplayTags) tagSet.add(t)
  }
  tagNames = [...tagSet].sort()
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
  const scored = searchCards(index, resolved, limit * 2)
  const results = scored.filter((r) => r.score <= SCORE_GATE).map((r) => r.item)
  // fallback to prefix match for short partial queries
  if (results.length === 0) return searchPrefix(allCards, resolved, limit)
  // boost exact word matches — "moose" should prefer "Staff of the Moose" over "Mouse Trap"
  const lower = resolved.toLowerCase()
  const wordRe = new RegExp(`\\b${lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
  const exact: BazaarCard[] = []
  const rest: BazaarCard[] = []
  for (const r of results) {
    if (wordRe.test(r.Title)) exact.push(r)
    else rest.push(r)
  }
  return [...exact, ...rest].slice(0, limit)
}

export function exact(name: string) {
  const resolved = resolveAlias(name)
  return findExact(allCards, resolved)
}

// includes but only at word boundaries — "book" matches "Spell Book" not "Zookeeper"
function wordIncludes(text: string, query: string): boolean {
  if (query.length < 3) return false
  const idx = text.indexOf(query)
  return idx > 0 && /[\s\-']/.test(text[idx - 1])
}

function findInList(list: string[], query: string): string | undefined {
  const lower = query.toLowerCase()
  return list.find((n) => n.toLowerCase() === lower)
    ?? list.find((n) => n.toLowerCase().startsWith(lower))
    ?? list.find((n) => wordIncludes(n.toLowerCase(), lower))
}

export function findHeroName(query: string): string | undefined {
  return findInList(heroNames, query)
}

export function findTagName(query: string): string | undefined {
  return findInList(tagNames, query)
}

export function byHero(hero: string) {
  const resolved = findHeroName(hero) ?? hero
  const lower = resolved.toLowerCase()
  return allCards.filter((i) => i.Heroes.some((h) => h.toLowerCase() === lower))
}

export function getEnchantments(): string[] {
  return enchantmentNames
}

function findByTitle<T extends { Title: string }>(list: T[], query: string): T | undefined {
  const lower = query.toLowerCase()
  return list.find((x) => x.Title.toLowerCase() === lower)
    ?? list.find((x) => x.Title.toLowerCase().startsWith(lower))
    ?? list.find((x) => wordIncludes(x.Title.toLowerCase(), lower))
}

export function findMonster(query: string): Monster | undefined {
  const byTitle = findByTitle(monsters, query)
  if (byTitle) return byTitle
  // fuse fallback for typos
  const results = monsterIndex.search(query, { limit: 1 })
  if (results.length > 0 && (results[0].score ?? 1) <= 0.2) return results[0].item
  return undefined
}

export function findCard(name: string): BazaarCard | undefined {
  const lower = name.toLowerCase()
  return allCards.find((c) => c.Title.toLowerCase() === lower)
}

export function byTag(tag: string): BazaarCard[] {
  const resolved = findTagName(tag) ?? tag
  const lower = resolved.toLowerCase()
  return items.filter((c) =>
    c.HiddenTags.some((t) => t.toLowerCase() === lower)
    || c.DisplayTags.some((t) => t.toLowerCase() === lower),
  )
}

export function monstersByDay(day: number): Monster[] {
  return monsters.filter((m) => m.MonsterMetadata.day === day)
}

export function findSkill(query: string): BazaarCard | undefined {
  return findByTitle(skills, query)
}

const SUGGEST_GATE = 0.4

export function suggest(query: string, limit = 3): string[] {
  const resolved = resolveAlias(query)
  const scored = searchCards(index, resolved, limit)
  return scored.filter((r) => r.score <= SUGGEST_GATE).map((r) => r.item.Title)
}

export function getHeroNames(): string[] { return heroNames }
export function getTagNames(): string[] { return tagNames }
export function getItems(): BazaarCard[] { return items }
export function getMonsters(): Monster[] { return monsters }
export function getSkills(): BazaarCard[] { return skills }
export function getAllCards(): BazaarCard[] { return allCards }
