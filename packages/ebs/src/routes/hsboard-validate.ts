// Pure validators for the battlegrounds board route — no external dependencies, so
// tests can import them without booting the auth module (same split as detect-validate).
//
// Everything here treats the payload as untrusted. It arrives from a program on someone
// else's machine, authenticated by a secret that can leak — so shapes, ranges and counts
// are all bounded before anything is kept.

import type { HsState, HsMinion, HsHero } from '@bazaarinfo/shared'

export const MAX_BOARD = 7
export const MAX_LOBBY = 8
export const MAX_ID_LEN = 64
export const MAX_KEYWORDS = 8
export const MAX_KEYWORD_LEN = 20
export const CHANNEL_ID_RE = /^\d{1,15}$/
export const MAX_SECRET_LEN = 256

const num = (v: unknown, min: number, max: number): boolean =>
  typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= min && v <= max

const cardId = (v: unknown): boolean =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LEN && /^[A-Za-z0-9_\-.]+$/.test(v)

export function parseMinion(v: unknown): HsMinion | null {
  if (!v || typeof v !== 'object') return null
  const m = v as Record<string, unknown>
  if (!cardId(m.id)) return null
  if (!num(m.pos, 1, MAX_BOARD)) return null
  // stats are unbounded upward in this game — a late golden with buffs is genuinely in
  // the thousands — but they are still integers within a sane ceiling
  if (!num(m.atk, 0, 1_000_000) || !num(m.hp, 0, 1_000_000)) return null
  const out: HsMinion = { id: m.id as string, pos: m.pos as number, atk: m.atk as number, hp: m.hp as number }
  if (m.tier !== undefined) {
    if (!num(m.tier, 1, 7)) return null
    out.tier = m.tier as number
  }
  if (m.golden !== undefined) {
    if (typeof m.golden !== 'boolean') return null
    out.golden = m.golden
  }
  if (m.kw !== undefined) {
    if (!Array.isArray(m.kw)) return null
    const kw = m.kw.filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length <= MAX_KEYWORD_LEN)
    if (kw.length) out.kw = kw.slice(0, MAX_KEYWORDS)
  }
  return out
}

export function parseHero(v: unknown): HsHero | null {
  if (!v || typeof v !== 'object') return null
  const h = v as Record<string, unknown>
  if (!cardId(h.id)) return null
  if (!num(h.hp, 0, 100_000)) return null
  const out: HsHero = { id: h.id as string, hp: h.hp as number }
  for (const [key, max] of [['armor', 100_000], ['tier', 7], ['place', 8]] as const) {
    const raw = h[key]
    if (raw === undefined) continue
    if (!num(raw, 0, max)) return null
    out[key] = raw as number
  }
  return out
}

/** the board state itself, or null when the shape is wrong. `null` input is legal and
 *  means "no game" — the companion sends it deliberately when the streamer leaves one. */
export function parseHsState(v: unknown): HsState | null {
  if (!v || typeof v !== 'object') return null
  const s = v as Record<string, unknown>
  if (!num(s.turn, 0, 1000)) return null
  if (s.phase !== 'shop' && s.phase !== 'combat') return null
  if (!Array.isArray(s.board)) return null
  const board = s.board.map(parseMinion).filter((m): m is HsMinion => !!m).slice(0, MAX_BOARD)
  const out: HsState = { turn: s.turn as number, phase: s.phase, board }

  if (s.hero !== undefined) {
    const hero = parseHero(s.hero)
    if (!hero) return null
    out.hero = hero
  }
  if (s.opponent !== undefined) {
    if (!s.opponent || typeof s.opponent !== 'object') return null
    const o = s.opponent as Record<string, unknown>
    const hero = parseHero(o.hero)
    if (!hero) return null
    out.opponent = { hero }
    if (o.board !== undefined) {
      if (!Array.isArray(o.board)) return null
      const ob = o.board.map(parseMinion).filter((m): m is HsMinion => !!m).slice(0, MAX_BOARD)
      if (ob.length) out.opponent.board = ob
    }
  }
  if (s.lobby !== undefined) {
    if (!Array.isArray(s.lobby)) return null
    const lobby = s.lobby.map(parseHero).filter((h): h is HsHero => !!h).slice(0, MAX_LOBBY)
    if (lobby.length) out.lobby = lobby
  }
  return out
}

