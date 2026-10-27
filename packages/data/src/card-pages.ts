// card-pages.ts — per-card facts (cooldown, art hash, cdn segment) read from each
// card's bazaardb page, fetched as RSC (the server-rendered data behind the html).
//
// bazaardb's dump.json carries neither cooldowns nor art hashes, and the old
// third-party cooldown source is gone, so this is the one place both come from.
// Results live in a runtime cache file (repo-root cache/, gitignored): the scraper
// fills only cards it has not seen (or that went stale), a few per refresh, so a patch
// day's new cards fill themselves and nothing needs running by hand.
//
// The cdn z-segment is NOT matched literally. It tracks the game version and has
// already moved (z11.0 -> z17.0 -> z19.0); a pinned pattern silently matches nothing.
// A new patch's cards exist only under the new segment, while the new segment still
// serves every older hash, so consumers follow the newest one seen.

import { open, rename, chmod, mkdir } from 'fs/promises'
import { dirname, resolve } from 'path'
import type { TierName, MerchantPool } from '@bazaarinfo/shared'

export type { MerchantPool }

export type CooldownValue = number | Partial<Record<TierName, number>>

// v = facts schema version; entries older than FACTS_VERSION re-fetch through the normal fill
export interface PageFacts {
  art?: string, cd?: CooldownValue | null, at: string
  v?: number
  buy?: CooldownValue, sell?: CooldownValue   // gold per tier (same shape as a cooldown)
  where?: string[]                            // bazaardb's "Where to Find" (inferred) source cards
  pool?: MerchantPool
}
export interface PageCache { cdn: string, cards: Record<string, PageFacts> }
export interface ParsedPage {
  art?: string, cdn?: string, cooldown: CooldownValue | null
  buy?: CooldownValue, sell?: CooldownValue, where?: string[], pool?: MerchantPool
}

// bump when parseCardPage learns a new fact: cached entries below it count as stale
export const FACTS_VERSION = 2

const SITEMAP_URL = 'https://bazaardb.gg/sitemap.xml'
export const USER_AGENT = 'BazaarInfo/1.0 (Twitch bot; github.com/mellen9999/bazaarinfo)'
const HASH_RE = /\/v1\/(z[\d.]+)\/([a-f0-9]{20,64})@/
const WHERE_MAX = 12
const POOL_HEROES_MAX = 12
// most pages are ~200KB; Stickybeans is 24MB (it lists every board it appears on)
const MAX_PAGE_BYTES = 48_000_000
const TIERS: TierName[] = ['Bronze', 'Silver', 'Gold', 'Diamond', 'Legendary']

// repo-root cache/card-pages.json; env override because the ebs runs from another checkout
export const DEFAULT_PAGES_PATH = resolve(import.meta.dir, '../../../cache/card-pages.json')
export function pagesPath(): string {
  return process.env.BAZAARINFO_CARD_PAGES || DEFAULT_PAGES_PATH
}

// pure: one RSC payload -> facts. a passive card has no cooldown row -> null.
export function parseCardPage(text: string): ParsedPage {
  const m = HASH_RE.exec(text)
  const out: ParsedPage = { cooldown: null }
  if (m) { out.cdn = m[1]; out.art = m[2] }

  const cooldown = parseTierRow(text, 'CooldownMax', 's')
  if (cooldown != null) out.cooldown = cooldown
  const buy = parseTierRow(text, 'BuyPrice')
  if (buy != null) out.buy = buy
  const sell = parseTierRow(text, 'SellPrice')
  if (sell != null) out.sell = sell
  const where = parseWhereToFind(text)
  if (where) out.where = where
  const pool = parseMerchantPool(text)
  if (pool) out.pool = pool
  return out
}

// pure: one per-tier attribute row ("tr","<attr>" -> cells "<attr>-Gold" ...) -> a number
// when every tier agrees, else a tier map. null when the row is absent or has no cells.
// unit 's' = cooldown cells ("4s"), '' = bare numbers (prices).
export function parseTierRow(text: string, attr: string, unit: '' | 's' = ''): CooldownValue | null {
  const marker = `"tr","${attr}"`
  const start = text.indexOf(marker)
  if (start < 0) return null
  // the row ends where the next row starts
  const next = text.indexOf('["$","tr"', start + marker.length)
  const row = text.slice(start, next < 0 ? undefined : next)
  const cell = new RegExp(`"${attr}-(Bronze|Silver|Gold|Diamond|Legendary)",\\{(?:"style":\\{[^{}]*\\},)?"children":"?([\\d.]+)${unit}"?[,}]`, 'g')
  const perTier: Partial<Record<TierName, number>> = {}
  for (const m of row.matchAll(cell)) {
    const v = parseFloat(m[2])
    if (Number.isFinite(v)) perTier[m[1] as TierName] = v
  }
  const vals = TIERS.map((t) => perTier[t]).filter((v): v is number => v != null)
  if (!vals.length) return null
  return vals.every((v) => v === vals[0]) ? vals[0] : perTier
}

const titleOfSlug = (slug: string): string => {
  try { return decodeURIComponent(slug).replace(/-/g, ' ') } catch { return slug.replace(/-/g, ' ') }
}

// pure: the "Where to Find" section -> source card titles (bazaardb flags it "Inferred").
// the section's body streams as a separate row referenced by "children":"$Lxx"; that row's
// card links carry the titles (img alt, else the url slug). absent/malformed -> undefined.
export function parseWhereToFind(text: string): string[] | undefined {
  const at = text.indexOf('section-where-to-find","className')
  if (at < 0) return undefined
  const ref = /"children":"\$L([0-9a-f]+)"/.exec(text.slice(at, at + 3000))
  let body: string
  if (ref) {
    const rowAt = text.indexOf(`\n${ref[1]}:`)
    if (rowAt < 0) return undefined
    const end = text.indexOf('\n', rowAt + 1)
    body = text.slice(rowAt, end < 0 ? undefined : end)
  } else {
    const end = text.indexOf('\n', at)
    body = text.slice(at, end < 0 ? at + 20_000 : Math.min(end, at + 20_000))
  }
  const titles: string[] = []
  const links = [...body.matchAll(/"href":"\/card\/[^/"]+\/([^"]+)"/g)]
  for (let i = 0; i < links.length && titles.length < WHERE_MAX; i++) {
    const from = links[i].index! + links[i][0].length
    const to = i + 1 < links.length ? links[i + 1].index! : body.length
    const alt = /"alt":"([^"]+)"/.exec(body.slice(from, to))
    let title = titleOfSlug(links[i][1])
    if (alt && alt[1] !== '$undefined') {
      try { title = JSON.parse(`"${alt[1]}"`) as string } catch { /* keep the slug title */ }
    }
    if (title && !titles.includes(title)) titles.push(title)
  }
  return titles.length ? titles : undefined
}

// balanced {...} starting at text[i] === '{', string-aware; null when it never closes
function sliceObject(text: string, i: number, max = 20_000): string | null {
  let depth = 0
  let inStr = false
  for (let j = i; j < text.length && j - i < max; j++) {
    const c = text[j]
    if (inStr) {
      if (c === '\\') j++
      else if (c === '"') inStr = false
    } else if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return text.slice(i, j + 1)
  }
  return null
}

// pure: a merchant page -> its pool (heroes + per-hero card counts per tier). any other
// page has no poolCounts -> undefined. malformed json -> undefined, never throws.
export function parseMerchantPool(text: string): MerchantPool | undefined {
  const heroesAt = text.indexOf('"availableHeroes":[')
  const countsAt = text.indexOf('"poolCounts":{', heroesAt < 0 ? 0 : heroesAt)
  if (heroesAt < 0 || countsAt < 0) return undefined
  try {
    const hm = /^"availableHeroes":(\[[^\]]*\])/.exec(text.slice(heroesAt, heroesAt + 600))
    const obj = sliceObject(text, countsAt + '"poolCounts":'.length)
    if (!hm || !obj) return undefined
    const heroes = (JSON.parse(hm[1]) as unknown[]).filter((h): h is string => typeof h === 'string').slice(0, POOL_HEROES_MAX)
    const raw = JSON.parse(obj) as Record<string, { cards?: Record<string, unknown> }>
    const counts: MerchantPool['counts'] = {}
    for (const hero of heroes) {
      const cards = raw[hero]?.cards
      if (!cards || typeof cards !== 'object') continue
      const per: Partial<Record<TierName, number>> = {}
      for (const t of TIERS) {
        const n = cards[t]
        if (typeof n === 'number' && Number.isFinite(n) && n > 0) per[t] = n
      }
      if (Object.keys(per).length) counts[hero] = per
    }
    if (!heroes.length || !Object.keys(counts).length) return undefined
    return { heroes, counts }
  } catch {
    return undefined
  }
}

// pure: sitemap xml -> slug -> /card/{id}/{slug}. slugs are percent-encoded
// ("Mortar-%26-Pestle"), so both the decoded and raw forms are keyed.
export function parseSitemap(xml: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const match of xml.matchAll(/https:\/\/bazaardb\.gg(\/card\/[^<\s]+)/g)) {
    const path = match[1]
    const slug = path.split('/').pop()!
    map.set(slug, path)
    try {
      const decoded = decodeURIComponent(slug)
      if (decoded !== slug) map.set(decoded, path)
    } catch { /* malformed escape: the raw key above still stands */ }
  }
  return map
}

export const titleSlug = (title: string) => title.replace(/ /g, '-')

// "z18.0" vs "z9.9": compare segment by segment
export function cdnNewer(a: string, b: string): boolean {
  const pa = a.slice(1).split('.').map(Number)
  const pb = b.slice(1).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d > 0
  }
  return false
}

export const CDN_RE = /^z[1-9]\d*\.\d+$/

// read a body with a hard byte ceiling, aborting past it — holds against chunked
// transfer-encoding and a missing or lying content-length
export async function readTextCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) { reader.cancel().catch(() => {}); throw new Error('page too large') }
    chunks.push(value)
  }
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { buf.set(c, off); off += c.byteLength }
  return new TextDecoder().decode(buf)
}

export type Fetcher = typeof fetch

export async function fetchSitemap(f: Fetcher = fetch): Promise<Map<string, string>> {
  const res = await f(SITEMAP_URL, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`sitemap HTTP ${res.status}`)
  return parseSitemap(await readTextCapped(res, 50_000_000))
}

export class RateLimited extends Error {
  constructor() { super('bazaardb rate limit (429)') }
}

export async function fetchCardPage(path: string, f: Fetcher = fetch): Promise<ParsedPage | null> {
  const res = await f(`https://bazaardb.gg${path}`, {
    headers: { 'User-Agent': USER_AGENT, RSC: '1' },
    signal: AbortSignal.timeout(20_000),
  })
  // rate-limited: the whole run must stop, not burn through the rest of the list
  if (res.status === 429) throw new RateLimited()
  if (!res.ok) return null
  return parseCardPage(await readTextCapped(res, MAX_PAGE_BYTES))
}

// fail-soft: a missing/corrupt file is just an empty cache
export async function loadPageCache(path: string = pagesPath()): Promise<PageCache> {
  try {
    const raw = await Bun.file(path).json() as Partial<PageCache>
    const cards = raw.cards && typeof raw.cards === 'object' ? raw.cards : {}
    return { cdn: typeof raw.cdn === 'string' && CDN_RE.test(raw.cdn) ? raw.cdn : '', cards }
  } catch {
    return { cdn: '', cards: {} }
  }
}

export async function savePageCache(cache: PageCache, path: string = pagesPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  const fh = await open(tmp, 'w')
  try {
    await fh.writeFile(JSON.stringify(cache))
    await fh.sync()
  } finally {
    await fh.close()
  }
  await chmod(tmp, 0o644)
  await rename(tmp, path)
}

export interface FillOptions {
  cap?: number          // max pages fetched this run
  delayMs?: number
  budgetMs?: number     // stop starting new fetches past this
  staleMs?: number      // re-fetch entries older than this (balance patches change cooldowns)
  fetcher?: Fetcher
  now?: () => number
  onProgress?: (msg: string) => void
  path?: string         // cache file to save to (default pagesPath())
  save?: boolean
}
export interface FillResult { fetched: number, failed: number, pending: number }

export const DEFAULT_CAP = 150
const STALE_MS = 3 * 86_400_000

// fetch pages for titles the cache lacks (or that went stale), missing first then
// oldest. never throws: a failed card is skipped and retried next run.
export async function fillPageCache(titles: string[], cache: PageCache, opts: FillOptions = {}): Promise<FillResult> {
  const { cap = DEFAULT_CAP, delayMs = 150, budgetMs = 120_000, staleMs = STALE_MS, fetcher = fetch, onProgress } = opts
  const now = opts.now ?? Date.now
  const t0 = now()
  const uniq = [...new Set(titles)]
  const missing = uniq.filter((t) => !cache.cards[t])
  const stale = uniq
    .filter((t) => cache.cards[t] && ((cache.cards[t].v ?? 1) < FACTS_VERSION || t0 - Date.parse(cache.cards[t].at || '') > staleMs))
    .sort((a, b) => Date.parse(cache.cards[a].at) - Date.parse(cache.cards[b].at))
  const todo = [...missing, ...stale]
  const res: FillResult = { fetched: 0, failed: 0, pending: Math.max(0, todo.length - cap) }
  if (!todo.length) return res

  let sitemap: Map<string, string>
  try {
    sitemap = await fetchSitemap(fetcher)
  } catch (e) {
    onProgress?.(`card pages: sitemap failed (${e instanceof Error ? e.message : e}) — ${todo.length} pending`)
    return { ...res, pending: todo.length }
  }

  let attempted = 0
  for (const title of todo) {
    if (attempted >= cap || now() - t0 > budgetMs) break
    const path = sitemap.get(titleSlug(title))
    if (!path) continue // not a card page (monster, renamed): leave it pending, costs nothing
    attempted++
    try {
      const page = await fetchCardPage(path, fetcher)
      // a page with neither art nor cooldown row parsed to nothing: treat as a failed
      // fetch (layout drift / error page) rather than caching "no cooldown" for 3 days
      if (!page || (!page.art && page.cooldown == null && !page.cdn)) { res.failed++ } else {
        const facts: PageFacts = { cd: page.cooldown, at: new Date(now()).toISOString(), v: FACTS_VERSION }
        if (page.buy != null) facts.buy = page.buy
        if (page.sell != null) facts.sell = page.sell
        if (page.where) facts.where = page.where
        if (page.pool) facts.pool = page.pool
        if (page.art) facts.art = page.art
        else if (cache.cards[title]?.art) facts.art = cache.cards[title].art
        cache.cards[title] = facts
        if (page.cdn && (!cache.cdn || cdnNewer(page.cdn, cache.cdn))) cache.cdn = page.cdn
        res.fetched++
      }
    } catch (e) {
      res.failed++
      onProgress?.(`card pages: ${title}: ${e instanceof Error ? e.message : e}`)
      if (e instanceof RateLimited) break // the rest stay pending for the next refresh
    }
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
  }
  res.pending = Math.max(0, todo.length - res.fetched)
  if (opts.save !== false && res.fetched > 0) {
    try { await savePageCache(cache, opts.path) } catch (e) { onProgress?.(`card pages: save failed: ${e instanceof Error ? e.message : e}`) }
  }
  onProgress?.(`card pages: fetched ${res.fetched}, failed ${res.failed}, pending ${res.pending}`)
  return res
}
