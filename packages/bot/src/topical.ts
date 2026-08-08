import { log } from './log'
import { readJson } from './http'
import { fetchSubreddit } from './reddit-feed'

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

// r/popular via the shared RSS transport — the JSON endpoint 403s from this host and had
// been failing silently inside allSettled below, leaving the digest quietly HN-only.
// RSS carries no score, so the feed's own ordering does the filtering instead.
async function fetchRedditTitles(): Promise<string[]> {
  const entries = await fetchSubreddit('popular', 'popular')
  return entries
    .map((e) => e.title.replace(/\s+/g, ' ').trim().slice(0, 90))
    .filter(Boolean)
    .slice(0, 4)
}

export async function refreshTopicalDigest(): Promise<void> {
  try {
    const [hn, reddit] = await Promise.allSettled([fetchHnTitles(), fetchRedditTitles()])
    const parts: string[] = []
    if (hn.status === 'fulfilled' && hn.value.length > 0) parts.push(`HN: ${hn.value.map((t) => `"${t}"`).join(' • ')}`)
    if (reddit.status === 'fulfilled' && reddit.value.length > 0) parts.push(`Reddit: ${reddit.value.map((t) => `"${t}"`).join(' • ')}`)
    if (parts.length === 0) return
    cachedDigest = parts.join(' || ')
    // name which halves landed — "refreshed (243 chars)" looked healthy for a week while
    // the reddit half was 403ing into allSettled and being dropped on the floor
    const sources = [
      hn.status === 'fulfilled' && hn.value.length > 0 ? 'hn' : null,
      reddit.status === 'fulfilled' && reddit.value.length > 0 ? 'reddit' : null,
    ].filter(Boolean).join('+')
    log(`topical: refreshed (${cachedDigest.length} chars, ${sources || 'none'})`)
  } catch (e) {
    log(`topical: refresh failed: ${e}`)
  }
}
