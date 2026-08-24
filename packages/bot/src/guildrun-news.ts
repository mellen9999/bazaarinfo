// Official Guildrun patch notes, from the steam news RSS — the only first-party feed
// the game has (no wiki, no API, weekly demo patches). "whats new in guildrun" was a
// hole: the dump shows current VALUES but never what changed or when. This is the
// guildrun analogue of patch.ts (bazaardb patch notes), same fail-soft contract:
// every export returns '' on any failure, an outage can never crash the bot.
//
// The RSS is entity-encoded steam-bb HTML inside <description>. We keep the headline
// facts — title, date, the first few list items — and never quote deep patch detail:
// specific number changes belong to the dump, which already tracks the patch.

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { log } from './log'

const FEED_URL = 'https://store.steampowered.com/feeds/news/app/3669200/'
const CACHE_PATH = resolve(import.meta.dir, '../../../cache/guildrun-news.json')
const UA = 'BazaarInfo/1.0 (Twitch bot; github.com/mellen9999/bazaarinfo)'
const TTL_MS = 6 * 60 * 60 * 1000 // news lands ~weekly; 6h keeps patch day fresh enough
const FETCH_TIMEOUT_MS = 30_000
const MAX_ITEMS = 3
const MAX_SUMMARY = 260

interface NewsItem {
  title: string
  date: string // "Aug 19" — display form, parsed from pubDate
  summary: string
}

interface NewsCache {
  fetchedAt: number
  items: NewsItem[]
}

let cache: NewsCache | null = null
let refreshing: Promise<void> | null = null

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
}

/** entity-encoded steam-bb html → the first few readable list lines. pure, testable. */
export function summarizeNewsHtml(raw: string): string {
  const html = decodeEntities(raw)
  // list items are where steam patch posts put the actual changes; paragraphs are greeting fluff
  const lis = [...html.matchAll(/<li[^>]*>(.*?)<\/li>/gs)]
    .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 3)
  let text = lis.slice(0, 4).join('; ')
  if (!text) text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  if (text.length > MAX_SUMMARY) text = text.slice(0, MAX_SUMMARY - 1).replace(/\s+\S*$/, '') + '…'
  return text
}

/** rss xml → items. tolerant: a malformed entry costs itself, never the parse. */
export function parseNewsFeed(xml: string): NewsItem[] {
  const items: NewsItem[] = []
  for (const m of xml.matchAll(/<item>(.*?)<\/item>/gs)) {
    const block = m[1]
    const title = /<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s.exec(block)?.[1]?.trim()
    if (!title) continue
    const pub = /<pubDate>(.*?)<\/pubDate>/s.exec(block)?.[1] ?? ''
    const d = new Date(pub)
    const date = Number.isNaN(d.getTime()) ? '' : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
    const desc = /<description>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/description>/s.exec(block)?.[1] ?? ''
    items.push({ title: decodeEntities(title), date, summary: summarizeNewsHtml(desc) })
    if (items.length >= MAX_ITEMS) break
  }
  return items
}

function loadDisk(): void {
  if (cache || !existsSync(CACHE_PATH)) return
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
    if (parsed && Array.isArray(parsed.items)) cache = parsed
  } catch {
    // corrupt cache = no cache
  }
}

async function refresh(): Promise<void> {
  try {
    const res = await fetch(FEED_URL, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const items = parseNewsFeed(await res.text())
    if (items.length === 0) {
      log('guildrun-news: feed parsed to zero items, keeping previous cache')
      return
    }
    cache = { fetchedAt: Date.now(), items }
    try { writeFileSync(CACHE_PATH, JSON.stringify(cache)) } catch {}
    log(`guildrun-news: ${items.length} items, latest "${items[0].title}"`)
  } catch (e) {
    log(`guildrun-news: refresh failed: ${e}`)
  }
}

/** non-blocking, same contract as refreshGuildrunIfNeeded. */
export function refreshGrNewsIfNeeded(): void {
  loadDisk()
  const age = cache ? Date.now() - cache.fetchedAt : Infinity
  if (age < TTL_MS || refreshing) return
  refreshing = refresh()
    .catch(() => {})
    .finally(() => {
      refreshing = null
    })
}

/** the prompt line for "whats new in guildrun" — '' when nothing loaded. */
export function getGrNewsLine(): string {
  loadDisk()
  if (!cache || cache.items.length === 0) return ''
  const parts = cache.items.map((i) => `${i.title}${i.date ? ` (${i.date})` : ''}: ${i.summary}`)
  return `Guildrun official news (steam, newest first — this is what "what's new" means): ${parts.join(' | ')}`
}

/** test seam */
export function __setGrNewsForTest(items: NewsItem[] | null): void {
  cache = items ? { fetchedAt: Date.now(), items } : null
}
