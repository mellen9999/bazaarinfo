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

export interface Coverage { tier: string; from: string; to: string; rolled_through: string | null; days_scanned: number; days_skipped: number; exhausted: boolean; partial: boolean; note?: string }
export interface Envelope<T> { data: T; coverage: Coverage; next_cursor?: string }
export interface LogRow { username: string; display_name: string; message: string; message_id: string; timestamp: string; reply_to_id: string | null }
export interface UserProfile { exists: boolean; username: string; first_seen: string | null; last_seen: string | null; messages: number; active_days: number }
export interface Chatter { username: string; messages: number; active_days: number }
export interface RemotePasta { text: string; repeats: number; users: number; days: number; first_at: string; last_at: string }
export interface TermFootprint { term: string; count: number; distinct_users: number; first_seen: string | null }
export interface TermCount { term: string; count: number; first_at: string | null; last_at: string | null }
// term endpoints compute asynchronously: {status, computed_at, data, coverage}, 202 while computing
export interface Computed<T> { status: string; computed_at: string; data: T; coverage: Coverage }
// signal: an outer budget (hslogs-context) that cuts the call short alongside its own timeout
// from/to: full ISO with Z (date-only 400s)
export interface Range { from?: string; to?: string; limit?: number; signal?: AbortSignal }

// common third-party chat bots; they top message rankings and are never "regulars"
const BOT_LOGINS = new Set(['nightbot', 'streamelements', 'streamlabs', 'fossabot', 'moobot', 'wizebot', 'sery_bot', 'soundalerts'])

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

// api errors are {error: <sentence>, error_code: <code>}; fall back to the status
async function errCode(res: Response): Promise<string> {
  try {
    const b = await res.json() as { error_code?: unknown }
    if (typeof b.error_code === 'string' && b.error_code) return b.error_code
  } catch {}
  return `http_${res.status}`
}

async function get<T>(channel: string, path: string, params: Record<string, string | number | undefined>, heavy = false, ttl = TTL_FAST, outer?: AbortSignal): Promise<T | null> {
  const key = process.env.HEATSYNC_LOGS_KEY
  if (!key) return null
  try {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v))
    const url = `${base()}/twitch/${encodeURIComponent(channel.toLowerCase())}${path}${qs.size ? '?' + qs : ''}`
    const hit = cacheGet(url)
    if (hit !== undefined) return hit as T
    if (Date.now() < openUntil) return null
    const send = () => fetch(url, {
      headers: { Authorization: `Bearer ${key}`, 'User-Agent': UA, Accept: 'application/json' },
      signal: outer ? AbortSignal.any([AbortSignal.timeout(heavy ? HEAVY_MS : FAST_MS), outer]) : AbortSignal.timeout(heavy ? HEAVY_MS : FAST_MS),
    })
    let res = await send()
    // 202 = still computing; the same url answers 200 within ~3s. one retry, but only when a
    // caller budget (outer) is running — it cuts the wait short; budgetless callers just miss.
    if (res.status === 202 && outer && !outer.aborted) {
      const ra = Number(res.headers.get('retry-after'))
      await new Promise<void>((r) => { const t = setTimeout(r, Math.min(Number.isFinite(ra) && ra > 0 ? ra : 2, 2) * 1000); outer.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true }) })
      if (outer.aborted) return null
      res = await send()
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'))
      trip(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) * 1000 : OPEN_MS)
      return null
    }
    if (res.status === 202) return null // still computing — not an answer, never cached
    if (!res.ok) { warn(`hslogs: ${res.status} ${await errCode(res)} ${path}`); return res.status >= 500 ? fail() : null }
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

// the api 400s (bad_query) on out-of-range params, so clamp here and no caller can send one
const clamp = (v: number | undefined, lo: number, hi: number) => (v === undefined ? undefined : Math.min(hi, Math.max(lo, Math.floor(v))))
const MAX_USER_MESSAGES = 200
const MAX_TOP_CHATTERS = 25
const MAX_PASTAS = 20
const MIN_PASTA_LEN = 80 // the rollup only stores pastas of 80+ chars
const MIN_PASTA_REPEATS = 2

export async function getMessages(channel: string, r: Range & { order?: 'new' | 'old'; cursor?: string } = {}) {
  return clean(await get<Envelope<LogRow[]>>(channel, '/messages', { from: r.from, to: r.to, limit: r.limit, cursor: r.cursor, order: order(r.order) }, false, TTL_FAST, r.signal))
}

export async function search(channel: string, q: string, r: Range & { user?: string } = {}) {
  return clean(await get<Envelope<LogRow[]>>(channel, '/search', { q, user: r.user?.toLowerCase(), from: r.from, to: r.to, limit: r.limit }, false, TTL_FAST, r.signal))
}

export async function getUserMessages(channel: string, user: string, r: Range & { order?: 'new' | 'old'; q?: string; cursor?: string } = {}) {
  if (forgottenCheck(user)) return null
  return clean(await get<Envelope<LogRow[]>>(channel, `/users/${encodeURIComponent(user.toLowerCase())}/messages`, { from: r.from, to: r.to, limit: clamp(r.limit, 1, MAX_USER_MESSAGES), order: r.order, q: r.q, cursor: r.cursor }, false, TTL_FAST, r.signal))
}

// the profile is a bare object, not enveloped: {exists, username, first_seen, ...}
export async function getUserProfile(channel: string, user: string, signal?: AbortSignal) {
  if (forgottenCheck(user)) return null
  const p = await get<UserProfile>(channel, `/users/${encodeURIComponent(user.toLowerCase())}/profile`, {}, false, TTL_AGG, signal)
  return p && typeof p.exists === 'boolean' ? p : null
}

export async function getTermCount(channel: string, user: string, term: string, r: Range = {}) {
  if (forgottenCheck(user)) return null
  const c = await get<Computed<TermCount>>(channel, `/users/${encodeURIComponent(user.toLowerCase())}/term-count`, { term, from: r.from, to: r.to }, true, TTL_AGG, r.signal)
  return c && c.data && typeof c.data.count === 'number' ? c : null
}

export async function getTopChatters(channel: string, days: 7 | 30 | 90 | 'all' = 30, limit = 10, signal?: AbortSignal) {
  const env = await get<Envelope<Chatter[]>>(channel, '/top-chatters', { days, limit: clamp(limit, 1, MAX_TOP_CHATTERS) }, false, TTL_AGG, signal)
  if (!env || !Array.isArray(env.data)) return null
  // the all-time ranking includes bots (bazaarinfo itself was #3 over 7d)
  const bot = (process.env.TWITCH_USERNAME ?? 'bazaarinfo').toLowerCase()
  return { ...env, data: env.data.filter((c) => !forgottenCheck(c.username) && c.username.toLowerCase() !== bot && !BOT_LOGINS.has(c.username.toLowerCase())) }
}

// pastas carry no usernames, so there is nothing for the forgotten filter to act on
export async function getPastas(channel: string, o: Range & { min_len?: number; min_repeats?: number; q?: string } = {}) {
  const env = await get<Envelope<RemotePasta[]>>(channel, '/pastas', { from: o.from, to: o.to, min_len: clamp(o.min_len, MIN_PASTA_LEN, 10_000), min_repeats: clamp(o.min_repeats, MIN_PASTA_REPEATS, 10_000), q: o.q, limit: clamp(o.limit, 1, MAX_PASTAS) }, true, TTL_AGG, o.signal)
  return env && Array.isArray(env.data) ? env : null
}

export async function getTermFootprint(channel: string, term: string, signal?: AbortSignal) {
  const c = await get<Computed<TermFootprint>>(channel, '/term-footprint', { term }, true, TTL_AGG, signal)
  return c && c.data && typeof c.data.count === 'number' ? c : null
}

// --- pins: ask heatsync to keep logging a channel while it's offline. owned by this key. ---

export type PinResult = { ok: true } | { ok: false; code: string }

async function mutate(method: 'PUT' | 'DELETE', channel: string): Promise<PinResult | null> {
  const key = process.env.HEATSYNC_LOGS_KEY
  if (!key || Date.now() < openUntil) return null
  try {
    const res = await fetch(`${base()}/twitch/${encodeURIComponent(channel.toLowerCase())}/pin`, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(FAST_MS),
    })
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'))
      trip(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) * 1000 : OPEN_MS)
      return null
    }
    if (res.status >= 500) return fail()
    failures = 0
    if (res.ok) return { ok: true }
    // 4xx are answers, not outages: they never trip the breaker
    return { ok: false, code: await errCode(res) }
  } catch {
    return fail()
  }
}

export const pin = (channel: string) => mutate('PUT', channel)
export const unpin = (channel: string) => mutate('DELETE', channel)

export interface PinList { channels: string[]; quota: { used: number; max: number } | null }

/** twitch channels this key currently pins (lowercased), or null when unreachable */
export async function listPins(): Promise<PinList | null> {
  const key = process.env.HEATSYNC_LOGS_KEY
  if (!key || Date.now() < openUntil) return null
  try {
    const res = await fetch(`${base()}/pins`, {
      headers: { Authorization: `Bearer ${key}`, 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(FAST_MS),
    })
    if (res.status === 429) { trip(); return null }
    if (!res.ok) return res.status >= 500 ? fail() : null
    const body = await res.json() as { data?: { quota?: { used?: unknown; max?: unknown }; pins?: unknown } }
    const pins = body.data?.pins
    if (!Array.isArray(pins)) return null
    failures = 0
    const channels: string[] = []
    for (const p of pins as { platform?: unknown; channel?: unknown }[]) {
      if (p?.platform === 'twitch' && typeof p.channel === 'string' && p.channel) channels.push(p.channel.toLowerCase())
    }
    const q = body.data?.quota
    return { channels, quota: typeof q?.used === 'number' && typeof q.max === 'number' ? { used: q.used, max: q.max } : null }
  } catch {
    return fail()
  }
}
