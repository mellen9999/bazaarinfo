import { log } from './log'
import { anthropicCall } from './ai-http'
import { fetchSubreddit, type FeedEntry } from './reddit-feed'

const API_KEY = process.env.ANTHROPIC_API_KEY
const MODEL = 'claude-haiku-4-5-20251001'
// digest is global, not per-channel — attribute spend to the same sentinel other
// unattributable background jobs use, so the ledger's totals stay accurate.
const BACKGROUND_SPEND_CHANNEL = '_background'

const FETCH_TIMEOUT = 30_000

// two communities, because the bot lives in two games. r/BobsTavern is where BG memes,
// tier-list arguments and "this hero is broken" discourse happen — the same value
// r/PlayTheBazaar has always carried, for the half of chat that came for hearthstone.
// kept as separate digests, refreshed on separate slots: they share the reddit transport's
// serialized queue, and chaining them would put a 90s gap inside `!b refresh`.
interface Source {
  sub: string
  key: string
  label: string
  game: string
}
const BAZAAR: Source = { sub: 'PlayTheBazaar', key: 'playthebazaar', label: 'r/PlayTheBazaar', game: 'The Bazaar' }
const BGS: Source = { sub: 'BobsTavern', key: 'bobstavern', label: 'r/BobsTavern', game: 'Hearthstone Battlegrounds' }

const digests = new Map<string, string>()

export function getRedditDigest(): string {
  return digests.get(BAZAAR.key) ?? ''
}

/** community buzz from the battlegrounds subreddit — injected on hearthstone-shaped asks. */
export function getBgRedditDigest(): string {
  return digests.get(BGS.key) ?? ''
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

async function summarizeWithHaiku(source: Source, context: string): Promise<string> {
  if (!API_KEY) return ''

  // reddit post bodies are user-authored and routinely carry split emoji — the shared
  // helper's surrogate scrubbing is what keeps one bad post from killing the digest.
  const text = await anthropicCall({
    tag: 'reddit',
    channel: BACKGROUND_SPEND_CHANNEL,
    model: MODEL,
    maxTokens: 250,
    timeoutMs: FETCH_TIMEOUT,
    content: `Summarize the ${source.label} front page (${source.game}) in under 600 chars. Cover ALL of these if present:
- Meta: dominant heroes/builds/items, what's strong/weak
- Community mood: complaints, praise, frustration, hype
- Memes/jokes: recurring bits, copypastas, shitposts worth knowing
- Drama: controversies, dev responses, monetization discourse
Posts are listed in front-page order — earlier means more prominent. There are no vote
counts, so never state or imply one. Be specific with names. Lowercase, terse, no headers.
Raw posts:\n\n${context}`,
  })
  return (text ?? '').slice(0, 600)
}

async function refresh(source: Source): Promise<void> {
  try {
    const entries = await fetchSubreddit(source.sub, source.key)
    // transport failed and already logged + alerted — hold the last good digest rather
    // than blanking it, so one bad fetch does not silently strip the bot's context.
    if (entries.length === 0) return

    const digest = await summarizeWithHaiku(source, buildRedditContext(entries.slice(0, 15)))
    if (digest) {
      digests.set(source.key, digest.replace(/^#+\s*/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1'))
      log(`reddit: ${source.label} ${entries.length} posts -> digest ${digests.get(source.key)!.length} chars`)
    } else {
      log(`reddit: ${source.label} no digest generated (no API key or empty response)`)
    }
  } catch (e) {
    log(`reddit: ${source.label} refresh failed: ${e}`)
  }
}

export function refreshRedditDigest(): Promise<void> {
  return refresh(BAZAAR)
}

export function refreshBgRedditDigest(): Promise<void> {
  return refresh(BGS)
}
