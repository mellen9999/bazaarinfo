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

Interpret the topic generously. It may be broad ("birds"), vague, misspelled, slangy, or a proper noun — ALWAYS find a specific, hard, verifiable fact within it and ask about that. Narrow a broad topic yourself (e.g. "birds" -> a fact about one specific species). Treat an unfamiliar word as a real thing worth a question. Never refuse a topic for being broad, simple, weird, short, or unfamiliar.

Hard requirements:
- The question must be genuinely HARD — obscure-but-real, the kind that stumps casual fans, not a surface fact anyone would know.
- It must have a SINGLE objective, verifiable answer. No opinion, no "favorite", no "which is best".
- The answer MUST be short and typeable in a chat box: 1-4 words, or a number. Never a sentence.
- Provide 2-5 accepted answer variants: lowercase forms, with/without leading articles, common alternate spellings/abbreviations. Always include the canonical answer.

ONLY refuse (return {"ok":false}) if the topic is sexual, hateful, harassing, or about a private individual. Nothing else is a valid reason to refuse — if in doubt, make a question.

Output ONLY a single minified JSON object, no markdown, no prose, no code fences:
{"ok":true,"question":"...","answer":"...","accept":["...","..."]}
or
{"ok":false}

Constraints: question <= 160 chars and ends with "?". answer <= 40 chars and <= 4 words.`

export async function generateCustomTrivia(topic: string, channel: string): Promise<CustomTrivia | null> {
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

  // one retry on a soft miss (refusal / unparseable / failed-validation) — the model
  // occasionally fumbles a borderline-broad topic on the first pass but lands it on the
  // second. hard misses (HTTP error, timeout, cap) don't retry: no point, and a retry
  // would double the latency on a path that already aborts at 9s. the cap is re-checked
  // before the retry so a spree can't slip a second call in over the daily backstop.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 && isOverDailyCap(channel)) break
    const r = await attemptGen(clean, channel)
    if (r.ok) return r.q
    if (!r.retry) return null
  }
  return null
}

type GenResult = { ok: true; q: CustomTrivia } | { ok: false; retry: boolean }

async function attemptGen(clean: string, channel: string): Promise<GenResult> {
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
        system: SYSTEM,
        messages: [{ role: 'user', content: `TOPIC: ${clean}` }],
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
  const answer = typeof o.answer === 'string' ? o.answer.trim() : ''
  if (question.length < 5 || question.length > 200) return null
  if (answer.length < 1 || answer.length > 40) return null
  // chat must be able to type the answer — reject sentence-length answers.
  if (answer.split(/\s+/).length > 5) return null

  const accept = Array.isArray(o.accept)
    ? o.accept.filter((a): a is string => typeof a === 'string' && a.trim().length > 0).map((a) => a.trim())
    : []

  return { question, answer, accept }
}
