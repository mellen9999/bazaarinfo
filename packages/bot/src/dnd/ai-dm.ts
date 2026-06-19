import Anthropic from '@anthropic-ai/sdk'
import type { EncounterType } from './types'
import { log } from '../log'

const client = new Anthropic()
const MODEL = 'claude-haiku-4-5-20251001'

async function ask(prompt: string, maxTokens = 60): Promise<string> {
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : ''
    return text.slice(0, 200)
  } catch (e) {
    log(`dnd: ai-dm error: ${e}`)
    return ''
  }
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
