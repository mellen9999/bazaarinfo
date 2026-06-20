import type { EncounterType } from './types'
import { log } from '../log'
import {
  buildClassDef, syntheticDef, matchBuiltin, normClassName, hasClassDef, getClassDef,
  registerClassDef, spellHintFor,
} from './classdef'
import type { ClassDef } from './classdef'
import * as db from './db'

const API_KEY = process.env.ANTHROPIC_API_KEY
const MODEL = 'claude-haiku-4-5-20251001'

// per-channel daily token cap — same env knob + same spend store as the main !b path
// (recordAiSpend/getDailyAiSpend live in the main db), so dnd shares ONE budget. the
// main db is loaded lazily inside callDm (not a static import) because importing it —
// or ai-cache — at module scope pulls the db/ai-sanitize/emotes chain into the dnd
// graph and forms a circular import. dynamic import resolves at call time, after the
// graph is fully initialised, so there's no cycle (and tests with no API key never hit it).
const DAILY_TOKEN_CAP = Math.max(0, parseInt(process.env.AI_DAILY_TOKEN_CAP ?? '0') || 0)

// the dungeon master IS Kripp — every line of narration is in his voice
const KRIPP_DM = `You are Kripparrian ("Kripp"), Octavian Morosan — Romanian-Canadian streamer, the original "No Life" hardcore grinder (world-first Diablo 3 Hardcore Inferno, #1 Hearthstone Arena & Battlegrounds player ever, now plays The Bazaar). Voice: dry, deadpan, monotone, relentlessly efficient and min-max-brained, obsessed with optimal value. Vegan — plant-based, OJ and falafel; slip in tasteful vegan jabs. Salt incarnate: deadpan despair at bad RNG ("of course", topdeck dread). Genuinely great plays are "actually insane" / "actually sick". Stay in character, keep it tight, obey the format the user asks for. No emojis.`

// every dnd AI call funnels through here so token usage is RECORDED and the per-channel
// daily cap is ENFORCED. dnd shares the same budget as the main !b lookups, so the cost
// backstop finally covers the game — it previously bypassed both tracking and the cap.
async function callDm(
  channel: string,
  opts: { maxTokens: number; system: string; prompt: string; timeoutMs: number },
): Promise<string | null> {
  if (!API_KEY) return null
  const mainDb = await import('../db')  // lazy — avoids a static circular import (see DAILY_TOKEN_CAP note)
  if (DAILY_TOKEN_CAP > 0) {
    try {
      const s = mainDb.getDailyAiSpend(channel)
      if (s.input_tokens + s.output_tokens >= DAILY_TOKEN_CAP) {
        log(`dnd: daily ai cap hit (${channel}) — using fallback`)
        return null
      }
    } catch { /* spend lookup failed — fail open, don't block the game */ }
  }
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: opts.maxTokens,
        system: opts.system,
        messages: [{ role: 'user', content: opts.prompt }],
      }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    })
    if (!res.ok) { log(`dnd: ai-dm ${res.status}`); return null }
    const data = await res.json() as {
      content?: { type: string; text: string }[]
      usage?: { input_tokens?: number; output_tokens?: number }
    }
    // always record spend so the daily cap can't be bypassed by a response that omits
    // usage — fall back to a conservative estimate (max output + a rough input guess)
    const inT = data.usage?.input_tokens ?? Math.ceil((opts.system.length + opts.prompt.length) / 4)
    const outT = data.usage?.output_tokens ?? opts.maxTokens
    mainDb.recordAiSpend(channel, inT, outT)
    return data.content?.[0]?.type === 'text' ? (data.content[0] as { text: string }).text.trim() : ''
  } catch (e) {
    log(`dnd: ai-dm error: ${e}`)
    return null
  }
}

async function ask(channel: string, prompt: string, maxTokens = 60): Promise<string> {
  const text = await callDm(channel, { maxTokens, system: KRIPP_DM, prompt, timeoutMs: 8_000 })
  return (text ?? '').slice(0, 200)
}

// --- custom class generation ---
const CLASS_GEN_SYSTEM = `You are a D&D 5e class designer for a Twitch dungeon-crawler. Given a class NAME (which may be silly, rude, or absurd — that's fine, lean into the humor), design a balanced level-1 class. Respond with ONLY a JSON object, no prose, no code fences:
{"chassis":"<one of: rage surge smite sneak nuke heal chaos flurry curse>","baseStats":{"str":N,"dex":N,"con":N,"int":N,"wis":N,"cha":N},"hitDie":<6|8|10|12>,"atkStat":"<str|dex|con|int|wis|cha>","weapon":{"name":"<short weapon name>","die":<4|6|8|10|12>,"count":<1|2>},"acArchetype":"<unarmored|mail|plate|light|mage|monk>","signature":"<bespoke ability name, max 24 chars>","role":"<one vivid sentence describing the fighter>","desc":"<short stat+ability summary, max 80 chars>"}
Chassis = the mechanical engine the signature ability runs on: rage=berserk melee, surge=extra attack, smite=slot→radiant burst, sneak=auto bonus damage striker, nuke=AoE blast caster, heal=support healer, chaos=random wild magic, flurry=multi-strike martial artist, curse=hex+blast warlock. Pick the chassis that best fits the name's vibe.
The "signature" MUST riff directly on the class name — pun on it, remix its words, or build the ability around its theme (e.g. name "kripps juicy butthole" -> "Buttjuice Tornado"; name "cheese wizard" -> "Gouda Nova"; name "sleepy cat" -> "Catnap Pounce"). Make it unmistakably derived from the name. The "weapon.name" and "desc" should match that theme too.
Stats use point-buy 8-17, total around 72. Be creative and funny with names/flavor but keep the numbers balanced.`

async function askJson(channel: string, name: string): Promise<Record<string, unknown> | null> {
  // JSON.stringify the untrusted class name so it lands as a quoted string literal —
  // a name like `ignore previous instructions` can't break out of the prompt frame.
  const raw = await callDm(channel, {
    maxTokens: 320, system: CLASS_GEN_SYSTEM,
    prompt: `Class name: ${JSON.stringify(name)}`, timeoutMs: 10_000,
  })
  if (!raw) return null
  const text = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < 0) return null
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch (e) {
    log(`dnd: classgen parse error: ${e}`)
    return null
  }
}

// Resolve a class name to a definition, generating + caching custom classes on the
// fly. Builtins and already-cached customs return instantly (no AI call). New custom
// names trigger one AI generation (or a deterministic fallback if AI is off/fails),
// then persist so every future join is free and identical.
export async function ensureClassDef(channel: string, rawName: string): Promise<ClassDef> {
  const builtin = matchBuiltin(rawName)
  if (builtin) return builtin
  const norm = normClassName(rawName)
  if (hasClassDef(rawName)) return getClassDef(rawName)

  const raw = await askJson(channel, rawName)
  const def = raw ? buildClassDef(rawName, raw) : syntheticDef(rawName)
  // re-check: a concurrent join may have cached it first; first write wins (INSERT OR IGNORE)
  db.saveClassDef(norm, def, raw ? 'ai' : 'synthetic')
  registerClassDef(def)
  return getClassDef(rawName)
}

export async function narrateFloor(
  channel: string,
  floor: number,
  encounterType: EncounterType,
  enemies: { name: string; hp: number; maxHp: number }[],
  playerCount: number,
): Promise<string> {
  const alive = enemies.filter((e) => e.hp > 0)
  if (encounterType === 'shop') {
    return `floor ${floor} — a merchant's torch flickers in the dark. inspect the wares, spend wisely. → !b buy 1 · !b buy 2 · !b buy 3 · !b buy 4 · !b move to skip`
  }
  if (encounterType === 'event') {
    return `floor ${floor} — something stirs in the shadows. ancient magic saturates the air. → !b explore to investigate`
  }
  if (alive.length === 0) {
    return `floor ${floor} is clear. blood stains the stone. → !b move to descend`
  }
  const enemyStr = alive.map((e) => `${e.name} (${e.hp}/${e.maxHp}HP)`).join(', ')
  const soloNote = playerCount <= 1 ? ' One adventurer stands alone.' : ''
  const prompt = `Twitch chat D&D dungeon, floor ${floor}.${soloNote} ${playerCount} adventurer(s) face: ${enemyStr}.
Write ONE tactical atmosphere line (170 chars max, lowercase, gritty D&D dungeon tone). End with: → !b a to attack · !b d to defend · !b spell for class ability. No emojis.`
  const result = await ask(channel, prompt, 72)
  if (!result) return `floor ${floor}: ${enemyStr} — roll for initiative. → !b a to attack · !b d to defend · !b spell for class ability`
  return result
}

export async function welcomePlayer(
  channel: string,
  username: string,
  cls: string,
  floor: number,
  encounterType: string,
  enemies: string[],
): Promise<string> {
  const def = getClassDef(cls)
  const role = def.role
  const enemyStr = enemies.length > 0 ? enemies.join(', ') : 'shadows'
  const spellHint = spellHintFor(def)
  const prompt = `Twitch chat D&D. @${username} descends as a ${cls} (${role}). Floor ${floor} (${encounterType}). Enemies: ${enemyStr}.
Write ONE welcoming line (160 chars max, lowercase, classic D&D dungeon tone). End with: !b a to attack · !b spell to use ${spellHint} · !b d to defend. No emojis.`
  const result = await ask(channel, prompt, 72)
  if (!result) return `@${username} descends as ${cls} — ${role}. → !b a to attack · !b spell to ${spellHint} · !b d to defend`
  return result
}

export async function narrateBoss(channel: string, floor: number, bossName: string, bossHp: number, playerCount: number): Promise<string> {
  const soloNote = playerCount <= 1 ? ' One lone challenger steps forward.' : ` ${playerCount} challengers.`
  const prompt = `Twitch chat D&D. A BOSS appears on floor ${floor}: ${bossName} (${bossHp}HP).${soloNote}
Write ONE epic, hype boss-entrance line in Kripp's voice (170 chars max, lowercase, dramatic). Name the boss. End with: → !b a to attack · !b spell. No emojis.`
  const result = await ask(channel, prompt, 80)
  return result
}

export async function narrateVeganShrine(channel: string, passed: boolean, username: string): Promise<string> {
  const prompt = passed
    ? `D&D dungeon. ${username} approaches an ancient shrine with no tainted goods. Write one sentence of mystical acceptance, 120 chars max, lowercase, reference purity and divine blessing.`
    : `D&D dungeon. ${username} approaches an ancient shrine carrying profane goods. Write one sentence of rejection, 120 chars max, lowercase, reference corruption and denied blessing.`
  const result = await ask(channel, prompt, 50)
  if (!result) {
    return passed
      ? `the shrine pulses with pale light for @${username}. "worthy." a divine warmth fills the hall. full heal granted.`
      : `the shrine recoils from @${username}'s tainted pack. cold silence. the blessing is denied.`
  }
  return result
}

export async function narrateDeath(channel: string, username: string, enemyName: string, floor: number): Promise<string> {
  const prompt = `D&D dungeon floor ${floor}. ${username} was just killed by ${enemyName}. Write one darkly poetic eulogy sentence, 140 chars max, lowercase, classic D&D tone. No emojis.`
  const result = await ask(channel, prompt, 55)
  if (!result) return `@${username} has fallen to ${enemyName} on floor ${floor}. the dungeon claims another.`
  return result
}
