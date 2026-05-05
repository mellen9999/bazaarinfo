import { log } from './log'

const HN_TOP = 'https://hacker-news.firebaseio.com/v0/topstories.json'
const HN_ITEM = (id: number) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`
const REDDIT_POPULAR = 'https://www.reddit.com/r/popular/hot.json?limit=15'
const USER_AGENT = 'BazaarInfo/1.0 (Twitch bot; github.com/mellen9999/bazaarinfo)'
const FETCH_TIMEOUT = 20_000

interface HnItem { title?: string; score?: number; type?: string }
interface RedditChild { data: { title: string; score: number; subreddit: string; over_18?: boolean; stickied?: boolean } }

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
  return await res.json() as T
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

async function fetchRedditTitles(): Promise<string[]> {
  const data = await fetchJson<{ data: { children: RedditChild[] } }>(REDDIT_POPULAR)
  return data.data.children
    .map((c) => c.data)
    .filter((d) => !d.over_18 && !d.stickied && d.score > 1000)
    .map((d) => `[${d.subreddit}] ${d.title.replace(/\s+/g, ' ').trim()}`.slice(0, 90))
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
    log(`topical: refreshed (${cachedDigest.length} chars)`)
  } catch (e) {
    log(`topical: refresh failed: ${e}`)
  }
}
