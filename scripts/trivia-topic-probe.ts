// end-to-end custom-trivia probe. trivia-eval.ts checks the VERIFIER in isolation; this
// runs the whole generator — stage 1 subjects, best-of-N lenses, the panel, the rescue
// pass — against real topics and reports what chat would actually have received.
//
//   ssh mele "cd ~/projects/bazaarinfo && bun run scripts/trivia-topic-probe.ts [topics...]"
//
// exists because "!trivia Fire Emblem" answered with a US-states question and nothing in
// the test suite could have caught it: every unit was passing, the pipeline was simply
// giving up on the topic and falling through to an unrelated substitute.
//
// needs ANTHROPIC_API_KEY + an AI channel (auto-loaded from .env on mele). isolated temp DB.
//
// `--haiku-gen` routes the GENERATION side (stage-1 subject pick + deep-cut writing) to
// haiku 4.5 while the verify panel stays on sonnet. Compare against a plain baseline run:
//
//   bun run scripts/trivia-topic-probe.ts
//   bun run scripts/trivia-topic-probe.ts --haiku-gen
//
// Adoption bar: same on-topic count and ZERO gave-up. A cheaper writer whose slates get
// binned by the panel triggers the rescue pass and nets out MORE expensive — the exact
// trap the measured haiku-lens rejection in ai-trivia.ts documents.
import { unlinkSync } from 'node:fs'
import { initDb, getAiSpendBySource } from '../packages/bot/src/db'
import { generateCustomTrivia } from '../packages/bot/src/ai-trivia'

// AI_TRIVIA is off in production (see aiTriviaEnabled in ai-cache) — running this
// IS deliberate spend, so it opts itself in. Never set this in the bot's env.
// (read lazily at call time, so setting it after the imports is fine — genModel too.)
process.env.AI_TRIVIA = '1'
const HAIKU_GEN = process.argv.includes('--haiku-gen')
if (HAIKU_GEN) process.env.AI_TRIVIA_GEN_MODEL = 'claude-haiku-4-5-20251001'

// fresh, per-config DB: a leftover bank from a previous run serves topics for 0 calls and
// a shared bank lets one config's spare questions subsidize the other — both corrupt the
// comparison. every probe run is a cold round on purpose.
const DB_PATH = `/tmp/bzi-trivia-probe${HAIKU_GEN ? '-haikugen' : ''}.db`
try { unlinkSync(DB_PATH) } catch {}
initDb(DB_PATH)
const CHANNEL = 'mellen'

// the defaults are the ones that actually failed in chat, plus a spread of shapes: a
// niche franchise, a broad genre, a person, a single word, a non-english title.
const DEFAULT_TOPICS = [
  'Fire Emblem',
  'granblue',
  'Digimon',
  'Elden Ring',
  'Kendrick Lamar',
  'cheese',
  'Neon Genesis Evangelion',
  'formula 1',
]

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const topics = args.length ? args : DEFAULT_TOPICS
console.log(`gen model: ${HAIKU_GEN ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-5'}  (verify panel: claude-sonnet-5)\n`)

// did the question actually land on the topic? a crude token overlap is enough to catch
// the failure this exists for — a US-states question about Fire Emblem shares nothing.
function looksOnTopic(topic: string, q: string, a: string): boolean {
  const words = topic.toLowerCase().split(/\s+/).filter((w) => w.length > 2)
  const hay = `${q} ${a}`.toLowerCase()
  return words.some((w) => hay.includes(w))
}

let onTopic = 0
let missed = 0

for (const topic of topics) {
  const t0 = Date.now()
  let q = null
  try {
    q = await generateCustomTrivia(topic, CHANNEL)
  } catch (e) {
    console.log(`✗ ${topic.padEnd(26)} THREW ${e}`)
    missed++
    continue
  }
  const ms = Date.now() - t0
  if (!q) {
    console.log(`✗ ${topic.padEnd(26)} NO QUESTION (chat gets an unrelated substitute)  ${ms}ms`)
    missed++
    continue
  }
  const on = looksOnTopic(topic, q.question, q.answer)
  if (on) onTopic++
  console.log(`${on ? '✓' : '?'} ${topic.padEnd(26)} ${ms}ms`)
  console.log(`   Q: ${q.question}`)
  console.log(`   A: ${q.answer}${q.accept?.length ? `  [${q.accept.join(', ')}]` : ''}`)
}

console.log(`\n${onTopic}/${topics.length} clearly on-topic, ${missed} gave up entirely`)
if (missed > 0) console.log('a "gave up" is what makes chat see a random question instead of their topic')

// what the run cost, split by pipeline stage (the per-stage tags in ai-trivia.ts), so a
// gen-model swap is judged on quality AND dollars at once. $/Mtok, standard (post-intro)
// pricing; cache read = 0.1x input, 1h-TTL cache write = 2x input.
const PRICE: Record<string, { in: number; out: number }> = {
  sonnet: { in: 3, out: 15 },
  haiku: { in: 1, out: 5 },
}
let totalCalls = 0
let totalUsd = 0
for (const r of getAiSpendBySource()) {
  const genStage = r.source === 'ai-trivia:gen' || r.source === 'ai-trivia:subject'
  const p = genStage && HAIKU_GEN ? PRICE.haiku : PRICE.sonnet
  const usd = (r.input_tokens * p.in + r.cache_read_tokens * p.in * 0.1 + r.cache_write_tokens * p.in * 2 + r.output_tokens * p.out) / 1e6
  totalCalls += r.calls
  totalUsd += usd
  console.log(`spend[${r.source}]: ${r.calls} calls  in=${r.input_tokens} out=${r.output_tokens} cache_read=${r.cache_read_tokens} cache_write=${r.cache_write_tokens}  ~$${usd.toFixed(4)}`)
}
console.log(`total: ${totalCalls} calls (${(totalCalls / topics.length).toFixed(1)}/round)  ~$${totalUsd.toFixed(4)} (~$${(totalUsd / topics.length).toFixed(4)}/round)`)
