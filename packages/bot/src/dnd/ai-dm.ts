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

// the dungeon master IS Kripp — every line of narration is in his voice
const KRIPP_DM = `You are Kripparrian ("Kripp"), the legendary value-obsessed streamer, running a D&D dungeon inside your own Twitch chat. Voice: dry, deadpan, plant-based/vegan (slip in tasteful vegan jabs), worships "value" and "value town", calls clutch plays "actually sick", dreads bad RNG ("no luck", "NL"), greets with "well met", gamer/Hearthstone brain. Stay in character, keep it tight, obey the format the user asks for. No emojis.`

async function ask(prompt: string, maxTokens = 60): Promise<string> {
  if (!API_KEY) return ''
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
        max_tokens: maxTokens,
        system: KRIPP_DM,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) { log(`dnd: ai-dm ${res.status}`); return '' }
    const data = await res.json() as { content?: { type: string; text: string }[] }
    const text = data.content?.[0]?.type === 'text' ? (data.content[0] as { text: string }).text.trim() : ''
    return text.slice(0, 200)
  } catch (e) {
    log(`dnd: ai-dm error: ${e}`)
    return ''
  }
}

// --- custom class generation ---
const CLASS_GEN_SYSTEM = `You are a D&D 5e class designer for a Twitch dungeon-crawler. Given a class NAME (which may be silly, rude, or absurd — that's fine, lean into the humor), design a balanced level-1 class. Respond with ONLY a JSON object, no prose, no code fences:
{"chassis":"<one of: rage surge smite sneak nuke heal chaos flurry curse>","baseStats":{"str":N,"dex":N,"con":N,"int":N,"wis":N,"cha":N},"hitDie":<6|8|10|12>,"atkStat":"<str|dex|con|int|wis|cha>","weapon":{"name":"<short weapon name>","die":<4|6|8|10|12>,"count":<1|2>},"acArchetype":"<unarmored|mail|plate|light|mage|monk>","signature":"<bespoke ability name, max 24 chars>","role":"<one vivid sentence describing the fighter>","desc":"<short stat+ability summary, max 80 chars>"}
Chassis = the mechanical engine the signature ability runs on: rage=berserk melee, surge=extra attack, smite=slot→radiant burst, sneak=auto bonus damage striker, nuke=AoE blast caster, heal=support healer, chaos=random wild magic, flurry=multi-strike martial artist, curse=hex+blast warlock. Pick the chassis that best fits the name's vibe.
The "signature" MUST riff directly on the class name — pun on it, remix its words, or build the ability around its theme (e.g. name "kripps juicy butthole" -> "Buttjuice Tornado"; name "cheese wizard" -> "Gouda Nova"; name "sleepy cat" -> "Catnap Pounce"). Make it unmistakably derived from the name. The "weapon.name" and "desc" should match that theme too.
Stats use point-buy 8-17, total around 72. Be creative and funny with names/flavor but keep the numbers balanced.`

async function askJson(name: string): Promise<Record<string, unknown> | null> {
  if (!API_KEY) return null
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
        max_tokens: 320,
        system: CLASS_GEN_SYSTEM,
        messages: [{ role: 'user', content: `Class name: ${name}` }],
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) { log(`dnd: classgen ${res.status}`); return null }
    const data = await res.json() as { content?: { type: string; text: string }[] }
    let text = data.content?.[0]?.type === 'text' ? (data.content[0] as { text: string }).text.trim() : ''
    text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end < 0) return null
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch (e) {
    log(`dnd: classgen error: ${e}`)
    return null
  }
}

// Resolve a class name to a definition, generating + caching custom classes on the
// fly. Builtins and already-cached customs return instantly (no AI call). New custom
// names trigger one AI generation (or a deterministic fallback if AI is off/fails),
// then persist so every future join is free and identical.
export async function ensureClassDef(rawName: string): Promise<ClassDef> {
  const builtin = matchBuiltin(rawName)
  if (builtin) return builtin
  const norm = normClassName(rawName)
  if (hasClassDef(rawName)) return getClassDef(rawName)

  const raw = await askJson(rawName)
  const def = raw ? buildClassDef(rawName, raw) : syntheticDef(rawName)
  // re-check: a concurrent join may have cached it first; first write wins (INSERT OR IGNORE)
  db.saveClassDef(norm, def, raw ? 'ai' : 'synthetic')
  registerClassDef(def)
  return getClassDef(rawName)
}

export async function narrateFloor(
  floor: number,
  encounterType: EncounterType,
  enemies: { name: string; hp: number; maxHp: number }[],
  playerCount: number,
  nlLifted: boolean,
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
  const result = await ask(prompt, 72)
  if (!result) return `floor ${floor}: ${enemyStr} — roll for initiative. → !b a to attack · !b d to defend · !b spell for class ability`
  return result
}

export async function welcomePlayer(
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
  const result = await ask(prompt, 72)
  if (!result) return `@${username} descends as ${cls} — ${role}. → !b a to attack · !b spell to ${spellHint} · !b d to defend`
  return result
}

export async function narrateBoss(floor: number, bossName: string, bossHp: number, playerCount: number): Promise<string> {
  const soloNote = playerCount <= 1 ? ' One lone challenger steps forward.' : ` ${playerCount} challengers.`
  const prompt = `Twitch chat D&D. A BOSS appears on floor ${floor}: ${bossName} (${bossHp}HP).${soloNote}
Write ONE epic, hype boss-entrance line in Kripp's voice (170 chars max, lowercase, dramatic). Name the boss. End with: → !b a to attack · !b spell. No emojis.`
  const result = await ask(prompt, 80)
  return result
}

export async function describeFloor(floor: number, encounterType: EncounterType, enemies: string[]): Promise<string> {
  const enemyStr = enemies.length > 0 ? enemies.join(', ') : 'silence'
  const prompt = `Twitch chat D&D. Dungeon level ${floor} (${encounterType}). Enemies: ${enemyStr}.
Write ONE vivid dungeon atmosphere sentence, 150 chars max, lowercase, gritty D&D tone. No emojis. Just the sentence.`
  return await ask(prompt, 60)
}

export async function narrateVeganShrine(passed: boolean, username: string): Promise<string> {
  const prompt = passed
    ? `D&D dungeon. ${username} approaches an ancient shrine with no tainted goods. Write one sentence of mystical acceptance, 120 chars max, lowercase, reference purity and divine blessing.`
    : `D&D dungeon. ${username} approaches an ancient shrine carrying profane goods. Write one sentence of rejection, 120 chars max, lowercase, reference corruption and denied blessing.`
  const result = await ask(prompt, 50)
  if (!result) {
    return passed
      ? `the shrine pulses with pale light for @${username}. "worthy." a divine warmth fills the hall. full heal granted.`
      : `the shrine recoils from @${username}'s tainted pack. cold silence. the blessing is denied.`
  }
  return result
}

export async function narrateDeath(username: string, enemyName: string, floor: number): Promise<string> {
  const prompt = `D&D dungeon floor ${floor}. ${username} was just killed by ${enemyName}. Write one darkly poetic eulogy sentence, 140 chars max, lowercase, classic D&D tone. No emojis.`
  const result = await ask(prompt, 55)
  if (!result) return `@${username} has fallen to ${enemyName} on floor ${floor}. the dungeon claims another.`
  return result
}
