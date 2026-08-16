import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { log } from './log'

// hearthstone battlegrounds standings from blizzard's own public leaderboard JSON — the
// same endpoint the official leaderboards page reads. no key, no OAuth, no third-party
// tracker (see the vod-backfill note: scraping trackers gets datacenter IPs blocked).
//
// mirrors the worldcup.ts/patch.ts fail-soft contract: every export returns ''/null on any
// failure, so a blizzard hiccup can never crash the bot or invent a rating.
//
// WHY THIS EXISTS: chat asked "whats kripps current BG rating" and the bot dodged with
// "THIS is bazaar chat not hearthstone's". kripp's audience is a hearthstone audience —
// the dodge was the bug. this makes the honest answer available.
//
// SCOPE, stated plainly because it bounds every answer: blizzard publishes only the RANKED
// leaderboard — roughly the top few hundred per region early in a season, growing to a few
// thousand later. a player who isn't on it has no public rating ANYWHERE; that is a real
// "not published", never a "we couldn't find it". the code says so rather than guessing.

const CACHE_PATH = resolve(import.meta.dir, '../../../cache/hs-leaderboard.json')
const UA = 'BazaarInfo/1.0 (Twitch bot; github.com/mellen9999/bazaarinfo)'
const API = 'https://hearthstone.blizzard.com/en-us/api/community/leaderboardsData'
const REGIONS = ['US', 'EU', 'AP'] as const
// omitting seasonId makes blizzard serve the CURRENT season — never hardcode one, or the
// bot silently reports a dead season's numbers the day a new one starts.
const MODES = { battlegrounds: 'BG', battlegroundsduo: 'BG duos' } as const
type Mode = keyof typeof MODES

const TTL_MS = 6 * 60 * 60 * 1000 // leaderboards move slowly; 6h is plenty
const HARD_STALE_MS = 72 * 60 * 60 * 1000 // past this, say the data is old rather than assert it
const MAX_PAGES = 80 // guard: a shape change must not turn into an unbounded fetch loop
const PAGE_CONCURRENCY = 5
const FETCH_TIMEOUT_MS = 8000

export interface HsEntry {
  name: string
  rank: number
  rating: number
  region: string
  mode: Mode
}

interface HsCache {
  fetchedAt: number
  seasons: Partial<Record<Mode, number>>
  entries: HsEntry[]
}

let cache: HsCache | null = null
let refreshing: Promise<void> | null = null

function loadDisk(): void {
  if (cache || !existsSync(CACHE_PATH)) return
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
    if (parsed && Array.isArray(parsed.entries)) cache = parsed
  } catch {
    // a corrupt cache is the same as no cache — refetch, never crash on it
  }
}

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// one region+mode, every page. blizzard returns 25 rows/page and tells us the total.
async function fetchBoard(region: string, mode: Mode): Promise<{ entries: HsEntry[]; season: number | null }> {
  const first = await getJson(`${API}?region=${region}&leaderboardId=${mode}&page=1`)
  const lb = first?.leaderboard
  if (!lb || !Array.isArray(lb.rows)) return { entries: [], season: null }

  const season = typeof first.seasonId === 'number' ? first.seasonId : null
  const pages = Math.min(Number(lb.pagination?.totalPages) || 1, MAX_PAGES)
  const out: HsEntry[] = []
  const take = (rows: unknown[]) => {
    for (const r of rows as any[]) {
      // trust nothing about the shape — a renamed field must yield zero rows, not NaN ratings
      if (typeof r?.accountid !== 'string' || typeof r?.rating !== 'number' || typeof r?.rank !== 'number') continue
      out.push({ name: r.accountid, rank: r.rank, rating: r.rating, region, mode })
    }
  }
  take(lb.rows)

  // pages 2..n, a few at a time — polite to blizzard, and one slow page can't stall the set
  const rest = Array.from({ length: pages - 1 }, (_, i) => i + 2)
  for (let i = 0; i < rest.length; i += PAGE_CONCURRENCY) {
    const batch = rest.slice(i, i + PAGE_CONCURRENCY)
    const results = await Promise.all(
      batch.map((p) => getJson(`${API}?region=${region}&leaderboardId=${mode}&page=${p}`)),
    )
    for (const j of results) if (Array.isArray(j?.leaderboard?.rows)) take(j.leaderboard.rows)
  }
  return { entries: out, season }
}

async function refresh(): Promise<void> {
  const entries: HsEntry[] = []
  const seasons: Partial<Record<Mode, number>> = {}
  for (const mode of Object.keys(MODES) as Mode[]) {
    for (const region of REGIONS) {
      const { entries: e, season } = await fetchBoard(region, mode)
      entries.push(...e)
      if (season != null) seasons[mode] = season
    }
  }
  // an empty sweep means blizzard is down or reshaped — keep the old cache, which is still
  // truthful with an age caveat, rather than replacing it with nothing
  if (entries.length === 0) {
    log('hs: leaderboard fetch returned nothing, keeping previous cache')
    return
  }
  cache = { fetchedAt: Date.now(), seasons, entries }
  try {
    writeFileSync(CACHE_PATH, JSON.stringify(cache))
  } catch {
    // memory cache still works; disk is only a warm-start optimisation
  }
  log(`hs: leaderboard refreshed — ${entries.length} ranked players across ${REGIONS.length} regions`)
}

// call before an AI turn (same shape as refreshWorldCupIfNeeded). never blocks the reply:
// a cold or stale cache kicks off a background refresh and this turn answers from what we
// have, because a late-but-correct rating beats a slow one.
export function refreshHsIfNeeded(): void {
  loadDisk()
  const age = cache ? Date.now() - cache.fetchedAt : Infinity
  if (age < TTL_MS || refreshing) return
  refreshing = refresh()
    .catch(() => {})
    .finally(() => {
      refreshing = null
    })
}

// battletags are matched case-insensitively; blizzard stores the display form.
function norm(s: string): string {
  return s.trim().toLowerCase()
}

// chat asks by stream name; blizzard indexes by battletag, and there is no public
// twitch→battletag lookup. so this is a small hand-kept map — guessing one would pin a
// stranger's rating on someone, which is the one mistake this module must never make.
// add an entry only when the streamer has stated the tag themselves.
const ALIASES: Record<string, string> = {
  kripp: 'LettuceKing',
  nl_kripp: 'LettuceKing',
  kripparrian: 'LettuceKing',
}

// resolve a chat-name to a battletag. tolerates the apostrophe-less possessive chat types.
export function resolveAlias(name: string): string {
  const n = norm(name)
  if (ALIASES[n]) return ALIASES[n]
  if (n.length > 3 && n.endsWith('s') && ALIASES[n.slice(0, -1)]) return ALIASES[n.slice(0, -1)]
  return name
}

// pure matcher — kept separate from the cache so every matching rule is testable without
// touching blizzard or the disk. a player can hold entries in several regions at once.
export function matchPlayer(entries: HsEntry[], name: string): HsEntry[] {
  const n = norm(name)
  if (!n) return []
  const byRank = (a: HsEntry, b: HsEntry) => a.rank - b.rank
  const exact = entries.filter((e) => norm(e.name) === n)
  if (exact.length) return exact.sort(byRank)
  // chat types "kripps rating" without the apostrophe, so a bare possessive-looking name
  // gets one retry without its trailing s — but only if that exact battletag really exists
  if (n.length > 3 && n.endsWith('s')) {
    const trimmed = entries.filter((e) => norm(e.name) === n.slice(0, -1))
    if (trimmed.length) return trimmed.sort(byRank)
  }
  // a prefix match only counts when it's unambiguous — "dog" must never resolve to
  // "dogdog" and report a stranger's rating as someone's own
  const pre = entries.filter((e) => norm(e.name).startsWith(n))
  const names = new Set(pre.map((e) => norm(e.name)))
  return names.size === 1 ? pre.sort(byRank) : []
}

export function lookupPlayer(name: string): HsEntry[] {
  loadDisk()
  return cache ? matchPlayer(cache.entries, name) : []
}

export function topPlayers(mode: Mode, region: string | null, limit = 3): HsEntry[] {
  loadDisk()
  if (!cache) return []
  return cache.entries
    .filter((e) => e.mode === mode && (!region || e.region === region))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
}

// is this a hearthstone battlegrounds rating/leaderboard question?
const BG_RE = /\b(?:battlegrounds?|bgs?|hearthstone|hs)\b/i
const RATING_RE = /\b(?:rating|mmr|rank(?:ed|ing)?|leaderboard|elo|standings?|top\s*\d*|number\s*(?:one|1)|#\s*1)\b/i
export function isHsRatingQuery(q: string): boolean {
  return BG_RE.test(q) && RATING_RE.test(q)
}

function ageNote(): string {
  if (!cache) return ''
  const age = Date.now() - cache.fetchedAt
  if (age < HARD_STALE_MS) return ''
  return ` (leaderboard snapshot is ${Math.round(age / (60 * 60 * 1000))}h old)`
}

function describe(e: HsEntry): string {
  return `${e.name}: rank ${e.rank} in ${e.region}, rating ${e.rating} (${MODES[e.mode]})`
}

// terse block for AI-context injection: real numbers to relay, and an explicit, honest
// account of what "not found" means so the model never fills the gap with a guess.
export function hsContext(query: string, subject: string | null): string {
  loadDisk()
  if (!cache || cache.entries.length === 0) return ''
  const season = cache.seasons.battlegrounds
  const head = `Hearthstone Battlegrounds leaderboard (official Blizzard data${season ? `, season ${season}` : ''}${ageNote()}):`

  const tag = subject ? resolveAlias(subject) : null
  const found = tag ? lookupPlayer(tag) : []
  if (found.length) {
    return `${head} ${found.slice(0, 3).map(describe).join('; ')}. Relay these numbers, do not guess others.`
  }
  // naming the battletag we actually checked keeps the "no rating" answer specific rather
  // than sounding like we simply failed to look
  const asked = tag && norm(tag) !== norm(subject ?? '') ? `${subject} (battletag ${tag})` : subject

  const counts = REGIONS.map((r) => `${r} ${cache!.entries.filter((e) => e.mode === 'battlegrounds' && e.region === r).length}`).join(', ')
  const top = topPlayers('battlegrounds', null, 3).map(describe).join('; ')
  if (subject) {
    // the important case: say WHY there's no number, so the model doesn't invent one or
    // imply the player is bad. an unranked player has no public rating anywhere.
    return `${head} no ranked entry for ${asked} — the leaderboard lists only the top ranked players per region (currently ${counts}). Blizzard publishes no rating for anyone outside it, so no rating for them exists publicly — say that plainly, do not guess a number, do not imply it means they are bad, and do not refuse the question. Current top: ${top}.`
  }
  return `${head} current top — ${top}. Ranked players per region: ${counts}. Relay these numbers, do not guess others.`
}

// pull the player being asked about out of a rating question, so "whats kripps BG rating"
// resolves to "kripp". returns null when the ask isn't about a specific person.
const STOP = new Set([
  'the', 'a', 'an', 'his', 'her', 'their', 'my', 'your', 'our', 'this', 'that', 'what', 'whats', 'is',
  'are', 'in', 'on', 'at', 'of', 'for', 'to', 'and', 'or', 'current', 'currently', 'now', 'right',
  'bg', 'bgs', 'battleground', 'battlegrounds', 'hearthstone', 'hs', 'rating', 'mmr', 'rank', 'ranked',
  'ranking', 'leaderboard', 'elo', 'standing', 'standings', 'top', 'number', 'one', 'who', 'whos',
  'best', 'player', 'players', 'lobby', 'join', 'want', 'wanna', 'i', 'he', 'she', 'they', 'it', 'bot',
])
export function extractSubject(query: string): string | null {
  const words = query
    .replace(/[?!.,]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^@/, '').replace(/'s$/i, '').replace(/s'$/i, ''))
    .filter(Boolean)
  for (const w of words) {
    if (STOP.has(norm(w))) continue
    if (w.length < 2) continue
    return w
  }
  return null
}
