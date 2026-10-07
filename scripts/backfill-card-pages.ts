// backfill-card-pages.ts — fill the whole card-page cache (cooldowns + art) in one go.
//
// The bot's data refresh already fills new cards a few at a time, so this is only for a
// cold start or a wipe. it reads titles from cache/items.json, writes
// cache/card-pages.json (or $BAZAARINFO_CARD_PAGES), and resumes where it left off.
//
// Usage: bun scripts/backfill-card-pages.ts [limit]   (limit = stop after N pages)

import { loadPageCache, fillPageCache, pagesPath } from '../packages/data/src/card-pages'

const ITEMS_PATH = 'cache/items.json'
const limit = Number(process.argv[2]) || Infinity

interface Card { Title: string }
const raw = await Bun.file(ITEMS_PATH).json() as { items: Card[], skills: Card[], events?: Card[] }
const titles = [...raw.items, ...raw.skills, ...(raw.events ?? [])].map((c) => c.Title)

const pages = await loadPageCache()
console.log(`${titles.length} cards, ${Object.keys(pages.cards).length} cached, writing ${pagesPath()}`)

let total = 0
while (total < limit) {
  const cap = Math.min(100, limit - total)
  const r = await fillPageCache(titles, pages, { cap, onProgress: console.log })
  total += r.fetched
  if (r.fetched === 0 || r.pending === 0) break
}
console.log(`done: ${total} fetched, cdn ${pages.cdn || 'unknown'}`)
