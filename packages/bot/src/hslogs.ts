// heatsync chat-log client (read-only). every call returns null on ANY failure and never
// throws; no HEATSYNC_LOGS_KEY = complete no-op. callers always keep a local fallback.
import * as db from './db'
import { warn } from './log'

const FAST_MS = 1500
const HEAVY_MS = 4000
const TTL_FAST = 60_000
const TTL_AGG = 3_600_000
const MAX_CACHE = 200
const FAIL_LIMIT = 3
const OPEN_MS = 60_000
const UA = 'bazaarinfo/0.1.0'

export interface Coverage { tier: string; from: string; to: string; rolled_through: string | null; partial: boolean; exhausted: boolean; note?: string }
export interface Envelope<T> { data: T; coverage: Coverage; next_cursor?: string }
export interface LogRow { username: string; display_name: string; message: string; message_id: string; timestamp: string; reply_to_id: string | null }
export interface UserProfile { exists: boolean; count: number; first_day: string | null; last_day: string | null; active_days: number; peak_hour: { hour: number; scope: string } | null }
export interface PastaRow { sample: string; n: number; users: number; first_at: string; last_at: string }
export interface Range { from?: string; to?: string; limit?: number }

let failures = 0
let openUntil = 0
const cache = new Map<string, { exp: number; val: unknown }>()
let forgottenCheck: (u: string) => boolean = (u) => { try { return db.isForgotten(u) } catch { return false } }

export function setForgottenCheck(fn: (u: string) => boolean): void { forgottenCheck = fn }
export function resetHslogs(): void { failures = 0; openUntil = 0; cache.clear() }
export function hslogsEnabled(): boolean { return !!process.env.HEATSYNC_LOGS_KEY }

function base(): string {
  return (process.env.HEATSYNC_LOGS_URL || 'https://heatsync.org/api/v1/logs').replace(/\/+$/, '')
}

function trip(ms = OPEN_MS): void { openUntil = Date.now() + ms }

function fail(): null {
  if (++failures >= FAIL_LIMIT) { trip(); failures = 0 }
  return null
}

function cacheGet(k: string): unknown | undefined {
  const e = cache.get(k)
  if (!e) return undefined
  if (e.exp <= Date.now()) { cache.delete(k); return undefined }
  cache.delete(k); cache.set(k, e) // LRU touch
  return e.val
}

function cacheSet(k: string, val: unknown, ttl: number): void {
  cache.delete(k)
  cache.set(k, { exp: Date.now() + ttl, val })
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string)
}

async function get<T>(channel: string, path: string, params: Record<string, string | number | undefined>, heavy = false, ttl = TTL_FAST): Promise<T | null> {
  const key = process.env.HEATSYNC_LOGS_KEY
  if (!key) return null
  try {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v))
    const url = `${base()}/twitch/${encodeURIComponent(channel.toLowerCase())}${path}${qs.size ? '?' + qs : ''}`
    const hit = cacheGet(url)
    if (hit !== undefined) return hit as T
    if (Date.now() < openUntil) return null
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(heavy ? HEAVY_MS : FAST_MS),
    })
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'))
      trip(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) * 1000 : OPEN_MS)
      return null
    }
    if (!res.ok) { warn(`hslogs: ${res.status} ${path}`); return fail() }
    const json = await res.json() as T
    failures = 0
    cacheSet(url, json, ttl)
    return json
  } catch {
    return fail()
  }
}

function clean(env: Envelope<LogRow[]> | null): Envelope<LogRow[]> | null {
  if (!env || !Array.isArray(env.data)) return null
  return { ...env, data: env.data.filter((r) => !forgottenCheck(r.username)) }
}

const order = (o?: 'new' | 'old') => o

export async function getMessages(channel: string, r: Range & { order?: 'new' | 'old'; cursor?: string } = {}) {
  return clean(await get<Envelope<LogRow[]>>(channel, '/messages', { from: r.from, to: r.to, limit: r.limit, cursor: r.cursor, order: order(r.order) }))
}

export async function search(channel: string, q: string, r: Range & { user?: string } = {}) {
  return clean(await get<Envelope<LogRow[]>>(channel, '/search', { q, user: r.user?.toLowerCase(), from: r.from, to: r.to, limit: r.limit }))
}

export async function getUserMessages(channel: string, user: string, r: Range & { order?: 'new' | 'old'; q?: string } = {}) {
  if (forgottenCheck(user)) return null
  return clean(await get<Envelope<LogRow[]>>(channel, `/users/${encodeURIComponent(user.toLowerCase())}/messages`, { from: r.from, to: r.to, limit: r.limit, order: r.order, q: r.q }))
}

export async function getUserProfile(channel: string, user: string) {
  if (forgottenCheck(user)) return null
  return get<Envelope<UserProfile>>(channel, `/users/${encodeURIComponent(user.toLowerCase())}/profile`, {}, false, TTL_AGG)
}

export async function getTermCount(channel: string, user: string, term: string, r: Range = {}) {
  if (forgottenCheck(user)) return null
  return get<Envelope<{ count: number; partial: boolean }>>(channel, `/users/${encodeURIComponent(user.toLowerCase())}/term-count`, { term, from: r.from, to: r.to }, true, TTL_AGG)
}

export async function getTopChatters(channel: string, days: 7 | 30 | 90 | 'all' = 30, limit = 10) {
  const env = await get<Envelope<{ username: string; count: number }[]>>(channel, '/top-chatters', { days, limit }, false, TTL_AGG)
  if (!env || !Array.isArray(env.data)) return null
  return { ...env, data: env.data.filter((c) => !forgottenCheck(c.username)) }
}

export async function getPastas(channel: string, o: Range & { min_len?: number; min_repeats?: number; q?: string } = {}) {
  return get<Envelope<PastaRow[]>>(channel, '/pastas', { from: o.from, to: o.to, min_len: o.min_len, min_repeats: o.min_repeats, q: o.q, limit: o.limit }, true, TTL_AGG)
}

export async function getTermFootprint(channel: string, term: string) {
  return get<Envelope<{ count: number; distinct_users: number; first_seen: string | null }>>(channel, '/term-footprint', { term }, true, TTL_AGG)
}
