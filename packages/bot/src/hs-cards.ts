import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { log } from './log'
import { STOP_WORDS, ENTITY_SKIP, COMMON_WORDS } from './ai-query'

// hearthstone battlegrounds CARD data — the companion to hs.ts, which only ever knew the
// ranked leaderboard. same reason it exists: kripp's chat is a hearthstone chat, and a
// "what does brann do" got either a dodge or the model's own memory, which is exactly the
// unreliable-recall failure the Bazaar side has guards against.
//
// source is HearthstoneJSON's card dump — the community mirror of blizzard's own card
// definitions. keyless, no OAuth, no third-party tracker, updated on patch day. blizzard's
// official card API needs a battle.net client id/secret, which is why it is not the source.
//
// SCOPE, stated plainly because it bounds every answer: the dump flags which minions and
// tavern spells are in the CURRENT rotating pool and which heroes are in the hero pool.
// nothing flags rotation for trinkets, buddies, anomalies, quest rewards or dark gifts —
// so those are carried with their real text and NO claim about whether they're offered
// right now. saying "i have the card, not the rotation" is honest; guessing is not.
//
// fail-soft like every other live source here: every export returns ''/[] on any failure,
// so a HearthstoneJSON outage can never crash the bot or invent a card.

const CACHE_PATH = resolve(import.meta.dir, '../../../cache/hs-cards.json')
const UA = 'BazaarInfo/1.0 (Twitch bot; github.com/mellen9999/bazaarinfo)'
const DUMP_URL = 'https://api.hearthstonejson.com/v1/latest/enUS/cards.json'

const TTL_MS = 24 * 60 * 60 * 1000 // card data changes on patch day, not hourly
const FETCH_TIMEOUT_MS = 60_000 // the full dump is ~10MB
const MAX_BYTES = 64 * 1024 * 1024 // a shape change must not turn into an unbounded download
const MAX_CARDS = 4 // context budget: nobody asks about five cards in one twitch message

export type HsKind = 'minion' | 'spell' | 'hero' | 'trinket' | 'buddy' | 'anomaly' | 'reward' | 'gift'

/** trimmed card record. short keys — the cache is written to disk on every refresh. */
export interface HsCard {
  n: string // name
  k: HsKind
  t?: number // tavern tier (techLevel)
  r?: string // tribe(s), slash-joined, game-facing spelling
  a?: number // attack
  h?: number // health
  x?: string // rules text (or hero power, for heroes)
  p?: 1 // flagged as in the current pool (minions, tavern spells, heroes only)
  d?: 1 // duos-exclusive
  e?: 1 // legendary/elite
  ar?: number // hero starting armor
  bd?: string // hero's buddy
  s?: string // trinket size: lesser / greater
}

interface HsCardCache {
  fetchedAt: number
  cards: HsCard[]
  /** card id -> name, for resolving what the companion reads out of Hearthstone's log.
   *  broader than `cards`: the log names tokens, golden copies and hero skins that are
   *  never worth a lookup of their own but must still be nameable on a live board. */
  ids?: Record<string, string>
}

let cache: HsCardCache | null = null
let refreshing: Promise<void> | null = null

// --- dump parsing (pure — the whole filter is testable without the network) ---

// blizzard's internal race names vs what players actually say in chat
const TRIBES: Record<string, string> = {
  MURLOC: 'Murloc', DEMON: 'Demon', BEAST: 'Beast', MECHANICAL: 'Mech', DRAGON: 'Dragon',
  PIRATE: 'Pirate', ELEMENTAL: 'Elemental', QUILBOAR: 'Quilboar', NAGA: 'Naga',
  UNDEAD: 'Undead', ALL: 'All tribes',
}

function cleanText(s: unknown): string | undefined {
  if (typeof s !== 'string') return undefined
  const out = s
    .replace(/\[x\]/g, '')
    .replace(/<[^>]+>/g, '')
    // a handful of cards ship two upgrade states glued together by a bare digit with no
    // spaces ("…this game.5Destroy a friendly Undead…"). keep the first state; the second
    // reads as a contradiction of the first and is not a separate card.
    .split(/(?<=[.!?)])\d(?=[A-Z])/)[0]
    .replace(/\s+/g, ' ')
    .trim()
  return out || undefined
}

function tribesOf(entry: any): string | undefined {
  const raw: string[] = Array.isArray(entry?.races) ? entry.races : entry?.race ? [entry.race] : []
  const named = raw.map((r) => TRIBES[r] ?? r).filter(Boolean)
  return named.length ? named.join('/') : undefined
}

// BG card ids encode the patch they shipped in (BG30_…, BG36_…). used only to pick the
// newest reprint when a trinket name appears in more than one season.
function patchOf(entry: any): number {
  const m = typeof entry?.id === 'string' ? entry.id.match(/^BG(\d+)/) : null
  return m ? Number(m[1]) : 0
}

/**
 * Every Battlegrounds-reachable card id mapped to its name.
 *
 * The companion sends raw card ids off the game log rather than names, so the mapping
 * lives here where it is refreshed daily — a rotation, a new token or a new hero skin
 * then needs no new companion build on anyone's machine.
 */
export function extractIdNames(dump: unknown[]): Record<string, string> {
  if (!Array.isArray(dump)) return {}
  const out: Record<string, string> = {}
  for (const raw of dump as any[]) {
    if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string') continue
    if (raw.type !== 'MINION' && raw.type !== 'HERO') continue
    if (!/^(?:BG|TB_Bacon)/.test(raw.id) && raw.set !== 'BATTLEGROUNDS') continue
    out[raw.id] = raw.name
  }
  return out
}

/**
 * Reduce the full HearthstoneJSON dump to the Battlegrounds cards, trimmed to what a chat
 * answer actually needs. Tolerant by design: a renamed field costs one card's detail, never
 * the whole refresh.
 */
export function extractBgCards(dump: unknown[]): HsCard[] {
  if (!Array.isArray(dump)) return []
  const byDbf = new Map<number, any>()
  for (const c of dump) if (c && typeof (c as any).dbfId === 'number') byDbf.set((c as any).dbfId, c)

  const out: HsCard[] = []
  const seen = new Set<string>()
  const push = (card: HsCard) => {
    if (!card.n) return
    const key = `${card.k}|${card.n.toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(card)
  }
  const named = (dbf: unknown): string | undefined => {
    const c = typeof dbf === 'number' ? byDbf.get(dbf) : null
    return typeof c?.name === 'string' ? c.name : undefined
  }
  const pick = (f: (c: any) => boolean) => (dump as any[]).filter((c) => c && f(c))

  // minions and tavern spells carry an explicit "is in the pool right now" flag — the only
  // rotation signal the dump publishes, and the reason those two get a `p` and nothing else does.
  for (const c of pick((c) => c.isBattlegroundsPoolMinion === true)) {
    push({
      n: c.name, k: 'minion', t: c.techLevel, r: tribesOf(c),
      a: c.attack, h: c.health, x: cleanText(c.text), p: 1,
      e: c.elite ? 1 : undefined, d: c.isBattlegroundsDuosExclusive ? 1 : undefined,
    })
  }
  for (const c of pick((c) => c.isBattlegroundsPoolSpell === true)) {
    push({ n: c.name, k: 'spell', t: c.techLevel, x: cleanText(c.text), p: 1, d: c.isBattlegroundsDuosExclusive ? 1 : undefined })
  }
  // a hero is only useful with its hero power, which lives in a separate card — resolve it
  // here so the cache is self-contained and a lookup never has to chase a dbfId.
  for (const c of pick((c) => c.battlegroundsHero === true)) {
    const hp = byDbf.get(c.heroPowerDbfId)
    const power = hp
      ? `${hp.name}${typeof hp.cost === 'number' ? ` (${hp.cost} gold)` : ''}: ${cleanText(hp.text) ?? '?'}`
      : undefined
    push({ n: c.name, k: 'hero', ar: c.armor, x: power, bd: named(c.battlegroundsBuddyDbfId), p: 1 })
  }
  // trinkets reprint across seasons under the same name — newest text wins, so sort by patch
  // descending and let the first-write-wins dedupe above keep it.
  for (const c of pick((c) => c.type === 'BATTLEGROUND_TRINKET').sort((a, b) => patchOf(b) - patchOf(a))) {
    const size = c.spellSchool === 'GREATER_TRINKET' ? 'greater' : c.spellSchool === 'LESSER_TRINKET' ? 'lesser' : undefined
    const races: string[] = Array.isArray(c.battlegroundsAssociatedRaces) ? c.battlegroundsAssociatedRaces : []
    push({
      n: c.name, k: 'trinket', x: cleanText(c.text), s: size,
      r: races.map((r) => TRIBES[r] ?? r).join('/') || undefined,
    })
  }
  // golden buddies duplicate their normal copy under the same name — battlegroundsNormalDbfId
  // is only set on the golden one, so skipping it keeps the base card's real stats.
  for (const c of pick((c) => c.isBattlegroundsBuddy === true && !c.battlegroundsNormalDbfId)) {
    push({ n: c.name, k: 'buddy', t: c.techLevel, r: tribesOf(c), a: c.attack, h: c.health, x: cleanText(c.text) })
  }
  for (const c of pick((c) => c.type === 'BATTLEGROUND_ANOMALY')) push({ n: c.name, k: 'anomaly', x: cleanText(c.text) })
  for (const c of pick((c) => c.type === 'BATTLEGROUND_QUEST_REWARD')) push({ n: c.name, k: 'reward', x: cleanText(c.text) })
  for (const c of pick((c) => c.isBattlegroundsDarkGift === true)) push({ n: c.name, k: 'gift', x: cleanText(c.text) })

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

async function refresh(): Promise<void> {
  let cards: HsCard[] = []
  let ids: Record<string, string> = {}
  try {
    const res = await fetch(DUMP_URL, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const len = Number(res.headers.get('content-length'))
    if (Number.isFinite(len) && len > MAX_BYTES) throw new Error(`dump too large (${len} bytes)`)
    const dump = await res.json() as unknown[]
    cards = extractBgCards(dump)
    ids = extractIdNames(dump)
  } catch (e) {
    log(`hs-cards: refresh failed: ${e}`)
    return
  }
  // an empty extract means HearthstoneJSON reshaped its fields — keep the old cards, which
  // are still true for every card that did not change, rather than going blind.
  if (cards.length === 0) {
    log('hs-cards: extract produced no cards, keeping previous cache')
    return
  }
  cache = { fetchedAt: Date.now(), cards, ids }
  buildIndex()
  try {
    writeFileSync(CACHE_PATH, JSON.stringify(cache))
  } catch {
    // memory cache still works; disk is only a warm-start optimisation
  }
  const pool = cards.filter((c) => c.p).length
  log(`hs-cards: ${cards.length} battlegrounds cards (${pool} flagged in the current pool), ${Object.keys(ids).length} ids`)
}

/** non-blocking, same contract as refreshHsIfNeeded — this turn answers from what we have. */
export function refreshHsCardsIfNeeded(): void {
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

// a single word only stands in for a card when it is distinctive. these are the words that
// appear inside a BG card name AND in ordinary chat — "What Are the Odds?", "Them Apples",
// "Well Wisher" would otherwise fire on half of everything anyone types.
const TOKEN_STOP = new Set<string>([
  ...STOP_WORDS, ...ENTITY_SKIP, ...COMMON_WORDS,
  'blood', 'deep', 'drake', 'gold', 'golden', 'great', 'hand', 'head', 'lord', 'mama',
  'master', 'might', 'mind', 'open', 'ring', 'ship', 'shop', 'snow', 'soul', 'wave',
  'wind', 'curse', 'dark', 'many', 'roll', 'magic', 'path', 'sign', 'tide', 'wise',
  'odds', 'apples', 'wisher', 'standing', 'apple', 'sushi', 'chimes', 'pouch', 'scroll',
  // battlegrounds vocabulary — the words the question is made of, never the answer
  'minion', 'minions', 'tavern', 'tier', 'tiers', 'triple', 'tripled', 'buddy', 'buddies',
  'trinket', 'trinkets', 'anomaly', 'anomalies', 'hero', 'heroes', 'power', 'powers',
  'battlegrounds', 'hearthstone', 'lobby', 'refresh', 'reroll', 'freeze', 'combat', 'board',
  // tribe names belong to the listing path, not the nickname path — "murlocs any good" is a
  // question about the tribe, not about the anomaly literally called "Oops, All Murlocs!"
  'murloc', 'murlocs', 'demon', 'demons', 'beast', 'beasts', 'mech', 'mechs', 'mechanical',
  'dragon', 'dragons', 'pirate', 'pirates', 'elemental', 'elementals', 'quilboar', 'quilboars',
  'naga', 'nagas', 'undead',
])

let byName = new Map<string, HsCard[]>()
let bySquash = new Map<string, HsCard[]>()
let byToken = new Map<string, HsCard[]>()

function add(map: Map<string, HsCard[]>, key: string, card: HsCard): void {
  const list = map.get(key)
  if (list) list.push(card)
  else map.set(key, [card])
}

function buildIndex(): void {
  byName = new Map()
  bySquash = new Map()
  byToken = new Map()
  for (const card of cache?.cards ?? []) {
    const n = norm(card.n)
    if (!n) continue
    add(byName, n, card)
    add(bySquash, squash(card.n), card)
    // only heroes and legendary minions get a one-word nickname. that is the set chat
    // actually shortens ("brann", "rokara", "titus"), and it is also the set whose names are
    // proper nouns — everything else is an ordinary English phrase, which is how a buddy
    // called "Broken Horn" answered "are undead broken in bg". a stopword list alone can
    // never close that off; restricting WHICH cards have nicknames does.
    if (card.k !== 'hero' && !card.e) continue
    for (const w of n.split(' ')) {
      if (w.length >= 4 && !TOKEN_STOP.has(w)) add(byToken, w, card)
    }
  }
}

// a card the current pool still offers outranks one that may have rotated out, and a
// longer name match outranks a one-word nickname.
function rank(a: HsCard, b: HsCard): number {
  return (b.p ?? 0) - (a.p ?? 0) || b.n.length - a.n.length
}

/**
 * Cards named in a query. Three passes, most specific first: the full name, a single
 * spacing-insensitive token ("capnhoggarr"), then a distinctive one-word nickname
 * ("brann"). Pure over the loaded index so every rule is testable offline.
 */
export function findHsCards(query: string): HsCard[] {
  if (!byName.size) return []
  const n = norm(query)
  if (!n) return []
  const tokens = n.split(' ')
  const hits = new Map<string, HsCard>()
  const take = (cards: HsCard[] | undefined) => {
    for (const c of cards ?? []) hits.set(`${c.k}|${c.n}`, c)
  }

  // full name, as a whole-word run inside the query. a one-word card name that is also an
  // ordinary word ("Buddies", "Quests" are both dark gifts) is skipped here for the same
  // reason it is kept out of the token index — the question is made of those words.
  const padded = ` ${n} `
  for (const [name, cards] of byName) {
    if (!name.includes(' ') && TOKEN_STOP.has(name)) continue
    if (padded.includes(` ${name} `)) take(cards)
  }
  // one token that IS the name with the spaces taken out — "bubblegum" for "Bubble Gum"
  for (const t of tokens) {
    if (t.length >= 6) take(bySquash.get(t))
  }
  // distinctive single word standing in for the whole name. a word that pulls in a crowd is
  // not a nickname, it's a coincidence — "portrait" must not drag in every trinket.
  if (hits.size === 0) {
    for (const t of tokens) {
      const cards = byToken.get(t)
      if (cards && cards.length <= 3) take(cards)
    }
  }
  return [...hits.values()].sort(rank).slice(0, MAX_CARDS)
}

// --- tier / tribe listings ---

const TRIBE_WORDS: Record<string, string> = {
  murloc: 'Murloc', murlocs: 'Murloc', demon: 'Demon', demons: 'Demon', beast: 'Beast',
  beasts: 'Beast', mech: 'Mech', mechs: 'Mech', mechanical: 'Mech', dragon: 'Dragon',
  dragons: 'Dragon', pirate: 'Pirate', pirates: 'Pirate', elemental: 'Elemental',
  elementals: 'Elemental', quilboar: 'Quilboar', quilboars: 'Quilboar', naga: 'Naga',
  nagas: 'Naga', undead: 'Undead',
}

interface Listing { tier: number | null; tribe: string | null; cards: HsCard[] }

/** "what's on tier 6", "list the murlocs" — pool minions only, so a rotated-out card can
 *  never appear in a list the model will read as "what you can be offered". */
export function findHsListing(query: string): Listing | null {
  const n = norm(query)
  const tierMatch = n.match(/\b(?:tier|tavern tier|t)\s*([1-7])\b/) ?? n.match(/\b([1-7])\s*(?:drop|tier)\b/)
  const tier = tierMatch ? Number(tierMatch[1]) : null
  let tribe: string | null = null
  for (const w of n.split(' ')) {
    if (TRIBE_WORDS[w]) { tribe = TRIBE_WORDS[w]; break }
  }
  if (tier == null && !tribe) return null
  const cards = (cache?.cards ?? []).filter((c) =>
    c.p && c.k === 'minion'
    && (tier == null || c.t === tier)
    && (!tribe || (c.r ?? '').split('/').includes(tribe)),
  )
  return cards.length ? { tier, tribe, cards } : null
}

// --- routing ---

// a hearthstone/battlegrounds question. deliberately does NOT include bare tribe names or
// "minion" on their own — this bot's home game is The Bazaar, and a query has to actually
// name hearthstone before its card data outranks the Bazaar dump.
const HS_SIGNAL = /\b(?:hearthstone|hs|battlegrounds?|bgs?|bob'?s tavern|tavern tier|hero power|golden(?:s)? (?:copy|minion)|triple[sd]?|bartender|refresh(?:es)? the tavern)\b/i
export function isHsCardQuery(q: string): boolean {
  return HS_SIGNAL.test(q)
}

// asking ABOUT something, rather than just mentioning battlegrounds. this is what decides
// whether an unresolved BG question gets the don't-answer-from-memory line or silence, so
// it deliberately leaves out bare "is"/"does" — "bgs is rigged" is a mood, not a question.
// kept here rather than reusing glossary's DEFINITIONAL_INTENT, which needs the apostrophe
// in "what's" and so misses the way chat actually types.
const HS_CARD_INTENT =
  /\b(what|whats|which|how|why|explain|define|tell me about|stats?|tier|tiers|text|ability|abilities|effect|synerg\w*|counters?|worth|best|worst|good|bad|broken|busted|op|nerf\w*|buff\w*|strong|weak|meta)\b/i
export function isHsCardIntent(q: string): boolean {
  return HS_CARD_INTENT.test(q)
}

/** true when the channel's twitch category is Hearthstone — during a BG stream, an
 *  unqualified card name is far likelier to be a BG card than a coincidence. */
export function isHearthstoneCategory(game: string | null | undefined): boolean {
  return !!game && /hearthstone/i.test(game)
}

// --- context block ---

const KIND_LABEL: Record<HsKind, string> = {
  minion: 'minion', spell: 'tavern spell', hero: 'hero', trinket: 'trinket',
  buddy: 'buddy', anomaly: 'anomaly', reward: 'quest reward', gift: 'dark gift',
}

export function describeHsCard(c: HsCard): string {
  const bits: string[] = []
  if (c.k === 'hero') {
    if (typeof c.ar === 'number') bits.push(`${c.ar} starting armor`)
    if (c.bd) bits.push(`buddy: ${c.bd}`)
  } else {
    if (c.t) bits.push(`tier ${c.t}`)
    if (c.s) bits.push(`${c.s} trinket`)
    if (c.r) bits.push(c.r)
    if (typeof c.a === 'number' && typeof c.h === 'number') bits.push(`${c.a}/${c.h}`)
    if (c.e) bits.push('legendary')
    if (c.d) bits.push('duos only')
  }
  const head = `${c.n} — BG ${KIND_LABEL[c.k]}${bits.length ? `, ${bits.join(', ')}` : ''}`
  const body = c.x ? `: ${c.x}` : ''
  // only minions, tavern spells and heroes carry a rotation flag; saying nothing for the
  // rest is the honest shape — see the module header.
  const pool = c.p ? ' [in the current pool]' : ''
  return `${head}${body}${pool}`
}

const NO_ROTATION_NOTE =
  ' Cards without "[in the current pool]" have no rotation flag in the data — give the text, but never claim whether they are offered right now.'

/**
 * Grounding block for a Hearthstone Battlegrounds question. '' when nothing matched and the
 * ask was not card-shaped, so there is nothing for the model to hallucinate from.
 *
 * `cardIntent` marks a "what does X do" ask: those get an explicit no-data line instead of
 * silence, because silence is what lets the model answer BG questions from memory.
 *
 * `grounded` is the caller's licence to relax the invented-stats guards: true ONLY when real
 * card numbers went into the prompt. The miss line carries no numbers, so it must never
 * disarm the guard that exists to catch exactly the answer it is warning about.
 */
export function hsCardContext(query: string, cardIntent: boolean): { text: string; grounded: boolean } {
  loadDisk()
  const miss = { text: '', grounded: false }
  if (!cache || cache.cards.length === 0) return miss
  const head = 'Hearthstone Battlegrounds card data (real card text — relay it, never invent stats, text or tiers):'

  const cards = findHsCards(query)
  if (cards.length > 0) {
    return {
      text: `${head}\n${cards.map(describeHsCard).join('\n')}\nThese are Hearthstone cards, not Bazaar cards — never mix the two games' terms.${NO_ROTATION_NOTE}`,
      grounded: true,
    }
  }

  const listing = findHsListing(query)
  if (listing) {
    const what = [listing.tier ? `Tier ${listing.tier}` : null, listing.tribe ?? 'minion']
      .filter(Boolean).join(' ')
    const names = listing.cards.map((c) => c.n)
    const shown = names.slice(0, 24)
    const more = names.length > shown.length ? ` (${shown.length} of ${names.length})` : ''
    return {
      text: `${head}\n${what}s in the current pool${more}: ${shown.join(', ')}. List only from these; there are no others.`,
      grounded: true,
    }
  }

  if (!cardIntent) return miss
  // the important case, and the whole reason this module has a miss path: a BG card question
  // we could not resolve. left silent, the model answers it from memory and is confidently
  // wrong — the same failure the Bazaar side has had a NO GAME DATA guard for all along.
  return {
    text: `Hearthstone Battlegrounds card data is loaded (${cache.cards.length} cards) but nothing in this question matched a card name. Do NOT state any specific BG card's stats, text, tier or tribe from memory — ask which card they mean.`,
    grounded: false,
  }
}

/**
 * Name for a card id straight off the game log, or null when the dump doesn't know it.
 *
 * null rather than the raw id: "BG29_843" in a chat reply is worse than saying nothing,
 * and a card the dump has never heard of is one this patch removed.
 */
export function hsCardName(id: string): string | null {
  loadDisk()
  return cache?.ids?.[id] ?? null
}

/** test seam — load a card set without touching the network or disk */
export function __setHsCards(cards: HsCard[], ids: Record<string, string> = {}): void {
  cache = { fetchedAt: Date.now(), cards, ids }
  buildIndex()
}
