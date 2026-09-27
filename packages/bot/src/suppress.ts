// Mod-issued feature pauses ("mod pause"). When chat weaponizes the bot (trivia spam,
// AI floods), a mod's plain-language "stop doing trivia" / "quiet down" takes REAL
// effect — [MOD] prompt semantics alone only change tone. PURE STATE: store/expire/
// check + the prompt hint + the throttled honest line. Parsing lives in commands.ts
// (deterministic fast-path) and ai-directive.ts (NL); enforcement at the choke points
// (trivia launchRound, runTrivia, tryAiRespond, dungeon castInput, handleCommand).
// Own map, NOT the directives ring buffer — a viewer steer-flood must never evict mod
// authority. In-memory, lazy expiry — the panel's persisted mirror below is what makes a
// pause survive a restart; the in-memory map (and its lazy expiry) stays the hot path.
// Proactive posters (gap-watch, reddit digests) are deliberately out of scope — they
// aren't chat-triggered misbehavior.

import * as db from './db'
import { log } from './log'

export type SuppressFeature = 'trivia' | 'depths' | 'ai' | 'all'
const FEATURE_SET: ReadonlySet<string> = new Set(['trivia', 'depths', 'ai', 'all'])

export const SUPPRESS_DEFAULT_MIN = 30
export const SUPPRESS_MAX_MIN = 180

interface Suppression {
  expiresAt: number
  by: string
}

const byChannel = new Map<string, Map<SuppressFeature, Suppression>>()

// --- persistence (channel_controls, key `pause:<feature>`) — mirrors ignore.ts's lazy
// ensureLoaded so a mod pause survives a restart, not just "until restart". write-through
// on every state change; the in-memory map stays authoritative for reads.
let loaded = false
function ensureLoaded(): void {
  if (loaded || !db.getDb()) return
  loaded = true
  try {
    const now = Date.now()
    for (const r of db.loadControls()) {
      if (!r.key.startsWith('pause:')) continue
      const feature = r.key.slice('pause:'.length)
      if (!FEATURE_SET.has(feature) || r.expires_at === null || r.expires_at <= now) continue
      const map = byChannel.get(r.channel) ?? new Map<SuppressFeature, Suppression>()
      map.set(feature as SuppressFeature, { expiresAt: r.expires_at, by: r.by })
      byChannel.set(r.channel, map)
    }
  } catch (e) {
    log(`suppress: load failed: ${e}`)
  }
}

function live(channel: string): Map<SuppressFeature, Suppression> {
  ensureLoaded()
  const ch = channel.toLowerCase()
  const map = byChannel.get(ch)
  if (!map) return new Map()
  const now = Date.now()
  for (const [f, s] of map) {
    if (s.expiresAt <= now) {
      map.delete(f)
      try { db.deleteControl(ch, `pause:${f}`) } catch (e) { log(`suppress: prune failed: ${e}`) }
    }
  }
  if (map.size === 0) byChannel.delete(ch)
  return map
}

/** pause a feature; returns the applied minutes (clamped 1..180, default 30). */
export function suppress(channel: string, feature: SuppressFeature, by: string, minutes?: number): number {
  ensureLoaded()
  const mins = Math.min(SUPPRESS_MAX_MIN, Math.max(1, Math.round(minutes ?? SUPPRESS_DEFAULT_MIN)))
  const ch = channel.toLowerCase()
  const expiresAt = Date.now() + mins * 60_000
  const map = byChannel.get(ch) ?? new Map<SuppressFeature, Suppression>()
  map.set(feature, { expiresAt, by })
  byChannel.set(ch, map)
  try { db.saveControl({ channel: ch, key: `pause:${feature}`, value: by, by, expires_at: expiresAt }) } catch (e) { log(`suppress: save failed: ${e}`) }
  return mins
}

/** lift a pause; 'all' clears every pause on the channel. true if anything was lifted. */
export function unsuppress(channel: string, feature: SuppressFeature): boolean {
  const map = live(channel)
  if (map.size === 0) return false
  const ch = channel.toLowerCase()
  if (feature === 'all') {
    byChannel.delete(ch)
    try { for (const f of map.keys()) db.deleteControl(ch, `pause:${f}`) } catch (e) { log(`suppress: clear failed: ${e}`) }
    return true
  }
  const had = map.delete(feature)
  if (had) { try { db.deleteControl(ch, `pause:${feature}`) } catch (e) { log(`suppress: delete failed: ${e}`) } }
  return had
}

/** is this feature paused? 'all' implies every feature — the implication lives here only. */
export function isSuppressed(channel: string, feature: SuppressFeature): boolean {
  const map = live(channel)
  return map.has(feature) || map.has('all')
}

/** minutes left on a feature's pause (via the feature or 'all'), 0 when not paused. */
export function remainingMinutes(channel: string, feature: SuppressFeature): number {
  const map = live(channel)
  const exp = Math.max(map.get(feature)?.expiresAt ?? 0, map.get('all')?.expiresAt ?? 0)
  return exp > 0 ? Math.max(1, Math.round((exp - Date.now()) / 60_000)) : 0
}

export function listSuppressions(channel: string): { feature: SuppressFeature; by: string; minutes: number }[] {
  const now = Date.now()
  return [...live(channel)].map(([feature, s]) => ({
    feature,
    by: s.by,
    minutes: Math.max(1, Math.round((s.expiresAt - now) / 60_000)),
  }))
}

// prompt hint so "why no trivia" gets an honest answer instead of a brush-off or a
// promise the bot can't keep. empty when nothing is paused — zero prompt cost then.
export function suppressHint(channel: string): string {
  const list = listSuppressions(channel)
  if (list.length === 0) return ''
  const parts = list.map((s) => `${s.feature} (${s.minutes}m left)`).join(', ')
  return `\n[MOD PAUSE] a mod paused: ${parts}. if asked, say a mod paused it — plainly, no dunking on the mod or chat. never start or promise a paused feature.`
}

// one honest line per channel per 5 min while AI answers are paused, silence after —
// same doctrine as directive mutes: say it once, don't narrate every drop.
const NOTICE_CD = 5 * 60_000
const noticeAt = new Map<string, number>()

export function suppressNotice(channel: string): string | null {
  const rem = remainingMinutes(channel, 'ai')
  if (rem <= 0) return null
  const ch = channel.toLowerCase()
  const last = noticeAt.get(ch) ?? 0
  if (Date.now() - last < NOTICE_CD) return null
  noticeAt.set(ch, Date.now())
  return `a mod paused my answers — back in ~${rem}m`
}

// NOTE: deliberately does not reset `loaded`. Bun runs a package.json test group's files
// in one shared process/module registry, so a db another file in the group initialized
// stays attached for the rest of the run; re-arming `loaded` here would make the very next
// suppress() in THIS file replay every row this file itself already wrote this run. A real
// "does it survive a restart" check belongs in a file that owns its own isolated db
// (control.test.ts) and drives the persistence layer directly, not through this reset.
export function resetForTest(): void {
  byChannel.clear()
  noticeAt.clear()
}

/** simulates a real restart (memory gone, db remains) — only safe from a test file that
 * owns its own isolated db (e.g. control.test.ts), never from a shared test-group file. */
export function __simulateRestartForTest(): void {
  byChannel.clear()
  loaded = false
}
