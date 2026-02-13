import { scrapeItems, scrapeSkills } from './scraper'
import type { CardCache } from '@bazaarinfo/shared'
import { resolve } from 'path'

const CACHE_DIR = resolve(import.meta.dir, '../../../cache')

async function main() {
  console.log('scraping items from bazaardb.gg...')

  const { cards: items, total: itemTotal } = await scrapeItems((done, pages) => {
    process.stdout.write(`\r  items: ${done}/${pages}`)
  })
  console.log(`\nfetched ${items.length} items (expected ~${itemTotal})`)

  console.log('scraping skills from bazaardb.gg...')
  const { cards: skills, total: skillTotal } = await scrapeSkills((done, pages) => {
    process.stdout.write(`\r  skills: ${done}/${pages}`)
  })
  console.log(`\nfetched ${skills.length} skills`)

  const cache: CardCache = {
    items,
    skills,
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
