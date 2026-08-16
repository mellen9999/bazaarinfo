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
import { initDb } from '../packages/bot/src/db'
import { generateCustomTrivia } from '../packages/bot/src/ai-trivia'

initDb('/tmp/bzi-trivia-probe.db')
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

const topics = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TOPICS

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
