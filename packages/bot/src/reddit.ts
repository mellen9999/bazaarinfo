import { log } from './log'
import { readJson } from './http'
import { fetchSubreddit, type FeedEntry } from './reddit-feed'

const SUBREDDIT = 'PlayTheBazaar'
const API_KEY = process.env.ANTHROPIC_API_KEY
const MODEL = 'claude-haiku-4-5-20251001'

const FETCH_TIMEOUT = 30_000

let cachedDigest = ''

export function getRedditDigest(): string {
  return cachedDigest
}

// the feed arrives in the subreddit's own hot order, so position is the only ranking
// signal available — RSS carries no score. Numbering it makes that explicit to the model
// instead of letting it invent authority the data does not have.
export function buildRedditContext(entries: FeedEntry[]): string {
  const lines: string[] = []
  for (const [i, e] of entries.entries()) {
    lines.push(`${i + 1}. ${e.title}${e.author ? ` (u/${e.author})` : ''}`)
    const snippet = e.body.slice(0, 400)
    if (snippet) lines.push(`  ${snippet}`)
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
      max_tokens: 250,
      messages: [{
        role: 'user',
        content: `Summarize the r/PlayTheBazaar front page in under 600 chars. Cover ALL of these if present:
- Meta: dominant heroes/builds/items, what's strong/weak
- Community mood: complaints, praise, frustration, hype
- Memes/jokes: recurring bits, copypastas, shitposts worth knowing
- Drama: controversies, dev responses, monetization discourse
Posts are listed in front-page order — earlier means more prominent. There are no vote
counts, so never state or imply one. Be specific with names. Lowercase, terse, no headers.
Raw posts:\n\n${context}`,
      }],
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  })

  if (!res.ok) throw new Error(`Haiku API ${res.status}`)

  const parsed = await readJson<{ content: { type: string; text?: string }[] }>(res)
  if (!parsed.data) return '' // empty/truncated body — skip this digest, don't throw
  const text = parsed.data.content?.find((b) => b.type === 'text')?.text ?? ''
  return text.slice(0, 600)
}

export async function refreshRedditDigest(): Promise<void> {
  try {
    const entries = await fetchSubreddit(SUBREDDIT, 'playthebazaar')
    // transport failed and already logged + alerted — hold the last good digest rather
    // than blanking it, so one bad fetch does not silently strip the bot's context.
    if (entries.length === 0) return

    const digest = await summarizeWithHaiku(buildRedditContext(entries.slice(0, 15)))
    if (digest) {
      cachedDigest = digest.replace(/^#+\s*/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1')
      log(`reddit: ${entries.length} posts -> digest ${cachedDigest.length} chars`)
    } else {
      log('reddit: no digest generated (no API key or empty response)')
    }
  } catch (e) {
    log(`reddit: refresh failed: ${e}`)
  }
}
