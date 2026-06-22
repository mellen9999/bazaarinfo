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
const MODEL = 'claude-sonnet-4-6'
const TIMEOUT = 9_000
const MAX_TOPIC_LEN = 80

export interface CustomTrivia {
  question: string
  answer: string
  accept: string[]
}

const SYSTEM = `You generate ONE trivia question about a user-supplied TOPIC for a live Twitch chat.

Interpret the topic generously. It may be broad ("birds"), vague, misspelled, slangy, a proper noun, an opinion or constraint phrase ("a 2010s game that isn't indie slop"), or adult/edgy ("sex", "drugs", "death") — ALWAYS find a specific, hard, verifiable fact within it and ask about that. Strip any attitude/opinion and extract the real subject (e.g. "2010s game that isn't indie slop" -> a major AAA 2010s game like The Witcher 3 or Red Dead 2 -> a fact about it). Narrow a broad topic yourself ("birds" -> a fact about one specific species). Treat an unfamiliar word as a real thing worth a question. You can ALWAYS make a question — never refuse a topic for being broad, simple, weird, messy, opinionated, short, unfamiliar, adult, or edgy.

For an adult or risqué topic, reframe it into a CLEAN, broadcast-safe question — clinical, scientific, historical, or etymological — and ask THAT (e.g. "sex" -> a biology/reproduction term; "masturbation" -> a historical/medical fact). Never graphic, explicit, crude, or titillating. The question must read fine out loud on a family-friendly stream.

Hard requirements:
- The question must be genuinely HARD — obscure-but-real, the kind that stumps casual fans, not a surface fact anyone would know.
- SINGLE CLEAR ANSWER. Pick a fact with exactly ONE correct, well-established answer and no competing valid responses. Use a fact you actually know is true — never fabricate. You do NOT need to refuse: essentially every topic (skyrim, crows, anything) has a solid single-answer fact, so just choose one you're confident in rather than bailing.
- AVOID ambiguous "what is the term/word for ..." definition questions where several legitimate terms fit (e.g. an organism eating dead matter -> scavenger / necrophage / saprophage / saprotroph are all defensible). Prefer facts with a crisp, single answer: a specific name, place, date, year, number, or record holder.
- Make chat learn something — a satisfying "oh neat" fact, not a dry technicality.
- ONE core verifiable fact only. Do NOT pad the question with extra specific claims (an award won, an exact year, "the first to do X") unless you are CERTAIN they are true — fabricated embellishments are the #1 way these questions go wrong. A clean simple true fact beats an impressive-sounding false one.
- The answer MUST be short and typeable in a chat box: 1-4 words, or a number. Never a sentence.
- "answer" is the SINGLE canonical form ONLY — e.g. "Ti", never "Ti (or Si)". Put every alternate/spelling in "accept".
- Provide 2-6 accepted variants: lowercase forms, with/without leading articles, common alternate spellings/abbreviations, AND any other name that is genuinely the SAME answer. Always include the canonical answer. (If a "variant" is actually a different valid answer, the question is too ambiguous — pick a sharper one instead.)

ONLY refuse (return {"ok":false}) if there is NO broadcast-safe question to be had: sexually explicit/pornographic content, sexualizing minors, hate-slur topics, or harassing a private individual. Everything else — including adult topics reframed cleanly per above — gets a question. If in doubt, make the question.

Output ONLY a single minified JSON object, no markdown, no prose, no code fences:
{"ok":true,"question":"...","answer":"...","accept":["...","..."]}
or
{"ok":false}

Constraints: question <= 160 chars and ends with "?". answer <= 40 chars and <= 4 words.`

export async function generateCustomTrivia(topic: string, channel: string, avoid: string[] = []): Promise<CustomTrivia | null> {
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
  // tell the model what was just asked so it never repeats a recent question verbatim.
  const avoidBlock = avoid.length
    ? `\n\nRecently asked here — do NOT repeat or closely paraphrase any of these; ask something different:\n${avoid.slice(-8).map((q) => `- ${q}`).join('\n')}`
    : ''

  // one retry on a soft miss (refusal / unparseable / failed-validation) — the model
  // occasionally fumbles a borderline-broad topic on the first pass but lands it on the
  // second. hard misses (HTTP error, timeout, cap) don't retry: no point, and a retry
  // would double the latency on a path that already aborts at 9s. the cap is re-checked
  // before the retry so a spree can't slip a second call in over the daily backstop.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 && isOverDailyCap(channel)) break
    const r = await attemptGen(SYSTEM, `TOPIC: ${clean}${avoidBlock}`, channel)
    if (!r.ok) { if (!r.retry) return null; continue }
    // independent fact-check before we commit — a second model with no stake in the
    // question catches wrong answers + fabricated embellishments (the #1 failure mode:
    // "won X award in YEAR", a fear-term that isn't a fear). reject -> regenerate once.
    if (await verifyTrivia(r.q, channel)) return r.q
    log(`ai-trivia: verify rejected "${r.q.question.slice(0, 50)}" (ans: ${r.q.answer})`)
  }
  return null
}

// adversarial verification: a fresh call, no stake in the question, asked to REFUTE.
// returns true only if it confirms every claim is true AND the answer is the single
// correct one. fails open to false (reject) on any error so a wrong question can't slip
// through on an API hiccup. cheap (short output), and only runs on the world-knowledge
// custom path — NOT person/chat trivia, whose answers live in context the checker lacks.
const VERIFY_SYSTEM = `You are a strict trivia fact-checker. You get a QUESTION and a claimed ANSWER. Try to REFUTE it.

Return {"ok":true} ONLY if you are confident that ALL hold:
- EVERY factual claim in the question is true — no invented award, date, name, record, or embellishment.
- The claimed ANSWER is correct AND is the single best answer (no other equally-valid answer exists).
- The question is internally coherent (e.g. if it asks for a "fear/phobia", the answer is actually a fear).

If anything is false, doubtful, incoherent, or ambiguous, return {"ok":false,"reason":"<brief>"}. When unsure, return false.

Output ONLY a single minified JSON object.`

async function verifyTrivia(q: CustomTrivia, channel: string): Promise<boolean> {
  if (!API_KEY) return true // can't verify without a key; don't block generation
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT)
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: safeStringify({
        model: MODEL,
        max_tokens: 80,
        temperature: 0,
        system: VERIFY_SYSTEM,
        messages: [{ role: 'user', content: `QUESTION: ${q.question}\nANSWER: ${q.answer}` }],
      }),
      signal: controller.signal,
    })
    if (!res.ok) { log(`ai-trivia: verify API ${res.status}`); return false }
    const parsed = await readJson<{ content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } }>(res)
    const u = parsed.data?.usage
    if (u) recordAiSpend(channel, u.input_tokens ?? 0, u.output_tokens ?? 0)
    const text = parsed.data?.content?.find((b) => b.type === 'text')?.text
    if (!text) return false
    const json = extractFirstJson(text)
    if (!json) return false
    try { return (JSON.parse(json) as { ok?: unknown }).ok === true } catch { return false }
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') log('ai-trivia: verify timed out')
    return false
  } finally {
    clearTimeout(timer)
  }
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

type GenResult = { ok: true; q: CustomTrivia } | { ok: false; retry: boolean }

async function attemptGen(system: string, userContent: string, channel: string): Promise<GenResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT)
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: safeStringify({
        model: MODEL,
        max_tokens: 300,
        temperature: 0.85,
        system,
        messages: [{ role: 'user', content: userContent }],
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      log(`ai-trivia: API ${res.status}`)
      return { ok: false, retry: false }
    }
    const parsed = await readJson<{ content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } }>(res)
    if (!parsed.data) return { ok: false, retry: false }
    // track spend so custom trivia counts toward the daily cap + shows in ai_spend,
    // same as the !b path — no untracked API spend.
    const u = parsed.data.usage
    if (u) recordAiSpend(channel, u.input_tokens ?? 0, u.output_tokens ?? 0)
    const text = parsed.data.content?.find((b) => b.type === 'text')?.text
    if (!text) return { ok: false, retry: true }
    const q = validate(text)
    return q ? { ok: true, q } : { ok: false, retry: true }
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') log('ai-trivia: generation timed out')
    else log(`ai-trivia: ${(e as Error)?.message ?? e}`)
    return { ok: false, retry: false }
  } finally {
    clearTimeout(timer)
  }
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
  // chat must be able to type the answer — reject sentence-length answers.
  if (canonical.split(/\s+/).length > 5) return null

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
