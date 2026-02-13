import { scrapeItems } from './scraper'
import type { CardCache } from '@bazaarinfo/shared'
import { resolve } from 'path'

const CACHE_DIR = resolve(import.meta.dir, '../../../cache')

async function main() {
  console.log('scraping items from bazaardb.gg...')

  const { cards, total } = await scrapeItems((done, pages) => {
    process.stdout.write(`\r  pages: ${done}/${pages}`)
  })

  console.log(`\nfetched ${cards.length} items (expected ~${total})`)

  const cache: CardCache = {
    items: cards,
    skills: [],
    monsters: [],
    fetchedAt: new Date().toISOString(),
  }

  const outPath = resolve(CACHE_DIR, 'items.json')
  await Bun.write(outPath, JSON.stringify(cache, null, 2))
  console.log(`wrote ${outPath}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
