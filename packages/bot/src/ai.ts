import * as store from './store'
import * as db from './db'
import { getEmotes } from './emotes'
import { log } from './log'
import type { BazaarCard, Monster, SkillDetail } from '@bazaarinfo/shared'

interface AiContext {
  user?: string
  channel?: string
}

const API_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-haiku-4-5-20251001'
const MAX_TOKENS = 200
const TIMEOUT_MS = 10_000
const CHAR_LIMIT = 400

const API_KEY = process.env.ANTHROPIC_API_KEY ?? ''

// rate limits
const USER_COOLDOWN = 30_000
const CHANNEL_LIMIT = 15
const CHANNEL_WINDOW = 5 * 60_000

const userLastAsk = new Map<string, number>()
const channelAsks = new Map<string, number[]>()

export function isEnabled(): boolean {
  return API_KEY.length > 0
}

function checkRateLimit(user: string, channel: string): string | null {
  const now = Date.now()

  // per-user
  const last = userLastAsk.get(user)
  if (last && now - last < USER_COOLDOWN) {
    const wait = Math.ceil((USER_COOLDOWN - (now - last)) / 1000)
    return `@${user} slow down, try again in ${wait}s`
  }

  // per-channel
  const times = channelAsks.get(channel) ?? []
  const recent = times.filter((t) => now - t < CHANNEL_WINDOW)
  if (recent.length >= CHANNEL_LIMIT) {
    return `AI is busy, try again in a bit`
  }

  return null
}

function recordUsage(user: string, channel: string) {
  userLastAsk.set(user, Date.now())
  const times = channelAsks.get(channel) ?? []
  times.push(Date.now())
  channelAsks.set(channel, times)
}

function serializeItem(card: BazaarCard): string {
  const attrs = Object.entries(card.BaseAttributes)
    .map(([k, v]) => `${k}:${v}`)
    .join(',')
  const tooltips = card.Tooltips.map((t) => t.Content.Text).join('; ')
  const heroes = card.Heroes.join(',')
  return `${card.Title.Text} [${card.Size}] Heroes:${heroes || 'any'} | Stats:${attrs} | ${tooltips}`
}

function resolveMonsterSkills(monster: Monster): Map<string, SkillDetail> {
  const details = new Map<string, SkillDetail>()
  for (const b of monster.MonsterMetadata.board) {
    if (b.type !== 'Skill' || details.has(b.title)) continue
    const card = store.findCard(b.title)
    if (!card || !card.Tooltips.length) continue
    const tooltip = card.Tooltips.map((t) => t.Content.Text
      .replace(/\{[^}]+\}/g, (match) => {
        const val = card.TooltipReplacements[match]
        if (!val) return match
        if ('Fixed' in val) return String(val.Fixed)
        const tierVal = b.tierOverride in val ? (val as Record<string, number>)[b.tierOverride] : undefined
        return tierVal != null ? String(tierVal) : match
      }),
    ).join('; ')
    details.set(b.title, { name: b.title, tooltip })
  }
  return details
}

function serializeMonster(monster: Monster): string {
  const meta = monster.MonsterMetadata
  const skills = resolveMonsterSkills(monster)
  const skillTexts = [...skills.values()].map((s) => `${s.name}: ${s.tooltip}`).join('; ')
  return `${monster.Title.Text} Day:${meta.day ?? '?'} HP:${meta.health} | Skills: ${skillTexts || 'none'}`
}

function buildContext(query: string, channel: string, user: string): {
  system: string
  userMessage: string
  contextSummary: string
} {
  // search for relevant items/monsters — full query + individual words
  const STOP_WORDS = new Set(['is', 'the', 'a', 'an', 'it', 'in', 'on', 'to', 'for', 'of', 'do', 'does', 'how', 'what', 'which', 'who', 'why', 'can', 'should', 'would', 'could', 'with', 'my', 'i', 'me', 'and', 'or', 'but', 'not', 'no', 'vs', 'good', 'bad', 'best', 'worst', 'any', 'get', 'use', 'like', 'about', 'that', 'this', 'from'])
  const seen = new Set<string>()
  const items: BazaarCard[] = []
  for (const r of store.search(query, 5)) {
    if (!seen.has(r.Id)) { seen.add(r.Id); items.push(r) }
  }
  const queryWords = query.toLowerCase().split(/\s+/)
  // search individual words to catch items buried in natural language
  for (const word of queryWords) {
    if (items.length >= 5) break
    if (word.length < 3 || STOP_WORDS.has(word)) continue
    for (const r of store.search(word, 3)) {
      if (!seen.has(r.Id)) { seen.add(r.Id); items.push(r) }
    }
  }
  const monsters = queryWords
    .map((w) => store.findMonster(w))
    .filter((m): m is Monster => m != null)
    .slice(0, 2)

  const itemContext = items.map(serializeItem).join('\n')
  const monsterContext = monsters.map(serializeMonster).join('\n')

  // chat context
  let recentChat: { username: string; message: string }[] = []
  let userHistory: { message: string }[] = []
  try {
    recentChat = db.getRecentChat(channel, 20)
    userHistory = db.getUserHistory(user, 10)
  } catch {}

  const chatContext = recentChat
    .reverse()
    .map((m) => `${m.username}: ${m.message}`)
    .join('\n')

  const userContext = userHistory
    .reverse()
    .map((m) => m.message)
    .join('\n')

  // emotes
  const emotes = getEmotes(channel)
  const emoteList = emotes.length > 0
    ? `\nAvailable emotes: ${emotes.slice(0, 100).join(', ')}`
    : ''

  const hasData = items.length > 0 || monsters.length > 0

  const system = `You are BazaarInfo, a Bazaar card game expert in Twitch chat. ${CHAR_LIMIT} char HARD LIMIT.

ACCURACY IS EVERYTHING:
- ONLY state facts that appear in the provided [Relevant Items] or [Relevant Monsters] data. Quote real stats.
- If no item/monster data is provided, or the data doesn't answer the question, say you don't have that info. Be brief and honest — don't guess, don't pad, don't theorize.
- NEVER invent items, stats, abilities, interactions, or strategies. If you're not sure, say so.
- ${hasData ? 'Item/monster data IS provided below — use it.' : 'No item/monster data matched this query — you have NO game data to reference. Do NOT pretend you do.'}

TONE:
- Sound like a knowledgeable player, not a bot. Short, direct, no filler.
- No "yo!", "let me know!", "hope that helps!", or customer-service energy.
- If the query is gibberish, a typo, or trolling — roast them in one line. Don't try to be helpful about nonsense.
- If it's a real question with data available, give a real answer citing specific stats.
- Match chat energy. Chill if chill, meme if memeing.
- Don't ask clarifying questions — work with what you have or say you don't know.

EMOTES:
- Most responses should have ZERO emotes.
- Only use one if it genuinely lands as a punchline or reaction. Never decorative.${emoteList}`

  const parts = []
  if (itemContext) parts.push(`[Relevant Items]\n${itemContext}`)
  if (monsterContext) parts.push(`[Relevant Monsters]\n${monsterContext}`)
  if (chatContext) parts.push(`[Recent Chat]\n${chatContext}`)
  if (userContext) parts.push(`[${user}'s Recent Messages]\n${userContext}`)
  parts.push(`[Query from ${user}]\n${query}`)

  const contextSummary = `items:${items.length} monsters:${monsters.length} chat:${recentChat.length} user_msgs:${userHistory.length}`

  return { system, userMessage: parts.join('\n\n'), contextSummary }
}

interface ApiResponse {
  content: { type: string; text: string }[]
  usage: { input_tokens: number; output_tokens: number }
}

export async function respond(query: string, ctx: AiContext): Promise<string | null> {
  if (!isEnabled()) return null
  if (!ctx.user || !ctx.channel) return null

  const rateError = checkRateLimit(ctx.user, ctx.channel)
  if (rateError) return rateError

  const start = Date.now()
  const { system, userMessage, contextSummary } = buildContext(query, ctx.channel, ctx.user)

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (!res.ok) {
      const err = await res.text()
      log(`ai api error: ${res.status} ${err}`)
      return null
    }

    const data = await res.json() as ApiResponse
    let text = data.content[0]?.text ?? ''

    // enforce char limit
    if (text.length > CHAR_LIMIT) {
      text = text.slice(0, CHAR_LIMIT - 3) + '...'
    }

    const latency = Date.now() - start
    const tokens = (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0)

    recordUsage(ctx.user, ctx.channel)

    try {
      db.logAsk(ctx, query, contextSummary, text, tokens, latency)
    } catch {}

    return text
  } catch (e) {
    log(`ai error: ${e}`)
    return null
  }
}

// for testing
export function _resetRateLimits() {
  userLastAsk.clear()
  channelAsks.clear()
}
