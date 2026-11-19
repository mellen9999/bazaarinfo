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
import { fetchSteamNews, type NewsItem } from './steam-news'

const APPID = 3669200
const CACHE_PATH = resolve(import.meta.dir, '../../../cache/guildrun-news.json')
const TTL_MS = 6 * 60 * 60 * 1000 // news lands ~weekly; 6h keeps patch day fresh enough

interface NewsCache {
  fetchedAt: number
  items: NewsItem[]
}

let cache: NewsCache | null = null
let refreshing: Promise<void> | null = null

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
    const items = await fetchSteamNews(APPID)
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
