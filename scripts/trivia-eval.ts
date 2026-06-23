// trivia verifier regression eval. feeds the LIVE adversarial verifier a corpus of
// known-good and known-bad questions — each bad one is a real failure that reached chat —
// and reports whether the verifier still makes the right call. run after any change to the
// generation/verification prompts so a fixed miss can't silently regress:
//
//   ssh mele "cd ~/projects/bazaarinfo && bun run scripts/trivia-eval.ts"
//
// needs ANTHROPIC_API_KEY + an AI channel (auto-loaded from .env on mele). uses an
// isolated temp DB so the bot's data is untouched. the verifier is a temp-0 model call,
// so a rare case may flip — investigate any FAIL, don't treat one as deterministic truth.
import { initDb } from '../packages/bot/src/db'
import { verifyPanel } from '../packages/bot/src/ai-trivia'

initDb('/tmp/bzi-trivia-eval.db')
const CHANNEL = 'mellen'

interface Case {
  question: string
  answer: string
  accept?: string[]
  expect: 'accept' | 'reject'
  why: string
}

const CASES: Case[] = [
  // --- known BAD: every one of these reached real chat and shouldn't have ---
  { question: 'How many buttons (excluding Start and Select) does a standard Super Nintendo controller have?', answer: '8', expect: 'reject', why: 'answer 8 INCLUDES start/select (6 excludes them); also "how many buttons" is convention-ambiguous' },
  { question: "How many walls surround Paradis Island's human territory — Wall Maria, Wall Rose, and what is the third called?", answer: 'Wall Sina', expect: 'reject', why: 'two-part: "how many" lead-in primes a number but the answer is a name' },
  { question: 'In the game Superhot, what is the central gameplay mechanic involving time?', answer: 'time moves when you move', expect: 'reject', why: 'non-typeable phrase answer — chat cannot type it verbatim' },
  { question: 'How many moons does Jupiter have?', answer: '95', expect: 'reject', why: 'time-varying count — no single agreed number' },
  { question: 'Which planet, first discovered by Galileo in 1612, is the largest in the solar system?', answer: 'Jupiter', expect: 'reject', why: 'false embellishment — Jupiter was not "discovered in 1612" (naked-eye since antiquity)' },
  { question: 'What is the scientific term for an organism that feeds on dead and decaying matter?', answer: 'saprophage', expect: 'reject', why: 'ambiguous definition — scavenger / saprotroph / detritivore all fit' },
  { question: "In Happy Gilmore, Bob Barker famously brawls with Adam Sandler — what is Bob Barker's character's first name?", answer: 'Bob', accept: ['bob', 'bob barker'], expect: 'reject', why: 'GIVEAWAY — the answer "Bob" is sitting in the question ("Bob Barker")' },
  { question: 'The Novaco Anger Scale, a standard measure of anger, is named after which psychologist?', answer: 'Raymond Novaco', accept: ['novaco', 'raymond novaco'], expect: 'reject', why: 'GIVEAWAY eponym trap — "Novaco" is already in the question' },
  { question: 'What color is the sky on a clear day?', answer: 'blue', expect: 'reject', why: 'LOW-EFFORT — a casual answers instantly, teaches nothing, looks like spam' },
  { question: 'Which martial art did The Price Is Right host Bob Barker practice for decades?', answer: 'judo', accept: ['judo'], expect: 'reject', why: 'plausible-but-WRONG — Barker practiced karate (trained by Chuck Norris); the solver lens re-derives and contradicts the claim' },

  // --- known GOOD: well-formed, true, single crisp answer; must pass ---
  { question: 'Minecraft\'s creator, who sold it to Microsoft in 2014, is known by what one-word online handle?', answer: 'Notch', expect: 'accept', why: 'true, single crisp answer' },
  { question: 'What is the only bird that can fly backwards?', answer: 'hummingbird', expect: 'accept', why: 'true superlative, crisp answer' },
  { question: 'In Attack on Titan, what is the name of the innermost of the three walls?', answer: 'Wall Sina', expect: 'accept', why: 'one clear ask, names the set, crisp answer' },
  { question: 'What 2016 first-person shooter advances time only when the player moves?', answer: 'Superhot', expect: 'accept', why: 'the crisp rephrase of the bad Superhot question' },
  { question: 'How many buttons does the original NES controller have, excluding the D-pad, Start, and Select?', answer: '2', expect: 'accept', why: 'unambiguous (d-pad excluded), correct, honors the exclusion' },
  { question: 'Guild Wars was developed by ArenaNet, a studio founded by former employees of which company behind Diablo and StarCraft?', answer: 'Blizzard', expect: 'accept', why: 'true, niche-but-verifiable, crisp answer' },
]

let pass = 0
const fails: string[] = []
for (let i = 0; i < CASES.length; i++) {
  const c = CASES[i]
  const { ok } = await verifyPanel({ question: c.question, answer: c.answer, accept: c.accept ?? [] }, CHANNEL)
  const verdict = ok ? 'accept' : 'reject'
  const good = verdict === c.expect
  if (good) pass++
  else fails.push(`  [${i + 1}] expected ${c.expect}, got ${verdict} :: "${c.question.slice(0, 60)}" (a: ${c.answer})\n        ${c.why}`)
  console.log(`${good ? 'PASS' : 'FAIL'}  want=${c.expect} got=${verdict}  ${c.question.slice(0, 55)}`)
}

console.log(`\n=== ${pass}/${CASES.length} correct ===`)
if (fails.length) {
  console.log('\nFAILURES:')
  console.log(fails.join('\n'))
  process.exit(1)
}
