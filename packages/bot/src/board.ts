// live-board answers — "what's on his board?" grounded in the overlay companion's
// latest frame, fetched from the EBS on demand (both run on this host). the game log
// never exposes live tiers or enchantments (permanent companion limitation), so the
// injected context carries card NAMES only and says so — the model must never be
// handed a stale tier it could confidently misquote.

import { humanizeDelta } from './schedule'

const EBS_URL = process.env.EBS_URL ?? 'http://127.0.0.1:3100'
const FETCH_TIMEOUT_MS = 1500
const CACHE_MS = 10_000 // don't re-hit the EBS for every message in a burst
const FRESH_MS = 10 * 60_000 // older than this: game likely closed — silence beats a stale board
const MAX_CACHE = 64

interface BoardCard {
  title: string
  owner?: string
  type?: string
}
interface BoardSnap {
  cards: BoardCard[]
  ageMs: number
}
interface CacheEntry {
  at: number
  snap: BoardSnap | null
}
const cache = new Map<string, CacheEntry>()

// channel login → twitch user id, wired from index.ts (the IRC client owns the map)
let resolveChannelId: (channel: string) => string | null = () => null
export function setChannelIdResolver(fn: (channel: string) => string | null): void {
  resolveChannelId = fn
}

// board/build-shaped asks. "running/using/playing" alone is far too broad, so those
// verbs only count inside a "what is he …" frame.
const BOARD_RE = /\b(?:boards?|builds?|loadout|load\s?out|item\s*set\s?ups?)\b|\bwhat(?:'?s|\s+is|\s+are)?\s+(?:\w+['’\w]*\s+){0,3}?(?:running|rocking|using|playing\s+with)\b/i
export function isBoardQuery(query: string): boolean {
  return BOARD_RE.test(query)
}

function setCache(ch: string, snap: BoardSnap | null): void {
  if (cache.size >= MAX_CACHE && !cache.has(ch)) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(ch, { at: Date.now(), snap })
}

// TTL-gated refresh, same contract as world cup / weather: no-op when fresh,
// fail-soft on any error, never throws.
export async function refreshBoardIfNeeded(channel: string): Promise<void> {
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
    const res = await fetch(`${EBS_URL}/board?channel_id=${encodeURIComponent(id)}`, {
      headers: { 'x-internal-secret': secret },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      setCache(ch, null)
      return
    }
    const data = (await res.json()) as { cards?: unknown; ageMs?: unknown }
    const ok =
      Array.isArray(data.cards) &&
      typeof data.ageMs === 'number' &&
      data.cards.every((c) => c && typeof (c as BoardCard).title === 'string')
    setCache(ch, ok ? { cards: (data.cards as BoardCard[]).slice(0, 50), ageMs: data.ageMs as number } : null)
  } catch {
    setCache(ch, null)
  }
}

// "Item x2" for real duplicates, keeping first-seen order
function nameList(cards: BoardCard[]): string {
  const counts = new Map<string, number>()
  for (const c of cards) counts.set(c.title, (counts.get(c.title) ?? 0) + 1)
  return [...counts].map(([t, n]) => (n > 1 ? `${t} x${n}` : t)).join(', ')
}

// sync read for the prompt builder — refreshBoardIfNeeded must have run first.
// empty string on anything less than fresh, real data: nothing to hallucinate from.
export function getBoardLine(channel: string): string {
  const entry = cache.get(channel.toLowerCase())
  if (!entry?.snap) return ''
  const age = entry.snap.ageMs + (Date.now() - entry.at)
  if (age > FRESH_MS) return ''
  const mine = entry.snap.cards.filter((c) => c.owner !== 'opponent')
  const items = mine.filter((c) => c.type !== 'Skill')
  const skills = mine.filter((c) => c.type === 'Skill')
  if (items.length === 0 && skills.length === 0) return ''
  const opp = entry.snap.cards.filter((c) => c.owner === 'opponent')
  // cap the lists, never the trailing honesty instruction
  const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
  let line = `Live board for ${channel} (real, seen by the overlay ${humanizeDelta(age)} ago): ${cap(nameList(items), 220) || 'no items visible'}${skills.length ? `; skills: ${cap(nameList(skills), 110)}` : ''}.`
  if (opp.length > 0) line += ` Opponent this fight: ${cap(nameList(opp), 110)}.`
  line += ' Card names are real detections; live tiers/enchantments are NOT known — never state or guess them.'
  return line
}

export function __setBoardCacheForTest(channel: string, snap: BoardSnap | null): void {
  if (snap === null) cache.delete(channel.toLowerCase())
  else cache.set(channel.toLowerCase(), { at: Date.now(), snap })
}
