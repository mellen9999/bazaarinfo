import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { log } from './log'
import { STOP_WORDS, ENTITY_SKIP, COMMON_WORDS } from './ai-query'

// guildrun game data — kripp moved his main game to Guildrun (aug 2026), and the same
// failure hs-cards.ts exists for arrived on day one: "what does irini do" got either a
// dodge or the model's own memory of a game younger than its training data, which is
// worse than memory of an old game — it KNOWS nothing and invents everything.
//
// source is the guildrundb dump (github.com/leihcsky/guildrundb) — JSON extracted from
// the game's own balancing files, tracking the weekly demo patches. no official API or
// wiki exists; the "wikis" around this game are an SEO farm (see docs/guildrun.md).
// relic descriptions ship as templates with unresolved {N} holes in part of the dump, so
// the resolved text comes from a second community db (a GPL twitch-overlay extension's
// database, served via jsdelivr) that carries the same 408 relics with real numbers.
//
// SCOPE: heroes (stats, kit, specs), relics, items, classes and rank modifiers — the
// things chat asks "what does X do" about. enemies (644) and the steam patch feed are
// deliberately out of v1. weekly patches mean every number here drifts — the daily
// refresh is the only honesty mechanism, so never hardcode counts or values.
//
// fail-soft like every other live source: every export returns ''/[] on any failure, so
// an upstream outage can never crash the bot or invent a hero.

const CACHE_PATH = resolve(import.meta.dir, '../../../cache/guildrun.json')
const UA = 'BazaarInfo/1.0 (Twitch bot; github.com/mellen9999/bazaarinfo)'
const DUMP_BASE = 'https://raw.githubusercontent.com/leihcsky/guildrundb/main/content/'
const EXT_DB_URL = 'https://cdn.jsdelivr.net/gh/KalaniEhuKai/GuildRunDataDisplayTwitchExtension@main/guildrundatabase.json'

const TTL_MS = 24 * 60 * 60 * 1000 // data changes on patch day (weekly), not hourly
const FETCH_TIMEOUT_MS = 60_000
const MAX_BYTES = 32 * 1024 * 1024 // per file — a shape change must not become an unbounded download
const MAX_MATCHES = 3 // hero blocks are dense; three is already a full prompt section

export type GrKind = 'hero' | 'relic' | 'item' | 'class' | 'rankmod'

/** trimmed record. short keys — the cache is written to disk on every refresh. */
export interface GrCard {
  n: string // name
  k: GrKind
  r?: string // rarity (relics, items)
  x?: string // effect / description text
  c?: string // hero: class label ("Warrior/Duelist"); rankmod: class pool it belongs to
  g?: string // hero: guild
  st?: string // hero: stat line
  sp?: string[] // hero: specialization lines ("The Electric: …")
}

interface GrCache {
  fetchedAt: number
  cards: GrCard[]
}

let cache: GrCache | null = null
let refreshing: Promise<void> | null = null

// --- text cleaning (pure — testable without the network) ---

const splitCamel = (s: string): string => s.replace(/([a-z])([A-Z])/g, '$1 $2')

const fmtNum = (v: unknown): string => {
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  return String(Math.round(n * 100) / 100)
}

/**
 * Game text arrives as markup — `[Burn]<burn>`, `[{0}+{1}_AttackSpeed]<statcalc_damage>`.
 * The dump DOES carry a `descriptionArgs` array, but for hero abilities its values are
 * internal multipliers, not the displayed numbers (Blizzard's args say 0.98s where the
 * game shows 5s) — filling them would put confidently-wrong numbers in front of chat,
 * which is the exact failure this module exists to prevent. So template text renders
 * QUALITATIVELY: a scaling term becomes "X (scales with Attack Speed)", a bare hole
 * becomes "X". Mechanics stay exact; magnitudes are honestly unstated. Real numbers only
 * come from sources that carry the displayed values (relic ext db, item stat mods,
 * hero base stats).
 */
export function cleanGrText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  // a statcalc term names its scaling stats in the shorthand — keep those, drop the coefficients
  let out = raw.replace(/\[([^\][]*)\]<statcalc_[^>]*>/g, (_, body: string) => {
    const stats = [...body.matchAll(/_([A-Za-z]+)/g)].map((m) => splitCamel(m[1]))
    return stats.length ? `X (scales with ${[...new Set(stats)].join(', ')})` : 'X'
  })
  // [visible]<tag> → visible; run twice for the occasional nested bracket
  for (let i = 0; i < 2; i++) out = out.replace(/\[([^\][]*)\]<[^>]*>/g, '$1')
  out = out
    .replace(/\{\d+\}/g, 'X') // any remaining hole is an unknown, said plainly
    .replace(/\s+/g, ' ')
    .trim()
  return out || undefined
}

// --- dump parsing (pure) ---

interface RawDumps {
  heroes: unknown[]
  classes: unknown[]
  guilds: unknown[]
  relics: unknown[]
  items: unknown[]
  passives: unknown[]
  actives: unknown[]
  specs: unknown[]
  rankmods: unknown[]
}

/** resolved relic text from the twitch-ext db, keyed "Relic_<id>". */
export type ExtRelics = Record<string, { name?: string; description?: string }>

const enabled = (e: any): boolean => e?.balancing?.disabledInGame !== true

function heroStatLine(s: any): string | undefined {
  if (!s || typeof s !== 'object') return undefined
  const bits: string[] = []
  if (s.maxHealth) bits.push(`${s.maxHealth} HP`)
  if (s.baseAttackDamage) bits.push(`${s.baseAttackDamage} base hit`)
  if (s.attack) bits.push(`${s.attack} attack`)
  if (s.magic) bits.push(`${s.magic} magic`)
  if (s.attackSpeed) bits.push(`${s.attackSpeed} attack speed`)
  if (s.defense) bits.push(`${s.defense} defense`)
  if (s.crit) bits.push(`${s.crit} crit`)
  if (s.maxMana) bits.push(`${s.maxMana} mana${s.manaRegen ? ` (${s.manaRegen} regen)` : ''}`)
  if (s.attackRange) bits.push(`range ${s.attackRange}`)
  return bits.length ? bits.join(', ') : undefined
}

/**
 * Reduce the raw dumps to the cards a chat answer needs. Tolerant by design: a renamed
 * field costs one card's detail, never the whole refresh.
 */
export function extractGuildrun(d: RawDumps, ext: ExtRelics = {}): GrCard[] {
  const out: GrCard[] = []
  const arr = (x: unknown): any[] => (Array.isArray(x) ? x : [])

  const classById = new Map<number, string>()
  for (const c of arr(d.classes)) if (c?.id && typeof c.name === 'string') classById.set(c.id, c.name)
  const guildById = new Map<number, string>()
  for (const g of arr(d.guilds)) {
    const title = g?.balancing?.title
    if (g?.id && typeof title === 'string') guildById.set(g.id, title)
  }

  // abilities index: by id (heroes link base kit by id) and by hero name (everything a
  // hero can ever have targets it by name — base kit AND spec-granted abilities).
  interface Ab { id: number; n: string; x?: string; hero?: string }
  const abilities: Ab[] = []
  for (const a of [...arr(d.passives), ...arr(d.actives)]) {
    const n = a?.name ?? a?.balancing?.title
    if (!a?.id || typeof n !== 'string') continue
    abilities.push({
      id: a.id, n,
      x: cleanGrText(a.description),
      hero: a.targetHero ?? a.balancing?.targetHero,
    })
  }
  const abilityById = new Map(abilities.map((a) => [a.id, a]))
  const abilityByName = new Map(abilities.map((a) => [a.n.toLowerCase(), a]))

  // heroes — class(es), guild, stats, kit, and the three C→B specialization choices
  for (const h of arr(d.heroes)) {
    if (!h?.id || typeof h.name !== 'string' || !enabled(h)) continue
    const cls = [classById.get(h.class1Id), classById.get(h.class2Id)].filter(Boolean).join('/')
    const specNames = arr(d.specs)
      .filter((s) => s?.id && Math.floor(s.id / 100) === h.id && typeof s.name === 'string')
      .map((s) => s.name as string)
    // spec text lives in an ability named after the spec (66 of 75 as of 0.5.5);
    // a spec with no matching ability keeps its bare name — real, just thinner.
    const sp = specNames.map((n) => {
      const ab = abilityByName.get(n.toLowerCase())
      return ab?.x ? `${n}: ${ab.x}` : n
    })
    // kit: the explicitly-linked abilities plus everything else that targets this hero
    // and is not one of its spec names (those render under specs, not the kit). the dump
    // does not say which extras are spec-granted, so the kit claims possession, not source.
    const linked = [h.passiveAbilityId, h.activeAbilityId]
      .map((id) => (typeof id === 'number' ? abilityById.get(id) : undefined))
      .filter((a): a is Ab => !!a)
    const specSet = new Set(specNames.map((n) => n.toLowerCase()))
    const linkedSet = new Set(linked.map((a) => a.id))
    const kit = [
      ...linked,
      ...abilities.filter((a) => a.hero === h.name && !specSet.has(a.n.toLowerCase()) && !linkedSet.has(a.id)),
    ]
      .slice(0, 3)
      .map((a) => (a.x ? `${a.n}: ${a.x}` : a.n))
    out.push({
      n: h.name, k: 'hero',
      c: cls || undefined,
      g: guildById.get(h.guildId),
      st: heroStatLine(h.stats),
      x: kit.join(' | ') || undefined,
      sp: sp.length ? sp : undefined,
    })
  }

  // relics — resolved text from the ext db wins (it has real numbers for all of them);
  // the dump's own template+args is the fallback when the ext db lags a patch.
  for (const r of arr(d.relics)) {
    if (!r?.id || typeof r.name !== 'string' || !enabled(r)) continue
    const extHit = ext[`Relic_${r.id}`]
    out.push({
      n: r.name, k: 'relic',
      r: typeof r.rarity === 'string' ? r.rarity.toLowerCase() : undefined,
      x: cleanGrText(extHit?.description) ?? cleanGrText(r.description),
    })
  }

  // items — 166 of 174 are plain stat sticks with exact values in statModifications
  for (const it of arr(d.items)) {
    if (!it?.id || typeof it.name !== 'string' || !enabled(it)) continue
    const mods = arr(it.balancing?.statModifications)
      .filter((m) => m?.TargetStat && m?.Value != null)
      .map((m) => `+${fmtNum(m.Value)} ${splitCamel(String(m.TargetStat))}`)
    out.push({
      n: it.name, k: 'item',
      r: typeof it.balancing?.rarity === 'string' ? it.balancing.rarity.toLowerCase() : undefined,
      x: mods.join(', ') || undefined,
    })
  }

  // classes — full mechanic descriptions ("Warriors use Attack… Mechanics: Crit, Rush, Shields")
  for (const c of arr(d.classes)) {
    if (!c?.id || typeof c.name !== 'string') continue
    out.push({ n: c.name, k: 'class', x: cleanGrText(c.description) })
  }

  // rank modifiers — the B→A and A→S choices, drawn from class pools
  for (const m of arr(d.rankmods)) {
    if (!m?.id || typeof m.name !== 'string' || !enabled(m)) continue
    out.push({ n: m.name, k: 'rankmod', x: cleanGrText(m.description) })
  }

  return out
}

// --- cache ---

function loadDisk(): void {
  if (cache || !existsSync(CACHE_PATH)) return
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
    if (parsed && Array.isArray(parsed.cards)) {
      cache = parsed
      buildIndex()
    }
  } catch {
    // a corrupt cache is the same as no cache — refetch, never crash on it
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  const len = Number(res.headers.get('content-length'))
  if (Number.isFinite(len) && len > MAX_BYTES) throw new Error(`too large (${len} bytes): ${url}`)
  return res.json()
}

async function refresh(): Promise<void> {
  let cards: GrCard[] = []
  try {
    const [heroes, classes, guilds, relics, items, passives, actives, specs, rankmods] = await Promise.all(
      ['heroes', 'heroClasses', 'guilds', 'relics', 'items', 'passiveAbilities', 'activeAbilities', 'heroSpecializations', 'rankModifiers']
        .map((f) => fetchJson(`${DUMP_BASE}${f}.json`)),
    ) as unknown[][]
    // the ext db is an enhancement, not a dependency — its outage must not blank the refresh
    let ext: ExtRelics = {}
    try {
      const raw = await fetchJson(EXT_DB_URL) as any
      if (raw?.relics && typeof raw.relics === 'object') ext = raw.relics
    } catch (e) {
      log(`guildrun: ext relic db unavailable, using dump templates: ${e}`)
    }
    cards = extractGuildrun({ heroes, classes, guilds, relics, items, passives, actives, specs, rankmods }, ext)
  } catch (e) {
    log(`guildrun: refresh failed: ${e}`)
    return
  }
  // an empty extract means the dump reshaped its fields — keep the old cards rather than going blind
  if (cards.length === 0) {
    log('guildrun: extract produced no cards, keeping previous cache')
    return
  }
  cache = { fetchedAt: Date.now(), cards }
  buildIndex()
  try {
    writeFileSync(CACHE_PATH, JSON.stringify(cache))
  } catch {
    // memory cache still works; disk is only a warm-start optimisation
  }
  const heroes = cards.filter((c) => c.k === 'hero').length
  log(`guildrun: ${cards.length} cards (${heroes} heroes)`)
}

/** non-blocking, same contract as refreshHsCardsIfNeeded — this turn answers from what we have. */
export function refreshGuildrunIfNeeded(): void {
  loadDisk()
  const age = cache ? Date.now() - cache.fetchedAt : Infinity
  if (age < TTL_MS || refreshing) return
  refreshing = refresh()
    .catch(() => {})
    .finally(() => {
      refreshing = null
    })
}

// --- name matching ---

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

// names that are also ordinary chat words. "rip bozo" is not a question about the hero
// Rip, and "hammer" or "grace" pass through half of everything anyone types — these only
// count when the message actually asks about something (intent), never on bare mention.
const AMBIENT_NAMES = new Set<string>([
  ...STOP_WORDS, ...ENTITY_SKIP, ...COMMON_WORDS,
  'rip', 'grace', 'hammer', 'sword', 'shield', 'staff', 'dagger', 'bow', 'axe', 'wand',
  'armor', 'helmet', 'boots', 'gloves', 'ring', 'cloak', 'potion', 'tome', 'orb',
  // the question's own vocabulary is never the answer
  'hero', 'heroes', 'relic', 'relics', 'item', 'items', 'spec', 'specs', 'class', 'rank',
  'guild', 'guildrun', 'rush', 'stall', 'storm', 'endless', 'rift', 'shards',
])

let byName = new Map<string, GrCard[]>()
let bySquash = new Map<string, GrCard[]>()

function add(map: Map<string, GrCard[]>, key: string, card: GrCard): void {
  const list = map.get(key)
  if (list) list.push(card)
  else map.set(key, [card])
}

function buildIndex(): void {
  byName = new Map()
  bySquash = new Map()
  for (const card of cache?.cards ?? []) {
    const n = norm(card.n)
    if (!n) continue
    add(byName, n, card)
    add(bySquash, squash(card.n), card)
  }
}

// a hero outranks a relic that shares its name, and a longer name beats a shorter one
const KIND_RANK: Record<GrKind, number> = { hero: 0, class: 1, relic: 2, item: 3, rankmod: 4 }
function rank(a: GrCard, b: GrCard): number {
  return KIND_RANK[a.k] - KIND_RANK[b.k] || b.n.length - a.n.length
}

/**
 * Cards named in a query. Full name as a whole-word run, then a spacing-insensitive
 * single token. Ambient-word names need the query to carry intent — that gate is the
 * caller's (grContext) because intent is a property of the whole question.
 */
export function findGrCards(query: string, intent: boolean): GrCard[] {
  if (!byName.size) return []
  const n = norm(query)
  if (!n) return []
  const hits = new Map<string, GrCard>()
  const take = (cards: GrCard[] | undefined) => {
    for (const c of cards ?? []) {
      if (!intent && AMBIENT_NAMES.has(norm(c.n))) continue
      hits.set(`${c.k}|${c.n}`, c)
    }
  }
  const padded = ` ${n} `
  for (const [name, cards] of byName) {
    if (padded.includes(` ${name} `)) take(cards)
  }
  for (const t of n.split(' ')) {
    if (t.length >= 6) take(bySquash.get(t))
  }
  return [...hits.values()].sort(rank).slice(0, MAX_MATCHES)
}

// --- class listing ---

const CLASS_WORDS: Record<string, string> = {
  warrior: 'Warrior', warriors: 'Warrior', tank: 'Tank', tanks: 'Tank',
  vanguard: 'Vanguard', vanguards: 'Vanguard', assassin: 'Assassin', assassins: 'Assassin',
  duelist: 'Duelist', duelists: 'Duelist', mystic: 'Mystic', mystics: 'Mystic',
  mage: 'Mage', mages: 'Mage',
}

interface Listing { cls: string | null; cards: GrCard[] }

/** "what duelists are there", "list the heroes" — the roster is small enough to list whole. */
export function findGrListing(query: string): Listing | null {
  const n = norm(query)
  if (!/\b(list|what|which|who|all|every)\b/.test(n)) return null
  let cls: string | null = null
  for (const w of n.split(' ')) {
    if (CLASS_WORDS[w]) { cls = CLASS_WORDS[w]; break }
  }
  if (!cls && !/\bheroes\b/.test(n)) return null
  const cards = (cache?.cards ?? []).filter((c) =>
    c.k === 'hero' && (!cls || (c.c ?? '').split('/').includes(cls)),
  )
  return cards.length ? { cls, cards } : null
}

// --- routing ---

/** a question that names the game. deliberately tight — this bot's home game is The
 *  Bazaar, and a query has to actually say guildrun before its data outranks the dump. */
const GR_SIGNAL = /\bguild\s?run\b/i
export function isGrQuery(q: string): boolean {
  return GR_SIGNAL.test(q)
}

// same shape as hs-cards' intent gate, same reason: "yo whats good" is not a hero question
const GR_INTENT =
  /\b(what|whats|which|how|why|explain|define|tell me about|stats?|text|ability|abilities|effect|synerg\w*|counters?|worth|best|worst|good|bad|broken|busted|op|nerf\w*|buff\w*|strong|weak|meta|build|spec|specs|relic|relics|item|items|rank|do|does)\b/i
export function isGrIntent(q: string): boolean {
  return GR_INTENT.test(q)
}

/** true when the channel's twitch category is Guildrun — during a guildrun stream an
 *  unqualified hero name is far likelier to be the hero than a coincidence. */
export function isGuildrunCategory(game: string | null | undefined): boolean {
  return !!game && /guild\s?run/i.test(game)
}

// --- context block ---

const KIND_LABEL: Record<GrKind, string> = {
  hero: 'hero', relic: 'relic', item: 'item', class: 'class', rankmod: 'rank modifier',
}

export function describeGrCard(c: GrCard): string {
  const bits: string[] = []
  if (c.k === 'hero') {
    if (c.c) bits.push(c.c)
    if (c.g) bits.push(`guild: ${c.g}`)
  }
  if (c.r) bits.push(c.r)
  const head = `${c.n} — guildrun ${KIND_LABEL[c.k]}${bits.length ? `, ${bits.join(', ')}` : ''}`
  const parts = [c.st, c.x].filter(Boolean)
  const body = parts.length ? `: ${parts.join('. ')}` : ''
  const specs = c.sp?.length ? ` Specs: ${c.sp.join(' | ')}` : ''
  return `${head}${body}${specs}`
}

/**
 * Grounding block for a Guildrun question — same contract as hsCardContext. '' when
 * nothing matched and the ask was not question-shaped; `grounded` true ONLY when real
 * numbers went into the prompt, because that is what licenses the stat guards to relax.
 */
export function grContext(query: string, intent: boolean): { text: string; grounded: boolean } {
  loadDisk()
  const miss = { text: '', grounded: false }
  if (!cache || cache.cards.length === 0) return miss
  const head = 'Guildrun game data (real values from the game files — relay it, never invent stats or effects):'

  const cards = findGrCards(query, intent)
  if (cards.length > 0) {
    return {
      text: `${head}\n${cards.map(describeGrCard).join('\n')}\nThese are Guildrun entities, not Bazaar or Hearthstone ones — never mix the games' terms. "X" marks a value the data does not state: describe the effect and its scaling, NEVER guess that number. The demo patches weekly, so treat stated numbers as current.`,
      grounded: true,
    }
  }

  const listing = findGrListing(query)
  if (listing) {
    const names = listing.cards.map((c) => c.n)
    return {
      text: `${head}\nGuildrun ${listing.cls ?? 'hero'}${listing.cls ? ' heroes' : 'es'}: ${names.join(', ')}. List only from these; there are no others.`,
      grounded: true,
    }
  }

  if (!intent) return miss
  // the reason this module has a miss path: a guildrun question we could not resolve.
  // left silent, the model answers a 2026 game from memory it does not have.
  return {
    text: `Guildrun data is loaded (${cache.cards.length} entries) but nothing in this question matched a name. Do NOT state any specific Guildrun hero's, relic's or item's numbers from memory — ask which one they mean, or answer only from general mechanics you are sure of.`,
    grounded: false,
  }
}

/** test seam — load a card set without touching the network or disk */
export function __setGrCards(cards: GrCard[]): void {
  cache = { fetchedAt: Date.now(), cards }
  buildIndex()
}
