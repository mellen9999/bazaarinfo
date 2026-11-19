// Steam news RSS, shared by every first-party feed (guildrun patch notes, the bazaar's
// own announcements). The RSS is entity-encoded steam-bb HTML inside <description>.
// Fail-soft contract: fetchSteamNews never throws — any failure returns [] so callers
// keep their last good cache.
import { log } from './log'

const UA = 'BazaarInfo/1.0 (Twitch bot; github.com/mellen9999/bazaarinfo)'
const FETCH_TIMEOUT_MS = 30_000
const MAX_ITEMS = 3
const MAX_SUMMARY = 260

export interface NewsItem {
  title: string
  date: string // "Aug 19" — display form, parsed from pubDate
  iso: string // pubDate as ISO, '' when unparseable
  summary: string
}

export interface NewsOpts {
  max?: number
  maxSummary?: number
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
}

/** entity-encoded steam-bb html → the first few readable list lines. pure, testable. */
export function summarizeNewsHtml(raw: string, maxSummary = MAX_SUMMARY): string {
  const html = decodeEntities(raw)
  // list items are where steam patch posts put the actual changes; paragraphs are greeting fluff
  const lis = [...html.matchAll(/<li[^>]*>(.*?)<\/li>/gs)]
    .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 3)
  let text = lis.slice(0, 4).join('; ')
  if (!text) text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  if (text.length > maxSummary) text = text.slice(0, maxSummary - 1).replace(/\s+\S*$/, '') + '…'
  return text
}

/** rss xml → items. tolerant: a malformed entry costs itself, never the parse. */
export function parseNewsFeed(xml: string, opts: NewsOpts = {}): NewsItem[] {
  const items: NewsItem[] = []
  const max = opts.max ?? MAX_ITEMS
  for (const m of xml.matchAll(/<item>(.*?)<\/item>/gs)) {
    const block = m[1]
    const title = /<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s.exec(block)?.[1]?.trim()
    if (!title) continue
    const pub = /<pubDate>(.*?)<\/pubDate>/s.exec(block)?.[1] ?? ''
    const d = new Date(pub)
    const date = Number.isNaN(d.getTime()) ? '' : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
    const desc = /<description>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/description>/s.exec(block)?.[1] ?? ''
    items.push({ title: decodeEntities(title), date, iso: Number.isNaN(d.getTime()) ? '' : d.toISOString(), summary: summarizeNewsHtml(desc, opts.maxSummary) })
    if (items.length >= max) break
  }
  return items
}

/** fetch + parse one app's news feed. [] on any failure (logged) — never throws. */
export async function fetchSteamNews(appid: number, opts: NewsOpts = {}): Promise<NewsItem[]> {
  try {
    const res = await fetch(`https://store.steampowered.com/feeds/news/app/${appid}/`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return parseNewsFeed(await res.text(), opts)
  } catch (e) {
    log(`steam-news ${appid}: fetch failed: ${e}`)
    return []
  }
}
