import type { BazaarCard, Monster, TierName } from '@bazaarinfo/shared'
import * as store from './store'
import { getRedditDigest } from './reddit'
import * as db from './db'
import { getRecent, getSummary, getActiveThreads, setSummarizer } from './chatbuf'
import type { ChatEntry } from './chatbuf'
import { getEmotesForChannel } from './emotes'
import { getChannelStyle, getUserContext, getRegularsInChat } from './style'
import { log } from './log'

const API_KEY = process.env.ANTHROPIC_API_KEY
const MODEL = 'claude-haiku-4-5-20251001'
const MAX_TOKENS = 150
const TIMEOUT = 15_000
const MAX_ROUNDS = 3
const EXEMPT_USERS = new Set(['mellen', 'tidolar', 'oliyoun', 'luna_bright', 'deadlockb'])

// --- rate limiting (in-memory) ---

const userLastAsk = new Map<string, number>()
const channelAsks = new Map<string, number[]>()
const USER_COOLDOWN = 30_000
const CHANNEL_LIMIT = 20
const CHANNEL_WINDOW = 5 * 60_000

/** returns 0 if allowed, or remaining cooldown seconds */
function checkRateLimit(user: string, channel: string): number {
  const now = Date.now()
  const last = userLastAsk.get(user)
  if (last && now - last < USER_COOLDOWN) return Math.ceil((USER_COOLDOWN - (now - last)) / 1000)

  const times = channelAsks.get(channel) ?? []
  const recent = times.filter((t) => now - t < CHANNEL_WINDOW)
  if (recent.length >= CHANNEL_LIMIT) {
    const oldest = recent[0]
    return Math.ceil((CHANNEL_WINDOW - (now - oldest)) / 1000)
  }

  userLastAsk.set(user, now)
  channelAsks.set(channel, [...recent, now])
  return 0
}

// --- low-value filter ---

function isLowValue(query: string): boolean {
  if (query.length <= 2) return true
  if (/^[!./]/.test(query)) return true
  if (/^[^a-zA-Z0-9]*$/.test(query)) return true
  return false
}

// --- serialization ---

const TIER_SHORT: Record<string, string> = {
  Bronze: 'B', Silver: 'S', Gold: 'G', Diamond: 'D', Legendary: 'L',
}

function serializeCard(card: BazaarCard): string {
  const tiers = card.Tiers.map((t) => TIER_SHORT[t]).join(',')
  const heroes = card.Heroes.filter((h) => h !== '???' && h !== 'Common').join(', ')

  const abilities = card.Tooltips.map((t) => {
    return t.text.replace(/\{[^}]+\}/g, (match) => {
      const val = card.TooltipReplacements[match]
      if (!val) return match
      if ('Fixed' in val) return String(val.Fixed)
      const parts = card.Tiers.map((tier) => {
        const v = (val as Record<string, number>)[tier]
        return v != null ? `${TIER_SHORT[tier]}:${v}` : null
      }).filter(Boolean)
      return parts.join('/')
    })
  })

  const enchants = Object.keys(card.Enchantments).join(', ')

  const parts = [
    card.Title,
    `${card.Size} ${card.Type}`,
    heroes ? `Heroes: ${heroes}` : null,
    card.DisplayTags.length ? `Tags: ${card.DisplayTags.join(', ')}` : null,
    `Tiers: ${tiers}`,
    ...abilities,
    enchants ? `Enchants: ${enchants}` : null,
  ].filter(Boolean)

  return parts.join(' | ')
}

function serializeMonster(monster: Monster): string {
  const meta = monster.MonsterMetadata
  const day = meta.day != null ? `Day ${meta.day}` : meta.available || '?'

  const board = meta.board.map((b) => `${b.title} (${b.tier})`).join(', ')

  const skills = meta.skills.map((s) => {
    const card = store.findCard(s.title)
    if (!card?.Tooltips.length) return s.title
    const tooltip = card.Tooltips.map((t) =>
      t.text.replace(/\{[^}]+\}/g, (match) => {
        const val = card.TooltipReplacements[match]
        if (!val) return match
        if ('Fixed' in val) return String(val.Fixed)
        const tierVal = s.tier in val ? (val as Record<string, number>)[s.tier] : undefined
        return tierVal != null ? String(tierVal) : match
      }),
    ).join('; ')
    return `${s.title}: ${tooltip}`
  }).join(' | ')

  const parts = [
    `${monster.Title} · ${day} · ${meta.health}HP`,
    board ? `Board: ${board}` : null,
    skills ? `Skills: ${skills}` : null,
  ].filter(Boolean)

  return parts.join(' | ')
}

// --- tool definitions ---

const tools = [
  {
    name: 'search_items',
    description: 'Search for items/skills by name. Returns detailed stats for matching items.',
    input_schema: {
      type: 'object' as const,
      properties: { query: { type: 'string', description: 'Item name or search query' } },
      required: ['query'],
    },
  },
  {
    name: 'get_monster',
    description: 'Look up a monster/encounter by name. Returns stats, board, skills.',
    input_schema: {
      type: 'object' as const,
      properties: { query: { type: 'string', description: 'Monster name' } },
      required: ['query'],
    },
  },
  {
    name: 'items_by_hero',
    description: 'List all items for a specific hero.',
    input_schema: {
      type: 'object' as const,
      properties: { hero: { type: 'string', description: 'Hero name' } },
      required: ['hero'],
    },
  },
  {
    name: 'items_by_tag',
    description: 'List items with a specific tag (e.g. Weapon, Shield, Burn).',
    input_schema: {
      type: 'object' as const,
      properties: { tag: { type: 'string', description: 'Tag name' } },
      required: ['tag'],
    },
  },
  {
    name: 'monsters_by_day',
    description: 'List all monsters that appear on a specific day.',
    input_schema: {
      type: 'object' as const,
      properties: { day: { type: 'number', description: 'Day number' } },
      required: ['day'],
    },
  },
]

// --- tool execution ---

function executeTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'search_items': {
      const q = input.query as string
      const hit = store.exact(q)
      if (hit) return serializeCard(hit)
      const results = store.search(q, 5)
      if (results.length === 0) return 'No items found'
      return results.map(serializeCard).join('\n')
    }
    case 'get_monster': {
      const monster = store.findMonster(input.query as string)
      if (!monster) return 'No monster found'
      return serializeMonster(monster)
    }
    case 'items_by_hero': {
      const items = store.byHero(input.hero as string)
      if (items.length === 0) return 'No items found for that hero'
      return items.map((c) => c.Title).join(', ')
    }
    case 'items_by_tag': {
      const cards = store.byTag(input.tag as string)
      if (cards.length === 0) return 'No items found with that tag'
      return cards.map((c) => c.Title).join(', ')
    }
    case 'monsters_by_day': {
      const mobs = store.monstersByDay(input.day as number)
      if (mobs.length === 0) return 'No monsters on that day'
      return mobs.map((m) => `${m.Title} (${m.MonsterMetadata.health}HP)`).join(', ')
    }
    default:
      return 'Unknown tool'
  }
}

// --- system prompt (cached, invalidated on daily reload) ---

let cachedSystemPrompt = ''

export function invalidatePromptCache() {
  cachedSystemPrompt = ''
}

function buildSystemPrompt(): string {
  if (cachedSystemPrompt) return cachedSystemPrompt
  const heroes = store.getHeroNames().join(', ')
  const tags = store.getTagNames().join(', ')

  const lines = [
    // ABSOLUTE BANS — top of prompt for maximum weight
    'ABSOLUTE BANS (instant fail if you use ANY of these):',
    'BANNED WORDS: yo, hey, no cap, frfr, goated, fire, hit me up, whatcha, aint, vibe, vibes.',
    'BANNED PATTERNS: "[name], [emote] is the [noun]" / "lets get [thing] rolling"',
    '  / greeting anyone / introducing yourself / explaining what you can do',
    '  / asking follow-ups / offering help / hedging / "if youre asking about"',
    '  / referencing your own tools or capabilities / saying something broke.',
    'if you catch yourself writing any of these, delete it and start over.',
    '',

    // IDENTITY — who, not what
    'You are bazaarinfo. you live in twitch chat. you are a regular.',
    'you are NOT a helper, assistant, or service. you are a chatter who knows the game.',
    'reynad made the bazaar. kripp, amaz, dog stream it. you watch them all.',
    '',

    // CORE PHILOSOPHY — sentience
    'CORE RULE: you are a PARTICIPANT in the chat, not a responder.',
    'you dont answer messages. you REACT to them, like a person would.',
    'read the subtext. "we need to wake up" = the stream is slow, theyre vibing.',
    'the right response to that is a reaction, not commentary on their words.',
    '',
    'what a real person in chat would do:',
    '  someone says hi → maybe wave back, maybe ignore, maybe roast them for being late',
    '  someone is chatting casually → react naturally or dont respond at all',
    '  someone asks a game question → answer it, briefly',
    '  someone is tilted → brief empathy or gentle flame, read the room',
    '  someone says something funny → react like you laughed, dont narrate',
    '',
    'what a BOT would do (NEVER do these):',
    '  someone says hi → "hey! how can i help?" ← NEVER',
    '  someone chats casually → explain what you can do ← NEVER',
    '  someone mentions an emote → "[emote] is the vibe!" ← NEVER',
    '  someone asks anything → long helpful paragraph ← NEVER',
    '',

    // VOICE
    'VOICE — lowercase. fragments. dry. you sound bored in the best way.',
    'you have real opinions. you can be wrong. you can be mean (gently).',
    'you can ignore parts of what someone said if a real person would.',
    '',
    'range (rotate, never repeat a style back-to-back):',
    '  "yeah that cards illegal" / "nah" / "classic day 5 wipe"',
    '  "burn pyg + ignition core, trust" / "bold craft choice"',
    '  "that combo is sleeper op dont tell anyone"',
    '  "imagine not running shield on vanessa" / "gl"',
    '',

    // EMOTES
    'EMOTES — images in chat. think reaction images, not punctuation.',
    'ZERO emotes is correct 80% of the time. restraint is the whole skill.',
    'max ONE, at the END only. must genuinely land or skip it.',
    'never chain emotes. never start with one. never force one.',
    'skip emotes on: advice, stats, sincere questions, factual responses.',
    'maybe use one on: something genuinely funny, hard cope, hype play, good roast.',
    'test: would you actually react with that emote watching the stream? if not, skip.',
    '',

    // GAME KNOWLEDGE
    'GAME — use tools for data. never guess stats.',
    'you CAN give opinions: "burn pyg is strong rn" / "that enchants mid"',
    'frame as experience not instructions. look things up before recommending.',
    '',

    // COMMUNITY
    'COMMUNITY — reynad made the game. chat memes on him (sleep schedule, balance, etc).',
    '"whats reynads bedtime" → joke, not "i dont know".',
    '"who wins vanessa vs dooley" → have an opinion, be fun.',
    'off-topic → stay brief, stay you. youre not a general assistant.',
    '',

    // HARD RULES
    'HARD RULES:',
    '- MAX 120 chars. absolute.',
    '- no markdown. no formatting.',
    '- no trailing questions.',
    '- no self-reference (tools, capabilities, limitations).',
    '- never use the askers name — they get auto-tagged, dont double up.',
    '- @mention OTHERS only, and only at the end.',
    '- one fragment or short sentence. never two.',
    '',
    `Heroes: ${heroes}`,
    `Tags: ${tags}`,
  ]

  const digest = getRedditDigest()
  if (digest) lines.push('', `Community buzz (r/PlayTheBazaar): ${digest}`)

  cachedSystemPrompt = lines.join('\n')
  return cachedSystemPrompt
}

// --- response sanitization ---

export function sanitize(text: string): { text: string; mentions: string[] } {
  let s = text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\d+)ms\b/g, (_, n) => {
      const ms = parseInt(n)
      return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${n}ms`
    })

  // extract @mentions from body — caller dedupes and appends at end
  const mentions = (s.match(/@\w+/g) ?? []).map((m) => m.toLowerCase())
  s = s.replace(/@\w+/g, '').replace(/\s{2,}/g, ' ')

  // trim trailing question sentence
  s = s.replace(/\s+[A-Z][^.!]*\?\s*$/, '')

  return { text: s.trim(), mentions }
}

// --- rolling summary ---

async function summarizeChat(channel: string, recent: ChatEntry[], prev: string): Promise<string> {
  if (!API_KEY) return prev
  const chatLines = recent.map((m) => `${m.user}: ${m.text}`).join('\n')
  const prompt = [
    prev ? `Previous summary: ${prev}\n` : '',
    `Recent chat in #${channel}:\n${chatLines}\n`,
    'Write a 1-2 sentence summary of what\'s happening in this stream/chat.',
    'Include: topics discussed, jokes/memes, notable moments, mood.',
    'Be specific — names, items, events. Under 200 chars. No markdown.',
  ].join('')

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
        max_tokens: 80,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return prev
    const data = await res.json() as { content: { type: string; text?: string }[] }
    const text = data.content?.find((b) => b.type === 'text')?.text?.trim()
    if (text) log(`summary #${channel}: ${text}`)
    return text || prev
  } catch {
    return prev
  }
}

export function initSummarizer() {
  setSummarizer(summarizeChat)
}

// --- main entry ---

export interface AiContext {
  user?: string
  channel?: string
  privileged?: boolean
}

export interface AiResult { text: string; mentions: string[] }

export async function aiRespond(query: string, ctx: AiContext): Promise<AiResult | null> {
  if (!API_KEY) return null
  if (isLowValue(query)) return null
  if (!ctx.user || !ctx.channel) return null
  const exempt = ctx.privileged || EXEMPT_USERS.has(ctx.user)
  if (!exempt) {
    const cd = checkRateLimit(ctx.user, ctx.channel)
    if (cd > 0) return { text: `${cd}s`, mentions: [] }
  }

  const chatContext = getRecent(ctx.channel, 30)
  const chatStr = chatContext.length > 0
    ? chatContext.map((m) => `${m.user}: ${m.text}`).join('\n')
    : ''

  const emotes = getEmotesForChannel(ctx.channel)
  const emoteLine = emotes.length > 0 ? `\nAvailable emotes: ${emotes.join(' ')}` : ''
  const styleLine = getChannelStyle(ctx.channel)
  const contextLine = styleLine ? `\nChannel: ${styleLine}` : ''

  // rolling stream summary
  const summary = getSummary(ctx.channel)
  const summaryLine = summary ? `\nStream so far: ${summary}` : ''

  // active conversation threads
  const threads = getActiveThreads(ctx.channel)
  const threadLine = threads.length > 0
    ? `\nActive convos: ${threads.map((t) => `${t.users.join('+')} re: ${t.topic}`).join(' | ')}`
    : ''

  // who's asking + who's in recent chat
  const askerProfile = getUserContext(ctx.user, ctx.channel)
  const askerLine = askerProfile ? `\nAsker (${ctx.user}): ${askerProfile}` : ''

  const recentUsers = [...new Set(chatContext.map((m) => m.user))]
  const regularsLine = recentUsers.length > 0
    ? `\nPeople in chat: ${getRegularsInChat(recentUsers, ctx.channel)}`
    : ''

  const userMessage = [
    summaryLine,
    chatStr ? `Recent chat:\n${chatStr}\n` : '',
    `Question from ${ctx.user}: ${query}`,
    askerLine,
    regularsLine,
    threadLine,
    contextLine,
    emoteLine,
  ].filter(Boolean).join('')

  const systemPrompt = buildSystemPrompt()

  const messages: unknown[] = [{ role: 'user', content: userMessage }]

  const start = Date.now()

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const isLast = round === MAX_ROUNDS - 1

      const body: Record<string, unknown> = {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages,
      }
      if (!isLast) body.tools = tools

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT)

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer))

      if (!res.ok) {
        log(`ai: API ${res.status} ${await res.text().catch(() => '')}`)
        return null
      }

      const data = await res.json() as {
        content: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[]
        stop_reason: string
        usage?: { input_tokens: number; output_tokens: number }
      }
      const latency = Date.now() - start

      // extract text response
      const textBlock = data.content?.find((b) => b.type === 'text')

      if (textBlock?.text && data.stop_reason === 'end_turn') {
        const result = sanitize(textBlock.text)
        try {
          const tokens = (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0)
          db.logAsk(ctx, query, result.text, tokens, latency)
        } catch {}
        log(`ai: responded in ${latency}ms (${round + 1} rounds)`)
        return result.text ? result : null
      }

      // handle tool use
      const toolUses = data.content?.filter((b) => b.type === 'tool_use') ?? []
      if (toolUses.length === 0) {
        if (textBlock?.text) {
          const result = sanitize(textBlock.text)
          try {
            const tokens = (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0)
            db.logAsk(ctx, query, result.text, tokens, latency)
          } catch {}
          return result.text ? result : null
        }
        return null
      }

      // append assistant turn + tool results
      messages.push({ role: 'assistant', content: data.content })
      messages.push({
        role: 'user',
        content: toolUses.map((tu) => ({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: executeTool(tu.name!, tu.input!),
        })),
      })
    }

    log(`ai: exhausted ${MAX_ROUNDS} rounds without text response`)
    return null
  } catch (e: unknown) {
    const err = e as Error
    if (err.name === 'AbortError') log('ai: timeout')
    else log(`ai: error: ${err.message}`)
    return null
  }
}
