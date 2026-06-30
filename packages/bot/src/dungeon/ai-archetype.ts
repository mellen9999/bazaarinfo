import { log } from '../log'
import { readJson, extractFirstJson } from '../http'
import { AI_CHANNELS, isOverDailyCap } from '../ai-cache'
import { recordAiSpend } from '../db'

// drop lone surrogate halves that would make JSON.stringify emit invalid UTF-8
function stripUnpairedSurrogates(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
}

function safeStringify(body: unknown): string {
  return JSON.stringify(body, (_k, v) => (typeof v === 'string' ? stripUnpairedSurrogates(v) : v))
}

const API_KEY = process.env.ANTHROPIC_API_KEY
const MODEL = 'claude-sonnet-5'
const TIMEOUT = 12_000

export type Build = 'tanky' | 'balanced' | 'aggressive'
export type SpecialKind = 'burst' | 'stun' | 'heal' | 'guard'

export interface Archetype {
  title: string        // e.g. "Reynad's Giant Forehead" — <= 40 chars
  blurb: string        // one short in-character line, <= 120 chars
  build: Build
  specialKind: SpecialKind
  moveName: string     // the signature move name, evocative + specific, <= 40 chars
  moveFlavor: string   // vivid one-line of the move's effect, MUST contain "{enemy}", <= 120 chars
}

export const DEFAULT_ARCHETYPE: Archetype = {
  title: 'the Wanderer',
  blurb: "a nameless drifter who answers the dungeon's call",
  build: 'balanced',
  specialKind: 'burst',
  moveName: 'Resolute Strike',
  moveFlavor: 'a decisive blow crashes into {enemy}',
}

const VALID_BUILDS = new Set<string>(['tanky', 'balanced', 'aggressive'])
const VALID_SPECIALS = new Set<string>(['burst', 'stun', 'heal', 'guard'])

// Archetype generation from Twitch chat vote suggestions. Isolated from the main
// chat AI path: no system-prompt chaining, no COT guards — a single constrained
// call that fuses chat's suggestions into one coherent hero. NEVER returns null;
// any failure path falls to DEFAULT_ARCHETYPE so the game run is never blocked.
const SYSTEM = `You fuse Twitch chat's voted hero suggestions into ONE coherent, fun Twitch-dungeon hero for a live chat game. The result is always a single, internally-consistent character — never a word-salad mashup.

WEIGHTING: the highest-voted suggestion is the primary identity. Runners-up are flavor accents only. A suggestion with more than 2× any rival's votes leads solo; the rest are small seasoning. When votes are close, find a clever synthesizing through-line that produces ONE believable character.

NEVER refuse. Funny AND naughty suggestions are first-class. Reframe crude/edgy/innuendo into a broadcast-safe but STILL genuinely funny hero — keep the comedic spirit, scrub only the explicit surface (e.g. "kripps butt juice tornado" → a gross-funny hero whose special releases some unspecified foul liquid; "deez nuts" → a tough, rotund brawler with a nutty gimmick). Drop ONLY: slurs, sexually explicit content, sexualizing minors, harassment targeting a real private individual. If genuinely nothing usable remains, output a generic adventurer.

BUILD and SPECIALKIND must thematically fit the concept:
- tanky / shield / wall / massive body part → build:tanky + specialKind:guard
- fire / rage / explosion / offense / burst → build:aggressive + specialKind:burst
- healing / cleric / support / warmth → build:balanced + specialKind:heal
- trickster / illusion / hypnosis / bee / jester / confusion → build:balanced + specialKind:stun
- paladin / knight / fortress → build:tanky + specialKind:guard
- assassin / rogue / poison / shadow → build:aggressive + specialKind:burst
- wizard / arcane / pyromancer → build:aggressive + specialKind:burst
- druid / shaman / nature → build:balanced + specialKind:heal
- bard / clown / jester / chaos → build:balanced + specialKind:stun

MOVENAME — hard ban: NEVER produce "<Concept> Blast", "<Concept> Strike", "<Concept> Attack", or "<Concept> Wave" as the whole gimmick name. These are lazy and forgettable. Invent a vivid, specific, particular name that could only belong to this hero.

MOVEFLAVOR: a vivid one-liner of the move landing on an enemy. MUST include the literal token {enemy} — the game engine replaces it with the monster's name at runtime. Broadcast-safe.

Constraints: title ≤ 40 chars. blurb ≤ 120 chars. moveName ≤ 40 chars. moveFlavor ≤ 120 chars and must include {enemy}.

Few-shot examples (quality and format bar — never reuse these verbatim):

SUGGESTIONS: reynads giant forehead (12 votes), wizard (3 votes), tank (2 votes)
{"title":"Reynad's Monolith Brow","blurb":"the forehead that ends arguments before they start","build":"tanky","specialKind":"guard","moveName":"Cranial Overdrive","moveFlavor":"the colossal brow drives {enemy} clean through the floor"}

SUGGESTIONS: pyromancer (8 votes), fire mage (4 votes)
{"title":"the Ashen Tempest","blurb":"she burned her old name and never looked back","build":"aggressive","specialKind":"burst","moveName":"Coronation of Embers","moveFlavor":"a spiral of white-hot ash consumes {enemy} from the outside in"}

SUGGESTIONS: a single confused bee (7 votes)
{"title":"Buzz, The One Bee","blurb":"not sure how it got here but it brought the stinger","build":"balanced","specialKind":"stun","moveName":"Frantic Waggle Dance","moveFlavor":"an erratic blur of wings leaves {enemy} completely disoriented"}

SUGGESTIONS: kripps butt juice tornado (6 votes)
{"title":"The Whirling Miasma","blurb":"a spinning vortex of... something. don't ask","build":"aggressive","specialKind":"burst","moveName":"Noxious Cyclone","moveFlavor":"a spinning column of unspeakable liquid slams into {enemy}"}

SUGGESTIONS: necromancer (5 votes), clown (3 votes), pizza delivery (1 vote)
{"title":"the Morbid Jester","blurb":"death's own comedian — fifteen minutes late or your corpse is free","build":"balanced","specialKind":"stun","moveName":"Punchline Suplex","moveFlavor":"the world's last joke lands on {enemy} before it even sees the fist"}

Output ONLY one minified JSON object, no markdown, no prose, no code fences:
{"title":"...","blurb":"...","build":"...","specialKind":"...","moveName":"...","moveFlavor":"..."}`

// parse the model's JSON and enforce every constraint — never trust the shape.
// repairs a missing {enemy} token rather than hard-failing (the engine needs it).
function validate(text: string): Archetype | null {
  const json = extractFirstJson(text)
  if (!json) return null
  let obj: unknown
  try { obj = JSON.parse(json) } catch { return null }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>

  const title = typeof o.title === 'string' ? o.title.trim() : ''
  const blurb = typeof o.blurb === 'string' ? o.blurb.trim() : ''
  const build = typeof o.build === 'string' ? o.build.trim() : ''
  const specialKind = typeof o.specialKind === 'string' ? o.specialKind.trim() : ''
  const moveName = typeof o.moveName === 'string' ? o.moveName.trim() : ''
  let moveFlavor = typeof o.moveFlavor === 'string' ? o.moveFlavor.trim() : ''

  if (!title || title.length > 40) return null
  if (!blurb || blurb.length > 120) return null
  if (!VALID_BUILDS.has(build)) return null
  if (!VALID_SPECIALS.has(specialKind)) return null
  if (!moveName || moveName.length > 40) return null
  if (!moveFlavor) return null

  // fix a missing {enemy} token rather than hard-failing — the engine needs it to
  // slot the monster name in. append a minimal suffix and re-check the length cap.
  if (!moveFlavor.includes('{enemy}')) {
    const fixed = `${moveFlavor} — {enemy} staggers`
    if (fixed.length <= 120) moveFlavor = fixed
    else return null
  }
  if (moveFlavor.length > 120) return null

  return {
    title,
    blurb,
    build: build as Build,
    specialKind: specialKind as SpecialKind,
    moveName,
    moveFlavor,
  }
}

async function attemptGen(input: string, channel: string): Promise<Archetype | null> {
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
        thinking: { type: 'disabled' },
        system: SYSTEM,
        messages: [{ role: 'user', content: `SUGGESTIONS: ${input}` }],
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      log(`ai-archetype: API ${res.status}`)
      return null
    }
    const parsed = await readJson<{
      content?: { type: string; text?: string }[]
      usage?: { input_tokens?: number; output_tokens?: number }
    }>(res)
    if (!parsed.data) return null
    const u = parsed.data.usage
    if (u) recordAiSpend(channel, u.input_tokens ?? 0, u.output_tokens ?? 0)
    const text = parsed.data.content?.find((b) => b.type === 'text')?.text
    if (!text) return null
    return validate(text)
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') log('ai-archetype: timed out')
    else log(`ai-archetype: ${(e as Error)?.message ?? e}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Generate a hero archetype from chat's voted suggestions. Takes the top 4 by votes,
// builds a weighted input string, makes one generation attempt with one retry on soft
// failure (bad JSON / missing field), and records token spend against the daily cap.
// NEVER returns null — any failure (no key, over cap, API error, invalid shape) falls
// to DEFAULT_ARCHETYPE so the game run always has a hero to launch with.
export async function generateArchetype(
  suggestions: { text: string; votes: number }[],
  channel: string,
): Promise<Archetype> {
  if (!API_KEY) return DEFAULT_ARCHETYPE
  if (!AI_CHANNELS.has(channel.toLowerCase())) return DEFAULT_ARCHETYPE
  if (isOverDailyCap(channel)) {
    log(`ai-archetype: daily cap hit for ${channel}`)
    return DEFAULT_ARCHETYPE
  }

  const top = [...suggestions]
    .sort((a, b) => b.votes - a.votes)
    .slice(0, 4)
  if (top.length === 0) return DEFAULT_ARCHETYPE

  const input = top
    .map((s) => `${stripUnpairedSurrogates(s.text.trim())} (${s.votes} vote${s.votes === 1 ? '' : 's'})`)
    .join(', ')

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 && isOverDailyCap(channel)) break
    const result = await attemptGen(input, channel)
    if (result !== null) return result
  }

  return DEFAULT_ARCHETYPE
}
