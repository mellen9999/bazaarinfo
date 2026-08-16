// live Battlegrounds board answers — "what's he got", "what tier is he", "who's he
// fighting", "what place is he in" — grounded in the companion's latest frame, fetched
// from the EBS on demand (both run on this host).
//
// the sibling of board.ts, and the same fail-soft contract: '' unless the data is real
// and fresh, so a closed game or a dead companion produces silence rather than a stale
// board stated as the current one.
//
// unlike The Bazaar's log, Hearthstone's carries the full picture — tier, stats, golden,
// keywords, the leaderboard. so this one CAN state tiers, and says so. what it still
// cannot see is the shop, and it never claims to.

import { humanizeDelta } from './schedule'
import { hsCardName } from './hs-cards'
import type { HsState, HsMinion, HsHero } from '@bazaarinfo/shared'

const EBS_URL = process.env.EBS_URL ?? 'http://127.0.0.1:3100'
const FETCH_TIMEOUT_MS = 1500
const CACHE_MS = 10_000
// a battlegrounds turn is ~40s of shop plus a fight; past this the game is over or the
// companion is gone, and either way there is no live board to describe
const FRESH_MS = 5 * 60_000
const MAX_CACHE = 64

interface Snap { hs: HsState; ageMs: number }
interface CacheEntry { at: number; snap: Snap | null }
const cache = new Map<string, CacheEntry>()

let resolveChannelId: (channel: string) => string | null = () => null
export function setHsChannelIdResolver(fn: (channel: string) => string | null): void {
  resolveChannelId = fn
}

// board-shaped asks, in battlegrounds words. deliberately narrower than board.ts's
// regex: this only ever fires alongside a hearthstone signal or a live Hearthstone
// category, so it does not need to carry the burden of disambiguating on its own.
const HS_BOARD_RE =
  /\b(?:board|comp|comps?ition|lineup|line\s?up|minions?|warband|tavern tier|tier|hp|health|armou?r|place|placement|first|winning|losing|fighting|opponent|lobby|left|alive|dead)\b|\bwhat(?:'?s|\s+is|\s+are)?\s+(?:\w+['’\w]*\s+){0,3}?(?:running|rocking|playing|got|building)\b/i
export function isHsBoardQuery(query: string): boolean {
  return HS_BOARD_RE.test(query)
}

// the leaderboard is seven heroes' worth of text — worth its place in the budget when
// someone asks who is left or what place he is in, wasteful on "what's on his board"
const LOBBY_RE = /\b(?:lobby|place|placement|left|alive|dead|out|standings?|leaderboard|first|last|winning|losing|who'?s? (?:up|ahead|left|winning)|others?|everyone else)\b/i
export function isHsLobbyQuery(query: string): boolean {
  return LOBBY_RE.test(query)
}

function setCache(ch: string, snap: Snap | null): void {
  if (cache.size >= MAX_CACHE && !cache.has(ch)) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(ch, { at: Date.now(), snap })
}

/** TTL-gated refresh, same contract as board.ts: no-op when fresh, never throws. */
export async function refreshHsBoardIfNeeded(channel: string): Promise<void> {
  const ch = channel.toLowerCase()
  const hit = cache.get(ch)
  if (hit && Date.now() - hit.at < CACHE_MS) return
  const id = resolveChannelId(ch)
  const secret = process.env.INTERNAL_SECRET ?? ''
  if (!id || !secret) {
    setCache(ch, null)
    return
  }
  try {
    const res = await fetch(`${EBS_URL}/hsboard?channel_id=${encodeURIComponent(id)}`, {
      headers: { 'x-internal-secret': secret },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      setCache(ch, null)
      return
    }
    const data = (await res.json()) as { hs?: unknown; ageMs?: unknown }
    const hs = data.hs as HsState | undefined
    const ok = !!hs && typeof hs === 'object' && Array.isArray(hs.board) && typeof data.ageMs === 'number'
    setCache(ch, ok ? { hs: hs!, ageMs: data.ageMs as number } : null)
  } catch {
    setCache(ch, null)
  }
}

// --- formatting ---

/** a minion as chat would say it. an id the dump no longer knows is dropped, not guessed. */
export function describeMinion(m: HsMinion): string | null {
  const name = hsCardName(m.id)
  if (!name) return null
  const bits: string[] = []
  if (m.golden) bits.push('golden')
  bits.push(name)
  let out = bits.join(' ')
  out += ` ${m.atk}/${m.hp}`
  if (m.kw?.length) out += ` (${m.kw.join(', ')})`
  return out
}

export function describeHero(h: HsHero): string | null {
  const name = hsCardName(h.id)
  if (!name) return null
  const bits: string[] = []
  const hp = h.armor ? `${h.hp}+${h.armor} armor` : `${h.hp} hp`
  bits.push(hp)
  if (h.tier) bits.push(`tavern tier ${h.tier}`)
  if (h.place) bits.push(`${ordinal(h.place)}`)
  return `${name} (${bits.join(', ')})`
}

/** the same hero, compressed — seven of these in one line is what a lobby costs */
export function describeHeroShort(h: HsHero): string | null {
  const name = hsCardName(h.id)
  if (!name) return null
  const hp = h.armor ? `${h.hp}+${h.armor}` : `${h.hp}`
  return `${ordinal(h.place ?? 0)} ${name} ${hp}${h.tier ? ` t${h.tier}` : ''}`
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

function joinMinions(list: HsMinion[]): string {
  return list.map(describeMinion).filter(Boolean).join(', ')
}

/**
 * The live-board block, or '' when there is nothing real and fresh to say.
 *
 * `ambient` mirrors board.ts: a board-shaped ask gets the direct-answer framing, any
 * other message gets the reference-only framing so the model can weave it into a joke
 * without being pushed to force it in.
 *
 * `query` decides how much detail earns its place — the seven-hero leaderboard is only
 * included when someone actually asked about the lobby.
 */
export function getHsBoardLine(channel: string, query = '', ambient = false): string {
  const entry = cache.get(channel.toLowerCase())
  if (!entry?.snap) return ''
  const age = entry.snap.ageMs + (Date.now() - entry.at)
  if (age > FRESH_MS) return ''
  const hs = entry.snap.hs

  const mine = joinMinions(hs.board)
  const hero = hs.hero ? describeHero(hs.hero) : null
  if (!mine && !hero) return ''

  const head = ambient
    ? `Live Battlegrounds board (${channel}, background — reference ONLY when it genuinely fits the message; never force it into an unrelated answer)`
    : `Live Battlegrounds board for ${channel} (real, from the game's own log ${humanizeDelta(age)} ago)`

  const parts: string[] = []
  if (hero) parts.push(`playing ${hero}`)
  parts.push(`turn ${hs.turn}`)
  parts.push(mine ? `board: ${mine}` : 'board: empty')

  let line = `${head}: ${parts.join('; ')}.`
  if (hs.phase === 'combat' && hs.opponent) {
    const oh = describeHero(hs.opponent.hero)
    const ob = hs.opponent.board ? joinMinions(hs.opponent.board) : ''
    if (oh) line += ` Fighting ${oh}${ob ? ` with ${ob}` : ''}.`
  } else {
    // saying which phase they're in is what stops "who's he fighting" being answered
    // off a board that belongs to the LAST fight
    line += ' In the shop right now, not in a fight — no current opponent.'
  }
  if (hs.lobby?.length && isHsLobbyQuery(query)) {
    const alive = hs.lobby.filter((h) => h.hp > 0)
    const dead = hs.lobby.length - alive.length
    const others = alive.map(describeHeroShort).filter(Boolean).slice(0, 7).join(', ')
    if (others) line += ` Rest of the lobby: ${others}${dead ? `; ${dead} already out` : ''}.`
  }
  line += ' These stats are read from the game log and are real — state them plainly. You do NOT see the shop or their hand, so never describe either.'
  return line
}

export function __setHsBoardCacheForTest(channel: string, snap: Snap | null): void {
  if (snap === null) cache.delete(channel.toLowerCase())
  else cache.set(channel.toLowerCase(), { at: Date.now(), snap })
}
