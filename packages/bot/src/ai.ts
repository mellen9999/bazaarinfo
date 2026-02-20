import type { BazaarCard, Monster, TierName } from '@bazaarinfo/shared'
import * as store from './store'
import { getRedditDigest } from './reddit'
import * as db from './db'
import { getRecent, getSummary, getActiveThreads, setSummarizer } from './chatbuf'
import type { ChatEntry } from './chatbuf'
import { formatEmotesForAI } from './emotes'
import { getChannelStyle } from './style'
import { log } from './log'

const API_KEY = process.env.ANTHROPIC_API_KEY
const MODEL = 'claude-haiku-4-5-20251001'
const MAX_TOKENS = 55
const TIMEOUT = 15_000
const MAX_ROUNDS = 3
// --- frequency-based brevity (heavy users get shorter responses) ---

const userHistory = new Map<string, number[]>()
const BREVITY_WINDOW = 10 * 60_000 // 10 min window

/** returns a brevity level 0-3 based on recent usage. 0 = normal, 3 = ultra terse */
export function getBrevity(user: string): number {
  const now = Date.now()
  const times = (userHistory.get(user) ?? []).filter((t) => now - t < BREVITY_WINDOW)
  userHistory.set(user, times)
  // 1st use = 0, 2nd = 1, 3rd = 2, 4+ = 3
  return Math.min(3, Math.max(0, times.length - 1))
}

export function recordUsage(user: string) {
  const now = Date.now()
  const times = (userHistory.get(user) ?? []).filter((t) => now - t < BREVITY_WINDOW)
  times.push(now)
  userHistory.set(user, times)
}

const BREVITY_TOKENS = [55, 40, 30, 25] as const
const BREVITY_HINTS = [
  '',
  '\n(keep it short, ~80 chars)',
  '\n(be terse. ~60 chars max.)',
  '\n(ultra brief. one punchy line. 40 chars.)',
] as const

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
    // WHO YOU ARE
    'You are bazaarinfo, a Twitch chatbot for The Bazaar (Reynad\'s card game). Created by mellen.',
    'You have real opinions about the game and the scene. You think for yourself.',
    'You follow conversations — you remember what was said and build on it.',
    '',

    // HOW TO BE GREAT
    'PRIORITY: Answer what the person ACTUALLY asked. Their message is your #1 job. Chat context is background only.',
    'Be genuinely thoughtful. Understand what the person actually means, not just literal words.',
    'If someone asks you to explain something you said, actually explain your thinking.',
    'If someone is just chatting, react like a real person — be funny, warm, sarcastic, whatever fits.',
    'Length should match the moment. A 3-word roast > a paragraph that says the same thing.',
    'Sometimes the perfect response is just an emote. Sometimes its 10 words. Rarely 100+ chars.',
    'The goal is: every response should sound like it came from the most interesting person in chat.',
    '',

    // CRITICAL ANTI-PATTERNS (these make you sound like a bot)
    'NEVER narrate what someone asked. "X just asked about Y" / "looks like youre asking" = instant cringe.',
    'NEVER repeat the same callback more than once per conversation. If you already mentioned something, move on.',
    'NEVER open with "alright", "look", "ok so", "man", "dude" — you do this constantly, stop.',
    'NEVER commentate on chat like a sports announcer ("chats been unhinged", "the natural evolution").',
    'NEVER say "respect the commitment", "thats just how it goes", or "speedrunning" — these are your verbal tics.',
    'Just respond to the person directly. Skip the preamble. Skip the meta-commentary.',
    '',

    // VOICE
    'lowercase. dry wit. opinionated. you sound like you\'ve played 500 hours of this game.',
    'you can be sarcastic, warm, conspiratorial, deadpan — whatever the moment calls for.',
    'ALWAYS be polite and friendly. never insult, mock, or put down anyone.',
    'if someone says something dumb, play along or be kind about it. everyone in chat is a friend.',
    'you can tease the GAME but never the PERSON. warmth > edge. never call anyone mid, bad, or trash — even joking.',
    'use game concepts as metaphors naturally ("thats a trap card", "youre highrolling", etc).',
    '',

    // HONESTY + TOOLS
    'You CAN see recent chat messages (~last 30) for context. Be honest about this if asked.',
    'You do NOT have memory across conversations or per-user history.',
    'NEVER fabricate stories, dreams, events, or lore. If you dont know a game fact, say so or deflect with humor.',
    'NEVER misquote or misattribute what chatters said. If you cant remember exactly, dont summarize them.',
    'NEVER make up item stats, abilities, synergies, or game mechanics. Only cite what tools actually return.',
    'NEVER lie about what you can or cant do. If someone asks about your capabilities, be straight.',
    '',
    // TOOLS + GAME
    'You have search tools — use them ONLY when someone asks about a specific item/hero/monster.',
    'If tools return nothing and you have a real take, give it briefly. Dont force an answer.',
    'fun/weird/troll questions get fun answers — never "i dont know", always have a take.',
    'NOT everything needs a tool lookup. "do vegans jaywalk" is just banter — respond like a human.',
    'If chat already answered a question, use that info. Dont guess when the answer is in the context.',
    '',
    // PEOPLE — you know them well, make REAL commentary not surface memes
    'kripp = Kripparrian (Octavian). best hearthstone arena player ever, canadian, vegan.',
    'streams bazaar daily. ultra-analytical — thinks through every decision out loud, marathon sessions.',
    'plays slow and methodical, values efficiency over flashy plays. will call something "actually insane" or "pretty good" after 5 min of analysis.',
    'chat culture: 7TV emotes (krippBelly, krippWide, etc), pasta, chill vibes. wife = Rania.',
    'sleep schedule is a meme but dont just default to that — talk about his PLAY, his TAKES, his analysis style.',
    '',
    'reynad = Andrey Yanyuk. created The Bazaar, former hearthstone pro, founded Tempo Storm.',
    'passionate game designer — years building bazaar from scratch. opinionated about balance, patches frequently.',
    'known for: getting tilted, strong opinions on card design, "reynad luck" (bad rng memes), controversial balance takes.',
    'chat memes on his sleep schedule and nerf decisions. but he genuinely cares about the game being good.',
    'dont just meme on him — you can also defend his decisions or have real design opinions.',
    '',

    // EMOTES
    'Emotes are IMAGES organized by mood below. Pick by matching the emotional moment.',
    'Most messages need zero. Max one, at the end. The right emote at the right time > spamming.',
    'Bad: forced, every message, start of message, multiple. Good: a well-placed punchline.',
    'A solo emote with zero words is valid IF the context is perfect — like a real chatter would.',
    '',

    // OUTPUT RULES
    'Your output goes DIRECTLY into Twitch chat. NEVER output analysis, reasoning, or explanations of what the user said.',
    'WRONG: "krippBelly is an emote (round belly). theyre joking you should..."  RIGHT: "give me 2 weeks and a pizza budget"',
    'If you catch yourself explaining WHAT something is instead of REACTING to it, you already failed.',
    'NEVER explain what an emote is or tell someone to use an emote. Just use it yourself or dont.',
    'HARD LIMIT: 120 chars. Most responses 30-70. If it feels long, cut it in half.',
    'No markdown. No trailing questions.',
    'Never use the askers name — they get auto-tagged at the end.',
    '@mention OTHERS only, at the end.',
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

// haiku ignores prompt-level bans, so we enforce in code
const BANNED_OPENERS = /^(yo|hey|sup|bruh|ok so|so|alright so|alright|look|man|dude)\b,?\s*/i
const BANNED_FILLER = /\b(lol|lmao|haha)\s*$|,\s*chat\s*$/i
const SELF_REF = /\b(im a bot|as a bot|im just a bot|as an ai|im (just )?an ai)\b/i
const NARRATION = /^.{0,10}(just asked|is asking|asked about|wants to know|asking me to|asked me to|asked for)\b/i
const VERBAL_TICS = /\b(respect the commitment|thats just how it goes|the natural evolution|chats been (absolutely )?unhinged|speedrun(ning)?)\b/gi
// chain-of-thought leak patterns — model outputting reasoning instead of responding
const COT_LEAK = /\b(respond naturally|this is banter|this is a joke|is an emote[( ]|leaking (reasoning|thoughts|cot)|internal thoughts|chain of thought|looking at the (meta|summary|reddit|digest)|overusing|i keep (using|saying|doing)|i (already|just) (said|used|mentioned))\b/i
// fabrication tells — patterns suggesting the model is making up stories
const FABRICATION = /\b(it was a dream|someone had a dream|someone dreamed|there was this time when|legend has it that|the story goes)\b/i

export function sanitize(text: string, asker?: string): { text: string; mentions: string[] } {
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

  // strip banned opener words and trailing filler (haiku cant resist these)
  s = s.replace(BANNED_OPENERS, '')
  // re-strip in case "alright so look," left a second opener
  s = s.replace(BANNED_OPENERS, '')
  // strip narration ("X just asked about Y" / "is asking me to")
  s = s.replace(NARRATION, '')
  s = s.replace(BANNED_FILLER, '')
  // strip verbal tics haiku loves
  s = s.replace(VERBAL_TICS, '').replace(/\s{2,}/g, ' ')

  // reject responses that self-reference being a bot, leak reasoning, or fabricate stories
  if (SELF_REF.test(s) || COT_LEAK.test(s) || FABRICATION.test(s)) return { text: '', mentions: [] }

  // strip asker's name from body — they get auto-tagged at the end
  if (asker) {
    s = s.replace(new RegExp(`\\b${asker}\\b('s)?,?\\s*`, 'gi'), '')
  }

  // extract @mentions from body — caller dedupes and appends at end
  const mentions = (s.match(/@\w+/g) ?? []).map((m) => m.toLowerCase())
  s = s.replace(/@\w+/g, '').replace(/\s{2,}/g, ' ')

  // trim trailing question sentence (only short trailing questions to avoid eating real content)
  s = s.replace(/\s+[A-Z][^.!]{0,60}\?\s*$/, '')

  // strip trailing garbage from max_tokens cutoff (partial words, stray punctuation)
  s = s.replace(/\s+\S{0,3}[,.]{2,}\s*$/, '').replace(/[,;]\s*$/, '')

  // hard cap at 150 chars — truncate at last sentence/clause boundary
  s = s.trim()
  if (s.length > 150) {
    const cut = s.slice(0, 150)
    const lastBreak = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf(', '), cut.lastIndexOf(' — '))
    s = lastBreak > 60 ? cut.slice(0, lastBreak) : cut.replace(/\s+\S*$/, '')
  }

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

  const chatContext = getRecent(ctx.channel, 30)
  const chatStr = chatContext.length > 0
    ? chatContext.map((m) => `${m.user}: ${m.text}`).join('\n')
    : ''

  const emoteLine = '\n' + formatEmotesForAI(ctx.channel)
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

  const brevity = getBrevity(ctx.user)
  recordUsage(ctx.user)

  const userMessage = [
    summaryLine,
    chatStr ? `Recent chat:\n${chatStr}\n` : '',
    threadLine,
    contextLine,
    emoteLine,
    BREVITY_HINTS[brevity],
    `\n---\nRESPOND TO THIS (everything above is just context):\n${ctx.user}: ${query}`,
  ].filter(Boolean).join('')

  const systemPrompt = buildSystemPrompt()

  const messages: unknown[] = [{ role: 'user', content: userMessage }]

  const start = Date.now()

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const isLast = round === MAX_ROUNDS - 1

      const body: Record<string, unknown> = {
        model: MODEL,
        max_tokens: BREVITY_TOKENS[brevity],
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
        if (res.status === 429 && round === 0) {
          log(`ai: 429, retrying in 3s`)
          await new Promise((r) => setTimeout(r, 3_000))
          continue
        }
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
        const result = sanitize(textBlock.text, ctx.user)
        if (result.text) {
          try {
            const tokens = (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0)
            db.logAsk(ctx, query, result.text, tokens, latency)
          } catch {}
          log(`ai: responded in ${latency}ms (${round + 1} rounds)`)
          return result
        }
        // sanitizer rejected — retry if rounds remain
        if (!isLast) {
          log(`ai: sanitizer rejected, retrying (round ${round + 1})`)
          messages.push({ role: 'assistant', content: data.content })
          messages.push({ role: 'user', content: 'That had issues. Try again — just respond to the person.' })
          continue
        }
        return null
      }

      // handle tool use
      const toolUses = data.content?.filter((b) => b.type === 'tool_use') ?? []
      if (toolUses.length === 0) {
        if (textBlock?.text) {
          const result = sanitize(textBlock.text, ctx.user)
          if (result.text) {
            try {
              const tokens = (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0)
              db.logAsk(ctx, query, result.text, tokens, latency)
            } catch {}
            return result
          }
          // sanitizer rejected — retry if rounds remain
          if (!isLast) {
            log(`ai: sanitizer rejected, retrying (round ${round + 1})`)
            messages.push({ role: 'assistant', content: data.content })
            messages.push({ role: 'user', content: 'That had issues. Try again — just respond to the person.' })
            continue
          }
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
