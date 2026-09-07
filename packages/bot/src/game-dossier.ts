// A one-paragraph dossier for whatever game is on stream (or named in an ask) that the
// bot has no deep data for. The Bazaar, Battlegrounds and Guildrun have their own dumps;
// everything else kripp queues up (a new roguelike, an ARPG season, a Steam demo) was
// answered from model memory — fine for a 2015 title, a coin flip for a 2026 one. This is
// the anchor: genre, studio, release, price, score, the blurb and the two newest Steam news
// headlines, keyless, from Steam's store API with Wikipedia's summary as the fallback for
// titles Steam doesn't sell (WoW, League, TFT, console games).
//
// Same fail-soft contract as guildrun-news: every export returns '' on any failure, nothing
// here can throw into the ask path, nothing is awaited by a reply. The live game is
// prefetched the moment the Helix poll sees it change, so an ask lands on a warm cache.

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { writeAtomic } from './fs-util'
import { parseNewsFeed } from './guildrun-news'
import { log } from './log'

const CACHE_PATH = resolve(import.meta.dir, '../../../cache/game-dossiers.json')
const UA = 'BazaarInfo/1.0 (Twitch bot; github.com/mellen9999/bazaarinfo)'
const STATIC_TTL_MS = 7 * 24 * 60 * 60 * 1000
const NEWS_TTL_MS = 6 * 60 * 60 * 1000
const MISS_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 8_000
const MAX_ENTRIES = 100
const MAX_BLURB = 220
const MAX_LINE = 520

export interface GameDossier {
  name: string
  fetchedAt: number
  newsAt: number
  steamId?: number
  blurb: string
  genres: string[]
  devs: string[]
  released: string
  price: string
  metacritic?: number
  news: { title: string; date: string }[]
  source: 'steam' | 'wiki' | 'none'
}

let cache: Record<string, GameDossier> | null = null
const inflight = new Map<string, Promise<void>>()

// twitch categories that are not a game. the bazaar/hs/guildrun exclusions live with
// their own modules (they have real data; a blurb would only compete for budget).
const NON_GAME = new Set([
  'just chatting', 'irl', 'special events', 'talk shows & podcasts', 'games + demos', 'music', 'art',
  'sports', 'software and game development', 'co-working & studying', 'retro', 'always on', 'slots',
  'casino', 'virtual casino', 'asmr', 'pools, hot tubs, and beaches', 'food & drink', 'travel & outdoors',
  'science & technology', 'politics', 'animals, aquariums, and zoos', 'fitness & health',
  'makers & crafting', 'beauty & body art', 'crypto', 'dj', 'watch parties', 'i\'m only sleeping',
])

export function isGameCategory(game: string | null | undefined): boolean {
  if (!game) return false
  const g = game.trim().toLowerCase()
  return g.length > 0 && !NON_GAME.has(g)
}

// a game we have NO dump for. the three with real data (bazaar, hearthstone, guildrun)
// ground themselves; a blurb next to a card dump would only compete for budget.
export function isUngroundedGame(game: string | null | undefined): boolean {
  return isGameCategory(game) && !/\b(bazaar|hearthstone|guild\s?run)\b/i.test(game!)
}

// short forms chat actually types → the title steam/wikipedia know. OTHER_GAME_RE in
// ai-query.ts is the trigger; this maps its captures to a searchable name.
const ALIASES: Record<string, string> = {
  poe: 'Path of Exile', 'poe2': 'Path of Exile 2', d2: 'Diablo II', d3: 'Diablo III', d4: 'Diablo IV', diablo: 'Diablo IV',
  'diablo 2': 'Diablo II', 'diablo ii': 'Diablo II', 'diablo 3': 'Diablo III', 'diablo iii': 'Diablo III',
  'diablo 4': 'Diablo IV', 'diablo iv': 'Diablo IV',
  wow: 'World of Warcraft', warcraft: 'World of Warcraft', lol: 'League of Legends', league: 'League of Legends',
  dota: 'Dota 2', 'dota 2': 'Dota 2', 'dota2': 'Dota 2', tft: 'Teamfight Tactics', bg3: "Baldur's Gate 3",
  cs2: 'Counter-Strike 2', csgo: 'Counter-Strike 2', sc2: 'StarCraft II', osrs: 'Old School RuneScape',
  'ff14': 'Final Fantasy XIV', 'ffxiv': 'Final Fantasy XIV', 'ff7': 'Final Fantasy VII', mtg: 'Magic: The Gathering',
  // genre words, not titles: '' = no dossier (the ask still routes as other-game)
  souls: '', soulslike: '', soulsborne: '', hs: 'Hearthstone',
}

export function canonicalGameName(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/\s+/g, ' ')
  return ALIASES[key] ?? raw.trim()
}

function keyOf(name: string): string {
  return name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function loadDisk(): void {
  if (cache) return
  cache = {}
  if (!existsSync(CACHE_PATH)) return
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cache = parsed
  } catch {
    // corrupt cache = empty cache
  }
}

async function saveDisk(): Promise<void> {
  if (!cache) return
  const entries = Object.entries(cache)
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
    cache = Object.fromEntries(entries.slice(0, MAX_ENTRIES))
  }
  try { await writeAtomic(CACHE_PATH, JSON.stringify(cache)) } catch {}
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return null
    return await res.json() as T
  } catch {
    return null
  }
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…'
}

interface SteamSearchItem { type?: string; id: number; name: string }
interface SteamDetails {
  type?: string; name: string; is_free?: boolean; short_description?: string
  developers?: string[]; genres?: { description: string }[]
  release_date?: { coming_soon?: boolean; date?: string }
  price_overview?: { final_formatted?: string }; metacritic?: { score?: number }
}

// pick the store hit that IS the title, never a soundtrack/DLC that merely contains it.
export function pickSteamHit(name: string, items: SteamSearchItem[]): SteamSearchItem | null {
  const want = keyOf(name)
  const apps = items.filter((i) => (i.type ?? 'app') === 'app')
  return apps.find((i) => keyOf(i.name) === want)
    ?? apps.find((i) => keyOf(i.name).startsWith(want) && !/soundtrack|dlc|pack|bundle|demo/i.test(i.name))
    ?? null
}

async function fromSteam(name: string): Promise<GameDossier | null> {
  const search = await getJson<{ items?: SteamSearchItem[] }>(
    `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&l=english&cc=US`,
  )
  const hit = search?.items ? pickSteamHit(name, search.items) : null
  if (!hit) return null
  const details = await getJson<Record<string, { success?: boolean; data?: SteamDetails }>>(
    `https://store.steampowered.com/api/appdetails?appids=${hit.id}&cc=us&l=english`,
  )
  const d = details?.[String(hit.id)]?.data
  if (!d || d.type !== 'game') return null
  const price = d.is_free ? 'free' : d.price_overview?.final_formatted ?? (d.release_date?.coming_soon ? 'unreleased' : '')
  return {
    name: (d.name || hit.name).replace(/[®™]/g, '').trim(),
    fetchedAt: Date.now(),
    newsAt: 0,
    steamId: hit.id,
    blurb: clip(d.short_description ?? '', MAX_BLURB),
    genres: (d.genres ?? []).map((g) => g.description.toLowerCase()).slice(0, 3),
    devs: (d.developers ?? []).slice(0, 2),
    released: d.release_date?.date ?? '',
    price,
    metacritic: d.metacritic?.score,
    news: [],
    source: 'steam',
  }
}

interface WikiSummary { type?: string; title?: string; description?: string; extract?: string }

async function fromWiki(name: string): Promise<GameDossier | null> {
  const titles = [name, `${name} (video game)`]
  for (const t of titles) {
    const w = await getJson<WikiSummary>(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.replace(/ /g, '_'))}`)
    if (!w?.extract || w.type === 'disambiguation') continue
    // a summary that never says game/played is some other article with the same name
    if (!/\b(game|played|players?|gameplay|developed|publish)/i.test(`${w.description ?? ''} ${w.extract}`)) continue
    return {
      name: (w.title || name).replace(/\s*\([^)]*\)\s*$/, ''),
      fetchedAt: Date.now(),
      newsAt: Date.now(),
      blurb: clip(w.extract, MAX_BLURB + 60),
      genres: w.description ? [w.description.toLowerCase()] : [],
      devs: [],
      released: '',
      price: '',
      news: [],
      source: 'wiki',
    }
  }
  return null
}

async function refreshNews(d: GameDossier): Promise<void> {
  if (!d.steamId) return
  try {
    const res = await fetch(`https://store.steampowered.com/feeds/news/app/${d.steamId}/`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return
    const items = parseNewsFeed(await res.text())
    d.news = items.slice(0, 2).map((i) => ({ title: clip(i.title, 60), date: i.date }))
    d.newsAt = Date.now()
  } catch {}
}

async function build(name: string): Promise<void> {
  loadDisk()
  const key = keyOf(name)
  const prev = cache![key]
  const now = Date.now()
  const staticFresh = prev && now - prev.fetchedAt < (prev.source === 'none' ? MISS_TTL_MS : STATIC_TTL_MS)
  let d = staticFresh ? prev : null
  if (!d) {
    d = (await fromSteam(name)) ?? (await fromWiki(name)) ?? {
      name, fetchedAt: now, newsAt: now, blurb: '', genres: [], devs: [], released: '', price: '', news: [], source: 'none' as const,
    }
    log(`game-dossier: ${name} → ${d.source}${d.steamId ? ` (steam ${d.steamId})` : ''}`)
  }
  if (d.steamId && now - d.newsAt > NEWS_TTL_MS) await refreshNews(d)
  cache![key] = d
  await saveDisk()
}

/** non-blocking warmup — the helix poll calls this on every game change, asks call it for a named title. */
export function prefetchGameDossier(name: string | null | undefined): void {
  if (!name) return
  const canon = canonicalGameName(name)
  // the three with dumps ground themselves — a wikipedia blurb beside live card data would
  // outrank it at this tier and could contradict it
  if (!isUngroundedGame(canon)) return
  const key = keyOf(canon)
  if (!key || inflight.has(key)) return
  loadDisk()
  const prev = cache![key]
  const now = Date.now()
  if (prev) {
    const staticFresh = now - prev.fetchedAt < (prev.source === 'none' ? MISS_TTL_MS : STATIC_TTL_MS)
    const newsFresh = !prev.steamId || now - prev.newsAt < NEWS_TTL_MS
    if (staticFresh && newsFresh) return
  }
  inflight.set(key, build(canon).catch((e) => log(`game-dossier: ${canon} failed: ${e}`)).finally(() => { inflight.delete(key) }))
}

export function getGameDossier(name: string | null | undefined): GameDossier | null {
  if (!name) return null
  const canon = canonicalGameName(name)
  if (!isUngroundedGame(canon)) return null
  loadDisk()
  const d = cache![keyOf(canon)]
  // read-through refresh: a title streamed for weeks would otherwise serve day-0 news
  // forever (the helix poll only warms on a game CHANGE). no-op while fresh, never awaited.
  if (d) prefetchGameDossier(canon)
  return d && d.source !== 'none' ? d : null
}

/** the prompt line. `label` says why it's here: on stream vs named in the ask. */
export function formatGameDossier(d: GameDossier, label: 'on stream' | 'asked about'): string {
  const meta: string[] = []
  if (d.genres.length) meta.push(d.genres.join('/'))
  if (d.devs.length) meta.push(d.devs.join(', '))
  if (d.released) meta.push(d.released)
  if (d.price) meta.push(d.price)
  if (typeof d.metacritic === 'number') meta.push(`metacritic ${d.metacritic}`)
  const head = `Game ${label}: ${d.name}${meta.length ? ` (${meta.join('; ')})` : ''}`
  const news = d.news.length ? ` steam news: ${d.news.map((n) => `"${n.title}"${n.date ? ` (${n.date})` : ''}`).join('; ')}.` : ''
  // the rule rides OUTSIDE the clip so a long blurb can never truncate it away. it is the
  // whole point for a live-service title: the blurb anchors genre and studio, but heroes,
  // abilities and patch history are exactly what the model half-remembers and states as fact
  // (live 2026-09-07: a hero's ult given a stun it does not have, then "mains have been
  // begging valve since beta").
  const rule = ' these facts are the anchor, never contradict them. beyond them say only what you actually know — heroes/abilities/numbers/patch history you cant vouch for: "not sure", never invented.'
  const line = clip(`${head}${d.blurb ? ` — ${d.blurb}` : ''}${news}`, MAX_LINE - rule.length)
  return `${line}${rule}`
}

export function getGameDossierLine(name: string | null | undefined, label: 'on stream' | 'asked about'): string {
  const d = getGameDossier(name)
  return d ? formatGameDossier(d, label) : ''
}

/** test seam */
export function __setGameDossierForTest(entries: Record<string, GameDossier> | null): void {
  cache = entries ? Object.fromEntries(Object.entries(entries).map(([k, v]) => [keyOf(k), v])) : {}
}
