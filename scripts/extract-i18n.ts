// bun scripts/extract-i18n.ts — rebuild cache/i18n/<lang>.json from the game's translation cache
// (BAZAAR_TRANSLATIONS_DIR overrides where the game keeps it). the bot's daily refresh runs the same code.
import { extractI18n, formatReport } from '../packages/data/src/i18n'
import { resolve } from 'path'
import type { CardCache } from '@bazaarinfo/shared'

const cache = await Bun.file(resolve(import.meta.dir, '../cache/items.json')).json() as CardCache
const reports = extractI18n({ cache, log: console.log })
for (const r of reports) console.log(formatReport(r))
if (!reports.length) process.exit(1)
