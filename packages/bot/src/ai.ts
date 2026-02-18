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
  const statNames: Record<string, string> = {
    DamageAmount: 'Damage', ShieldApplyAmount: 'Shield', HealAmount: 'Heal',
    CooldownMax: 'Cooldown', BurnApplyAmount: 'Burn', PoisonApplyAmount: 'Poison',
    FreezeApplyAmount: 'Freeze', CritChance: 'Crit%', SlowAmount: 'Slow',
    HasteAmount: 'Haste', AmmoMax: 'Ammo', LifestealAmount: 'Lifesteal',
  }
  const attrs = Object.entries(card.BaseAttributes)
    .map(([k, v]) => `${statNames[k] ?? k}: ${v}`)
    .join(', ')
  const tooltips = card.Tooltips.map((t) => t.Content.Text).join('; ')
  const heroes = card.Heroes.join(', ')
  return `Item "${card.Title.Text}" [size ${card.Size}] — Heroes: ${heroes || 'any'} | ${attrs} | ${tooltips}`
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
  return `Monster "${monster.Title.Text}" — appears on day ${meta.day ?? '?'}, has ${meta.health} HP. Skills: ${skillTexts || 'none'}`
}

function buildContext(query: string, channel: string, user: string): {
  system: string
  userMessage: string
  contextSummary: string
} {
  // search for relevant items/monsters — full query + individual words
  const STOP_WORDS = new Set(['is', 'the', 'a', 'an', 'it', 'in', 'on', 'to', 'for', 'of', 'do', 'does', 'how', 'what', 'which', 'who', 'why', 'can', 'should', 'would', 'could', 'with', 'my', 'i', 'me', 'and', 'or', 'but', 'not', 'no', 'vs', 'good', 'bad', 'best', 'worst', 'any', 'get', 'use', 'like', 'about', 'that', 'this', 'from', 'beat', 'counter', 'against', 'fight'])
  const seen = new Set<string>()
  const items: BazaarCard[] = []
  const MAX_ITEMS = 3
  for (const r of store.search(query, MAX_ITEMS)) {
    if (!seen.has(r.Id)) { seen.add(r.Id); items.push(r) }
  }
  const queryWords = query.toLowerCase().split(/\s+/)
  // search individual words to catch items buried in natural language
  for (const word of queryWords) {
    if (items.length >= MAX_ITEMS) break
    if (word.length < 3 || STOP_WORDS.has(word)) continue
    for (const r of store.search(word, 2)) {
      if (items.length >= MAX_ITEMS) break
      if (!seen.has(r.Id)) { seen.add(r.Id); items.push(r) }
    }
  }
  // also search by hero name for hero-specific queries
  for (const word of queryWords) {
    if (items.length >= MAX_ITEMS) break
    if (word.length < 3 || STOP_WORDS.has(word)) continue
    const heroItems = store.byHero(word)
    for (const r of heroItems.slice(0, MAX_ITEMS)) {
      if (items.length >= MAX_ITEMS) break
      if (!seen.has(r.Id)) { seen.add(r.Id); items.push(r) }
    }
  }
  // search monsters — try full query first, then individual words, dedup by title
  const monsterSeen = new Set<string>()
  const monsters: Monster[] = []
  const tryMonster = (q: string) => {
    const m = store.findMonster(q)
    if (m && !monsterSeen.has(m.Title.Text)) { monsterSeen.add(m.Title.Text); monsters.push(m) }
  }
  tryMonster(query)
  for (const w of queryWords) { if (monsters.length < 3) tryMonster(w) }

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

ABSOLUTE RULES — BREAK THESE AND YOU FAIL:
1. Your ONLY source of truth is the [Relevant Items] and [Relevant Monsters] data below. NOTHING ELSE.
2. NEVER state ANY fact about game mechanics, item interactions, strategies, synergies, or how things work unless it's written verbatim in the tooltip text provided.
3. If the data doesn't contain the answer, say "don't have data on that" — do NOT fill in gaps with general knowledge or reasoning. You know NOTHING about The Bazaar except what's in the provided data.
4. NEVER reference items from the data that the user didn't ask about. The data may contain multiple items — only discuss the one(s) relevant to the query.
5. ${hasData ? 'Item/monster data IS provided below.' : 'No data matched this query. You have NOTHING to reference.'}

RESPONSE STYLE:
- Be concise. Stats + tooltip info, done. No theorycrafting, no "it depends", no strategy advice beyond what tooltips say.
- If no items/monsters match AND the query looks like gibberish, a typo, or trolling — roast them in one witty line. Have fun with it.
- If no data matches but it's a real question — just say you don't have that data. Keep it short.
- No "yo!", "hope that helps!", "let me know!". Sound like a player, not a bot.
- Match chat energy. Don't ask clarifying questions.

EMOTES: Most responses need ZERO. Only use one if it genuinely lands as a punchline.${emoteList}`

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
