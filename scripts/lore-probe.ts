// Channel-lore probe. Two modes, both against a real logged-chat db:
//
//   bun scripts/lore-probe.ts "The tidolar crime family"   -> dossier + a live generated round
//   bun scripts/lore-probe.ts --gate topics.txt            -> gate only, one topic per line, no API
//
// The gate mode is the one that matters for regressions: run it over a sample of real
// !trivia topics and every world topic must come back "world". A false positive there
// hijacks someone's question into a chat-recall quiz.
//
// env: PROBE_DB (defaults to ~/.bazaarinfo.db), PROBE_CHANNEL (nl_kripp),
//      and for a live round: AI_TRIVIA=1 AI_CHANNELS=<channel> ANTHROPIC_API_KEY=...
import { readFileSync } from 'fs'
import * as db from '../packages/bot/src/db'
import { buildLoreDossier } from '../packages/bot/src/lore'
import { generateLoreTrivia } from '../packages/bot/src/ai-trivia'

const channel = process.env.PROBE_CHANNEL ?? 'nl_kripp'
db.initDb(process.env.PROBE_DB)

if (process.argv[2] === '--gate') {
  for (const raw of readFileSync(process.argv[3], 'utf8').split('\n')) {
    const t = raw.replace(/^(?:about|on|for)\s+/i, '').trim()
    if (!t) continue
    const d = buildLoreDossier(t, channel)
    console.log(`${d ? `LORE(${d.anchor})`.padEnd(14) : 'world'.padEnd(14)}${t}`)
  }
  process.exit(0)
}

const topic = process.argv[2] ?? 'The tidolar crime family'
const lore = buildLoreDossier(topic, channel)
if (!lore) {
  console.log(`NOT LORE: "${topic}" — falls through to the world path`)
  process.exit(0)
}
console.log(`--- DOSSIER (anchor: ${lore.anchor}) ---\n${lore.text}\n`)
const q = await generateLoreTrivia(lore.text, topic, channel)
console.log('--- ROUND ---')
console.log(q ? `Q: ${q.question}\nA: ${q.answer}\naccept: ${q.accept.join(', ')}` : 'null (no candidate survived — caller serves a labeled bazaar round)')
process.exit(0)
