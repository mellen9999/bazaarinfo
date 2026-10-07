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
import type { TierName } from '@bazaarinfo/shared'

export type CooldownValue = number | Partial<Record<TierName, number>>

export interface PageFacts { art?: string, cd?: CooldownValue | null, at: string }
export interface PageCache { cdn: string, cards: Record<string, PageFacts> }
export interface ParsedPage { art?: string, cdn?: string, cooldown: CooldownValue | null }

const SITEMAP_URL = 'https://bazaardb.gg/sitemap.xml'
const USER_AGENT = 'BazaarInfo/1.0 (Twitch bot; github.com/mellen9999/bazaarinfo)'
const HASH_RE = /\/v1\/(z[\d.]+)\/([a-f0-9]{20,64})@/
const COOLDOWN_ROW = '"tr","CooldownMax"'
const COOLDOWN_CELL = /"CooldownMax-(Bronze|Silver|Gold|Diamond|Legendary)",\{(?:"style":\{[^{}]*\},)?"children":"([\d.]+)s"/g
const MAX_PAGE_BYTES = 8_000_000
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

  const start = text.indexOf(COOLDOWN_ROW)
  if (start < 0) return out
  // the row ends where the next row starts
  const next = text.indexOf('["$","tr"', start + COOLDOWN_ROW.length)
  const row = text.slice(start, next < 0 ? undefined : next)
  const perTier: Partial<Record<TierName, number>> = {}
  for (const cell of row.matchAll(COOLDOWN_CELL)) {
    const v = parseFloat(cell[2])
    if (Number.isFinite(v)) perTier[cell[1] as TierName] = v
  }
  const vals = TIERS.map((t) => perTier[t]).filter((v): v is number => v != null)
  if (!vals.length) return out
  out.cooldown = vals.every((v) => v === vals[0]) ? vals[0] : perTier
  return out
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

export async function fetchCardPage(path: string, f: Fetcher = fetch): Promise<ParsedPage | null> {
  const res = await f(`https://bazaardb.gg${path}`, {
    headers: { 'User-Agent': USER_AGENT, RSC: '1' },
    signal: AbortSignal.timeout(20_000),
  })
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
    .filter((t) => cache.cards[t] && t0 - Date.parse(cache.cards[t].at || '') > staleMs)
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
        const facts: PageFacts = { cd: page.cooldown, at: new Date(now()).toISOString() }
        if (page.art) facts.art = page.art
        else if (cache.cards[title]?.art) facts.art = cache.cards[title].art
        cache.cards[title] = facts
        if (page.cdn && (!cache.cdn || cdnNewer(page.cdn, cache.cdn))) cache.cdn = page.cdn
        res.fetched++
      }
    } catch (e) {
      res.failed++
      onProgress?.(`card pages: ${title}: ${e instanceof Error ? e.message : e}`)
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
