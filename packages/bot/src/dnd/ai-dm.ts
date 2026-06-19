import type { EncounterType } from './types'
import { log } from '../log'

const API_KEY = process.env.ANTHROPIC_API_KEY
const MODEL = 'claude-haiku-4-5-20251001'

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

const CLASS_ROLE: Record<string, string> = {
  Merchant: 'gold-hoarding economic powerhouse with shop discounts',
  Rogue: 'poison specialist who steals gold on kills',
  Tinkerer: 'item synergy expert whose gadgets hit harder with gear',
  Brawler: 'high-HP brute who charges for triple damage',
  Pyromancer: 'burn-everything fire mage with AoE inferno',
  Veteran: 'balanced fighter who copies enemy abilities',
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
    return `floor ${floor} — the merchant lays out their wares. inspect and buy wisely. → !b buy 1 · !b buy 2 · !b buy 3 · !b buy 4 · !b move to skip`
  }
  if (encounterType === 'event') {
    return `floor ${floor} — something stirs in the darkness. the depths have secrets. → !b explore to investigate`
  }
  if (alive.length === 0) {
    return `floor ${floor} is clear. the silence is eerie. → !b move to descend`
  }
  const enemyStr = alive.map((e) => `${e.name} (${e.hp}/${e.maxHp}HP)`).join(', ')
  const nlNote = nlLifted ? ' NL curse lifted — luck restored.' : ''
  const prompt = `Twitch chat D&D, Kripp's Bazaar Depths floor ${floor}.${nlNote} ${playerCount} adventurer(s) face: ${enemyStr}.
Write ONE tactical situation line (170 chars max, lowercase, dry RPG tone) that describes the threat and ends naturally with: → !b a to attack · !b d to defend · !b spell for your class ability. No emojis.`
  const result = await ask(prompt, 72)
  if (!result) return `floor ${floor}: ${enemyStr}. → !b a to attack · !b d to defend · !b spell for your class ability`
  return result
}

export async function welcomePlayer(
  username: string,
  cls: string,
  floor: number,
  encounterType: string,
  enemies: string[],
): Promise<string> {
  const role = CLASS_ROLE[cls] ?? cls
  const enemyStr = enemies.length > 0 ? enemies.join(', ') : 'none yet'
  const spellHint = cls === 'Brawler' ? 'Charge (3x dmg)' : cls === 'Pyromancer' ? 'Inferno (AoE burn)' : cls === 'Rogue' ? 'Shadowstrike (crit+poison)' : cls === 'Merchant' ? 'Liquidate (sell item for dmg)' : cls === 'Tinkerer' ? 'Overclock (+50% item power)' : 'Adapt (copy enemy ability)'
  const prompt = `Twitch chat D&D. @${username} descends into Kripp's Bazaar Depths as a ${cls} (${role}). Floor ${floor} (${encounterType}). Enemies: ${enemyStr}.
Write ONE welcoming sentence (160 chars max, lowercase) introducing their class role briefly, and ending with: type !b a to attack · !b spell to ${spellHint} · !b d to defend. No emojis.`
  const result = await ask(prompt, 72)
  if (!result) return `@${username} descends as a ${cls} — ${role}. → !b a to attack · !b spell to ${spellHint} · !b d to defend`
  return result
}

export async function describeFloor(floor: number, encounterType: EncounterType, enemies: string[]): Promise<string> {
  const enemyStr = enemies.length > 0 ? enemies.join(', ') : 'none'
  const prompt = `Twitch chat D&D. Kripp's Bazaar Depths, floor ${floor} (${encounterType}).
Enemies present: ${enemyStr}.
Write ONE vivid dungeon atmosphere sentence, 150 chars max, lowercase, dry RPG tone. May reference RNG, vegan streamer, "classic", or bazaar market lore. No emojis. Just the sentence.`
  return await ask(prompt, 60)
}

export async function narrateVeganShrine(passed: boolean, username: string): Promise<string> {
  const prompt = passed
    ? `Twitch chat D&D. Player ${username} approaches the Vegan Shrine with a clean inventory. Write one sentence of mystical approval, 120 chars max, lowercase, reference veganism and RNG blessing.`
    : `Twitch chat D&D. Player ${username} approaches the Vegan Shrine but has meat items. Write one sentence of rejection, 120 chars max, lowercase, reference carnivore shame and missed blessing.`
  const result = await ask(prompt, 50)
  if (!result) {
    return passed
      ? `the vegan shrine glows for @${username}. a true believer. full heal granted.`
      : `the vegan shrine recoils from @${username}'s meat-tainted inventory. carnivore detected. nothing happens.`
  }
  return result
}

export async function narrateDeath(username: string, enemyName: string, floor: number): Promise<string> {
  const prompt = `Twitch chat D&D, Kripp's Bazaar Depths floor ${floor}. Player ${username} was just killed by ${enemyName}. Write one darkly funny eulogy sentence, 140 chars max, lowercase, Kripp/RNG/bazaar flavor. No emojis.`
  const result = await ask(prompt, 55)
  if (!result) return `@${username} has fallen to ${enemyName} on floor ${floor}. the depths claim another.`
  return result
}
