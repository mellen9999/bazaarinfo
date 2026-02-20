import { log } from './log'

const SUBREDDIT_URL = 'https://www.reddit.com/r/PlayTheBazaar/hot.json?limit=25'
const USER_AGENT = 'BazaarInfo/1.0 (Twitch bot; github.com/mellen9999/bazaarinfo)'
const API_KEY = process.env.ANTHROPIC_API_KEY
const MODEL = 'claude-haiku-4-5-20251001'

const MAX_RETRIES = 3
const RETRY_DELAYS = [1000, 2000, 4000]
const FETCH_TIMEOUT = 30_000

interface RedditPost {
  title: string
  score: number
  selftext: string
  link_flair_text: string | null
  id: string
  num_comments: number
}

interface RedditComment {
  body: string
  score: number
}

let cachedDigest = ''

export function getRedditDigest(): string {
  return cachedDigest
}

async function fetchJson(url: string): Promise<unknown> {
  let lastErr: Error | undefined

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e))
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]))
      }
    }
  }

  throw lastErr ?? new Error('fetch failed')
}

async function fetchHotPosts(): Promise<RedditPost[]> {
  const data = await fetchJson(SUBREDDIT_URL) as {
    data: { children: { data: RedditPost }[] }
  }
  return data.data.children.map((c) => c.data)
}

async function fetchTopComments(postId: string, limit = 5): Promise<RedditComment[]> {
  const url = `https://www.reddit.com/r/PlayTheBazaar/comments/${postId}.json?limit=${limit}&sort=top`
  const data = await fetchJson(url) as { data: { children: { data: RedditComment }[] } }[]
  if (!Array.isArray(data) || data.length < 2) return []
  return data[1].data.children
    .filter((c) => c.data?.body)
    .map((c) => ({ body: c.data.body, score: c.data.score }))
}

function buildRedditContext(posts: RedditPost[], commentMap: Map<string, RedditComment[]>): string {
  const lines: string[] = []

  for (const post of posts) {
    const flair = post.link_flair_text ? ` [${post.link_flair_text}]` : ''
    const snippet = post.selftext.slice(0, 200)
    lines.push(`[${post.score}pts]${flair} ${post.title}`)
    if (snippet) lines.push(`  ${snippet}`)

    const comments = commentMap.get(post.id)
    if (comments?.length) {
      for (const c of comments) {
        lines.push(`  > [${c.score}pts] ${c.body.slice(0, 150)}`)
      }
    }
  }

  return lines.join('\n')
}

async function summarizeWithHaiku(context: string): Promise<string> {
  if (!API_KEY) return ''

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 120,
      messages: [{
        role: 'user',
        content: `Summarize the current Bazaar meta, popular builds, and community sentiment in under 500 chars. Be specific about item/hero names. Raw Reddit data:\n\n${context}`,
      }],
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  })

  if (!res.ok) throw new Error(`Haiku API ${res.status}`)

  const data = await res.json() as {
    content: { type: string; text?: string }[]
  }
  const text = data.content?.find((b) => b.type === 'text')?.text ?? ''
  return text.slice(0, 500)
}

export async function refreshRedditDigest(): Promise<void> {
  try {
    const allPosts = await fetchHotPosts()

    // top 10 by score
    const topPosts = [...allPosts].sort((a, b) => b.score - a.score).slice(0, 10)

    // top 3 most-discussed for comment fetching
    const discussed = [...allPosts].sort((a, b) => b.num_comments - a.num_comments).slice(0, 3)
    const commentMap = new Map<string, RedditComment[]>()
    for (const post of discussed) {
      try {
        commentMap.set(post.id, await fetchTopComments(post.id))
      } catch (e) {
        log(`reddit: failed to fetch comments for ${post.id}: ${e}`)
      }
    }

    // merge: use topPosts but include comment posts if not already present
    const postIds = new Set(topPosts.map((p) => p.id))
    for (const p of discussed) {
      if (!postIds.has(p.id)) topPosts.push(p)
    }

    const context = buildRedditContext(topPosts, commentMap)
    const digest = await summarizeWithHaiku(context)

    if (digest) {
      cachedDigest = digest.replace(/^#+\s*/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1')
      log(`reddit: fetched ${topPosts.length} posts, digest: ${digest.slice(0, 80)}...`)
    } else {
      log('reddit: no digest generated (no API key or empty response)')
    }
  } catch (e) {
    log(`reddit: refresh failed: ${e}`)
    // keep existing digest (or empty) — no crash
  }
}
