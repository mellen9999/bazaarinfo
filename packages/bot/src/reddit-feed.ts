// Shared reddit transport.
//
// reddit.com's JSON endpoints (/hot.json, /comments/*.json) return HTTP 403 from this
// host — same datacenter-IP block that killed EventSub. It failed silently for at least
// a week: the community-buzz digest was empty on every single request and nothing said so.
//
// The .rss (Atom) feed is served to the same IP and needs no credentials, no app
// registration, and no token refresh — which is why it is the transport rather than
// OAuth. It is rate limited hard, so every caller shares ONE serialized queue with a
// minimum gap and 429-aware backoff. Refreshes here are daily / 4-hourly, so waiting a
// couple of minutes for a slot costs nothing.
//
// What RSS gives up vs the JSON API: post score and comment counts, and comment bodies.
// Feed order still reflects the listing order asked for, so position stands in for rank.
import { log } from './log'
import { notify } from './notify'

const UA = 'BazaarInfo/1.0 (+github.com/mellen9999/bazaarinfo)'
const FETCH_TIMEOUT = 20_000

// measured against the live feed: back-to-back requests 429, and even a 20s gap does.
// 90s clears it with margin. This is a floor between requests, not a poll interval.
const MIN_GAP_MS = 90_000
const MAX_429_RETRIES = 3
const RETRY_BACKOFF_MS = [60_000, 120_000, 240_000]

// a source that has not produced data in this long is broken, not quiet — say so out loud
// rather than repeating the week of silence that made this rewrite necessary.
const STALE_ALERT_MS = 26 * 60 * 60_000

export interface FeedEntry {
  title: string
  author: string
  body: string
  updated: string
}

let queue: Promise<unknown> = Promise.resolve()
let lastFetchAt = 0
const lastSuccessAt = new Map<string, number>()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'",
  }
  // repeat: reddit double-encodes the HTML it embeds in <content>
  let out = s
  for (let i = 0; i < 2; i++) {
    out = out.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, ent: string) => {
      if (named[ent]) return named[ent]
      if (ent.startsWith('#x') || ent.startsWith('#X')) {
        const code = parseInt(ent.slice(2), 16)
        return Number.isFinite(code) ? String.fromCodePoint(code) : m
      }
      if (ent.startsWith('#')) {
        const code = parseInt(ent.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : m
      }
      return m
    })
  }
  return out
}

function stripHtml(s: string): string {
  return decodeEntities(s)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'))
  return m ? m[1] : ''
}

/** parse an Atom feed into entries. Tolerant by design — a feed shape change should
 *  degrade to fewer entries, never throw and take the whole refresh down with it. */
export function parseAtom(xml: string): FeedEntry[] {
  const entries: FeedEntry[] = []
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)) {
    const block = m[1]
    const title = stripHtml(tag(block, 'title'))
    if (!title) continue
    entries.push({
      title,
      author: stripHtml(tag(block, 'name')).replace(/^\/u\//, ''),
      body: stripHtml(tag(block, 'content')),
      updated: tag(block, 'updated').trim(),
    })
  }
  return entries
}

async function fetchOnce(url: string): Promise<string> {
  const wait = MIN_GAP_MS - (Date.now() - lastFetchAt)
  if (wait > 0) await sleep(wait)
  lastFetchAt = Date.now()
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT) })
  if (res.status === 429) throw new Error('429')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.text()
}

/**
 * Fetch and parse a subreddit's Atom feed. Serialized against every other caller.
 * `key` names the source for staleness tracking (e.g. 'playthebazaar').
 * Returns [] on failure — callers keep whatever digest they already had.
 */
export function fetchSubreddit(sub: string, key: string): Promise<FeedEntry[]> {
  const run = async (): Promise<FeedEntry[]> => {
    const url = `https://www.reddit.com/r/${sub}/.rss`
    for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
      try {
        const entries = parseAtom(await fetchOnce(url))
        if (entries.length === 0) throw new Error('feed parsed to zero entries')
        lastSuccessAt.set(key, Date.now())
        log(`reddit-feed: r/${sub} -> ${entries.length} entries`)
        return entries
      } catch (e) {
        const is429 = e instanceof Error && e.message === '429'
        if (is429 && attempt < MAX_429_RETRIES) {
          await sleep(RETRY_BACKOFF_MS[attempt])
          continue
        }
        log(`reddit-feed: r/${sub} failed: ${e}`)
        await alertIfStale(sub, key)
        return []
      }
    }
    return []
  }
  // chain onto the shared queue so two sources never race the rate limiter
  const next = queue.then(run, run)
  queue = next.catch(() => {})
  return next
}

async function alertIfStale(sub: string, key: string): Promise<void> {
  const last = lastSuccessAt.get(key)
  // never succeeded in this process: only alarm once the process has been up long enough
  // that a scheduled refresh should have landed, so a restart is not itself an alert.
  const age = last ? Date.now() - last : Number.POSITIVE_INFINITY
  if (age < STALE_ALERT_MS) return
  const howLong = last ? `${Math.round(age / 3_600_000)}h` : 'never since boot'
  await notify(
    `reddit-stale-${key}`,
    'bazaarinfo: reddit feed stale',
    `r/${sub} has not returned data (${howLong}). community buzz is running empty.`,
  ).catch(() => {})
}

/** exposed for the health check + tests */
export function lastRedditSuccess(key: string): number | undefined {
  return lastSuccessAt.get(key)
}
