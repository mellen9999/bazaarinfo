// Guildrun trivia, generated from the real card set — the exact reason hs-trivia.ts
// exists, for kripp's third game: a bare "!trivia" during a Guildrun stream was quizzing
// the room on a different game than the one on screen.
//
// Deterministic like the Bazaar and BG generators: every question reads straight off the
// guildrun cache (or the curated keyword glossary), so there is nothing to fact-check and
// nothing to hallucinate. Same quality bar: one crisp typeable answer, the answer never
// visible in the question, no coin flips, and any candidate with more than one right
// answer is dropped rather than told a correct chatter they are wrong.

import { grHeroCards, grRelicCards, grKeywordCards, type GrCard } from './guildrun'

export interface GrTriviaQ {
  question: string
  answer: string
  accepted: string[]
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

// a question must never contain its own answer (relic text routinely names its class,
// keyword defs name their own mechanic — "Rush (N) effects…")
function leaksName(name: string, text: string): boolean {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((w) => w.length > 3 && new RegExp(`\\b${w}\\b`, 'i').test(text))
}

const MAX_TEXT = 180

/** hero → class. dual-class heroes are skipped: two right answers is zero fair ones. */
export function genGrClassQuestion(): GrTriviaQ | null {
  const pool = grHeroCards().filter((h) => h.c && !h.c.includes('/') && !leaksName(h.c, h.n))
  if (pool.length === 0) return null
  const h = pickRandom(pool)
  return {
    question: `Which class is ${h.n} in Guildrun?`,
    answer: h.c!,
    accepted: [h.c!, `${h.c}s`],
  }
}

/** hero → guild. the flavor fact chat actually retains. */
export function genGrGuildQuestion(): GrTriviaQ | null {
  const pool = grHeroCards().filter((h) => h.g && !leaksName(h.g, h.n) && !leaksName(h.n, h.g))
  if (pool.length === 0) return null
  const h = pickRandom(pool)
  return {
    question: `Which guild does ${h.n} belong to in Guildrun?`,
    answer: h.g!,
    accepted: [h.g!],
  }
}

/** hero base HP — parsed from the stat line the dump wrote ("650 HP, …"). */
export function genGrHeroHpQuestion(): GrTriviaQ | null {
  const pool = grHeroCards()
    .map((h) => ({ h, hp: /^(\d+) HP\b/.exec(h.st ?? '')?.[1] }))
    .filter((p): p is { h: GrCard; hp: string } => !!p.hp)
  if (pool.length === 0) return null
  const { h, hp } = pickRandom(pool)
  // two heroes sharing a base HP would both be right answers to the reverse question,
  // but this direction (hero → number) always has exactly one
  return {
    question: `How much base HP does ${h.n} have in Guildrun?`,
    answer: hp,
    accepted: [hp, `${hp} hp`, `${hp}hp`],
  }
}

/** relic text → relic. real numbers from the resolved db; the strongest question here. */
export function genGrRelicTextQuestion(): GrTriviaQ | null {
  const pool = grRelicCards().filter(
    (r) => r.x && r.x.length >= 25 && r.x.length <= MAX_TEXT && !r.x.includes('X') && !leaksName(r.n, r.x),
  )
  if (pool.length === 0) return null
  const r = pickRandom(pool)
  if (pool.filter((o) => o.x === r.x).length > 1) return null
  return {
    question: `Which Guildrun relic does this: "${r.x}"?`,
    answer: r.n,
    accepted: [r.n],
  }
}

/** mechanic definition → keyword name, from the curated glossary. */
export function genGrKeywordQuestion(): GrTriviaQ | null {
  const pool = grKeywordCards().filter(
    (k) => k.x && k.x.length <= MAX_TEXT && !leaksName(k.n, k.x)
      && !(k.a ?? []).some((al) => leaksName(al, k.x!))
      && !/NOT active|INERT/.test(k.x), // "which mechanic doesn't exist" is a trick, not trivia
  )
  if (pool.length === 0) return null
  const k = pickRandom(pool)
  return {
    question: `Which Guildrun mechanic is this: "${k.x}"?`,
    answer: k.n,
    accepted: [k.n, ...(k.a ?? [])],
  }
}

/** spec name → hero. unique spec names only — a shared name has several right answers. */
export function genGrSpecQuestion(): GrTriviaQ | null {
  const heroes = grHeroCards().filter((h) => h.sp?.length)
  if (heroes.length === 0) return null
  const counts = new Map<string, number>()
  for (const h of heroes) for (const s of h.sp!) {
    const name = s.split(':')[0].trim().toLowerCase()
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const h = pickRandom(heroes)
  const spec = pickRandom(h.sp!).split(':')[0].trim()
  if ((counts.get(spec.toLowerCase()) ?? 0) > 1 || leaksName(h.n, spec)) return null
  return {
    question: `Which Guildrun hero has the specialization "${spec}"?`,
    answer: h.n,
    accepted: [h.n],
  }
}

/**
 * The universal free-win guard, same as hs-trivia's: one check over the finished pair
 * catches every leak direction the per-generator filters miss.
 */
function guard(gen: () => GrTriviaQ | null): () => GrTriviaQ | null {
  return () => {
    const q = gen()
    if (!q) return null
    const hay = q.question.toLowerCase()
    if (hay.includes(q.answer.toLowerCase())) return null
    if (q.accepted.some((a) => a.length > 3 && hay.includes(a.toLowerCase()))) return null
    return q
  }
}

/** every generator, in the order trivia.ts registers them. */
export const GR_GENERATORS = [
  genGrClassQuestion,
  genGrGuildQuestion,
  genGrHeroHpQuestion,
  genGrRelicTextQuestion,
  genGrKeywordQuestion,
  genGrSpecQuestion,
].map((g) => Object.defineProperty(guard(g), 'name', { value: g.name }))

/** true when there is enough data loaded to ask anything at all. keywords are always
 *  loaded (they're code), so the bar is the fetched card set — a keyword-only round
 *  rotation would repeat itself into the ground. */
export function grTriviaReady(): boolean {
  return grHeroCards().length > 0
}
