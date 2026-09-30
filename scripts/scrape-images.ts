// scrape-images.ts — fetch image hashes for all Bazaar cards from bazaardb.gg
//
// How it works:
//   1. Parse bazaardb.gg/sitemap.xml to get card page URLs (/card/{id}/{slug})
//   2. Fetch each card via RSC (React Server Components) endpoint, which returns
//      server-rendered data including the CDN image URL
//   3. Extract the sha1 hash from the CDN pattern: s.bazaardb.gg/v1/z{ver}/{hash}@...
//
// The version segment is NOT matched literally. It tracks the game version and has
// already moved once (z11.0 -> z17.0); a pinned pattern silently matches nothing,
// which is how every card ended up with no art and nobody noticed.
//
// Output is packages/data/art-keys.json — the map the data scraper actually reads,
// committed so a deploy carries it — plus packages/data/art-cdn.json, the newest
// z-segment seen, which the EBS image proxy serves from. A new patch's cards exist
// only under the new segment (18.0 cards 404 under z17.0), while the new segment
// still serves every older hash, so the proxy must follow the newest one.
//
// If bazaardb ever re-keys its CDN, the stored
// hashes all go stale at once: delete that file and re-run, since resume treats any
// existing entry as done.
//
// Run it here, commit the result, deploy. Do NOT wire it into the bot's refresh
// pipeline: that would have the bot write a git-tracked file on mele, and the deploy
// there is a bare `git pull` over pre-existing local work — a dirty tracked file is
// exactly what turns the next pull into a conflict. The content diff already alerts
// with "N items missing art" on patch day; that alert is the trigger.
//
// NOTE: A cleaner alternative would be to ask teemaw (bazaardb.gg owner) to include
// image hashes in dump.json. This scraper is a working fallback in the meantime.
//
// Usage: bun scripts/scrape-images.ts
//
// This used to force NODE_TLS_REJECT_UNAUTHORIZED=0 for a bazaardb cert Bun didn't
// trust. That cert verifies cleanly now, and turning verification off process-wide
// to scrape a third party is a MITM waiting to happen — if it ever fails again, add
// the CA to the trust store rather than bringing this back.

import { readFileSync, writeFileSync, existsSync } from 'fs'

const CACHE_PATH = 'cache/items.json'
const HASHES_PATH = 'packages/data/art-keys.json'
const CDN_PATH = 'packages/data/art-cdn.json'
const SITEMAP_URL = 'https://bazaardb.gg/sitemap.xml'
const USER_AGENT = 'BazaarInfo/1.0 (Twitch bot; github.com/mellen9999/bazaarinfo)'
const DELAY_MS = 150
const LOG_EVERY = 50

// RSC response contains CDN URLs like: s.bazaardb.gg/v1/z18.0/{hash}@256.webp.
// The z-segment is the game version and moves with patches — match any of them.
const HASH_RE = /\/v1\/(z[\d.]+)\/([a-f0-9]{20,64})@/

interface CardLike { Title: string }
interface CardCache {
  items: CardLike[]
  skills: CardLike[]
  monsters: CardLike[]
  events?: CardLike[]
}

async function fetchSitemap(): Promise<Map<string, string>> {
  const res = await fetch(SITEMAP_URL, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`sitemap HTTP ${res.status}`)
  const xml = await res.text()

  // build slug → path map: /card/{id}/{slug}
  //
  // Sitemap slugs are percent-encoded, so "Mortar & Pestle" appears as
  // "Mortar-%26-Pestle". Keyed raw, every title carrying punctuation misses — that
  // was 5 real cards (&, :, ,) silently left with no art. Key both forms: the
  // decoded one matches how titles are spelled, the raw one costs nothing and keeps
  // working if a slug is ever stored unencoded.
  const map = new Map<string, string>()
  for (const match of xml.matchAll(/https:\/\/bazaardb\.gg(\/card\/[^<\s]+)/g)) {
    const path = match[1]
    const slug = path.split('/').pop()!
    map.set(slug, path)
    try {
      const decoded = decodeURIComponent(slug)
      if (decoded !== slug) map.set(decoded, path)
    } catch { /* malformed escape — the raw key above still stands */ }
  }
  return map
}

// Fetch card page via RSC endpoint — returns server-rendered data including image URLs
async function fetchCardHash(cardPath: string): Promise<{ hash: string, cdn: string } | null> {
  const res = await fetch(`https://bazaardb.gg${cardPath}`, {
    headers: {
      'User-Agent': USER_AGENT,
      'RSC': '1',
    },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) return null
  const text = await res.text()
  const m = text.match(HASH_RE)
  return m ? { cdn: m[1], hash: m[2] } : null
}

// "z18.0" → [18, 0]; compares segment by segment so z18.0 beats z9.9
function cdnNewer(a: string, b: string): boolean {
  const pa = a.slice(1).split('.').map(Number)
  const pb = b.slice(1).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d > 0
  }
  return false
}

async function main() {
  const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf-8')) as CardCache
  const allTitles = [
    ...raw.items.map((c) => c.Title),
    ...raw.skills.map((c) => c.Title),
    ...raw.monsters.map((c) => c.Title),
    ...(raw.events ?? []).map((c) => c.Title),
  ]

  const hashes: Record<string, string> = existsSync(HASHES_PATH)
    ? JSON.parse(readFileSync(HASHES_PATH, 'utf-8'))
    : {}

  let cdn: string = existsSync(CDN_PATH)
    ? JSON.parse(readFileSync(CDN_PATH, 'utf-8')).version
    : 'z0'

  const alreadyDone = Object.keys(hashes).length
  console.log(`cards: ${allTitles.length} total, ${alreadyDone} already hashed`)

  console.log('fetching sitemap...')
  const slugMap = await fetchSitemap()
  console.log(`sitemap: ${slugMap.size} card URLs`)

  const todo = allTitles.filter((t) => !hashes[t])
  console.log(`processing ${todo.length} cards...`)

  let done = 0
  let found = 0
  let failed = 0

  for (const title of todo) {
    // title "Magnifying Glass" → slug "Magnifying-Glass"
    const slug = title.replace(/ /g, '-')
    const cardPath = slugMap.get(slug)

    if (!cardPath) {
      console.log(`[skip] no sitemap entry: "${title}" (slug: ${slug})`)
      failed++
    } else {
      try {
        const hit = await fetchCardHash(cardPath)
        if (hit) {
          hashes[title] = hit.hash
          if (cdnNewer(hit.cdn, cdn)) cdn = hit.cdn
          found++
        } else {
          console.log(`[miss] no hash in RSC: ${title}`)
          failed++
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.log(`[err] ${title}: ${msg}`)
        failed++
      }
    }

    done++

    if (done % LOG_EVERY === 0) {
      console.log(`progress: ${done}/${todo.length} (+${found} found, ${failed} failed)`)
      writeFileSync(HASHES_PATH, JSON.stringify(hashes, null, 2))
    }

    await new Promise((r) => setTimeout(r, DELAY_MS))
  }

  writeFileSync(HASHES_PATH, JSON.stringify(hashes, null, 2))
  // never write the 'z0' placeholder — that would point the proxy at nothing
  if (cdn !== 'z0') writeFileSync(CDN_PATH, JSON.stringify({ version: cdn }, null, 2) + '\n')
  console.log(`done: ${Object.keys(hashes).length} hashes total, ${failed} failures, cdn ${cdn}`)
}

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})
