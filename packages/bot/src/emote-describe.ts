import { log } from './log'
import { writeAtomic } from './fs-util'
import { join } from 'path'

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

export interface EmoteDescription {
  desc: string
  mood: string
  overlay?: boolean
}

let cache: Record<string, EmoteDescription> = {}

// pre-seed well-known twitch/bttv/ffz emotes (no 7TV image available)
const KNOWN: Record<string, EmoteDescription> = {
  'Kappa': { desc: 'smug sarcastic grey face', mood: 'sarcasm' },
  'KappaPride': { desc: 'rainbow pride Kappa face', mood: 'happy' },
  'Keepo': { desc: 'cat-eared Kappa face', mood: 'cute' },
  'PogChamp': { desc: 'excited open mouth amazed face', mood: 'hype' },
  'LUL': { desc: 'bald guy laughing hard', mood: 'funny' },
  'OMEGALUL': { desc: 'distorted huge laughing face', mood: 'funny' },
  'monkaS': { desc: 'sweating nervous pepe frog', mood: 'scared' },
  'PepeHands': { desc: 'crying pepe frog, tears streaming', mood: 'sad' },
  'FeelsBadMan': { desc: 'sad downcast pepe frog', mood: 'sad' },
  'FeelsGoodMan': { desc: 'happy smiling pepe frog', mood: 'happy' },
  'FeelsStrongMan': { desc: 'pepe crying but staying strong', mood: 'happy' },
  'Sadge': { desc: 'small sad pepe, depressed', mood: 'sad' },
  'widepeepoHappy': { desc: 'wide stretched happy pepe', mood: 'happy' },
  'widepeepoSad': { desc: 'wide stretched sad pepe', mood: 'sad' },
  'peepoClap': { desc: 'small pepe clapping hands', mood: 'celebration' },
  'EZ': { desc: 'smug face, too easy', mood: 'sarcasm' },
  'Clap': { desc: 'hands clapping', mood: 'celebration' },
  'KEKW': { desc: 'spanish man laughing hysterically', mood: 'funny' },
  'LULW': { desc: 'wide stretched laughing face', mood: 'funny' },
  'catJAM': { desc: 'cat vibing nodding to music', mood: 'dance' },
  'modCheck': { desc: 'pepe looking around suspiciously', mood: 'confused' },
  'Copium': { desc: 'pepe inhaling copium gas mask', mood: 'sarcasm' },
  'Copege': { desc: 'pepe wearing copium mask, coping', mood: 'sarcasm' },
  'Clueless': { desc: 'pepe looking blissfully unaware', mood: 'sarcasm' },
  'Aware': { desc: 'pepe with wide knowing eyes', mood: 'thinking' },
  'Stare': { desc: 'pepe staring intensely forward', mood: 'thinking' },
  'BASED': { desc: 'lit fuse, hot take', mood: 'chad' },
  'Chatting': { desc: 'pepe typing at keyboard', mood: 'neutral' },
  'ICANT': { desc: 'pepe dying of laughter', mood: 'funny' },
  'Susge': { desc: 'suspicious skeptical pepe', mood: 'thinking' },
  'NOTED': { desc: 'pepe writing in notebook', mood: 'thinking' },
  'ppOverheat': { desc: 'pepe overheating, steam coming out', mood: 'shock' },
  'monkaW': { desc: 'zoomed nervous sweating pepe', mood: 'scared' },
  'monkaHmm': { desc: 'pepe thinking skeptically', mood: 'thinking' },
  'PepeLaugh': { desc: 'pepe covering mouth laughing', mood: 'funny' },
  'pepeMeltdown': { desc: 'pepe melting, losing composure', mood: 'sad' },
  'peepoGiggle': { desc: 'pepe giggling mischievously', mood: 'funny' },
  'GIGACHAD': { desc: 'ultra masculine chad jawline', mood: 'chad' },
  'Chad': { desc: 'confident chad face', mood: 'chad' },
  'BBoomer': { desc: 'old boomer with headphones', mood: 'cringe' },
  'forsenCD': { desc: 'transparent cd face, cheating joke', mood: 'sarcasm' },
  'xqcL': { desc: 'heart with happy tears, affection', mood: 'love' },
  'POGGERS': { desc: 'pepe version of pogchamp, hyped', mood: 'hype' },
  'PagMan': { desc: 'amazed excited man face', mood: 'hype' },
  'PagChomp': { desc: 'excited fish mouth chomp', mood: 'hype' },
  'D:': { desc: 'shocked horrified face', mood: 'shock' },
  'NODDERS': { desc: 'pepe nodding yes, agreeing', mood: 'hype' },
  'NOPERS': { desc: 'pepe shaking head no', mood: 'sarcasm' },
  'pepega': { desc: 'derpy pepe with megaphone', mood: 'cringe' },
  'WideHardo': { desc: 'wide face trying hard', mood: 'hype' },
  '5Head': { desc: 'pepe with huge brain, genius', mood: 'thinking' },
  '3Head': { desc: 'pepe with tiny brain, dumb', mood: 'cringe' },
  'pepeDS': { desc: 'pepe dancing disco moves', mood: 'dance' },
  'RainTime': { desc: 'pepe sitting in rain, peaceful', mood: 'sad' },
}

export async function loadDescriptionCache() {
  try {
    const file = Bun.file(CACHE_PATH)
    if (await file.exists()) {
      cache = await file.json()
      log(`loaded ${Object.keys(cache).length} emote descriptions`)
    }
  } catch {
    cache = {}
  }
  // KNOWN always wins — these are hand-curated and override 7TV auto-descriptions
  let updated = 0
  for (const [name, known] of Object.entries(KNOWN)) {
    const existing = cache[name]
    if (!existing || existing.desc !== known.desc || existing.mood !== known.mood || existing.overlay !== known.overlay) {
      cache[name] = known
      updated++
    }
  }

  // scrub filler words from all cached descriptions (one-time migration)
  let scrubbed = 0
  for (const [name, entry] of Object.entries(cache)) {
    if (name in KNOWN) continue // already correct
    const cleaned = cleanDesc(entry.desc, name)
    if (cleaned !== entry.desc) {
      entry.desc = cleaned
      scrubbed++
    }
  }

  if (updated > 0 || scrubbed > 0) {
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
): Promise<{ name: string, desc: string, mood: string }[]> {
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
      'For each emote, give a short description (max 8 words) and one mood tag.',
      'NEVER use generic words like "emote", "meme", "icon", "image", or "picture" — describe what it LOOKS like.',
      'NEVER include the emote name in its description.',
      'Each description must be visually unique — avoid generic phrases like "green frog with expression".',
      `Valid moods: ${MOODS.join(', ')}`,
      'Respond with ONLY a JSON array, no markdown fences:',
      '[{"name":"emoteName","desc":"short description","mood":"mood_tag"}]',
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
        max_tokens: 400,
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
        ...item,
        desc: cleanDesc(item.desc, item.name),
        mood: normalizeMood(item.mood),
      }))
  } catch (e) {
    log('emote describe batch failed:', e instanceof Error ? e.message : e)
    return []
  }
}

