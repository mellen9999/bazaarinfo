// Battlegrounds trivia, generated from the real card set.
//
// WHY THIS EXISTS: a bare "!trivia" during a Hearthstone stream served "How much health
// does Surly Mechanic have?" — a Bazaar monster — to a Battlegrounds audience. Twenty-four
// people answered with numbers between 3 and 11, because that is what minion health looks
// like in the game they were watching. The real answer was 1925. Nobody was close, and
// nobody could have been: the bot was quizzing them on a different game than the one on
// screen.
//
// These are deterministic, like the Bazaar generators and unlike the AI topic path: every
// question is read straight off the card cache, so there is nothing to fact-check and
// nothing to hallucinate. Only CURRENT-POOL cards are used, so an answer can never be a
// card the game no longer offers.
//
// Same quality bar as everything else here: one crisp typeable answer, the answer never
// visible in the question, and no coin flips.

import { hsPoolMinions, hsHeroes, type HsCard } from './hs-cards'

export interface HsTriviaQ {
  question: string
  answer: string
  accepted: string[]
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

// a question must never contain its own answer. card text routinely names the card
// ("Deflect-o-Bot" text mentions Mechs, "Sellemental" says "sell this"), so any candidate
// whose text leaks a distinctive word of its own name is dropped rather than patched.
function leaksName(name: string, text: string): boolean {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((w) => w.length > 3 && new RegExp(`\\b${w}\\b`, 'i').test(text))
}

const MAX_TEXT = 160

/** "Which Battlegrounds minion reads …" — the strongest of these: real knowledge, one answer. */
export function genHsTextQuestion(): HsTriviaQ | null {
  const pool = hsPoolMinions().filter(
    (c) => c.x && c.x.length >= 20 && c.x.length <= MAX_TEXT && !leaksName(c.n, c.x),
  )
  if (pool.length === 0) return null
  const c = pickRandom(pool)
  // a text shared by more than one card has more than one right answer — drop it rather
  // than tell a correct chatter they are wrong
  if (pool.filter((o) => o.x === c.x).length > 1) return null
  return {
    question: `Which Battlegrounds minion reads: "${c.x}"?`,
    answer: c.n,
    accepted: [c.n],
  }
}

/** tavern tier — the single most-asked thing about any BG minion. */
export function genHsTierQuestion(): HsTriviaQ | null {
  const pool = hsPoolMinions().filter((c) => c.t && c.t >= 1 && c.t <= 7)
  if (pool.length === 0) return null
  const c = pickRandom(pool)
  return {
    question: `What tavern tier is ${c.n} in Battlegrounds?`,
    answer: String(c.t),
    accepted: [String(c.t), `tier ${c.t}`, `t${c.t}`],
  }
}

/** tribe. skipped for multi-tribe and All-tribe cards — those have several right answers. */
export function genHsTribeQuestion(): HsTriviaQ | null {
  const pool = hsPoolMinions().filter(
    (c) => c.r && !c.r.includes('/') && c.r !== 'All tribes' && !leaksName(c.n, c.r),
  )
  if (pool.length === 0) return null
  const c = pickRandom(pool)
  return {
    question: `Which minion type is ${c.n} in Battlegrounds?`,
    answer: c.r!,
    accepted: [c.r!, `${c.r}s`],
  }
}

/** base stats. typeable as "3/2", and knowing it is real BG knowledge. */
export function genHsStatsQuestion(): HsTriviaQ | null {
  const pool = hsPoolMinions().filter((c) => typeof c.a === 'number' && typeof c.h === 'number' && c.t)
  if (pool.length === 0) return null
  const c = pickRandom(pool)
  return {
    question: `What are ${c.n}'s base stats in Battlegrounds? (attack/health)`,
    answer: `${c.a}/${c.h}`,
    accepted: [`${c.a}/${c.h}`, `${c.a} / ${c.h}`, `${c.a}-${c.h}`],
  }
}

/** hero power → hero. the power name is unique, so exactly one hero answers it. */
export function genHsHeroPowerQuestion(): HsTriviaQ | null {
  const heroes = hsHeroes().filter((h) => h.x && h.x.includes(':'))
  if (heroes.length === 0) return null
  const h = pickRandom(heroes)
  // stored as "Name (N gold): text" — the name alone is the prompt
  const power = h.x!.split('(')[0].split(':')[0].trim()
  if (!power || leaksName(h.n, power)) return null
  // a power name shared by two heroes has two right answers
  if (heroes.filter((o) => o.x!.split('(')[0].split(':')[0].trim() === power).length > 1) return null
  return {
    question: `Which Battlegrounds hero has the hero power "${power}"?`,
    answer: h.n,
    accepted: [h.n],
  }
}

/** what a hero's power actually does → the hero. */
export function genHsHeroTextQuestion(): HsTriviaQ | null {
  const heroes = hsHeroes().filter((h) => h.x && h.x.includes(': '))
  if (heroes.length === 0) return null
  const h = pickRandom(heroes)
  const text = h.x!.slice(h.x!.indexOf(': ') + 2).trim()
  if (text.length < 20 || text.length > MAX_TEXT) return null
  if (leaksName(h.n, text)) return null
  return {
    question: `Which Battlegrounds hero's power does this: "${text}"?`,
    answer: h.n,
    accepted: [h.n],
  }
}

/**
 * The universal free-win guard: a question that contains its own answer is not a question.
 *
 * Applied to every generator rather than inside each, because the per-generator checks
 * kept missing cases from the other direction — "Which minion type is Mechagnome
 * Interpreter?" answers "Mech", and C'Thun's hero power is literally "Saturday C'Thuns!".
 * One check over the finished pair catches those and anything the card set invents next.
 */
function guard(gen: () => HsTriviaQ | null): () => HsTriviaQ | null {
  return () => {
    const q = gen()
    if (!q) return null
    const hay = q.question.toLowerCase()
    if (hay.includes(q.answer.toLowerCase())) return null
    // an accepted alias giving it away is the same free win by another name
    if (q.accepted.some((a) => a.length > 3 && hay.includes(a.toLowerCase()))) return null
    return q
  }
}

/** every generator, in the order trivia.ts registers them. */
export const HS_GENERATORS = [
  genHsTextQuestion,
  genHsTierQuestion,
  genHsTribeQuestion,
  genHsStatsQuestion,
  genHsHeroPowerQuestion,
  genHsHeroTextQuestion,
].map((g) => Object.defineProperty(guard(g), 'name', { value: g.name }))

/** true when there is enough card data loaded to ask anything at all. */
export function hsTriviaReady(): boolean {
  return hsPoolMinions().length > 0
}

/** exposed so tests can assert the shared quality bar without duplicating it */
export function __leaksNameForTest(name: string, text: string): boolean {
  return leaksName(name, text)
}
export type { HsCard }
