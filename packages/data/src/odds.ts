// odds.ts — bazaardb shop odds (item-odds, shop-odds) through the key bazaardb issued us.
//
// promises made to bazaardb: same user-agent as every other fetch, a hard cache (one pull
// per query per day, persisted so a restart can't re-spend it), stop on 429, and credit +
// link on every answer (format side). the key is ip-locked: a 403 parks the client for an
// hour instead of hammering. key lives in env BAZAARDB_KEY only, never in git.

import { chmod, rename } from 'fs/promises'
import { resolve } from 'path'
import type { ItemOdds, ShopOdds } from '@bazaarinfo/shared'
import { USER_AGENT, RateLimited, fetchSitemap, titleSlug, type Fetcher } from './card-pages'

const BASE = 'https://bazaardb.gg'
const TTL_MS = 86_400_000
const SITEMAP_TTL_MS = 86_400_000
const FORBIDDEN_PARK_MS = 3_600_000
const TIMEOUT_MS = 4_000
const MAX_ENTRIES = 600
const TOP_MERCHANTS = 3
const API_TIERS = ['Bronze', 'Silver', 'Gold', 'Diamond']

export const oddsKey = (): string => process.env.BAZAARDB_KEY?.trim() || ''

export const DEFAULT_ODDS_PATH = resolve(import.meta.dir, '../../../cache/odds.json')
export const oddsPath = (): string => process.env.BAZAARINFO_ODDS || DEFAULT_ODDS_PATH

export class OddsForbidden extends Error {
  constructor() { super('bazaardb odds: ip not allowed or bad key (403)') }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string')

// pure: item-odds payload -> the few numbers an answer needs. null = shape drifted.
export function parseItemOdds(raw: unknown): ItemOdds | null {
  const o = raw as Record<string, unknown> | null
  if (!o || typeof o !== 'object') return null
  const { itemName, itemUri, hero, tierOffered, days, pAnyByDay, merchants } = o
  if (typeof itemName !== 'string' || typeof itemUri !== 'string' || typeof hero !== 'string' || typeof tierOffered !== 'string') return null
  if (!isStrArr(days) || !Array.isArray(pAnyByDay) || !pAnyByDay.every(isNum) || pAnyByDay.length !== days.length) return null
  if (!/^\/card\/[a-z0-9]+\/[^\s]+$/.test(itemUri)) return null
  const top: ItemOdds['top'] = []
  for (const m of Array.isArray(merchants) ? merchants : []) {
    const mm = m as { name?: unknown, days?: unknown }
    if (typeof mm?.name !== 'string' || !Array.isArray(mm.days)) continue
    let peak = 0, day = ''
    mm.days.forEach((d: { pDay?: unknown }, i: number) => {
      if (isNum(d?.pDay) && d.pDay > peak) { peak = d.pDay; day = days[i] ?? '' }
    })
    if (peak > 0) top.push({ name: mm.name, peak, day })
  }
  top.sort((a, b) => b.peak - a.peak)
  return { name: itemName, uri: itemUri, hero, tier: tierOffered, days, pAny: pAnyByDay, top: top.slice(0, TOP_MERCHANTS) }
}

// pure: shop-odds payload -> per-day tier shares (percent)
export function parseShopOdds(raw: unknown): ShopOdds | null {
  const days = (raw as { days?: unknown } | null)?.days
  if (!Array.isArray(days) || !days.length) return null
  const out: ShopOdds['days'] = []
  for (const d of days as Record<string, unknown>[]) {
    const tiers = d?.tiers as Record<string, unknown> | undefined
    if (!isNum(d?.day) || !isNum(d?.samples) || !tiers || typeof tiers !== 'object') return null
    const clean: Record<string, number> = {}
    for (const [k, v] of Object.entries(tiers)) if (isNum(v)) clean[k] = v
    out.push({ day: d.day, samples: d.samples, tiers: clean })
  }
  return { days: out }
}

interface Entry { at: number, v: unknown | null }   // v null = bazaardb has no odds for it (cached too)

export interface OddsOptions {
  fetcher?: Fetcher
  now?: () => number
  path?: string
  key?: () => string
  log?: (msg: string) => void
}

export class OddsClient {
  private entries: Map<string, Entry> | null = null
  private inflight = new Map<string, Promise<unknown | null>>()
  private sitemap: { at: number, ids: Map<string, string> } | null = null
  private parkedUntil = 0
  private opts: Required<Omit<OddsOptions, 'path'>> & { path?: string }

  constructor(opts: OddsOptions = {}) {
    this.opts = { fetcher: fetch, now: Date.now, key: oddsKey, log: () => {}, ...opts }
  }

  get enabled(): boolean { return !!this.opts.key() }

  // never throws: any failure is "no odds" and the answer goes out without them
  async item(title: string, hero: string, tier: string): Promise<ItemOdds | null> {
    if (!API_TIERS.includes(tier)) return null
    try {
      const id = await this.cardId(title)
      if (!id) return null
      const qs = new URLSearchParams({ item: id, hero, tier })
      return await this.cached(`item:${id}:${hero}:${tier}`, `/api/item-odds?${qs}`, parseItemOdds) as ItemOdds | null
    } catch (e) {
      this.opts.log(`odds item ${title}: ${e instanceof Error ? e.message : e}`)
      return null
    }
  }

  async shop(): Promise<ShopOdds | null> {
    try {
      return await this.cached('shop', '/api/shop-odds', parseShopOdds) as ShopOdds | null
    } catch (e) {
      this.opts.log(`odds shop: ${e instanceof Error ? e.message : e}`)
      return null
    }
  }

  private async cardId(title: string): Promise<string | null> {
    const { now, fetcher } = this.opts
    if (!this.sitemap || now() - this.sitemap.at > SITEMAP_TTL_MS) {
      const map = await fetchSitemap(fetcher)
      const ids = new Map<string, string>()
      for (const [slug, path] of map) ids.set(slug, path.split('/')[2] ?? '')
      this.sitemap = { at: now(), ids }
    }
    return this.sitemap.ids.get(titleSlug(title)) || null
  }

  private async cached(key: string, path: string, parse: (raw: unknown) => unknown | null): Promise<unknown | null> {
    if (!this.enabled) return null
    const { now } = this.opts
    if (now() < this.parkedUntil) return null
    const entries = await this.load()
    const hit = entries.get(key)
    if (hit && now() - hit.at < TTL_MS) return hit.v
    const pending = this.inflight.get(key)
    if (pending) return pending
    const p = this.pull(key, path, parse, entries, hit).finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }

  private async pull(key: string, path: string, parse: (raw: unknown) => unknown | null, entries: Map<string, Entry>, stale?: Entry): Promise<unknown | null> {
    const { now, fetcher, log } = this.opts
    const res = await fetcher(`${BASE}${path}`, {
      headers: { 'User-Agent': USER_AGENT, Authorization: `Bearer ${this.opts.key()}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.status === 429) { this.parkedUntil = now() + TTL_MS; throw new RateLimited() }
    if (res.status === 403) {
      this.parkedUntil = now() + FORBIDDEN_PARK_MS
      log('odds: 403 from bazaardb — key bad or this host is not the allowlisted ip; parked 1h')
      throw new OddsForbidden()
    }
    let v: unknown | null = null
    if (res.status !== 404) {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      v = parse(await res.json())
      if (v == null) {
        log(`odds: ${path.split('?')[0]} shape changed — not caching`)
        return stale?.v ?? null   // drifted payload: serve the old answer, retry next ask
      }
    }
    entries.set(key, { at: now(), v })
    await this.save(entries)
    return v
  }

  // fail-soft: a missing/corrupt file is an empty cache
  private async load(): Promise<Map<string, Entry>> {
    if (this.entries) return this.entries
    this.entries = new Map()
    try {
      const raw = await Bun.file(this.opts.path ?? oddsPath()).json() as Record<string, Entry>
      for (const [k, e] of Object.entries(raw)) if (e && isNum(e.at) && 'v' in e) this.entries.set(k, e)
    } catch { /* first run */ }
    return this.entries
  }

  private async save(entries: Map<string, Entry>): Promise<void> {
    const t = this.opts.now()
    // oldest out first; Map keeps insertion order but re-sets keep their slot, so sort by age
    const keep = [...entries].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES)
    this.entries = new Map(keep.filter(([, e]) => t - e.at < TTL_MS * 3))
    const path = this.opts.path ?? oddsPath()
    const tmp = `${path}.${process.pid}.tmp`
    try {
      await Bun.write(tmp, JSON.stringify(Object.fromEntries(this.entries)))
      await chmod(tmp, 0o600)
      await rename(tmp, path)
    } catch (e) { this.opts.log(`odds: save failed: ${e instanceof Error ? e.message : e}`) }
  }
}

let shared: OddsClient | null = null
export const odds = (log?: (m: string) => void): OddsClient => (shared ??= new OddsClient({ log }))
