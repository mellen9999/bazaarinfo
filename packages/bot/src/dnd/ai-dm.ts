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
  Barbarian: 'raging front-liner who enters berserker fury for bonus damage and resistance',
  Fighter:   'martial champion with Action Surge for devastating double attacks',
  Paladin:   'divine warrior who channels spell slots into radiant smite damage',
  Rogue:     'cunning striker with automatic Sneak Attack extra damage dice',
  Wizard:    'arcane scholar who devastates groups with Fireball',
  Cleric:    'divine healer who keeps the party standing with Healing Word',
  Sorcerer:  'wild mage whose Chaos Bolt channels unpredictable magical power',
  Monk:      'disciplined martial artist spending ki for Flurry of Blows',
  Warlock:   'eldritch pactbinder who curses foes and blasts with dark energy',
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
  const role = CLASS_ROLE[cls] ?? cls
  const enemyStr = enemies.length > 0 ? enemies.join(', ') : 'shadows'
  const spellHint = (() => {
    switch (cls) {
      case 'Barbarian': return 'Rage (enter fury, +dmg+resistance)'
      case 'Fighter':   return 'Action Surge (attack twice)'
      case 'Paladin':   return 'Divine Smite (slot → radiant burst)'
      case 'Rogue':     return 'attack — Sneak Attack auto triggers'
      case 'Wizard':    return 'Fireball (8d6 to all enemies)'
      case 'Cleric':    return 'Healing Word (restore ally HP)'
      case 'Sorcerer':  return 'Wild Magic (chaos damage + surge)'
      case 'Monk':      return 'Flurry of Blows (ki → 2 extra strikes)'
      case 'Warlock':   return 'Hex + Eldritch Blast (curse + force bolt)'
      default:          return 'class ability'
    }
  })()
  const prompt = `Twitch chat D&D. @${username} descends as a ${cls} (${role}). Floor ${floor} (${encounterType}). Enemies: ${enemyStr}.
Write ONE welcoming line (160 chars max, lowercase, classic D&D dungeon tone). End with: !b a to attack · !b spell to use ${spellHint} · !b d to defend. No emojis.`
  const result = await ask(prompt, 72)
  if (!result) return `@${username} descends as ${cls} — ${role}. → !b a to attack · !b spell to ${spellHint} · !b d to defend`
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
