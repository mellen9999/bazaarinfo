// trivia cooldowns, set per channel from the control panel.
//   round: channel-wide gap between rounds (default off)
//   user:  how often one chatter can start a round (default 5m) — mods skip both
// settings persist in channel_controls (write-through, lazy-loaded — same shape as the
// ai-trivia switch in ai-cache.ts). per-user start stamps stay in memory on purpose: a
// restart refilling a 5-minute cooldown is harmless, a table for it would be bloat.
// leaf module: trivia.ts and commands-trivia.ts both import it, it imports neither.

import * as db from './db'
import { log } from './log'

export type CdScope = 'round' | 'user'

// the only values the panel offers; parseAction rejects anything else
export const ROUND_CD_CHOICES: readonly number[] = [0, 30, 60, 120, 300]
export const USER_CD_CHOICES: readonly number[] = [0, 60, 120, 300, 600]
export const CD_CHOICES: Record<CdScope, readonly number[]> = { round: ROUND_CD_CHOICES, user: USER_CD_CHOICES }
const DEFAULTS: Record<CdScope, number> = { round: 0, user: 300 }
const key = (scope: CdScope) => `trivia-cd:${scope}`

const settings = new Map<string, Record<CdScope, number>>()
let loaded = false
function ensureLoaded(): void {
  if (loaded || !db.getDb()) return
  loaded = true
  try {
    for (const r of db.loadControls()) {
      if (r.expires_at !== null && r.expires_at <= Date.now()) continue
      const scope = r.key === key('round') ? 'round' : r.key === key('user') ? 'user' : null
      const n = Number(r.value)
      if (!scope || !CD_CHOICES[scope].includes(n)) continue
      const cur = settings.get(r.channel) ?? { ...DEFAULTS }
      cur[scope] = n
      settings.set(r.channel, cur)
    }
  } catch (e) {
    log(`trivia-cd: load failed: ${e}`)
  }
}

export function getTriviaCd(channel: string): { round: number; user: number } {
  ensureLoaded()
  return { ...(settings.get(channel.toLowerCase()) ?? DEFAULTS) }
}

/** false when `sec` isn't one of the allowed values for that scope. */
export function setTriviaCd(channel: string, scope: CdScope, sec: number, by: string): boolean {
  if (!CD_CHOICES[scope].includes(sec)) return false
  ensureLoaded()
  const ch = channel.toLowerCase()
  settings.set(ch, { ...getTriviaCd(ch), [scope]: sec })
  try { db.saveControl({ channel: ch, key: key(scope), value: String(sec), by, expires_at: null }) } catch (e) { log(`trivia-cd: save failed: ${e}`) }
  return true
}

// --- per-user start stamps ---

const STAMPS_MAX = 500
interface Stamp { at: number; noticed: boolean }
const stamps = new Map<string, Stamp>()
const starters = new Map<string, string>()
const stampKey = (ch: string, user: string) => `${ch.toLowerCase()}:${user.toLowerCase()}`

/** ms until this chatter may start another round (0 = free to go). */
export function userCdLeft(channel: string, user: string): number {
  const s = stamps.get(stampKey(channel, user))
  if (!s) return 0
  return Math.max(0, getTriviaCd(channel).user * 1000 - (Date.now() - s.at))
}

/** true once per cooldown window — the caller replies then, and stays quiet after (anti-spam). */
export function shouldNotifyUser(channel: string, user: string): boolean {
  const s = stamps.get(stampKey(channel, user))
  if (!s || s.noticed) return false
  s.noticed = true
  return true
}

/** remember who started the current round (mods too), so a cancelled round can refund them. */
export function noteStarter(channel: string, user: string | undefined): void {
  if (user) starters.set(channel.toLowerCase(), user.toLowerCase())
  else starters.delete(channel.toLowerCase())
}

/** an accepted ask costs the chatter their cooldown. no-op when the cd is off. */
export function chargeUser(channel: string, user: string): void {
  noteStarter(channel, user)
  if (getTriviaCd(channel).user <= 0) return
  stamps.set(stampKey(channel, user), { at: Date.now(), noticed: false })
  if (stamps.size > STAMPS_MAX) {
    const cutoff = Date.now() - Math.max(...USER_CD_CHOICES) * 1000
    for (const [k, v] of stamps) if (v.at < cutoff) stamps.delete(k)
  }
}

/** a refused/failed ask never costs cd. */
export function refundUser(channel: string, user: string): void {
  stamps.delete(stampKey(channel, user))
}

/** refund whoever started the live round — used when the round never reached chat. */
export function refundStarter(channel: string): void {
  const u = starters.get(channel.toLowerCase())
  if (u) refundUser(channel, u)
}

export function __resetForTest(): void {
  settings.clear()
  stamps.clear()
  starters.clear()
  loaded = false
}
