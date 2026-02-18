import type { RedditPost, RedditCache } from '@bazaarinfo/shared'

const USER_AGENT = 'BazaarInfo/1.0 (Twitch bot; github.com/mellen9999/bazaarinfo)'
const BODY_LIMIT = 500
const DELAY_MS = 500

interface RedditListing {
  data: {
    after: string | null
    children: {
      data: {
        id: string
        title: string
        selftext: string
        score: number
        permalink: string
        created_utc: number
        link_flair_text: string | null
      }
    }[]
  }
}

async function fetchListing(url: string): Promise<RedditListing> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`reddit ${res.status} for ${url}`)
  return res.json()
}

function extractPosts(listing: RedditListing): RedditPost[] {
  return listing.data.children.map((c) => ({
    id: c.data.id,
    title: c.data.title,
    body: c.data.selftext.slice(0, BODY_LIMIT),
    score: c.data.score,
    url: `https://reddit.com${c.data.permalink}`,
    createdAt: c.data.created_utc,
    flair: c.data.link_flair_text ?? '',
  }))
}

async function fetchPaginated(baseUrl: string, maxPages = 3): Promise<RedditPost[]> {
  const posts: RedditPost[] = []
  let after: string | null = null
  for (let i = 0; i < maxPages; i++) {
    const url = after ? `${baseUrl}&after=${after}` : baseUrl
    const listing = await fetchListing(url)
    posts.push(...extractPosts(listing))
    after = listing.data.after
    if (!after) break
    if (i < maxPages - 1) await new Promise((r) => setTimeout(r, DELAY_MS))
  }
  return posts
}

export async function scrapeReddit(subreddit = 'PlayTheBazaar'): Promise<RedditCache> {
  const base = `https://www.reddit.com/r/${subreddit}`

  // fetch multiple sort orders in parallel for broad coverage
  const [topWeek, topMonth, topAll, hot, fresh] = await Promise.all([
    fetchPaginated(`${base}/top.json?t=week&limit=100`, 2),
    fetchPaginated(`${base}/top.json?t=month&limit=100`, 3),
    fetchPaginated(`${base}/top.json?t=all&limit=100`, 3),
    fetchPaginated(`${base}/hot.json?limit=100`, 2),
    fetchListing(`${base}/new.json?limit=100`).then(extractPosts),
  ])

  const seen = new Set<string>()
  const posts: RedditPost[] = []
  // priority order: recent top first, then historical, then hot, then new
  for (const p of [...topWeek, ...topMonth, ...hot, ...fresh, ...topAll]) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    posts.push(p)
  }
  posts.sort((a, b) => b.score - a.score)

  return { posts, fetchedAt: new Date().toISOString() }
}
