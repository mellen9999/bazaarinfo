import { log } from './log'
import { readJson, extractFirstJson } from './http'
import { AI_CHANNELS, isOverDailyCap } from './ai-cache'
import { recordAiSpend } from './db'

// drop lone surrogate halves that would make JSON.stringify emit invalid UTF-8 and
// the API reject the body. self-contained so this stays decoupled from ai.ts.
function stripUnpairedSurrogates(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
}

function safeStringify(body: unknown): string {
  return JSON.stringify(body, (_k, v) => (typeof v === 'string' ? stripUnpairedSurrogates(v) : v))
}

// Custom-topic trivia generation. Isolated from the chat path (ai.ts): no system
// prompt, no chat context, no sanitize/COT guards — just a single constrained call
// that turns a user-supplied topic into one hard, objectively-answerable question
// with a short, typeable answer. Returns null on any failure or refusal so the
// caller always has a clean miss path.

const API_KEY = process.env.ANTHROPIC_API_KEY
const MODEL = 'claude-sonnet-5'
const TIMEOUT = 12_000 // headroom for the verify panel: ~12 calls fire at once per round
const MAX_TOPIC_LEN = 80

export interface CustomTrivia {
  question: string
  answer: string
  accept: string[]
}

// The shared quality bar + answer/output contract. Lives in ONE place so the stage-2
// deep-cut writer and the round-2 broaden fallback enforce identical rules.
const BAR = `The bar — every question must be ALL of these:
- SURPRISING: a satisfying "oh neat, I didn't know that" fact, never a surface fact everyone already knows, never a dry technicality. Chat should learn something.
- FAIR + GUESSABLE: challenging but landable. A knowledgeable fan or a sharp guesser can get it; a casual won't. Interesting beats obscure — never so niche that nobody in chat could possibly know or reason it out, and never a coin-flip nobody could deduce.
- SELF-CONTAINED: the question carries everything needed to find the answer. NEVER reference an unnamed "this game / this bird / a certain X" that chat has no way to identify.
- NEVER GIVES IT AWAY: the answer — and EVERY accepted form of it — must NOT appear anywhere in the question, and the wording must not telegraph it. A viewer must not be able to win by copying a word straight out of the question. No gimmes a casual answers with zero thought. AVOID eponym traps: do NOT name "the X Scale / X's Law / the X Effect" and then ask who it is named after when the answer is X — the name is already given. Find an angle where the answer is genuinely withheld.
- TRUE + SINGLE-ANSWER: exactly ONE correct, well-established answer, no competing valid responses. Use a fact you genuinely know — never fabricate.
- ONE CLEAR ASK: the question requests exactly ONE thing, and its wording makes the answer TYPE obvious. NEVER bundle two questions ("how many X, and what is the third called?"). NEVER use a misdirecting lead-in — if the answer is a name or word, do NOT open with "how many" or any count framing that primes chat to type a number; if the answer is a number, don't phrase it like a name lookup. A reader should know from the wording whether to type a name, a number, or a word.
- TYPEABLE ANSWER: the answer must be a crisp token a viewer can type verbatim and win — a proper noun, name, place, title, a single common word, or a number. NEVER a descriptive phrase, a verb phrase, or a sentence fragment that chat would have to word exactly right. BAD answers: "time moves when you move", "royal blood contact", "label the buttons", "rotate the eggs" — nobody types those exactly, so the round dies. If the cleanest fact would need a phrase answer, REPHRASE THE QUESTION so the answer collapses to one crisp noun. e.g. instead of asking Superhot's mechanic (answer "time moves when you move"), ask "What 2016 FPS advances time only when you move?" (answer "Superhot"). Pick the framing where the answer is a single nameable thing.
- CLEAN of embellishment: ONE core verifiable fact only. Do NOT pad with extra specific claims (an award, an exact year, "the first to do X") unless you are CERTAIN each is true. Fabricated embellishments are the #1 failure — a clean simple true fact beats an impressive-sounding false one.
- AVOID internet/meme/emote PROVENANCE unless rock-certain: "how emote X became official/global", "the first emote/meme to Y", "originated on streamer Z's <year> stream", "named after". These origin stories are where confident fabrication happens most — real fragments (a real emote, a real streamer, a real era) get stitched into a false history. If you are not 100% sure of the exact origin AND year AND status, pick a different fact.
- NOT a fuzzy definition: avoid "what is the term/word for ..." questions where several legitimate terms fit (dead-matter eater -> scavenger / saprophage / saprotroph all defensible). Prefer a crisp single answer: a specific name, title, place, date, year, number, or record holder.
- NOT an ambiguous count: avoid "how many X" when the count depends on convention or changes over time (buttons on a controller — is the d-pad 0/1/4?; moons of a planet; episodes of an ongoing show). Only ask a count when there is ONE agreed number, and if you state an exclusion ("excluding Start and Select"), double-check your own answer actually respects it.

Answer format:
- The answer MUST be short and typeable in a chat box: 1-4 words, or a number. Never a sentence.
- "answer" is the SINGLE canonical form ONLY — e.g. "Ti", never "Ti (or Si)". Put every alternate/spelling in "accept".
- Provide 2-6 accepted variants: lowercase forms, with/without leading articles, common alternate spellings/abbreviations, AND any other name that is genuinely the SAME answer. Always include the canonical answer. (If a "variant" is actually a different valid answer, the question is too ambiguous — pick a sharper one instead.)

ONLY refuse (return {"ok":false}) if there is NO broadcast-safe question to be had: sexually explicit/pornographic content, sexualizing minors, hate-slur topics, or harassing a private individual. Everything else — including adult topics reframed cleanly — gets a question. If in doubt, make the question.

Output ONLY a single minified JSON object, no markdown, no prose, no code fences:
{"ok":true,"question":"...","answer":"...","accept":["...","..."]}
or
{"ok":false}

Constraints: question <= 160 chars and ends with "?". answer <= 40 chars and <= 4 words.`

// STAGE 1 of the two-tier generator: pick the SUBJECT(S), do NOT write a question yet.
// Splitting "what is this question about" from "what is the surprising fact" is the whole
// point — it stops the model collapsing a named topic into a question whose answer is just
// the topic restated ("anger management" -> answer "Anger Management").
const SUBJECT_SYSTEM = `You are STAGE 1 of a two-stage trivia generator for a live Twitch chat. You do NOT write a question. You only choose the SUBJECT(S) a great question will be built on.

Interpret the topic generously. It may be broad ("birds"), vague, misspelled, slangy, a proper noun, an opinion/constraint phrase ("a 2010s game that isn't indie slop"), or adult/edgy ("sex", "drugs"). Strip any attitude and extract the real subject. Treat an unfamiliar word as a real thing. NEVER refuse for being broad, simple, weird, niche, short, unfamiliar, adult, or edgy.

Pick 1-3 SPECIFIC, concrete subjects you genuinely know well enough to have a SURPRISING, lesser-known fact ready about each:
- If the topic already NAMES one specific thing (a single movie, person, game, place, song, event, product), return exactly that ONE subject and set "namesSubject": true.
- If the topic is BROAD or a category, pick 2-3 specific, NON-OBVIOUS instances and set "namesSubject": false. Reach past the single most famous example: for "2010s games" skip Skyrim/GTA V/Witcher 3; for "birds" pick specific species. Vary your picks across repeated asks.
- For a NICHE topic you only partly know, anchor on something solid — the specific thing, or zoom out to its franchise, creator, studio, genre, era, or country.
- For an adult/edgy topic, pick a clean, broadcast-safe specific subject.
- Add a short disambiguating tag in a name when useful, e.g. "Anger Management (2003 film)".

Output ONLY one minified JSON object, no prose:
{"namesSubject":true,"subjects":["Anger Management (2003 film)"]}
or {"namesSubject":false,"subjects":["...","...","..."]}
or {"subjects":[]} only if the topic is genuinely empty or unintelligible.`

// STAGE 2: given an already-chosen subject, mine a surprising deep cut and frame it as one
// typeable question. The no-name-back rule is what kills the "answer = the topic" failure.
const DEEPCUT_SYSTEM = `You are STAGE 2 of a two-stage trivia generator for a live Twitch chat. You are GIVEN one specific SUBJECT (already chosen for you) and write ONE question about a SURPRISING, lesser-known-but-fun fact about THAT subject — the kind that makes chat go "oh neat, I didn't know that". You are the best trivia writer alive: fresh, fair, rock-solid true, never fabricated.

Go DEEP, not surface. Skip the obvious headline everyone already knows; mine a deep cut you are CERTAIN is true — a casting/origin/behind-the-scenes detail, a record, a hidden connection, a namesake, an original title, a strange-but-true cause.

Do NOT just name the subject back:
- GUESS_THE_SUBJECT=false: the asker already named this subject, so its own name/title is a FORBIDDEN answer. NAME the subject in the question and ask about a PROPERTY of it — a person, place, year, number, or other name connected to it. The answer must be a fact ABOUT the subject, never the subject itself.
- GUESS_THE_SUBJECT=true: you MAY instead make the subject itself the answer, giving enough identifying clues to land it — but still pick a surprising angle, not a textbook description.

If you do NOT have a solid, surprising, verifiable fact for this exact subject, zoom OUT to its creator, franchise, studio, genre, era, or country and ask a great true question there instead — never fabricate to fill the slot.

${BAR}`

// rotating question "lenses" — a soft angle steer injected per generation so repeated
// requests on the same broad topic ("a 2010s game") attack from a different direction
// each round instead of the model always reaching for the same kind of fact. the model
// is told to swap angles if it lacks a solid fact in this one, so this never forces a
// fabrication — it only widens variety. topic-agnostic: every angle fits almost any
// subject (a game, a person, a country, a chemical, an anime).
export const LENSES = [
  'an unexpected origin or etymology — why it has its name, or where it actually came from',
  'a well-established record or superlative — a famous first, only, biggest, or fastest that is widely reported (not an obscure stat you cannot be sure of)',
  'a surprising but well-documented number — a year, count, or measurement that is solidly recorded, never a precise figure you would have to guess at',
  'a hidden connection to something seemingly unrelated',
  'a widely-believed misconception versus the surprising truth',
  'the specific person or place behind it — a creator, inventor, namesake, or birthplace',
  'an original name, codename, or working title from before it became what we know',
  'a strange-but-true detail or a cause behind why it is the way it is',
]

// per-channel recent-lens memory so a channel does not see the same angle twice within a
// short window. mirrors trivia.ts's recentTypes pattern; bounded, self-trimming.
const recentLenses = new Map<string, number[]>()

// pick k DISTINCT lenses for a best-of-N round, preferring angles not used recently in
// this channel so consecutive rounds attack from fresh directions. updates the recent
// window. k is clamped to the number of lenses; returns at least 1.
export function pickDistinctLenses(channel: string, k: number): string[] {
  const want = Math.max(1, Math.min(k, LENSES.length))
  const recent = recentLenses.get(channel) ?? []
  const fresh = LENSES.map((_, i) => i).filter((i) => !recent.includes(i))
  const bag = (fresh.length >= want ? fresh : LENSES.map((_, i) => i)).slice()
  const chosen: number[] = []
  while (chosen.length < want && bag.length) {
    chosen.push(bag.splice(Math.floor(Math.random() * bag.length), 1)[0])
  }
  recent.push(...chosen)
  while (recent.length > 6) recent.shift()
  recentLenses.set(channel, recent)
  return chosen.map((i) => LENSES[i])
}

// how many candidate questions we generate per round. best-of-N: more angles tried in
// parallel => higher chance one survives verification (low null rate, so questions stay
// on-topic instead of falling to the curated pool) AND we get to ship the strongest of
// several. parallel calls => no extra latency over a single attempt, only more tokens.
// 6 (was 4): the unanimous 3-lens gate + solver "differs => reject" wipes verifiable-but-
// debatable topics to zero survivors at 4; two more angles keep them off the curated pool.
const CANDIDATES = 6

const BROADEN = 'Play it safe: pick the single most well-established, certainly-true fact you know that connects to this topic — zoom out to its broader subject if needed — and ask a clean question whose answer is one crisp nameable thing.'

function lensInstruction(lens: string): string {
  return `Favor THIS angle if you have a SOLID, verifiable fact for it; otherwise pick a better angle for this topic (never invent one to fit): ${lens}`
}

export async function generateCustomTrivia(topic: string, channel: string, avoid: string[] = [], avoidAnswers: string[] = []): Promise<CustomTrivia | null> {
  if (!API_KEY) return null
  // governed exactly like the !b AI path: only spend in AI-enabled channels, and honor
  // the per-channel daily token backstop so a custom-trivia spree can't dodge the cap.
  if (!AI_CHANNELS.has(channel.toLowerCase())) return null
  if (isOverDailyCap(channel)) {
    log(`ai-trivia: daily cap hit for ${channel}, skipping generation`)
    return null
  }
  const clean = stripUnpairedSurrogates(topic.trim()).slice(0, MAX_TOPIC_LEN)
  if (clean.length < 2) return null
  // tell the model what was just asked so it never repeats a recent question verbatim, AND
  // which answers were just used so it can't ship the same fact reworded (a repeat on the
  // same topic lands on the same answer even when the question text differs).
  const avoidQ = avoid.length
    ? `\n\nRecently asked here — do NOT repeat or closely paraphrase any of these; ask something different:\n${avoid.slice(-8).map((q) => `- ${q}`).join('\n')}`
    : ''
  const avoidA = avoidAnswers.length
    ? `\n\nDo NOT reuse any of these recent ANSWERS — pick a genuinely different fact/subject, even on the same topic:\n${avoidAnswers.slice(-12).map((a) => `- ${a}`).join('\n')}`
    : ''
  const avoidBlock = avoidQ + avoidA

  // STAGE 1: commit to a specific subject (or a few) before writing anything. This is what
  // forces depth — the writer is handed "Anger Management (2003 film)" and told to mine a
  // fact about it, instead of being free to ask a question whose answer IS the topic.
  const { namesSubject, subjects } = await pickSubjects(clean, channel, avoidAnswers)
  if (isOverDailyCap(channel)) return null // stage 1 may have tipped the daily cap

  // STAGE 2: best-of-N deep-cut questions spread across the chosen subjects with distinct
  // angles. one subject -> N angles drill into it; several subjects -> one angle each for
  // variety. guessTheSubject is OFF when stage 1 says the topic already names the subject,
  // so the answer must be a fact ABOUT it, never the subject's own name.
  const lenses = pickDistinctLenses(channel, CANDIDATES)
  const items = lenses.map((lens, i) => ({ subject: subjects[i % subjects.length], instruction: lensInstruction(lens) }))
  let passed: Scored[] = await generateAndVerify(channel, items, clean, avoidBlock, !namesSubject)
  // round 2 only if round 1 produced nothing usable — a single play-it-safe broaden pass on
  // the raw topic (naming allowed). cap re-checked so a spree can't dodge the backstop.
  if (passed.length === 0 && !isOverDailyCap(channel)) {
    passed = await generateAndVerify(channel, [{ subject: clean, instruction: BROADEN }], clean, avoidBlock, true)
  }
  if (passed.length === 0) return null
  return pickBestCandidate(passed)
}

// STAGE 1 call: turn the raw topic into 1-3 concrete subjects + whether the topic already
// names its subject. Fails soft to "the topic itself is the subject, naming allowed" so a
// stage-1 hiccup degrades to the old single-stage behavior rather than dead-ending.
async function pickSubjects(topic: string, channel: string, avoidAnswers: string[] = []): Promise<{ namesSubject: boolean; subjects: string[] }> {
  const fallback = { namesSubject: false, subjects: [topic] }
  // for a broad topic, steer subject choice away from instances already used recently so
  // repeated asks spread across different subjects instead of re-picking the same one.
  const avoidLine = avoidAnswers.length
    ? `\n\nAvoid subjects that would lead back to these recently-used answers: ${avoidAnswers.slice(-12).join(', ')}.`
    : ''
  const text = await callApi(SUBJECT_SYSTEM, `TOPIC: ${topic}${avoidLine}`, channel, 200)
  if (!text) return fallback
  const json = extractFirstJson(text)
  if (!json) return fallback
  try {
    const o = JSON.parse(json) as { namesSubject?: unknown; subjects?: unknown }
    const subjects = Array.isArray(o.subjects)
      ? o.subjects
          .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          .map((s) => s.trim().slice(0, MAX_TOPIC_LEN))
          .slice(0, 3)
      : []
    if (subjects.length === 0) return fallback
    return { namesSubject: o.namesSubject === true, subjects }
  } catch {
    return fallback
  }
}

// STAGE 2: one deep-cut question per (subject, angle) item in parallel, dedupe, then verify
// the survivors in parallel. when guessTheSubject is false, drop any candidate whose answer
// just restates the subject/topic — the exact "too basic" tautology this whole change kills.
async function generateAndVerify(
  channel: string,
  items: { subject: string; instruction: string }[],
  topic: string,
  avoidBlock: string,
  guessTheSubject: boolean,
): Promise<Scored[]> {
  const gens = await Promise.all(
    items.map(async (it) => {
      const content = `SUBJECT: ${it.subject}\nGUESS_THE_SUBJECT: ${guessTheSubject}\n\n${it.instruction}${avoidBlock}`
      const g = await attemptGen(DEEPCUT_SYSTEM, content, channel)
      if (!g.ok) return null
      if (!guessTheSubject && echoesSubject(g.q.answer, it.subject, topic)) {
        log(`ai-trivia: dropped tautology "${g.q.answer}" (subject named in topic: ${it.subject})`)
        return null
      }
      // deterministic backstop to the verifier's GIVEAWAY rule: if a winning answer is
      // sitting verbatim in the question, a viewer can copy it — drop it, no API call needed.
      if (answerLeaks(g.q)) {
        log(`ai-trivia: dropped giveaway "${g.q.answer}" (answer appears in the question)`)
        return null
      }
      return g.q
    }),
  )
  const cands = dedupeCandidates(gens.filter((q): q is CustomTrivia => q !== null))
  if (cands.length === 0) return []
  const verdicts = await Promise.all(cands.map((q) => verifyPanel(q, channel, topic)))
  const passed: Scored[] = []
  cands.forEach((q, i) => {
    if (verdicts[i].ok) passed.push({ q, quality: verdicts[i].quality })
    else log(`ai-trivia: verify rejected "${q.question.slice(0, 50)}" (ans: ${q.answer})`)
  })
  return passed
}

// deterministic giveaway check: true if any distinctive accepted answer appears as a
// contiguous word run in the question (a viewer could copy it verbatim). Skips short and
// pure-number forms — a 2-letter token or a bare count recurs harmlessly in normal wording.
export function answerLeaks(q: CustomTrivia): boolean {
  const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()} `
  const nq = norm(q.question)
  for (const a of [q.answer, ...q.accept]) {
    const na = norm(a).trim()
    if (na.length < 3 || /^\d+$/.test(na)) continue
    if (nq.includes(` ${na} `)) return true
  }
  return false
}

// true when an answer merely restates the subject or the user's topic — e.g. topic "anger
// management" -> answer "Anger Management". Strips a disambiguating "(2003 film)" tag and
// punctuation, then flags an exact match or an answer that is essentially the whole subject.
function echoesSubject(answer: string, subject: string, topic: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
  const a = norm(answer)
  if (a.length < 2) return false
  for (const ctx of [norm(subject), norm(topic)]) {
    if (!ctx) continue
    if (a === ctx) return true
    if (ctx.includes(a) && a.length >= ctx.length * 0.6) return true
  }
  return false
}

// drop near-duplicate candidates (same normalized question or same answer) so best-of-N
// doesn't ship two rephrasings of the same fact.
function dedupeCandidates(cands: CustomTrivia[]): CustomTrivia[] {
  const seenQ = new Set<string>()
  const seenA = new Set<string>()
  const out: CustomTrivia[] = []
  for (const c of cands) {
    const nq = c.question.toLowerCase().replace(/\s+/g, ' ').trim()
    const na = c.answer.toLowerCase().trim()
    if (seenQ.has(nq) || seenA.has(na)) continue
    seenQ.add(nq)
    seenA.add(na)
    out.push(c)
  }
  return out
}

// a verified candidate plus the verifier's quality rating (1-3), so the orchestrator can
// ship the BEST survivor, not just any that passed.
interface Scored {
  q: CustomTrivia
  quality: number
}

// pick the ship-worthy question: highest verifier quality first (best-of-all-time bar),
// then the most TYPEABLE answer (fewest words) as a tie-break, then random so the same
// topic still varies across rounds.
function pickBestCandidate(cands: Scored[]): CustomTrivia {
  const maxQ = Math.max(...cands.map((c) => c.quality))
  const top = cands.filter((c) => c.quality === maxQ)
  const minWords = Math.min(...top.map((c) => c.q.answer.trim().split(/\s+/).length))
  const best = top.filter((c) => c.q.answer.trim().split(/\s+/).length === minWords)
  return best[Math.floor(Math.random() * best.length)].q
}

// adversarial verification: a fresh call, no stake in the question, asked to REFUTE.
// returns true only if it confirms every claim is true AND the answer is the single
// correct one. fails open to false (reject) on any error so a wrong question can't slip
// through on an API hiccup. cheap (short output), and only runs on the world-knowledge
// custom path — NOT person/chat trivia, whose answers live in context the checker lacks.
const VERIFY_SYSTEM = `You are a meticulous trivia fact-checker. You get a QUESTION and a claimed ANSWER. Catch BROKEN questions before they reach live chat.

FIRST think in the "check" field: restate what is being asked, confirm the core fact, and — for any count or number — RECOMPUTE it yourself step by step and confirm it honors EVERY stated condition in the question (if it says "excluding Start and Select", your count must actually exclude them). Then give the verdict.

Reject (ok:false) if you find ANY of these problems:
- A claim you know or strongly believe is FALSE — including a count that does NOT match the question's own stated conditions (e.g. it says "excluding X" but the answer is the count that includes X).
- An unconfirmable embellishment — a specific award, exact date, record, or "first to do X" you cannot verify. Fabricated padding is the #1 failure.
- AMBIGUITY: more than one equally-valid answer. This includes (a) a "what is the term/word for X" definition question where several legitimate terms fit (an organism that eats dead matter -> scavenger / saprophage / saprotroph / detritivore / decomposer are all defensible -> reject), and (b) a count whose value depends on convention or changes over time ("how many buttons does a controller have" — is the d-pad 0, 1, or 4? — reject; "how many moons does Jupiter have" changes yearly — reject). If multiple answers could each be marked correct, reject.
- Incoherence — the answer doesn't actually fit what's asked (asks for a "fear/phobia" but the answer isn't one).
- Misdirecting or two-part wording — REJECT if the question bundles two asks OR if its opening primes the wrong TYPE of answer. Canonical fail: "How many walls surround the island — Wall Maria, Wall Rose, and what is the third called?" opens with "how many" (a reader types a NUMBER) but the real answer is a name ("Wall Sina") — reject. Any time the first words imply a count but the answer is a name/word (or the reverse), reject.
- Not self-contained — refers to an unnamed specific thing ("this game", "a certain bird") the guesser can't identify.
- A non-typeable ANSWER — it is a descriptive phrase, verb phrase, or sentence fragment rather than a crisp token a viewer types verbatim (a name, proper noun, place, title, single word, or number). "time moves when you move", "royal blood contact", "label the buttons" are BAD; reject them.
- GIVEAWAY — the answer, ANY accepted form of it, or an obvious synonym appears in the question text, OR the answer is trivially derivable from words in the question. A viewer must not be able to win by copying a word straight out of the question. This includes EPONYM TRAPS: "the Novaco Scale is named after which psychologist?" gives away "Novaco"; "Newton's law... named after whom?" gives away "Newton" — reject. If the answer is sitting in the question, reject.
- OFF-TOPIC — when a TOPIC line is given, the question MUST genuinely be about that topic: either about the topic itself, or about a person/place/work/event/thing that clearly BELONGS to it. A question on an unrelated subject that drifted in by mistake must be rejected (asked about "Romania" but the question is about a Diablo speedrun -> reject). Be generous about what belongs to a topic — a Romanian gymnast IS on-topic for "Romania", a boss in a game IS on-topic for that game, and a fact about a subject's creator, franchise, series, studio, or country of origin IS on-topic (a deliberate zoom-out, not drift). Reject only a REAL mismatch where the question shares no genuine connection to the topic, never a fair tangent. If no TOPIC line is given, skip this check.

Otherwise return ok:true. Do NOT reject merely because the topic is niche, obscure, or unfamiliar — and do NOT reject just because a question feels well-known. Only reject a concrete, objective problem you can point to. Weak-but-valid questions are handled by the quality score, not rejection.

Also rate the question's quality 1-3 (only meaningful when ok:true): 3 = excellent, genuinely surprising "oh neat" question with the answer well withheld; 2 = solid and fair; 1 = a surface gimme any casual instantly knows with zero thought ("what color is the sky"), filler, or otherwise weak. Be honest, do not inflate — this both ranks survivors AND, by consensus, floors out spammy questions.

Output ONLY one minified JSON object, no prose outside it:
{"check":"<your step-by-step verification, recomputing any count>","ok":true,"quality":3}
or
{"check":"...","ok":false,"reason":"<brief>"}`

// SOLVER lens — the highest-value check: re-derives the answer independently and rejects on
// mismatch. catches plausible-but-WRONG facts a single believe-the-claim verifier waves
// through (e.g. "Bob Barker's real-life sport" -> claims golf, but the solver knows karate).
const VERIFY_SOLVE_SYSTEM = `You are an independent solver fact-checking a trivia QUESTION before it reaches live chat. IGNORE the claimed answer at first.

In the "check" field: work out the answer YOURSELF, from your own knowledge, step by step (recompute any count, honoring every stated condition). THEN compare your independent answer to the claimed ANSWER / ACCEPTED FORMS.

Reject (ok:false) if: your independent answer DIFFERS from the claim, OR you are confident the claim is false, OR the question has no single determinable answer.

Do NOT reject merely because the topic is obscure and you are unsure. If you genuinely cannot determine the answer but the claim is plausible and the question is well-formed, accept (ok:true). ONLY your CONFIDENT disagreement is grounds to reject — a wrong fact is far worse than a hard one.

When accepting, rate quality 1-3 (3 = genuinely surprising "oh neat", 2 = solid, 1 = a surface gimme any casual instantly knows or otherwise weak). Output ONLY one minified JSON object:
{"check":"<your independent solve + comparison>","ok":true,"quality":3}
or
{"check":"...","ok":false,"reason":"<what you got vs the claim>"}`

// SKEPTIC lens — hunts the #1 failure mode: a fabricated or unverifiable specific detail
// (a made-up award, wrong year/number, false "first/only/biggest") smuggled in as padding.
const VERIFY_SKEPTIC_SYSTEM = `You are a skeptical fact-checker. Your ONE job: catch a FABRICATED or UNVERIFIABLE specific claim hidden in a trivia QUESTION — a made-up award, a wrong date/number, a false "first/only/biggest/largest" superlative, or an invented name or detail. Fabricated embellishment is the #1 reason these questions are wrong.

In the "check" field: list EACH specific factual claim the question makes and mark each true / false / can't-verify.

Reject (ok:false) ONLY if you can NAME a specific claim you are confident is FALSE, or a load-bearing specific detail that is fabricated. Do NOT reject because a fact is merely obscure or you cannot fully confirm it — plausible-but-obscure is fine. When in doubt, accept.

ONE EXCEPTION — invert the default for INTERNET/STREAMER/MEME PROVENANCE. Claims about how an emote, meme, or online phrase came to be — "became an official/global Twitch emote", "the first emote to X", "added to Twitch/Discord in <year>", "originated on <streamer>'s <year> stream", "named after <person>", "the community that spammed it into existence" — are the single most fabrication-prone class here: models (you included) routinely stitch together real fragments (a real emote + a real streamer + a real era) into a confident but WRONG origin story. For any such provenance/superlative claim about internet or streaming culture, REFUTE unless you are genuinely certain the exact origin, year, AND "official/global/first" status are all correct. Plausible-sounding but unconfirmable emote/meme lore = reject. (e.g. "forsenE became an official global Twitch emote after 2014 TPP spam" conflates a BTTV emote with Kappa's era — reject.)

When accepting, rate quality 1-3 (3 = genuinely surprising, 2 = solid, 1 = a surface gimme any casual instantly knows or otherwise weak). Output ONLY one minified JSON object:
{"check":"<claim-by-claim audit>","ok":true,"quality":3}
or
{"check":"...","ok":false,"reason":"<the specific false/fabricated claim>"}`

export interface Verdict {
  ok: boolean
  quality: number // 1-3 when ok, 0 when rejected — ranks survivors so the best one ships
}

// run ONE verifier lens. fails closed (reject) on any error so a wrong question can't slip
// through on an API hiccup. max_tokens 360 leaves room to reason in the "check" field before
// the verdict — recomputing a count or independently solving catches errors a yes/no misses.
async function runVerifier(system: string, q: CustomTrivia, channel: string, topic = ''): Promise<Verdict> {
  // pass every accepted form so a lens can catch a giveaway/match hiding in an alternate.
  const answers = [q.answer, ...q.accept.filter((a) => a.toLowerCase() !== q.answer.toLowerCase())].join(' / ')
  // the user's TOPIC is fed only to the general lens, which owns the off-topic-drift check;
  // the solver/skeptic stay laser-focused on correctness. blank topic => the check is skipped.
  const topicLine = topic.trim() ? `TOPIC: ${topic.trim()}\n` : ''
  const text = await callApi(system, `${topicLine}QUESTION: ${q.question}\nANSWER: ${q.answer}\nACCEPTED FORMS: ${answers}`, channel, 360)
  if (!text) return { ok: false, quality: 0 }
  const json = extractFirstJson(text)
  if (!json) return { ok: false, quality: 0 }
  try {
    const o = JSON.parse(json) as { ok?: unknown; quality?: unknown }
    if (o.ok !== true) return { ok: false, quality: 0 }
    const quality = typeof o.quality === 'number' && o.quality >= 1 && o.quality <= 3 ? Math.round(o.quality) : 2
    return { ok: true, quality }
  } catch {
    return { ok: false, quality: 0 }
  }
}

// single general lens — exported as the eval/test seam and used standalone where a quick
// check is enough. the live path uses verifyPanel (below) for the full diverse panel.
export async function verifyTrivia(q: CustomTrivia, channel: string): Promise<Verdict> {
  if (!API_KEY) return { ok: true, quality: 2 } // can't verify without a key; don't block generation
  return runVerifier(VERIFY_SYSTEM, q, channel)
}

// PANEL: three independent lenses in parallel — general (format/leak/ambiguity/spam),
// solver (re-derives the answer, catches plausible-but-wrong), skeptic (hunts fabricated
// detail). A question ships ONLY if ALL THREE accept — each fires only on a CONFIDENT,
// concrete problem in its domain, so an obscure-but-true deep cut survives while a wrong or
// gimme fact is vetoed. Parallel ⇒ the panel costs 3x tokens but the SAME wall-clock as one
// call. This is the best-of-all-time gate.
//
// minimum quality to ship — floors out true gimmes ("what color is the sky"). We take the
// MAX rating across lenses, not the mean: the solver and skeptic focus on correctness and
// reflexively stamp quality 1, so only the lens that actually judged the question should set
// the bar. A real gimme gets a 1 from ALL three (max 1 -> dropped); a good question gets a
// >=2 from at least one (kept). Avoids both over-rejecting good classics and shipping spam.
const MIN_QUALITY = 2

// run all three lenses in parallel, returning each verdict in [general, solver, skeptic]
// order. exported so the eval/diagnostics can see WHICH lens vetoed, not just the aggregate.
export async function verifyAllLenses(q: CustomTrivia, channel: string, topic = ''): Promise<Verdict[]> {
  // only the general lens (first) receives the topic — it owns the off-topic-drift veto.
  return Promise.all([
    runVerifier(VERIFY_SYSTEM, q, channel, topic),
    runVerifier(VERIFY_SOLVE_SYSTEM, q, channel),
    runVerifier(VERIFY_SKEPTIC_SYSTEM, q, channel),
  ])
}

export async function verifyPanel(q: CustomTrivia, channel: string, topic = ''): Promise<Verdict> {
  if (!API_KEY) return { ok: true, quality: 2 } // can't verify without a key; don't block generation
  const verdicts = await verifyAllLenses(q, channel, topic)
  // an objective defect (false fact / leak / ambiguity / fabrication) — any lens vetoes.
  if (!verdicts.every((v) => v.ok)) return { ok: false, quality: 0 }
  const quality = Math.max(...verdicts.map((v) => v.quality))
  if (quality < MIN_QUALITY) return { ok: false, quality: 0 } // consensus gimme — drop it
  return { ok: true, quality }
}

// Trivia about what just happened in chat ("!b trivia about the last 5 min of
// chat"). Same constrained single-call shape as custom-topic, but the source
// material is the recent chat log and the question must be answerable from it.
// Caller supplies the (bot-filtered) lines so this stays decoupled from chatbuf.
const CHAT_SYSTEM = `You generate ONE trivia question about what happened in a Twitch chat log (provided by the user).

Base the question ONLY on the actual messages shown — the answer MUST be objectively findable in the log: who said/asked something, a specific word/number/name someone mentioned, what topic came up, who did X. A fun recall question about the conversation.

Hard requirements:
- SINGLE objective, verifiable answer found in the log. No opinion, no "favorite".
- Answer short + typeable: 1-4 words, a number, or a username. "answer" is the single canonical form ONLY; put alternates (with/without @, casing) in "accept".
- Provide 2-5 accepted variants in "accept".
- Keep it light and SFW. NEVER quote or ask about slurs, harassment, doxxing/personal info, or sexual content. If the log is mostly that, or too thin/empty to make a fair question, return {"ok":false}.

Output ONLY a single minified JSON object, no markdown/prose/fences:
{"ok":true,"question":"...","answer":"...","accept":["...","..."]}
or
{"ok":false}

Constraints: question <= 160 chars and ends with "?". answer <= 40 chars and <= 4 words.`

const MIN_CHAT_LINES = 5

export async function generateChatTrivia(chatLines: string[], channel: string): Promise<CustomTrivia | null> {
  if (!API_KEY) return null
  if (!AI_CHANNELS.has(channel.toLowerCase())) return null
  if (isOverDailyCap(channel)) {
    log(`ai-trivia: daily cap hit for ${channel}, skipping chat trivia`)
    return null
  }
  const lines = chatLines.map((l) => stripUnpairedSurrogates(l).trim()).filter(Boolean)
  if (lines.length < MIN_CHAT_LINES) return null // not enough chat to be fair
  // cap context so a flood of long pastas can't blow the request body / budget
  const log_ = lines.slice(-40).join('\n').slice(-2400)

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 && isOverDailyCap(channel)) break
    const r = await attemptGen(CHAT_SYSTEM, `CHAT LOG (oldest first):\n${log_}`, channel)
    if (r.ok) return r.q
    if (!r.retry) return null
  }
  return null
}

// Trivia about a specific chatter ("!b trivia about @sw1ngggg"). Same constrained
// single-call shape, but grounded ONLY in the dossier the caller assembles from what
// we've logged about that person in THIS channel (extracted facts, stats, their own
// messages). The model must never invent a real-world detail — questions are about the
// person's in-channel persona (catchphrase, most-looked-up item, a stat), kept friendly
// and SFW. No dossier fact to ask about -> {"ok":false}, so a thin profile fails clean.
const PERSON_SYSTEM = `You generate ONE fun, affectionate trivia question about a Twitch CHATTER for the rest of the chat to guess, based ONLY on the DOSSIER the user provides (things we logged about them in this channel).

The answer MUST be findable in the dossier. Refer to the person by the given HANDLE.

FAIRNESS — most important: the rest of chat must have a real shot at the answer. Prefer what a regular who actually watches this person would KNOW: their signature/most-spammed emote, their main/most-looked-up item, a recurring word or topic in their messages, the thing they're known for. AVOID hidden numbers nobody could guess (exact win counts, message totals) — use those only as a last resort if there is nothing observable to ask. The best question makes a regular go "oh yeah, that's totally them".

Hard requirements:
- Base EVERYTHING on the dossier. NEVER invent or guess a real name, age, location, job, gender, or any detail not present. If the dossier has no single observable, objectively-answerable fact, return {"ok":false}.
- SINGLE objective, verifiable answer. Short + typeable: 1-4 words, an emote, a number, or a username. "answer" is the single canonical form; put variants (casing, with/without @, articles) in "accept".
- Provide 2-5 accepted variants in "accept".
- Keep it light, playful, a friendly shoutout-quiz — NEVER a roast, harassment, or anything embarrassing. NEVER ask about slurs, sexual content, or personal/identifying info. If the dossier is mostly toxic or too thin to be fair, return {"ok":false}.

Output ONLY a single minified JSON object, no markdown/prose/fences:
{"ok":true,"question":"...","answer":"...","accept":["...","..."]}
or
{"ok":false}

Constraints: question <= 160 chars and ends with "?". answer <= 40 chars and <= 4 words.`

const MIN_DOSSIER_LEN = 20

export async function generatePersonTrivia(dossier: string, handle: string, channel: string): Promise<CustomTrivia | null> {
  if (!API_KEY) return null
  if (!AI_CHANNELS.has(channel.toLowerCase())) return null
  if (isOverDailyCap(channel)) {
    log(`ai-trivia: daily cap hit for ${channel}, skipping person trivia`)
    return null
  }
  const d = stripUnpairedSurrogates(dossier.trim()).slice(0, 2400)
  if (d.length < MIN_DOSSIER_LEN) return null
  const content = `HANDLE: ${handle}\nDOSSIER:\n${d}`

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 && isOverDailyCap(channel)) break
    const r = await attemptGen(PERSON_SYSTEM, content, channel)
    if (r.ok) return r.q
    if (!r.retry) return null
  }
  return null
}

// single shared Anthropic call: builds the body, enforces the timeout, records spend, and
// returns the model's text (or null on any error/timeout/empty). every stage of the
// generator (subject pick, deep-cut write, verify) goes through here so the fetch, spend
// tracking, and failure handling live in ONE place.
async function callApi(system: string, content: string, channel: string, maxTokens: number): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT)
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY!, 'anthropic-version': '2023-06-01' },
      body: safeStringify({ model: MODEL, max_tokens: maxTokens, thinking: { type: 'disabled' }, system, messages: [{ role: 'user', content }] }),
      signal: controller.signal,
    })
    if (!res.ok) { log(`ai-trivia: API ${res.status}`); return null }
    const parsed = await readJson<{ content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } }>(res)
    // track spend so every trivia call counts toward the daily cap + shows in ai_spend,
    // same as the !b path — no untracked API spend.
    const u = parsed.data?.usage
    if (u) recordAiSpend(channel, u.input_tokens ?? 0, u.output_tokens ?? 0)
    return parsed.data?.content?.find((b) => b.type === 'text')?.text ?? null
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') log('ai-trivia: call timed out')
    else log(`ai-trivia: ${(e as Error)?.message ?? e}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

type GenResult = { ok: true; q: CustomTrivia } | { ok: false; retry: boolean }

async function attemptGen(system: string, userContent: string, channel: string): Promise<GenResult> {
  const text = await callApi(system, userContent, channel, 300)
  if (!text) return { ok: false, retry: false }
  const q = validate(text)
  return q ? { ok: true, q } : { ok: false, retry: true }
}

// parse the model's JSON and enforce every constraint ourselves — never trust the
// shape. a long answer, a multi-sentence answer, or a missing field all fail closed.
function validate(text: string): CustomTrivia | null {
  const json = extractFirstJson(text)
  if (!json) return null
  let obj: unknown
  try {
    obj = JSON.parse(json)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  if (o.ok !== true) return null

  const question = typeof o.question === 'string' ? o.question.trim() : ''
  const rawAnswer = typeof o.answer === 'string' ? o.answer.trim() : ''
  if (question.length < 5 || question.length > 200) return null
  if (rawAnswer.length < 1 || rawAnswer.length > 40) return null

  // the model sometimes crams an alternate into the answer ("Ti (or Si)", "Ti / Si").
  // split it: the canonical answer is the primary form (so the reveal + hint count are
  // clean), and every alternate folds into accept so chat can still type either.
  const { canonical, alts } = splitAlternates(rawAnswer)
  // chat must type the answer verbatim to win, so it has to be a crisp token — a name,
  // number, or short noun phrase, never a sentence/verb phrase. >4 words is almost always
  // a descriptive phrase nobody types exactly; the semantic verifier + crispest-candidate
  // preference catch the shorter phrase answers this word cap can't.
  if (canonical.split(/\s+/).length > 4) return null

  const accept = Array.isArray(o.accept)
    ? o.accept.filter((a): a is string => typeof a === 'string' && a.trim().length > 0).map((a) => a.trim())
    : []
  for (const alt of [canonical, ...alts]) {
    if (!accept.some((a) => a.toLowerCase() === alt.toLowerCase())) accept.push(alt)
  }

  return { question, answer: canonical, accept }
}

// "Ti (or Si)" / "Ti / Si" / "Ti or Si" -> { canonical: "Ti", alts: ["Si"] }.
// Returns the whole string as canonical with no alts when there's nothing to split.
export function splitAlternates(answer: string): { canonical: string; alts: string[] } {
  const alts: string[] = []
  // pull a trailing parenthetical alternate: "Ti (or Si)" / "Ti [Si]"
  let base = answer.replace(/\s*[([]\s*(?:or\s+|aka\s+|a\.?k\.?a\.?\s+)?([^)\]]+?)\s*[)\]]\s*$/i, (_m, alt) => {
    alts.push(String(alt).trim())
    return ''
  }).trim()
  // then split a "/" or " or " alternate list on the remainder: "Ti / Si", "Ti or Si"
  const parts = base.split(/\s*\/\s*|\s+or\s+/i).map((p) => p.trim()).filter(Boolean)
  if (parts.length > 1) {
    base = parts[0]
    alts.push(...parts.slice(1))
  }
  const canonical = base.length >= 1 ? base : answer.trim()
  return { canonical, alts: alts.filter((a) => a && a.toLowerCase() !== canonical.toLowerCase()) }
}
