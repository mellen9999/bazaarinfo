import { log } from './log'
import { readJson } from './http'

const HN_TOP = 'https://hacker-news.firebaseio.com/v0/topstories.json'
const HN_ITEM = (id: number) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`
const USER_AGENT = 'BazaarInfo/1.0 (Twitch bot; github.com/mellen9999/bazaarinfo)'
const FETCH_TIMEOUT = 20_000

interface HnItem { title?: string; score?: number; type?: string }

let cachedDigest = ''

export function getTopicalDigest(): string {
  return cachedDigest
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const parsed = await readJson<T>(res)
  if (!parsed.data) throw new Error('HTTP empty/malformed body')
  return parsed.data
}

async function fetchHnTitles(): Promise<string[]> {
  const ids = await fetchJson<number[]>(HN_TOP)
  const top = ids.slice(0, 25)
  const items = await Promise.all(top.map((id) =>
    fetchJson<HnItem>(HN_ITEM(id)).catch(() => null),
  ))
  return items
    .filter((i): i is HnItem => !!i?.title && (i.score ?? 0) > 100)
    .map((i) => i.title!.replace(/\s+/g, ' ').trim().slice(0, 90))
    .slice(0, 5)
}

export async function refreshTopicalDigest(): Promise<void> {
  try {
    const hn = await fetchHnTitles()
    if (hn.length === 0) return
    cachedDigest = `HN: ${hn.map((t) => `"${t}"`).join(' • ')}`
    log(`topical: refreshed (${cachedDigest.length} chars)`)
  } catch (e) {
    log(`topical: refresh failed: ${e}`)
  }
}
