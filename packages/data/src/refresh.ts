import { scrapeItems, scrapeSkills, scrapeMonsters } from './scraper'
import type { CardCache } from '@bazaarinfo/shared'
import { resolve } from 'path'

const CACHE_DIR = resolve(import.meta.dir, '../../../cache')

async function main() {
  console.log('scraping from bazaardb.gg...')

  const [itemsResult, skillsResult, monstersResult] = await Promise.all([
    scrapeItems((done, pages) => {
      process.stdout.write(`\r  items: ${done}/${pages}`)
    }),
    scrapeSkills((done, pages) => {
      process.stdout.write(`\r  skills: ${done}/${pages}`)
    }),
    scrapeMonsters(),
  ])

  console.log(`\nfetched ${itemsResult.cards.length} items, ${skillsResult.cards.length} skills, ${monstersResult.monsters.length} monsters`)

  const cache: CardCache = {
    items: itemsResult.cards,
    skills: skillsResult.cards,
    monsters: monstersResult.monsters,
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
