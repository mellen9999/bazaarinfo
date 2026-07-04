import { log } from './log'
import { writeAtomic } from './fs-util'
import { join } from 'path'
// db is imported lazily inside describeEmotes (the maintenance-script-only path) so this
// module — pulled into the bot runtime via emotes.ts — stays free of a static db dependency
// that would break the partial db mocks in trivia/commands tests.

const API_KEY = process.env.ANTHROPIC_API_KEY
const CACHE_PATH = join(import.meta.dir, '../../..', 'cache', 'emote-descriptions.json')
const BATCH_SIZE = 5
const CONCURRENCY = 1
const CHUNK_DELAY = 15_000 // 15s between batches to avoid starving live chat

const MOODS = [
  'hype', 'funny', 'sad', 'happy', 'sarcasm', 'shock', 'thinking',
  'chad', 'cringe', 'greeting', 'love', 'rage', 'confused', 'cool',
  'scared', 'celebration', 'dance', 'cute', 'neutral',
] as const

const VALID_MOODS = new Set<string>(MOODS)

// map common hallucinated moods to valid ones
const MOOD_ALIASES: Record<string, string> = {
  shocked: 'shock', creepy: 'cringe', suspicious: 'thinking',
  chat: 'neutral', chaos: 'hype', angry: 'rage', fear: 'scared',
  excitement: 'hype', joy: 'happy', disgust: 'cringe',
  surprise: 'shock', bored: 'neutral', relaxed: 'cool',
}

function normalizeMood(mood: string): string {
  const lower = mood.toLowerCase()
  if (VALID_MOODS.has(lower)) return lower
  return MOOD_ALIASES[lower] ?? 'neutral'
}

// strip useless filler words that waste tokens — everything is an emote, no need to say so
const FILLER_RE = /\b(emote|meme|icon|image|picture|emoticon)\b/gi
function cleanDesc(desc: string, name: string): string {
  let cleaned = desc.replace(FILLER_RE, '').replace(/\s{2,}/g, ' ').trim()
  // strip emote name from its own description
  const nameRe = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
  cleaned = cleaned.replace(nameRe, '').replace(/\s{2,}/g, ' ').trim()
  // clean up orphaned punctuation left behind
  cleaned = cleaned.replace(/\s*,\s*,\s*/g, ', ') // double commas
  cleaned = cleaned.replace(/\s+,/g, ',') // space before comma
  cleaned = cleaned.replace(/^[,\-–\s]+|[,\-–\s]+$/g, '').trim()
  return cleaned || desc // fallback to original if cleaning emptied it
}

// normalize model phrasing so injection templates compose cleanly:
// use is rendered as-is, avoid is rendered as "not X" — strip redundant lead-ins
function cleanUse(s: string, name: string): string {
  return cleanDesc(s.replace(/^used\s+(for|to|when)\s+/i, '').replace(/^for\s+/i, ''), name)
}
function cleanAvoid(s: string, name: string): string {
  return cleanDesc(s.replace(/^(do\s+not|don't|never)\s+use\s+(for|when|as)\s+/i, '').replace(/^not\s+(for\s+)?/i, ''), name)
}

export interface EmoteDescription {
  desc: string
  mood: string
  /** what chat uses it for — short, cultural meaning over pixels */
  use?: string
  /** what it is NOT for — only set when misuse is a real risk (irony emotes etc) */
  avoid?: string
  overlay?: boolean
}

let cache: Record<string, EmoteDescription> = {}

// pre-seed well-known twitch/bttv/ffz emotes (no 7TV image available)
const KNOWN: Record<string, EmoteDescription> = {
  'Kappa': { desc: 'smug sarcastic grey face', mood: 'sarcasm', use: 'marks sarcasm or trolling', avoid: 'genuine statements' },
  'KappaPride': { desc: 'rainbow pride Kappa face', mood: 'happy', use: 'pride, flamboyant moments', avoid: 'generic happiness' },
  'Keepo': { desc: 'cat-eared Kappa face', mood: 'cute', use: 'playful sarcasm' },
  'PogChamp': { desc: 'excited open mouth amazed face', mood: 'hype', use: 'big plays, hype moments' },
  'LUL': { desc: 'bald guy laughing hard', mood: 'funny', use: 'something funny happened' },
  'OMEGALUL': { desc: 'distorted huge laughing face', mood: 'funny', use: 'extreme laughter, mocking fails' },
  'monkaS': { desc: 'sweating nervous pepe frog', mood: 'scared', use: 'tense scary moments' },
  'PepeHands': { desc: 'crying pepe frog, tears streaming', mood: 'sad', use: 'genuine sadness, loss' },
  'FeelsBadMan': { desc: 'sad downcast pepe frog', mood: 'sad', use: 'sympathy, disappointment' },
  'FeelsGoodMan': { desc: 'happy smiling pepe frog', mood: 'happy', use: 'satisfaction, things going well' },
  'FeelsStrongMan': { desc: 'pepe crying but staying strong', mood: 'happy', use: 'emotional triumph, bittersweet wins' },
  'Sadge': { desc: 'small sad pepe, depressed', mood: 'sad', use: 'resigned disappointment' },
  'widepeepoHappy': { desc: 'wide stretched happy pepe', mood: 'happy', use: 'wholesome joy' },
  'widepeepoSad': { desc: 'wide stretched sad pepe', mood: 'sad', use: 'exaggerated sadness' },
  'peepoClap': { desc: 'small pepe clapping hands', mood: 'celebration', use: 'applauding a play' },
  'EZ': { desc: 'smug face, too easy', mood: 'sarcasm', use: 'mock ease after a win', avoid: 'genuine praise' },
  'Clap': { desc: 'hands clapping', mood: 'celebration', use: 'applause, often ironic' },
  'KEKW': { desc: 'spanish man laughing hysterically', mood: 'funny', use: 'hard laughter at fails' },
  'LULW': { desc: 'wide stretched laughing face', mood: 'funny', use: 'amplified laughter' },
  'catJAM': { desc: 'cat vibing nodding to music', mood: 'dance', use: 'vibing to music' },
  'modCheck': { desc: 'pepe looking around suspiciously', mood: 'confused', use: 'where are the mods, looking for something' },
  'Copium': { desc: 'pepe inhaling copium gas mask', mood: 'sarcasm', use: 'mocking denial after a loss', avoid: 'genuine hope' },
  'Copege': { desc: 'pepe wearing copium mask, coping', mood: 'sarcasm', use: 'coping with a loss' },
  'Clueless': { desc: 'pepe looking blissfully unaware', mood: 'sarcasm', use: 'ironic — he has no idea what is coming', avoid: 'literal confusion' },
  'Aware': { desc: 'pepe with wide knowing eyes', mood: 'thinking', use: 'ironic — fully aware, pretending otherwise' },
  'Stare': { desc: 'pepe staring intensely forward', mood: 'thinking', use: 'deadpan judgment, awkward silence' },
  'BASED': { desc: 'lit fuse, hot take', mood: 'chad', use: 'endorsing a bold opinion' },
  'Chatting': { desc: 'pepe typing at keyboard', mood: 'neutral', use: 'chat yapping, off-topic talk' },
  'ICANT': { desc: 'pepe dying of laughter', mood: 'funny', use: 'cannot handle how funny' },
  'Susge': { desc: 'suspicious skeptical pepe', mood: 'thinking', use: 'something feels off' },
  'NOTED': { desc: 'pepe writing in notebook', mood: 'thinking', use: 'ironic note-taking of nonsense', avoid: 'genuine note-taking' },
  'ppOverheat': { desc: 'pepe overheating, steam coming out', mood: 'shock', use: 'overstimulated, too much happening' },
  'monkaW': { desc: 'zoomed nervous sweating pepe', mood: 'scared', use: 'extreme tension' },
  'monkaHmm': { desc: 'pepe thinking skeptically', mood: 'thinking', use: 'doubtful pondering' },
  'PepeLaugh': { desc: 'pepe covering mouth laughing', mood: 'funny', use: 'laughing at incoming disaster he knows about' },
  'pepeMeltdown': { desc: 'pepe melting, losing composure', mood: 'sad', use: 'total breakdown, chaos' },
  'peepoGiggle': { desc: 'pepe giggling mischievously', mood: 'funny', use: 'cheeky amusement' },
  'GIGACHAD': { desc: 'ultra masculine chad jawline', mood: 'chad', use: 'peak confidence, respect' },
  'Chad': { desc: 'confident chad face', mood: 'chad', use: 'confident move' },
  'BBoomer': { desc: 'old boomer with headphones', mood: 'cringe', use: 'out-of-touch boomer moment' },
  'forsenCD': { desc: 'transparent cd face, cheating joke', mood: 'sarcasm', use: 'accusing cheating, ironic', avoid: 'serious accusations' },
  'xqcL': { desc: 'heart with happy tears, affection', mood: 'love', use: 'wholesome affection' },
  'POGGERS': { desc: 'pepe version of pogchamp, hyped', mood: 'hype', use: 'hype, big moment' },
  'PagMan': { desc: 'amazed excited man face', mood: 'hype', use: 'awe at greatness' },
  'PagChomp': { desc: 'excited fish mouth chomp', mood: 'hype', use: 'hype chomp' },
  'D:': { desc: 'shocked horrified face', mood: 'shock', use: 'mock horror, dramatic gasp' },
  'NODDERS': { desc: 'pepe nodding yes, agreeing', mood: 'hype', use: 'emphatic agreement' },
  'NOPERS': { desc: 'pepe shaking head no', mood: 'sarcasm', use: 'emphatic disagreement' },
  'pepega': { desc: 'derpy pepe with megaphone', mood: 'cringe', use: 'calling something dumb', avoid: 'mocking real people harshly' },
  'WideHardo': { desc: 'wide face trying hard', mood: 'hype', use: 'sweaty tryhard effort', avoid: 'genuine praise' },
  '5Head': { desc: 'pepe with huge brain, genius', mood: 'thinking', use: 'galaxy-brain play, sometimes ironic' },
  '3Head': { desc: 'pepe with tiny brain, dumb', mood: 'cringe', use: 'dumb take or play' },
  'pepeDS': { desc: 'pepe dancing disco moves', mood: 'dance', use: 'party, celebration dance' },
  'RainTime': { desc: 'pepe sitting in rain, peaceful', mood: 'sad', use: 'melancholy comfy vibes' },
}

export async function loadDescriptionCache() {
  let loadFailed = false
  try {
    const file = Bun.file(CACHE_PATH)
    if (await file.exists()) {
      cache = await file.json()
      log(`loaded ${Object.keys(cache).length} emote descriptions`)
    }
  } catch (e) {
    loadFailed = true
    cache = {}
    console.error(`emote cache parse failed, NOT overwriting — inspect ${CACHE_PATH}`, e)
  }
  // KNOWN always wins — these are hand-curated and override 7TV auto-descriptions
  let updated = 0
  for (const [name, known] of Object.entries(KNOWN)) {
    const existing = cache[name]
    if (!existing || existing.desc !== known.desc || existing.mood !== known.mood
      || existing.use !== known.use || existing.avoid !== known.avoid || existing.overlay !== known.overlay) {
      cache[name] = known
      updated++
    }
  }

  // scrub filler words from all cached descriptions (one-time migration)
  let scrubbed = 0
  for (const [name, entry] of Object.entries(cache)) {
    if (name in KNOWN) continue // already correct
    if (!entry || typeof entry.desc !== 'string') { delete cache[name]; continue }
    const cleaned = cleanDesc(entry.desc, name)
    if (cleaned !== entry.desc) {
      entry.desc = cleaned
      scrubbed++
    }
    // migrate use/avoid written before phrasing normalization existed
    if (typeof entry.use === 'string') {
      const u = cleanUse(entry.use, name)
      if (u !== entry.use) { entry.use = u; scrubbed++ }
    }
    if (typeof entry.avoid === 'string') {
      const a = cleanAvoid(entry.avoid, name)
      if (a !== entry.avoid) { entry.avoid = a; scrubbed++ }
    }
  }

  if (!loadFailed && (updated > 0 || scrubbed > 0)) {
    log(`emote cache: ${updated} known overrides, ${scrubbed} descriptions scrubbed`)
    await saveCache()
  }
}

async function saveCache() {
  await writeAtomic(CACHE_PATH, JSON.stringify(cache, null, 2), 0o644)
}

export function getDescriptions(): Record<string, EmoteDescription> {
  return cache
}

async function fetchEmoteImage(emoteId: string): Promise<{ base64: string, type: string } | null> {
  try {
    // try animated webp first (captures animation), fall back to static
    const url = `https://cdn.7tv.app/emote/${emoteId}/2x.webp`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    return { base64: buf.toString('base64'), type: 'image/webp' }
  } catch {
    return null
  }
}

async function describeBatch(
  emotes: { name: string, id: string }[],
): Promise<{ name: string, desc: string, mood: string, use?: string, avoid?: string }[]> {
  const images = await Promise.all(emotes.map(async (e) => ({
    ...e,
    image: await fetchEmoteImage(e.id),
  })))

  const valid = images.filter((e) => e.image !== null)
  if (valid.length === 0) return []

  const content: any[] = []
  const nameList: string[] = []

  for (const e of valid) {
    nameList.push(e.name)
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: e.image!.type, data: e.image!.base64 },
    })
  }

  content.push({
    type: 'text',
    text: [
      `These are ${valid.length} Twitch/7TV chat emotes in order: ${nameList.join(', ')}`,
      'Some may be animated — describe the action/motion if visible.',
      'You know Twitch emote culture. Use each emote NAME to inform its meaning, not just the pixels — many emotes (peepo/pepe variants, -ge suffixes, Pag/monka families) have established usage that the image alone does not show.',
      'For each emote give:',
      '- "desc": what it looks like / the action, max 8 words',
      '- "use": what chat actually uses it for, max 6 words',
      '- "avoid": ONLY when the emote is commonly misused (ironic emotes, insults, hype-only emotes) — what it is NOT for, max 5 words. Omit this key otherwise.',
      '- "mood": one tag',
      'NEVER use generic words like "emote", "meme", "icon", "image", or "picture" — describe what it LOOKS like.',
      'NEVER include the emote name in its description.',
      'Each description must be visually unique — avoid generic phrases like "green frog with expression".',
      `Valid moods: ${MOODS.join(', ')}`,
      'Respond with ONLY a JSON array, no markdown fences:',
      '[{"name":"emoteName","desc":"short description","use":"chat usage","mood":"mood_tag"}]',
    ].join('\n'),
  })

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY!,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        messages: [{ role: 'user', content }],
      }),
      signal: AbortSignal.timeout(30_000),
    })

    if (!res.ok) {
      log(`emote describe API ${res.status}:`, await res.text())
      return []
    }

    const data = await res.json() as { content: { text: string }[] }
    const text = data.content?.[0]?.text ?? ''

    // parse JSON — strip markdown fences if present
    const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    const parsed = JSON.parse(jsonStr)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item: any) => item.name && item.desc && item.mood)
      .map((item: any) => ({
        name: item.name,
        desc: cleanDesc(item.desc, item.name),
        mood: normalizeMood(item.mood),
        ...(typeof item.use === 'string' && item.use.trim() ? { use: cleanUse(item.use, item.name) } : {}),
        ...(typeof item.avoid === 'string' && item.avoid.trim() ? { avoid: cleanAvoid(item.avoid, item.name) } : {}),
      }))
  } catch (e) {
    log('emote describe batch failed:', e instanceof Error ? e.message : e)
    return []
  }
}

// daily token cap for maintenance runs — mirrors AI_DAILY_TOKEN_CAP env var used by the live bot
const DESCRIBE_TOKEN_CAP = Math.max(0, parseInt(process.env.AI_DAILY_TOKEN_CAP ?? '0') || 0)

/**
 * Orchestrates describing all unknown emotes via describeBatch.
 * Skips emotes already in cache, respects AI_DAILY_TOKEN_CAP, and
 * persists cache after each batch for crash-safety.
 * Returns count of newly described emotes.
 */
export async function describeEmotes(
  emotes: { name: string, id: string, overlay?: boolean }[],
  opts: { force?: boolean } = {},
): Promise<number> {
  if (!API_KEY) {
    console.error('ANTHROPIC_API_KEY not set — skipping describe')
    return 0
  }

  // filter to emotes not yet described (force = re-describe everything except hand-curated KNOWN)
  const unknown = emotes.filter((e) => {
    if (e.name in KNOWN) return false
    if (opts.force) return true
    const existing = cache[e.name]
    return !existing || !existing.desc
  })
  if (unknown.length === 0) {
    log('all emotes already described')
    return 0
  }
  log(`describing ${unknown.length} new emotes in batches of ${BATCH_SIZE}`)

  let described = 0

  // lazy db import — keeps this module's static graph db-free (see top-of-file note)
  const getGlobalDailyAiSpend = DESCRIBE_TOKEN_CAP > 0
    ? (await import('./db')).getGlobalDailyAiSpend
    : null

  for (let i = 0; i < unknown.length; i += BATCH_SIZE) {
    // check global daily token cap before each batch
    if (getGlobalDailyAiSpend) {
      const spend = getGlobalDailyAiSpend()
      if (spend.tokens >= DESCRIBE_TOKEN_CAP) {
        console.error(`daily token cap reached (${spend.tokens}/${DESCRIBE_TOKEN_CAP}) — stopping`)
        break
      }
    }

    const batch = unknown.slice(i, i + BATCH_SIZE)
    const results = await describeBatch(batch)

    for (const r of results) {
      const overlay = emotes.find((e) => e.name === r.name)?.overlay
      cache[r.name] = {
        desc: r.desc, mood: r.mood,
        ...(r.use ? { use: r.use } : {}),
        ...(r.avoid ? { avoid: r.avoid } : {}),
        ...(overlay ? { overlay: true } : {}),
      }
      described++
    }

    // persist after each batch — crash-safe progress
    if (results.length > 0) await saveCache()

    if (i + BATCH_SIZE < unknown.length) {
      log(`batch done (${described} so far), waiting ${CHUNK_DELAY / 1000}s...`)
      await new Promise((r) => setTimeout(r, CHUNK_DELAY))
    }
  }

  return described
}

