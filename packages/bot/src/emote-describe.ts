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
  'xqcL': { desc: 'xqc heart emote, love', mood: 'love' },
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
  // seed known emotes that aren't cached yet
  let seeded = 0
  for (const [name, desc] of Object.entries(KNOWN)) {
    if (!cache[name]) {
      cache[name] = desc
      seeded++
    }
  }
  if (seeded > 0) {
    log(`seeded ${seeded} known emote descriptions`)
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
        max_tokens: 2048,
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
      .map((item: any) => ({ ...item, mood: normalizeMood(item.mood) }))
  } catch (e) {
    log('emote describe batch failed:', e instanceof Error ? e.message : e)
    return []
  }
}

export async function describeEmotes(emotes: { name: string, id: string, overlay?: boolean }[]): Promise<number> {
  // update overlay flags on existing cache entries
  let flagsUpdated = 0
  for (const e of emotes) {
    if (e.overlay && cache[e.name] && !cache[e.name].overlay) {
      cache[e.name].overlay = true
      flagsUpdated++
    }
  }
  if (flagsUpdated > 0) {
    log(`updated overlay flag on ${flagsUpdated} cached emotes`)
    await saveCache()
  }

  if (!API_KEY) {
    log('no ANTHROPIC_API_KEY, skipping emote descriptions')
    return 0
  }

  const newEmotes = emotes.filter((e) => !cache[e.name])
  if (newEmotes.length === 0) {
    log('all emotes already described')
    return 0
  }

  log(`describing ${newEmotes.length} new emotes (batches of ${BATCH_SIZE}, ${CONCURRENCY} concurrent)...`)

  const batches: typeof newEmotes[] = []
  for (let i = 0; i < newEmotes.length; i += BATCH_SIZE) {
    batches.push(newEmotes.slice(i, i + BATCH_SIZE))
  }

  let processed = 0

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const chunk = batches.slice(i, i + CONCURRENCY)
    const results = await Promise.all(chunk.map(describeBatch))

    for (const batchResult of results) {
      for (const item of batchResult) {
        const emote = newEmotes.find((e) => e.name === item.name)
        cache[item.name] = { desc: item.desc, mood: item.mood, overlay: emote?.overlay }
        processed++
      }
    }

    log(`  ${processed}/${newEmotes.length} described`)
    await saveCache()
    if (i + CONCURRENCY < batches.length) await new Promise((r) => setTimeout(r, CHUNK_DELAY))
  }

  log(`emote descriptions done: ${processed} new`)
  return processed
}
