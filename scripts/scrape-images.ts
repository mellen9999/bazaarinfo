// scrape-images.ts — fetch image hashes for all Bazaar cards from bazaardb.gg
//
// How it works:
//   1. Parse bazaardb.gg/sitemap.xml to get card page URLs (/card/{id}/{slug})
//   2. Fetch each card via RSC (React Server Components) endpoint, which returns
//      server-rendered data including the CDN image URL
//   3. Extract the sha1 hash from the CDN pattern: s.bazaardb.gg/v1/z11.0/{hash}@...
//
// NOTE: A cleaner alternative would be to ask teemaw (bazaardb.gg owner) to include
// image hashes in dump.json. This scraper is a working fallback in the meantime.
//
// Usage: bun scripts/scrape-images.ts
// (or: NODE_TLS_REJECT_UNAUTHORIZED=0 bun scripts/scrape-images.ts)
//
// bazaardb.gg uses a ZeroSSL cert that isn't in Bun's trust store on some systems.
// Setting this env var at process start bypasses the TLS verification.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

import { readFileSync, writeFileSync, existsSync } from 'fs'

const CACHE_PATH = 'cache/items.json'
const HASHES_PATH = 'cache/image-hashes.json'
const SITEMAP_URL = 'https://bazaardb.gg/sitemap.xml'
const USER_AGENT = 'BazaarInfo/1.0 (Twitch bot; github.com/mellen9999/bazaarinfo)'
const DELAY_MS = 150
const LOG_EVERY = 50

// RSC response contains CDN URLs like: bazaardb.gg/v1/z11.0/{hash}@256.webp
const HASH_RE = /\/v1\/z11\.0\/([a-f0-9]{20,64})@/

interface CardLike { Title: string }
interface CardCache {
  items: CardLike[]
  skills: CardLike[]
  monsters: CardLike[]
}

async function fetchSitemap(): Promise<Map<string, string>> {
  const res = await fetch(SITEMAP_URL, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`sitemap HTTP ${res.status}`)
  const xml = await res.text()

  // build slug → path map: /card/{id}/{slug}
  const map = new Map<string, string>()
  for (const match of xml.matchAll(/https:\/\/bazaardb\.gg(\/card\/[^<\s]+)/g)) {
    const path = match[1]
    const slug = path.split('/').pop()!
    map.set(slug, path)
  }
  return map
}

// Fetch card page via RSC endpoint — returns server-rendered data including image URLs
async function fetchCardHash(cardPath: string): Promise<string | null> {
  const res = await fetch(`https://bazaardb.gg${cardPath}`, {
    headers: {
      'User-Agent': USER_AGENT,
      'RSC': '1',
    },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) return null
  const text = await res.text()
  return text.match(HASH_RE)?.[1] ?? null
}

async function main() {
  const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf-8')) as CardCache
  const allTitles = [
    ...raw.items.map((c) => c.Title),
    ...raw.skills.map((c) => c.Title),
    ...raw.monsters.map((c) => c.Title),
  ]

  const hashes: Record<string, string> = existsSync(HASHES_PATH)
    ? JSON.parse(readFileSync(HASHES_PATH, 'utf-8'))
    : {}

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
        const hash = await fetchCardHash(cardPath)
        if (hash) {
          hashes[title] = hash
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
  console.log(`done: ${Object.keys(hashes).length} hashes total, ${failed} failures`)
}

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})
