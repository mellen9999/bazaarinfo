import type { RedditPost, RedditCache } from '@bazaarinfo/shared'

const USER_AGENT = 'BazaarInfo/1.0 (Twitch bot; github.com/mellen9999/bazaarinfo)'
const BODY_LIMIT = 300

interface RedditListing {
  data: {
    children: {
      data: {
        id: string
        title: string
        selftext: string
        score: number
        permalink: string
        created_utc: number
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
  }))
}

export async function scrapeReddit(subreddit = 'PlayTheBazaar'): Promise<RedditCache> {
  const base = `https://www.reddit.com/r/${subreddit}`
  const [top, fresh] = await Promise.all([
    fetchListing(`${base}/top.json?t=week&limit=25`),
    fetchListing(`${base}/new.json?limit=15`),
  ])

  const seen = new Set<string>()
  const posts: RedditPost[] = []
  for (const p of [...extractPosts(top), ...extractPosts(fresh)]) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    posts.push(p)
  }
  posts.sort((a, b) => b.score - a.score)

  return { posts, fetchedAt: new Date().toISOString() }
}
