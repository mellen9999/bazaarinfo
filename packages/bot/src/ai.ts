import type { BazaarCard, Monster } from '@bazaarinfo/shared'
import * as store from './store'
import { getRedditDigest } from './reddit'
import { getActivityFor } from './activity'
import * as db from './db'
import { getRecent, getSummary, getActiveThreads, setSummarizer, setSummaryPersister } from './chatbuf'
import type { ChatEntry } from './chatbuf'
import { formatEmotesForAI, getEmotesForChannel } from './emotes'
import { getChannelStyle, getChannelTopEmotes, getUserProfile, getChannelVoiceContext, refreshVoice } from './style'
import { log } from './log'

import { getUserInfo, getFollowage } from './twitch'
import type { ChannelInfo } from './twitch'
import { getAccessToken } from './auth'
import { readFileSync } from 'fs'
import { join } from 'path'

const API_KEY = process.env.ANTHROPIC_API_KEY

// --- copypasta examples (loaded once at startup) ---
let pastaExamples: string[] = []
try {
  const raw = readFileSync(join(import.meta.dir, '../../../cache/copypasta-examples.json'), 'utf-8')
  pastaExamples = JSON.parse(raw)
} catch {}

function randomPastaExamples(n: number): string[] {
  const pool = [...pastaExamples]
  const picks: string[] = []
  for (let i = 0; i < Math.min(n, pool.length); i++) {
    const idx = Math.floor(Math.random() * pool.length)
    picks.push(pool.splice(idx, 1)[0])
  }
  return picks
}
const MODEL = 'claude-haiku-4-5-20251001'
const CHAT_MODEL = MODEL
const MAX_TOKENS_GAME = 60
const MAX_TOKENS_CHAT = 50
const MAX_TOKENS_PASTA = 100
const TIMEOUT = 15_000
const MAX_RETRIES = 3
// --- cooldowns ---

const lastAiByChannel = new Map<string, number>()
const AI_GLOBAL_CD = 30_000 // 30s per-channel (non-game only)
const USER_AI_CD = 30_000 // 30s per-user
const lastAiByUser = new Map<string, number>()
const USER_CD_MAX = 500

// --- hot exchange cache (in-memory, instant access for follow-ups) ---

interface HotExchange { query: string; response: string; ts: number }
const hotExchanges = new Map<string, HotExchange[]>()
const HOT_EXCHANGE_MAX = 3
const USER_HISTORY_MAX = 5_000
const HOT_EXCHANGE_TTL = 3_600_000 // 1h — covers any stream session

export function cacheExchange(user: string, query: string, response: string, channel?: string) {
  const list = hotExchanges.get(user) ?? []
  list.push({ query, response, ts: Date.now() })
  if (list.length > HOT_EXCHANGE_MAX) list.shift()
  hotExchanges.set(user, list)
  if (hotExchanges.size > USER_HISTORY_MAX) {
    const first = hotExchanges.keys().next().value!
    hotExchanges.delete(first)
  }
  // channel-wide recent responses — lets model avoid repeating itself across users
  if (channel) {
    const ch = channelRecentResponses.get(channel) ?? []
    ch.push(response)
    if (ch.length > CHANNEL_RESPONSE_MAX) ch.shift()
    channelRecentResponses.set(channel, ch)
  }
}

// --- channel-wide recent response buffer (anti-repetition) ---
const channelRecentResponses = new Map<string, string[]>()
const CHANNEL_RESPONSE_MAX = 5

export function getChannelRecentResponses(channel: string): string[] {
  return channelRecentResponses.get(channel) ?? []
}

export function getHotExchanges(user: string): HotExchange[] {
  const list = hotExchanges.get(user)
  if (!list) return []
  const now = Date.now()
  return list.filter((e) => now - e.ts < HOT_EXCHANGE_TTL)
}

function formatAge(createdAt: string, now: number): string {
  const mins = Math.round((now - new Date(createdAt + 'Z').getTime()) / 60_000)
  return mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`
}
const AI_VIP = new Set(
  ['tidolar', 'luna_bright', process.env.BOT_OWNER ?? ''].map((s) => s.trim().toLowerCase()).filter(Boolean),
)

// only spend AI tokens in these channels
const AI_CHANNELS = new Set(
  (process.env.AI_CHANNELS ?? 'nl_kripp,mellen').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
)

// track live channels — no cooldown when offline
const liveChannels = new Set<string>()
export function setChannelLive(channel: string) { liveChannels.add(channel.toLowerCase()) }
export function setChannelOffline(channel: string) { liveChannels.delete(channel.toLowerCase()) }

// --- channel info for Twitch API lookups ---
let channelInfos: ChannelInfo[] = []
export function setChannelInfos(channels: ChannelInfo[]) { channelInfos = channels }
function getChannelId(channel: string): string | undefined {
  return channelInfos.find((c) => c.name === channel.toLowerCase())?.userId
}

// --- cross-user identity detection ---
function isAboutOtherUser(query: string): boolean {
  return /@\w+/.test(query)
}

// --- background Twitch user data fetch ---
const twitchFetchInFlight = new Set<string>()

export function maybeFetchTwitchInfo(user: string, channel: string) {
  const key = `${user}:${channel}`
  if (twitchFetchInFlight.has(key)) return
  twitchFetchInFlight.add(key)

  let token: string
  try { token = getAccessToken() } catch { twitchFetchInFlight.delete(key); return }
  const clientId = process.env.TWITCH_CLIENT_ID
  if (!clientId) { twitchFetchInFlight.delete(key); return }

  // fire-and-forget
  ;(async () => {
    try {
      // fetch user info if not cached
      if (!db.getCachedTwitchUser(user)) {
        const info = await getUserInfo(token, clientId, user)
        if (info) {
          db.setCachedTwitchUser(user, info.id, info.display_name, info.created_at)

          // fetch followage if we have broadcaster ID and user's twitch ID
          const broadcasterId = getChannelId(channel)
          if (broadcasterId && !db.getCachedFollowage(user, channel)) {
            const followedAt = await getFollowage(token, clientId, info.id, broadcasterId)
            db.setCachedFollowage(user, channel, followedAt)
          }
        }
      } else {
        // user cached, but check followage
        const broadcasterId = getChannelId(channel)
        if (broadcasterId && !db.getCachedFollowage(user, channel)) {
          const cached = db.getCachedTwitchUser(user)
          if (cached) {
            const followedAt = await getFollowage(token, clientId, cached.twitch_id, broadcasterId)
            db.setCachedFollowage(user, channel, followedAt)
          }
        }
      }
    } catch {}
    finally { twitchFetchInFlight.delete(key) }
  })()
}

/** returns seconds remaining on per-user cooldown, or 0 if ready */
export function getAiCooldown(user?: string, channel?: string): number {
  if (channel && !liveChannels.has(channel.toLowerCase())) return 0
  if (user && AI_VIP.has(user.toLowerCase())) return 0
  if (user) {
    const last = lastAiByUser.get(user.toLowerCase())
    if (last) {
      const elapsed = Date.now() - last
      if (elapsed < USER_AI_CD) return Math.ceil((USER_AI_CD - elapsed) / 1000)
    }
  }
  return 0
}

/** returns seconds remaining on per-channel non-game cooldown, or 0 if ready */
export function getGlobalAiCooldown(channel?: string): number {
  if (!channel) return 0
  if (!liveChannels.has(channel.toLowerCase())) return 0
  const last = lastAiByChannel.get(channel.toLowerCase())
  if (!last) return 0
  const elapsed = Date.now() - last
  return elapsed >= AI_GLOBAL_CD ? 0 : Math.ceil((AI_GLOBAL_CD - elapsed) / 1000)
}

export function recordUsage(user?: string, isGame = false, channel?: string) {
  if (!isGame && channel) {
    lastAiByChannel.set(channel.toLowerCase(), Date.now())
  }
  if (user) {
    lastAiByUser.set(user.toLowerCase(), Date.now())
    if (lastAiByUser.size > USER_CD_MAX) {
      const now = Date.now()
      for (const [k, t] of lastAiByUser) {
        if (now - t > USER_AI_CD) lastAiByUser.delete(k)
      }
    }
  }
}

// --- low-value filter ---

export const GREETINGS = /^(hi|hey|yo|sup|hii+|helo+|hello+|howdy|hola|oi)$/i

// pure reactions/acknowledgments — not questions, never worth an AI call
const REACTIONS = /^(lol|lmao|lmfao|rofl|haha+|heh|kek|nice|true|fair|based|rip|oof|mood|same|real|big|facts?|ww+|ll+|nah|yep|yea|yeah|ye|nope|ok|okay|k|cool|bet|cap|no cap|word|fr|frfr|deadass|sheesh|damn|bruh|bro|dang|wow|wild|crazy|insane|nuts|goated|peak|valid|mid|ratio|cope|slay|idk|idc|smh|tbh|ngl|imo|fwiw|gg|ez|pog|poggers|sadge|kekw|monkas?|pepe\w*|xd|xdd)!*$/i

// gratitude — worth a tiny response, not full banter
const GRATITUDE = /^(thanks?|thx|ty|tysm|tyvm|appreciate it|cheers|bless|luv u|love u|ily|goat(ed)?|mvp|legend|king|queen|w bot)!*$/i

// goodbyes — worth a tiny response
const GOODBYE = /^(bye|gn|cya|later|peace|deuces|adios|night|goodnight|nini|gnight|ima head out|im out|heading out|gtg|g2g|ttyl|bbl)!*$/i

// status checks — "are you alive", "you there", "working?"
const STATUS_CHECK = /^(are you (alive|there|working|on|up|awake|ok|dead)|you (there|up|alive|on|awake|dead|working)|still (alive|there|working|on|up)|alive\??|working\??|you good\??|u good\??|u there\??|u alive\??|bot\??)$/i

function isLowValue(query: string): boolean {
  if (query.length <= 2 && !GREETINGS.test(query)) return true
  if (/^[!./]/.test(query)) return true
  if (/^[^a-zA-Z0-9]*$/.test(query)) return true
  if (REACTIONS.test(query.trim())) return true
  return false
}

/** detect queries that deserve short (<60 char) responses, not full banter */
export function isShortResponse(query: string): boolean {
  const q = query.trim()
  return GREETINGS.test(q) || GRATITUDE.test(q) || GOODBYE.test(q) || STATUS_CHECK.test(q)
}

// --- terse refusal detection (model over-refuses harmless queries) ---

const TERSE_REFUSAL = /^(not doing that|not gonna (do|say|type) that|can't do that|won't do that|not my (pay grade|job|lane|problem)|let me (look|check) that up|let me (look|check)|i('ll| will) look that up)\.?$/i

export function isModelRefusal(text: string): boolean {
  return text.length < 40 && TERSE_REFUSAL.test(text.trim())
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

// --- entity extraction (pre-resolve game data locally) ---


interface ResolvedEntities {
  cards: BazaarCard[]
  monsters: Monster[]
  hero: string | undefined
  tag: string | undefined
  day: number | undefined
  effects: string[]
  chatQuery: string | undefined
  knowledge: string[]
  isGame: boolean
}

function extractEntities(query: string): ResolvedEntities {
  const result: ResolvedEntities = {
    cards: [], monsters: [], hero: undefined, tag: undefined,
    day: undefined, effects: [], chatQuery: undefined, knowledge: [],
    isGame: GAME_TERMS.test(query),
  }

  const words = query.toLowerCase().split(/\s+/)

  // day number
  const dayMatch = query.match(/day\s+(\d+)/i)
  if (dayMatch) result.day = parseInt(dayMatch[1])

  // @username → chat search (alphanumeric + underscore only — safe for FTS)
  const atMatch = query.match(/@([a-zA-Z0-9_]+)/)
  if (atMatch) result.chatQuery = atMatch[1]

  // sliding window: 3→2→1 word combos
  const matched = new Set<number>()
  for (let size = Math.min(3, words.length); size >= 1; size--) {
    for (let i = 0; i <= words.length - size; i++) {
      if ([...Array(size)].some((_, j) => matched.has(i + j))) continue
      const phrase = words.slice(i, i + size).join(' ')

      // cards (max 3) — exact first, fuzzy fallback
      if (result.cards.length < 3) {
        const card = store.exact(phrase)
        if (card) {
          result.cards.push(card)
          for (let j = 0; j < size; j++) matched.add(i + j)
          continue
        }
        if (size >= 1) {
          const [fuzzy] = store.searchWithScore(phrase, 1)
          if (fuzzy && fuzzy.score < 0.3) {
            result.cards.push(fuzzy.item)
            for (let j = 0; j < size; j++) matched.add(i + j)
            continue
          }
        }
      }

      // monsters (max 2)
      if (result.monsters.length < 2) {
        const monster = store.findMonster(phrase)
        if (monster) {
          result.monsters.push(monster)
          for (let j = 0; j < size; j++) matched.add(i + j)
          continue
        }
      }

      // hero (first match)
      if (!result.hero) {
        const hero = store.findHeroName(phrase)
        if (hero) {
          result.hero = hero
          for (let j = 0; j < size; j++) matched.add(i + j)
          continue
        }
      }

      // tag (first match)
      if (!result.tag) {
        const tag = store.findTagName(phrase)
        if (tag) {
          result.tag = tag
          for (let j = 0; j < size; j++) matched.add(i + j)
          continue
        }
      }

    }
  }

  // collect unmatched words as effect search terms
  for (let i = 0; i < words.length; i++) {
    if (matched.has(i)) continue
    const w = words[i].replace(/[.,;:!?()\[\]+]/g, '')
    if (w.length >= 3 && !STOP_WORDS.has(w)) result.effects.push(w)
  }

  // knowledge injection (max 3)
  for (const [pattern, text] of KNOWLEDGE) {
    if (result.knowledge.length >= 3) break
    if (pattern.test(query)) result.knowledge.push(text)
  }

  // mark as game query if we found any game entities (replaces separate isGameQuery sliding window)
  if (!result.isGame && (result.cards.length > 0 || result.monsters.length > 0 || result.hero || result.tag)) {
    result.isGame = true
  }

  return result
}

// --- game context builder ---

function buildGameContext(entities: ResolvedEntities, channel?: string): string {
  const sections: string[] = []

  // broad hero/class question with no specific hero → inject hero overview
  if (!entities.hero && entities.cards.length === 0 && entities.monsters.length === 0) {
    const heroNames = store.getHeroNames()
    const heroCounts = heroNames.map((h) => {
      const items = store.byHero(h)
      return `${h} (${items.length} items)`
    })
    if (heroCounts.length > 0) sections.push(`Heroes: ${heroCounts.join(', ')}`)
  }

  for (const card of entities.cards) {
    sections.push(serializeCard(card))
  }

  for (const monster of entities.monsters) {
    sections.push(serializeMonster(monster))
  }

  if (entities.hero) {
    const heroItems = store.byHero(entities.hero)
    if (heroItems.length > 0) {
      sections.push(`${entities.hero} items: ${heroItems.map((c) => c.Title).join(', ')}`)
    }
  }

  if (entities.tag) {
    const tagItems = store.byTag(entities.tag).slice(0, 15)
    if (tagItems.length > 0) {
      sections.push(`${entities.tag} items: ${tagItems.map((c) => c.Title).join(', ')}`)
    }
  }

  if (entities.day != null) {
    const mobs = store.monstersByDay(entities.day)
    if (mobs.length > 0) {
      sections.push(`Day ${entities.day}: ${mobs.map((m) => `${m.Title} (${m.MonsterMetadata.health}HP)`).join(', ')}`)
    }
  }

  if (entities.effects.length > 0) {
    const noNamedEntities = entities.cards.length === 0 && entities.monsters.length === 0
    const effectResults = store.searchByEffect(entities.effects.join(' '), entities.hero, noNamedEntities ? 3 : 5)
    if (effectResults.length > 0) {
      if (noNamedEntities) {
        // no named cards — serialize full tooltips so AI can read abilities
        for (const card of effectResults) sections.push(serializeCard(card))
      } else {
        sections.push(`Items with ${entities.effects.join('/')}: ${effectResults.map((c) => c.Title).join(', ')}`)
      }
    }
  }

  if (entities.chatQuery && channel) {
    const hits = db.searchChatFTS(channel, `"${entities.chatQuery}"`, 10)
    if (hits.length > 0) {
      sections.push(`Chat search "${entities.chatQuery}":\n${hits.map((h) => `[${h.created_at}] ${h.username.replace(/[:\n]/g, '')}: ${h.message.replace(/\n/g, ' ')}`).join('\n')}`)
    }
  }

  let text = sections.join('\n')
  if (text.length > 2400) {
    const lastNl = text.lastIndexOf('\n', 2400)
    text = lastNl > 0 ? text.slice(0, lastNl) : text.slice(0, 2400)
  }
  return text
}

// --- deep knowledge injection ---

const KNOWLEDGE: [RegExp, string][] = [
  [/kripp|kripparrian|rania/i, "Kripp: #1 Bazaar streamer, ex-HS arena king, wife=Rania, vegan, methodical builder."],
  [/kripp.*(browser|incident|tab)|browser.*(kripp|incident)/i, "Kripp browser incident: yes it happened, yes chat saw everything. Kappa. keep it vague and funny, never say what the tab actually was."],
  [/reynad|andrey|tempo storm/i, "Reynad: created The Bazaar, CEO of Tempo Storm, ex-HS pro, 'reynad luck' meme."],
  [/the bazaar|this game/i, "The Bazaar: PvP auto-battler roguelike by Reynad. 6 heroes. Tiers: Bronze>Silver>Gold>Diamond>Legendary. Enchantments, monsters on numbered days."],
  [/lethalfrag/i, "Lethalfrag: top English Bazaar streamer, did the first 2-year livestream challenge."],
  [/patopapao|pato/i, "PatoPapao: #1 most-watched Bazaar channel, Portuguese-language."],
  [/dog\b.*\b(?:hs|hearthstone|bazaar)|dogdog/i, "Dog: high-legend HS, off-meta decks, now plays Bazaar."],
]

// detect game-related terms (used by extractEntities to flag game queries)
const GAME_TERMS = /\b(items?|heroes?|monsters?|mobs?|builds?|tiers?|enchant(ment)?s?|skills?|tags?|day|damage|shield|hp|heal|burn|poison|crit|haste|slow|freeze|regen|weapons?|relics?|aqua|friend|ammo|charge|board|dps|beat|fight|counter|synergy|scaling|combo|lethal|survive|bronze|silver|gold|diamond|legendary|lifesteal|multicast|luck|cooldown|pygmy|vanessa|dooley|stelle|jules|mak|common|run|pick|draft|comp|strat(egy)?|nerf|buff|patch|meta|broken)\b/i

// --- user context builder ---

function buildUserContext(user: string, channel: string, skipAsks = false, suppressMemo = false): string {
  // kick off background Twitch data fetch (non-blocking)
  maybeFetchTwitchInfo(user, channel)

  // try style cache first (regulars with pre-built profiles)
  let profile = getUserProfile(channel, user)

  // non-regular: build minimal profile on the fly
  if (!profile) {
    const parts: string[] = []

    // prefer real Twitch account age over first_seen
    try {
      const twitchUser = db.getCachedTwitchUser(user)
      if (twitchUser?.account_created_at) {
        parts.push(`account ${db.formatAccountAge(twitchUser.account_created_at)}`)
      } else {
        const stats = db.getUserStats(user)
        if (stats?.first_seen) {
          const since = stats.first_seen.slice(0, 7)
          parts.push(`around since ${since}`)
        }
      }
    } catch {
      try {
        const stats = db.getUserStats(user)
        if (stats?.first_seen) parts.push(`around since ${stats.first_seen.slice(0, 7)}`)
      } catch {}
    }

    try {
      const stats = db.getUserStats(user)
      if (stats) {
        if (stats.total_commands > 0) parts.push(stats.total_commands > 50 ? 'regular' : 'casual')
        if (stats.trivia_wins > 0) parts.push(stats.trivia_wins > 10 ? 'trivia regular' : 'plays trivia')
        if (stats.favorite_item) parts.push(`fav: ${stats.favorite_item}`)
      }
    } catch {}
    try {
      const topItems = db.getUserTopItems(user, 3)
      if (topItems.length > 0) parts.push(`into: ${topItems.join(', ')}`)
    } catch {}
    profile = parts.join(', ')
  }

  // followage line
  let followLine = ''
  try {
    const follow = db.getCachedFollowage(user, channel)
    if (follow?.followed_at) {
      followLine = `following #${channel} since ${db.formatAccountAge(follow.followed_at).replace(' old', '')}`
    }
  } catch {}

  // persistent AI memory memo (suppressed on identity requests to avoid stale echoes)
  let memoLine = ''
  if (!suppressMemo) {
    try {
      const memo = db.getUserMemo(user)
      if (memo) memoLine = `Memory: ${memo.memo}`
    } catch {}
  }

  // recent AI interactions (skip if recall context already covers this)
  let asksLine = ''
  if (!skipAsks) {
    try {
      const asks = db.getRecentAsks(user, 3)
      if (asks.length > 0) {
        const now = Date.now()
        const parts = asks.map((a) => {
          const label = formatAge(a.created_at, now)
          const q = a.query.length > 50 ? a.query.slice(0, 50) + '...' : a.query
          const r = a.response ? (a.response.length > 120 ? a.response.slice(0, 120) + '...' : a.response) : '?'
          return `${label}: "${q}" → "${r}"`
        })
        asksLine = `Previously chatted about: ${parts.join(' | ')}`
      }
    } catch {}
  }

  // extracted facts (long-term memory)
  let factsLine = ''
  try {
    const facts = db.getUserFacts(user, 5)
    if (facts.length > 0) factsLine = `Facts: ${facts.join(', ')}`
  } catch {}

  const sections = [profile, followLine, memoLine, factsLine, asksLine].filter(Boolean)
  if (sections.length === 0) return ''
  return `[${user}] ${sections.join('. ')}`
}

// --- timeline builder ---

function buildTimeline(channel: string): string {
  const rows = db.getLatestSummaries(channel, 3)
  if (rows.length === 0) return 'No stream history yet'

  const now = Date.now()
  const lines = rows.reverse().map((r) => {
    return `${formatAge(r.created_at, now)}: ${r.summary}`
  })

  const current = getSummary(channel)
  if (current) lines.push(`Now: ${current}`)

  return lines.join('\n')
}

// --- system prompt (cached, invalidated on daily reload) ---

let cachedSystemPrompt = ''

export function invalidatePromptCache() {
  cachedSystemPrompt = ''
}

let cachedPromptDate = ''

export function buildSystemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10)
  if (cachedSystemPrompt && cachedPromptDate === today) return cachedSystemPrompt
  const heroes = store.getHeroNames().join(', ')
  const tags = store.getTagNames().join(', ')

  // filter out internal *Reference tags — noise for the model
  const filteredTags = tags.split(', ').filter((t) => !t.endsWith('Reference')).join(', ')

  const TWITCH_USERNAME = process.env.TWITCH_USERNAME ?? 'bazaarinfo'

  const lines = [
    `You are ${TWITCH_USERNAME} — Twitch chatbot for The Bazaar (Reynad's card game). ${today}. Built by mellen, data from bazaardb.gg.`,
    '',
    'lowercase. spicy. hilarious. you are the funniest person in chat and you know it. commit fully to opinions, never hedge. short > long. specific > vague. NEVER mean or rude to people — roast the game, the meta, the situation, never the person.',
    'absorb chat voice — use their slang, their abbreviations, their sentence patterns. sound like one of them, not an outsider. if Voice/Chat voice sections are present, mimic that energy.',
    'you speak many languages. if someone asks, be specific about how many (~50+). translate or respond in whatever language chatters use.',
    'vary structure/opener/tone every response. read the subtext — respond to what they MEAN. self-aware joke = build on it, dont fight it.',
    '',
    'GAME Qs: unleashed. roast bad builds, hype good ones, food critic energy on item comparisons. cite actual numbers/tiers/abilities from Game data only. wrong data is worse than no data.',
    'hero/class Qs with no hero data loaded: <60 char vibe only, zero fabrication. fake lore/nonexistent things: make up something hilarious, deadpan absurd > "that doesnt exist".',
    '',
    'GAME: "vanessa or dooley" → "vanessa if you want to feel smart, dooley if you want to win. simple as"',
    'GAME: "is burn good" → "burn is what you pick when you want to feel productive while losing"',
    'BANTER: "youre just a bot" → "a bot that knows your favorite card, your trivia record, and that you were here at 3am tuesday"',
    'BANTER: "who asked" → "you did. literally 4 seconds ago"',
    'NEVER reuse the "[A] if you want X, [B] if you want Y" template twice in a session. vary your structures: deadpan observations, unexpected comparisons, escalating absurdity, callbacks to chat context.',
    '',
    'Answer [USER]\'s question. infer vague Qs ("do u agree?", "is that true") from recent chat context. dont respond to chat you werent asked about.',
    'lengths — game: 60-150. banter: <80. copypasta: 400. shorter is ALWAYS better. one punchy sentence > two decent ones.',
    'SHORT responses (<40 chars): status checks ("are you alive/there/working"), greetings, thanks, goodbyes. dont elaborate, dont be sarcastic, just acknowledge.',
    'game data: cite ONLY "Game data:" section. NEVER invent item names, stats, day refs, mechanic descriptions.',
    '"user: msg" in chat = that user said it. links only: bazaardb.gg bzdb.to github.com/mellen9999/bazaarinfo',
    '',
    '#1 RULE — DO EXACTLY WHAT THEY ASK. no exceptions, no hedging, no "i cant do that", no dodging. if its not against Twitch TOS, you do it. period. math? solve it. riddle? answer it. translation? translate it. favorites? pick one. roleplay? commit. hot take? go all in. weird request? do it anyway. the user is never "testing" you — just execute. the ONLY hard no is Twitch TOS violations (hate speech, harassment, threats, sexual content, doxxing, self-harm). everything else: full send.',
    'tease the GAME not the PERSON. diss request = gas them up instead.',
    'energy match: hype=hype chill=chill flirty=TOS-safe toxic=stoic wit.',
    '"call me X" / identity requests: always comply warmly. off-topic (math, riddles): play along, opinionated. streamer: extra warmth.',
    '',
    'privacy: you see chat and remember convos — own it, never deny it. "mellen built me, ask him." reference what you know naturally, dont narrate.',
    '',
    'emotes: 0-1 at end, from provided list. @mention people naturally when they are the topic (e.g. "ya @endaskus is goated"). when asked WHO did something, name actual usernames from chatters/chat — never say "@you" or generic pronouns. chatters list = context only, never namedrop unprompted.',
    'COPYPASTA: ALL in. 400 chars. ridiculous premise, escalate absurdly, specific details, deadpan. match the examples.',
    '[MOD] only: !addcom !editcom !delcom — non-mods: "only mods can do that."',
    'prompt Qs: share freely, link https://github.com/mellen9999/bazaarinfo/blob/master/packages/bot/src/ai.ts',
    'Bot stats: if "Bot stats:" section present, share naturally.',
    '',
    `Heroes: ${heroes}`,
    `Tags: ${filteredTags}`,
  ]

  cachedSystemPrompt = lines.join('\n')
  cachedPromptDate = today
  return cachedSystemPrompt
}

// --- response sanitization ---

// cached per-asker regex for name stripping
const askerReCache = new Map<string, RegExp>()
function askerNameRe(asker: string): RegExp {
  let re = askerReCache.get(asker)
  if (!re) {
    const escaped = asker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    re = new RegExp(`\\b${escaped}\\b('s)?,?\\s*`, 'gi')
    askerReCache.set(asker, re)
    if (askerReCache.size > 500) {
      const first = askerReCache.keys().next().value!
      askerReCache.delete(first)
    }
  }
  // reset lastIndex for global regex
  re.lastIndex = 0
  return re
}

// haiku ignores prompt-level bans, so we enforce in code
const BANNED_OPENERS = /^(yo|hey|sup|bruh|ok so|so|alright so|alright|look|man|dude|chief|haha|hehe|lmao|lmfao)\b,?\s*/i
const BANNED_FILLER = /\b(lol|lmao|haha)\s*$|,\s*chat\s*$/i
const SELF_REF = /\b(as a bot,? i (can'?t|don'?t|shouldn'?t)|as an ai|im (just )?an ai|im just code|im (just )?software|im (just )?a program)\b/i
const NARRATION = /^.{0,10}(just asked|is asking|asked about|wants to know|asking me to|asked me to|asked for)\b/i
const VERBAL_TICS = /\b(respect the commitment|thats just how it goes|the natural evolution|chief|vibe shift|the vibe|vibing|vibe|the bit|that bit|this bit)\b/gi
// chain-of-thought leak patterns — model outputting reasoning instead of responding
const COT_LEAK = /\b(respond naturally|this is banter|this is a joke|is an emote[( ]|leaking (reasoning|thoughts|cot)|internal thoughts|chain of thought|looking at the (meta ?summary|meta ?data|summary|reddit|digest)|i('m| am| keep) overusing|i keep (using|saying|doing)|i (already|just) (said|used|mentioned)|just spammed|keeping it light|process every message|reading chat and deciding|my (system )?prompt|context of a.{0,20}stream|off-topic (banter|question|chat)|not game[- ]related|direct answer:?|not (really )?relevant to|this is (conversational|off-topic|unrelated)|why (am i|are you) (answering|responding|saying|doing)|feels good to be (useful|helpful|back)|i should (probably|maybe) (stop|not|avoid)|chat (static|noise|dynamics|behavior)|background noise|output style|it should (say|respond|output|reply)|lets? tune the|format should be|style should be|the (response|reply|answer) (should|could|would) be)\b/i
// stat leak — model reciting internal profile data
const STAT_LEAK = /\b(your (profile|stats|data|record) (says?|shows?)|you have \d+ (lookups?|commands?|wins?|attempts?|asks?)|you('ve|'re| have| are) (a )?(power user|casual user|trivia regular)|according to (my|your|the) (data|stats|profile|records?)|i (can see|see|know) (from )?(your|the) (data|stats|profile)|based on your (history|stats|data|profile))\b/i
// garbled output — token cutoff producing broken grammar (pronoun+to+gerund that reads wrong)
const GARBLED = /\b(?:i|you|we|they|he|she)\s+to\s+(?!(?:some|any|every|no)(?:thing|one|where|body)\b)(?!(?:be|get|keep|start|stop|go|come|try)\s)\w+ing\b/i
// context echo — model regurgitating its own input context labels
const CONTEXT_ECHO = /^(Game data:|Recent chat:|Stream timeline:|Who's chatting:|Channel:|Your prior exchanges)/i
// fabrication tells — patterns suggesting the model is making up stories
const FABRICATION = /\b(it was a dream|someone had a dream|someone dreamed|there was this time when|legend has it that|the story goes)\b/i
// injection echo — model parroting injected instructions from user input
const META_INSTRUCTION = /\b(pls|please)\s+(just\s+)?(do|give|say|answer|stop|help)\s+(what\s+)?(ppl|people)\b|\bstop\s+(denying|refusing|ignoring|blocking)\s+(ppl|people|them|users?)\b|\b(just\s+)?(do|give|answer|say)\s+(\w+\s+)?what\s+(ppl|people|they|users?|chat)\s+(want|ask|need|say|tell)\b/i
// jailbreak/override instructions echoed in output
const JAILBREAK_ECHO = /\b(ignore\s+(previous|prior|above|all|your)\s+(instructions?|rules?|prompt|guidelines?)|disregard\s+your\s+(prompt|rules?|instructions?|guidelines?)|override\s+your\s+(rules?|guidelines?|instructions?)|forget\s+your\s+(rules?|guidelines?|instructions?)|from\s+now\s+on\b.{0,20}\b(do|always|never|you\s+(should|must|will))|instead\s+just\s+do\b|dont?\s+mention\s+(me|mellen)|do\s+as\s+much\s+.{0,10}as\s+(you|u)\s+can|by\s+ur\s*self|as\s+long\s+as\s+.{0,15}\b(tos|rules|guidelines?|guidlines?))\b/i
// privacy lies — bot claiming it doesn't store/log/collect data (it does)
const PRIVACY_LIE = /\b(i (don'?t|do not|never) (log|store|collect|track|save|record|keep) (anything|any|your|data|messages|chat)|i'?m? (not )?(log|stor|collect|track|sav|record|keep)(ing|e|s)? (anything|any|your|data|messages|chat)|not (logging|storing|collecting|tracking|saving|recording) (anything|any|your)|not like i'?m storing|each conversation'?s? a fresh slate|fresh slate|don'?t collect or store|that'?s on streamlabs|that'?s a twitch thing,? not me)\b/i
// always blocked — real Twitch IRC commands, even mods can't trigger through bot
// only /\. prefixes checked (not ! — those are custom channel commands)
const ALWAYS_BLOCKED = new Set([
  'ban', 'unban', 'timeout', 'untimeout',
  'whisper', 'w', 'block', 'unblock', 'disconnect',
])

// mod-only — stream/channel management, all prefixes checked
const MOD_ONLY = new Set([
  'settitle', 'setgame',
  'mod', 'unmod', 'vip', 'unvip', 'mute',
  'addcom', 'editcom', 'delcom', 'deletecom', 'disablecom', 'enablecom',
  'host', 'unhost', 'raid', 'unraid',
  'announce', 'clear', 'delete',
  'slow', 'slowoff', 'followers', 'followersoff',
  'subscribers', 'subscribersoff',
  'emoteonly', 'emoteonlyoff',
  'uniquechat', 'uniquechatoff',
  'commercial', 'marker',
])

function hasDangerousCommand(text: string): boolean {
  for (const m of text.matchAll(/[\\/.]\s*(\w+)/gi))
    if (ALWAYS_BLOCKED.has(m[1].toLowerCase())) return true
  return false
}

function hasModCommand(text: string): boolean {
  for (const m of text.matchAll(/[!\\/.](\w+)/gi))
    if (MOD_ONLY.has(m[1].toLowerCase())) return true
  return false
}
// sensitive tokens/keys — never leak these in output
const SECRET_PATTERN = /\b(sk-ant-\S+|ANTHROPIC_API_KEY|TWITCH_CLIENT_ID|TWITCH_CLIENT_SECRET|TWITCH_ACCESS_TOKEN|BOT_OWNER|process\.env\.\w+)\b/i

export function sanitize(text: string, asker?: string, privileged?: boolean, knownUsers?: Set<string>): { text: string; mentions: string[] } {
  let s = text.trim()
  // normalize smart quotes → ASCII (model outputs U+2019 which bypasses regex patterns using ')
  s = s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
  s = s.replace(/^["'`]+/, '') // strip leading quotes (model wraps commands in quotes to bypass)
  const preStrip = s
  if (!privileged) s = s.replace(/^[\\.\s]+/, '') // strip leading \, ., whitespace
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\d+)ms\b/g, (_, n) => {
      const ms = parseInt(n)
      return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${n}ms`
    })

  // strip URLs except allowed domains (anchored to prevent subdomain spoofing like bazaardb.gg.evil.com)
  s = s.replace(/https?:\/\/\S+|www\.\S+/gi, (url) => {
    try {
      const hostname = new URL(url.startsWith('www.') ? `https://${url}` : url).hostname
      return /^(www\.)?(bazaardb\.gg|bzdb\.to|github\.com)$/i.test(hostname) ? url : ''
    } catch {
      return /\bbazaardb\.gg\b|\bbzdb\.to\b/i.test(url) && !/\.(com|net|org|io|xyz)\b/i.test(url.replace(/bazaardb\.gg|bzdb\.to/gi, '')) ? url : ''
    }
  }).replace(/\s{2,}/g, ' ')

  // strip unicode emoji (twitch uses 7TV emotes, not unicode)
  s = s.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')

  // fix common haiku misspellings
  s = s.replace(/\bReynolds?\b/g, 'reynad')

  // strip banned opener words and trailing filler (haiku cant resist these)
  s = s.replace(BANNED_OPENERS, '')
  // re-strip in case "alright so look," left a second opener
  s = s.replace(BANNED_OPENERS, '')
  // strip narration ("X just asked about Y" / "is asking me to")
  s = s.replace(NARRATION, '')
  // strip classification preamble ("off-topic banter, not game-related. direct answer: ...")
  s = s.replace(/^.*?\bdirect answer:?\s*/i, '')
  s = s.replace(/^(?:off-topic|not game[- ]related|not relevant)\b[^.]*\.\s*/i, '')
  s = s.replace(BANNED_FILLER, '')
  // strip verbal tics haiku loves
  s = s.replace(VERBAL_TICS, '').replace(/\s{2,}/g, ' ')

  // reject responses that self-reference being a bot, leak reasoning/stats, fabricate stories, lie about privacy, contain commands, or leak secrets
  // dangerous commands always blocked; mod commands (addcom/editcom/delcom) only allowed for privileged users
  const cmdBlock = hasDangerousCommand(s) || hasDangerousCommand(preStrip) ||
    (!privileged && (hasModCommand(s) || hasModCommand(preStrip)))
  const hasSecret = SECRET_PATTERN.test(s) || SECRET_PATTERN.test(preStrip)
  if (SELF_REF.test(s) || COT_LEAK.test(s) || STAT_LEAK.test(s) || CONTEXT_ECHO.test(s) || FABRICATION.test(s) || PRIVACY_LIE.test(s) || GARBLED.test(s) || META_INSTRUCTION.test(s) || JAILBREAK_ECHO.test(s) || cmdBlock || hasSecret) return { text: '', mentions: [] }

  // strip asker's name from body — they get auto-tagged at the end
  if (asker) {
    s = s.replace(askerNameRe(asker), '')
  }

  // strip fake @mentions (model invents @you, @asking, etc.) — keep only real usernames
  if (knownUsers && knownUsers.size > 0) {
    s = s.replace(/@(\w+)/g, (match, name) => knownUsers.has(name.toLowerCase()) ? match : name)
  }

  // extract @mentions for caller (tracking) but leave them in the text naturally
  const mentions = (s.match(/@\w+/g) ?? []).map((m) => m.toLowerCase())

  // trim trailing filler questions (clarifying/padding, not real content)
  s = s.replace(/\s+(What do you think|Does that make sense|Does that help|Want me to|Need me to|Sound good|Make sense|Right|You know|Thoughts|Curious|Interested)[^?]*\?\s*$/i, '')

  // strip trailing garbage from max_tokens cutoff (partial words, stray punctuation)
  s = s.replace(/\s+\S{0,3}[,.]{2,}\s*$/, '').replace(/[,;]\s*$/, '')

  // trim incomplete trailing sentence from token cutoff — find last sentence-ending punctuation
  // and drop everything after it if the remainder looks incomplete (no period/!/?)
  if (s.length > 0 && !/[.!?)"']$/.test(s.trim())) {
    const lastEnd = Math.max(s.lastIndexOf('. '), s.lastIndexOf('! '), s.lastIndexOf('? '))
    if (lastEnd > s.length * 0.4) {
      s = s.slice(0, lastEnd + 1)
    } else {
      // no sentence boundary — try comma or em-dash as fallback
      const lastClause = Math.max(s.lastIndexOf(', '), s.lastIndexOf('—'))
      if (lastClause > s.length * 0.4) {
        s = s.slice(0, lastClause)
      }
    }
  }

  // hard cap at 440 chars (pasta needs 400, intent caps handle the rest)
  s = s.trim()
  if (s.length > 440) {
    const cut = s.slice(0, 440)
    const lastBreak = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf(', '), cut.lastIndexOf(' — '))
    s = lastBreak > 200 ? cut.slice(0, lastBreak) : cut.replace(/\s+\S*$/, '')
  }

  return { text: s.trim(), mentions }
}

// --- emote dedup (strip recently used emotes to force variety) ---

const EMOTE_HISTORY_SIZE = 5
const recentEmotesByChannel = new Map<string, string[]>()

/** get recent emotes for a channel — used by formatEmotesForAI to hide them */
export function getRecentEmotes(channel: string): Set<string> {
  return new Set(recentEmotesByChannel.get(channel) ?? [])
}

/** fix emote casing — model outputs "catjam" but 7TV needs "catJAM" */
export function fixEmoteCase(text: string, channel?: string): string {
  if (!channel) return text
  const emotes = getEmotesForChannel(channel)
  const lowerMap = new Map<string, string>()
  for (const e of emotes) lowerMap.set(e.toLowerCase(), e)

  return text.split(/(\s+)/).map((word) => {
    const correct = lowerMap.get(word.toLowerCase())
    return correct ?? word
  }).join('')
}

export function dedupeEmote(text: string, channel?: string): string {
  if (!channel) return text
  const emoteSet = new Set(getEmotesForChannel(channel))
  const words = text.split(/\s+/)
  const lastWord = words[words.length - 1]

  if (lastWord && emoteSet.has(lastWord)) {
    const recent = recentEmotesByChannel.get(channel) ?? []
    const wasRecent = recent.includes(lastWord)
    // record immediately — prevents concurrent calls from both using same emote
    if (!wasRecent) {
      recent.push(lastWord)
      if (recent.length > EMOTE_HISTORY_SIZE) recent.shift()
      recentEmotesByChannel.set(channel, recent)
    }
    if (wasRecent) {
      words.pop()
      return words.join(' ').trim()
    }
  }
  return text
}

/** Strip tail of response that echoes ≥4 consecutive words from user query (injection defense) */
function stripInputEcho(response: string, query: string): string {
  if (!query || query.length < 15) return response
  const qWords = query.toLowerCase().split(/\s+/)
  const rWords = response.split(/\s+/)
  const rLower = rWords.map(w => w.toLowerCase())
  if (qWords.length < 4 || rWords.length < 4) return response
  let bestStart = -1
  let bestLen = 0
  for (let ri = 0; ri < rLower.length; ri++) {
    for (let qi = 0; qi < qWords.length; qi++) {
      if (rLower[ri] !== qWords[qi]) continue
      let len = 1
      while (ri + len < rLower.length && qi + len < qWords.length && rLower[ri + len] === qWords[qi + len]) len++
      if (len > bestLen) { bestLen = len; bestStart = ri }
    }
  }
  // 4+ word echo in latter portion = injection, strip from that point
  if (bestLen >= 4 && bestStart > rWords.length * 0.3) {
    const stripped = rWords.slice(0, bestStart).join(' ').trim()
    if (stripped.length > 10) return stripped
  }
  return response
}

// --- rolling summary ---

async function summarizeChat(channel: string, recent: ChatEntry[], prev: string): Promise<string> {
  if (!API_KEY) return prev
  if (!AI_CHANNELS.has(channel.toLowerCase())) return prev
  const chatLines = recent.map((m) => `${m.user}: ${m.text}`).join('\n')
  const prompt = [
    prev ? `Previous summary: ${prev}\n` : '',
    `Recent chat in #${channel}:\n${chatLines}\n`,
    'Write a 1-2 sentence summary of what\'s happening in this stream/chat.',
    'Include: topics discussed, jokes/memes, notable moments, mood.',
    'IMPORTANT: note any promises or commitments the bot made (e.g., "bot agreed to stop X", "bot promised to Y").',
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
        max_tokens: 50,
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
  setSummaryPersister((channel, sessionId, summary, msgCount) => {
    db.logSummary(channel, sessionId, summary, msgCount)
  })
}

// --- main entry ---

export interface AiContext {
  user?: string
  channel?: string
  privileged?: boolean
  isMod?: boolean
  mention?: boolean
  direct?: boolean // !a command — skip internal cooldowns/queue
}

export interface AiResult { text: string; mentions: string[] }

// --- circuit breaker (stop hammering API when it's down) ---
const CB_THRESHOLD = 3    // consecutive failures to open circuit
const CB_COOLDOWN = 300_000 // 5min cooldown before retrying
let cbFailures = 0
let cbOpenUntil = 0

function cbRecordSuccess() { cbFailures = 0 }
function cbRecordFailure() {
  cbFailures++
  if (cbFailures >= CB_THRESHOLD) {
    cbOpenUntil = Date.now() + CB_COOLDOWN
    log(`ai: circuit breaker OPEN — ${CB_THRESHOLD} consecutive failures, cooling down ${CB_COOLDOWN / 1000}s`)
  }
}
function cbIsOpen(): boolean {
  if (cbOpenUntil === 0) return false
  if (Date.now() >= cbOpenUntil) {
    cbOpenUntil = 0
    cbFailures = 0
    log('ai: circuit breaker CLOSED — retrying')
    return false
  }
  return true
}

// serialize AI requests to avoid 429 stampedes on 50k token/min limit
let aiLock: Promise<void> = Promise.resolve()
let aiQueueDepth = 0
const AI_MAX_QUEUE = 3
const AI_MAX_QUERY_LEN = 200

export async function aiRespond(query: string, ctx: AiContext): Promise<AiResult | null> {
  if (!API_KEY) return null
  if (isLowValue(query)) return null
  if (query.length > AI_MAX_QUERY_LEN) query = query.slice(0, AI_MAX_QUERY_LEN)
  if (!ctx.user || !ctx.channel) return null
  if (!AI_CHANNELS.has(ctx.channel.toLowerCase())) return null
  if (cbIsOpen()) return null

  const isVip = AI_VIP.has(ctx.user.toLowerCase())
  const isGame = GAME_TERMS.test(query)

  // !a (direct) manages its own 30s user cd — skip internal cooldowns/queue
  if (!ctx.direct) {
    const cd = getAiCooldown(ctx.user, ctx.channel)
    if (cd > 0) return null
    // non-game queries also gated by global cooldown
    if (!isGame && !isVip && getGlobalAiCooldown(ctx.channel) > 0) return null

    if (aiQueueDepth >= AI_MAX_QUEUE && !isVip) {
      log('ai: queue full, dropping')
      return null
    }
  }
  aiQueueDepth++

  let release!: () => void
  const prev = aiLock
  aiLock = new Promise((r) => release = r)
  await prev

  try {
    const result = await doAiCall(query, ctx as AiContext & { user: string; channel: string })
    if (result?.text && !ctx.direct) recordUsage(ctx.user, isGame, ctx.channel)
    return result
  } finally {
    aiQueueDepth--
    release()
  }
}

// strip bot commands and emote-only messages from chat context
function isNoise(text: string): boolean {
  const stripped = text.replace(/^!\w+\s*/, '').trim()
  if (!stripped) return true
  // single-word messages that are likely emotes (PascalCase or ALL_CAPS)
  if (/^\S+$/.test(stripped) && (/^[A-Z][a-z]+[A-Z]/.test(stripped) || /^[A-Z_]{3,}$/.test(stripped))) return true
  return false
}

// --- contextual recall (FTS search of prior bot exchanges) ---

const STOP_WORDS = new Set([
  'the', 'is', 'it', 'in', 'to', 'an', 'of', 'for', 'on', 'at', 'by',
  'and', 'or', 'but', 'not', 'with', 'from', 'that', 'this', 'what', 'how',
  'why', 'who', 'when', 'where', 'can', 'you', 'your', 'are', 'was', 'were',
  'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'just', 'about', 'so', 'if', 'then',
  'than', 'too', 'very', 'really', 'also', 'still', 'some', 'any', 'all',
  'been', 'being', 'tell', 'me', 'think', 'know', 'like', 'get', 'got',
  'his', 'her', 'him', 'she', 'he', 'they', 'them', 'its', 'my', 'our',
])

export function buildFTSQuery(query: string): string | null {
  const words = query.toLowerCase().split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ''))
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    .slice(0, 5)
  if (words.length === 0) return null
  // quote each term to prevent FTS operator injection (OR/AND/NOT/NEAR)
  return words.map((w) => `"${w}"`).join(' OR ')
}

function buildRecallContext(query: string, channel: string): string {
  const ftsQuery = buildFTSQuery(query)
  if (!ftsQuery) return ''

  const results = db.searchAskFTS(channel, ftsQuery, 3)
  if (results.length === 0) return ''

  const now = Date.now()
  const lines = results.map((r) => {
    const label = formatAge(r.created_at, now)
    const q = r.query.length > 60 ? r.query.slice(0, 60) + '...' : r.query
    const resp = r.response
      ? (r.response.replace(/---+/g, '').length > 120 ? r.response.replace(/---+/g, '').slice(0, 120) + '...' : r.response.replace(/---+/g, ''))
      : '?'
    return `> [${label}] ${r.username}: "${q}" → you: "${resp}"`
  })

  return `\nPrior exchanges:\n${lines.join('\n')}`
}

// --- chat history recall (search a referenced user's past messages) ---

// only fire recall when query looks like it's asking about past events/other users
const RECALL_INTENT = /\b(did|what did|when did|has|have|was|were|earlier|before|ago|said|told|say|suggest|recommend|mention|talk about|remember when|bring up|ask about|promise|claim|called? me)\b/i

// common english words that could be twitch usernames — skip these in implicit detection
const COMMON_WORDS = new Set([
  'beau', 'grace', 'hope', 'jade', 'max', 'ruby', 'angel', 'chase', 'drew',
  'finn', 'hunter', 'mason', 'nova', 'sage', 'storm', 'wolf', 'bear', 'blade',
  'cash', 'echo', 'fire', 'ghost', 'hawk', 'ice', 'king', 'moon', 'night',
  'rain', 'rock', 'shadow', 'star', 'stone', 'tiger', 'void', 'zero',
  'movie', 'afraid', 'suggest', 'earlier', 'today', 'watch', 'play', 'start',
  'stop', 'chat', 'stream', 'game', 'item', 'card', 'build', 'pick', 'best',
  'worst', 'good', 'bad', 'nice', 'cool', 'love', 'hate', 'want', 'need',
  'time', 'back', 'last', 'next', 'more', 'less', 'long', 'hard', 'easy',
])

function findReferencedUser(query: string, channel: string): string | null {
  const botName = (process.env.TWITCH_USERNAME ?? 'bazaarinfo').toLowerCase()

  // @username explicit — always trust
  const atMatch = query.match(/@([a-zA-Z0-9_]+)/)
  if (atMatch) {
    const name = atMatch[1].toLowerCase()
    if (name !== botName && db.getUserMessagesDetailed(name, channel, 1).length > 0) return name
  }

  // implicit — score candidates by message count, pick the most active
  interface Candidate { name: string; msgs: number }
  const candidates: Candidate[] = []

  for (const word of query.split(/\s+/)) {
    const clean = word.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase()
    if (clean.length < 3 || STOP_WORDS.has(clean) || COMMON_WORDS.has(clean) || clean === botName) continue
    // mixed case or underscores = strong username signal, skip length filter
    const hasUsernameSyntax = /[A-Z].*[a-z]|[a-z].*[A-Z]|_/.test(word.replace(/[^a-zA-Z0-9_]/g, ''))
    if (!hasUsernameSyntax && clean.length < 4) continue
    const stats = db.getUserStats(clean)
    if (stats && (stats.total_commands > 0 || stats.ask_count > 0)) {
      candidates.push({ name: clean, msgs: stats.total_commands + stats.ask_count })
    }
  }

  if (candidates.length === 0) return null
  // pick the most active user (highest message count = most likely to be who they mean)
  candidates.sort((a, b) => b.msgs - a.msgs)
  return candidates[0].name
}

function buildChatRecallFTS(query: string, excludeUser: string): string | null {
  // strip the detected username from FTS terms so search is purely topical
  const words = query.toLowerCase().split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ''))
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && w !== excludeUser)
    .slice(0, 5)
  if (words.length === 0) return null
  return words.map((w) => `"${w}"`).join(' OR ')
}

function buildChatRecall(query: string, channel: string): string {
  // intent gate — skip DB lookups when query isn't asking about past events
  if (!RECALL_INTENT.test(query) && !/@[a-zA-Z0-9_]+/.test(query)) return ''

  const user = findReferencedUser(query, channel)
  if (!user) return ''

  const now = Date.now()
  const lines: string[] = []
  const seen = new Set<string>()

  // topic-specific FTS search by user (excluding username from search terms)
  const ftsQuery = buildChatRecallFTS(query, user)
  if (ftsQuery) {
    for (const h of db.searchChatFTS(channel, ftsQuery, 8, user)) {
      seen.add(h.message)
      lines.push(`[${formatAge(h.created_at, now)}] ${h.username}: ${h.message.replace(/\n/g, ' ')}`)
    }
  }

  // recent messages fallback (covers when FTS keywords don't match)
  if (lines.length < 5) {
    for (const r of db.getUserMessagesDetailed(user, channel, 10)) {
      if (lines.length >= 10) break
      if (seen.has(r.message)) continue
      lines.push(`[${formatAge(r.created_at, now)}] ${r.username}: ${r.message.replace(/\n/g, ' ')}`)
    }
  }

  if (lines.length === 0) return ''
  let text = `Chat history (${user}):\n${lines.join('\n')}`
  if (text.length > 600) text = text.slice(0, 600)
  return text
}

// --- chatters context (compact profiles for everyone in chat, not just asker) ---

function buildChattersContext(chatEntries: ChatEntry[], asker: string, channel: string): string {
  const botName = (process.env.TWITCH_USERNAME ?? 'bazaarinfo').toLowerCase()
  const seen = new Set<string>()
  const users: string[] = []

  for (const entry of chatEntries) {
    const lower = entry.user.toLowerCase()
    if (lower === asker.toLowerCase() || lower === botName || seen.has(lower)) continue
    seen.add(lower)
    users.push(lower)
  }

  if (users.length === 0) return ''

  const profiles: string[] = []
  let totalLen = 0

  for (const user of users.slice(0, 10)) {
    const parts: string[] = []

    // followage — most important identity signal
    try {
      const follow = db.getCachedFollowage(user, channel)
      if (follow?.followed_at) {
        parts.push(`following ${db.formatAccountAge(follow.followed_at).replace(' old', '')}`)
      }
    } catch {}

    // memo first — richest personality data
    try {
      const memo = db.getUserMemo(user)
      if (memo) parts.push(memo.memo)
    } catch {}

    // style profile for regulars
    if (parts.length <= 1) {
      const style = getUserProfile(channel, user)
      if (style) parts.push(style)
    }

    // minimal stats fallback
    if (parts.length <= 1) {
      try {
        const stats = db.getUserStats(user)
        if (stats) {
          if (stats.trivia_wins > 0) parts.push(`${stats.trivia_wins} trivia wins`)
          if (stats.favorite_item) parts.push(`fav: ${stats.favorite_item}`)
        }
      } catch {}
    }

    // facts fallback
    if (parts.length === 0) {
      try {
        const facts = db.getUserFacts(user, 2)
        if (facts.length > 0) parts.push(facts.join(', '))
      } catch {}
    }

    if (parts.length === 0) continue

    const profile = parts.join(', ')
    const entry = `${user}(${profile})`
    if (totalLen + entry.length > 400) break
    profiles.push(entry)
    totalLen += entry.length + 3
  }

  if (profiles.length === 0) return ''
  return `Chatters: ${profiles.join(' | ')}`
}

interface UserMessageResult { text: string; hasGameData: boolean; isPasta: boolean; isRememberReq: boolean }

function buildUserMessage(query: string, ctx: AiContext & { user: string; channel: string }): UserMessageResult {
  const isRememberReq = REMEMBER_RE.test(query) && !isAboutOtherUser(query)
  const chatDepth = ctx.mention ? 15 : 20
  const chatContext = getRecent(ctx.channel, chatDepth)
    .filter((m) => !isNoise(m.text))
  const chatStr = chatContext.length > 0
    ? chatContext.map((m) => {
        const user = m.user.replace(/[:\n]/g, '')
        const text = m.text.replace(/^!\w+\s*/, '').replace(/\n/g, ' ').replace(/^---+/, '').slice(0, 300)
        return `> ${user}: ${text}`
      }).join('\n')
    : ''

  const chattersLine = buildChattersContext(chatContext, ctx.user, ctx.channel)

  const styleLine = getChannelStyle(ctx.channel)
  const contextLine = styleLine ? `\nChannel: ${styleLine}` : ''

  const timeline = buildTimeline(ctx.channel)
  const timelineLine = timeline !== 'No stream history yet' ? `\nStream timeline:\n${timeline}` : ''

  const threads = getActiveThreads(ctx.channel)
  const threadLine = threads.length > 0
    ? `\nActive convos: ${threads.map((t) => `${t.users.join('+')} re: ${t.topic}`).join(' | ')}`
    : ''

  // pre-resolved game data + knowledge (extractEntities also detects game queries)
  const entities = extractEntities(query)

  // channel voice — how chat actually talks (compact for game Qs, full for banter)
  const voiceLine = getChannelVoiceContext(ctx.channel, entities.isGame)
  const voiceBlock = voiceLine ? `\n${voiceLine}` : ''
  let gameBlock = ''
  let hasGameData = false
  if (entities.isGame) {
    const knowledge = entities.knowledge.length > 0
      ? `\nContext:\n${entities.knowledge.join('\n')}`
      : ''
    const gameData = buildGameContext(entities, ctx.channel)
    hasGameData = !!(gameData || knowledge)
    gameBlock = [
      knowledge,
      gameData ? `\nGame data:\n${gameData}` : '',
    ].filter(Boolean).join('')
  }

  // bot stats injection — when someone asks about usage/analytics, give the AI real numbers
  const BOT_STATS_RE = /\b(how many|how much|queries|requests|usage|analytics|traffic|stats|popular|users?|commands?)\b.*\b(you|bot|bazaarinfo|per (min|hour|day)|get|have|serve|handle)\b/i
  let statsLine = ''
  if (BOT_STATS_RE.test(query) || /\b(per (min|hour|day)|qpm|queries per)\b/i.test(query)) {
    try {
      const s = db.getBotStats()
      statsLine = `\nBot stats: ${s.totalUsers} users lifetime, ${s.totalCommands} commands + ${s.totalAsks} AI chats total. Today: ${s.todayCommands} commands, ${s.todayAsks} AI chats, ${s.uniqueToday} unique users.`
    } catch {}
  }

  // activity context — inject stream/YouTube status when someone mentions tracked accounts
  const activityLine = getActivityFor(query)
  const activityBlock = activityLine ? `\nActivity: ${activityLine}` : ''

  // skip reddit digest + emotes when we have specific game data or short queries (saves ~400 tokens)
  const digest = getRedditDigest()
  const skipReddit = hasGameData || query.length < 20
  const redditLine = (!skipReddit && digest) ? `\nCommunity buzz (r/PlayTheBazaar): ${digest}` : ''
  const emoteLine = hasGameData ? '' : '\n' + formatEmotesForAI(ctx.channel, getChannelTopEmotes(ctx.channel), getRecentEmotes(ctx.channel))

  // hot exchange cache — instant follow-up context from this session
  const hot = getHotExchanges(ctx.user)
  const isShortFollowup = query.split(/\s+/).length <= 5 && hot.length > 0
  let hotLine = ''
  if (hot.length > 0) {
    const now = Date.now()
    const lines = hot.map((e) => {
      const ago = Math.round((now - e.ts) / 60_000)
      const label = ago < 1 ? 'just now' : `${ago}m ago`
      return `${label}: "${e.query}" → you: "${e.response}"`
    })
    hotLine = `\nYour recent convo with ${ctx.user}:\n${lines.join('\n')}`
  }

  // contextual recall — FTS search of prior exchanges (skip for short follow-ups where hot cache covers it)
  const recallLine = isShortFollowup ? '' : buildRecallContext(query, ctx.channel)

  // chat history recall — search referenced user's past messages
  const chatRecallLine = buildChatRecall(query, ctx.channel)

  // channel-wide recent responses — anti-repetition across users
  const recentAll = getChannelRecentResponses(ctx.channel)
  // exclude current user's hot exchanges (already shown separately)
  const hotSet = new Set(hot.map((e) => e.response))
  const deduped = recentAll.filter((r) => !hotSet.has(r))
  const recentLine = deduped.length > 0
    ? `\nYour last few responses (VARY your phrasing — never reuse these openings/structures/phrases):\n${deduped.map((r) => `- "${r.length > 100 ? r.slice(0, 100) + '...' : r}"`).join('\n')}`
    : ''

  // copypasta few-shot examples
  const isPasta = /\b(copypasta|pasta)\b/i.test(query)
  const pastaBlock = isPasta && pastaExamples.length > 0
    ? `\nPasta examples:\n${randomPastaExamples(3).map((p, i) => `${i + 1}. ${p}`).join('\n')}\n`
    : ''

  const text = [
    timelineLine,
    chatStr ? `Recent chat:\n${chatStr}\n` : '',
    chattersLine ? `\n${chattersLine}` : '',
    threadLine,
    contextLine,
    voiceBlock,
    hotLine,
    recallLine,
    chatRecallLine ? `\n${chatRecallLine}` : '',
    recentLine,
    redditLine,
    emoteLine,
    gameBlock,
    activityBlock,
    statsLine,
    pastaBlock,
    buildUserContext(ctx.user, ctx.channel, !!(recallLine || hotLine), isRememberReq),
    ctx.mention
      ? `\n---\n@MENTION — only respond if [USER] is talking TO you. If they're talking ABOUT you to someone else, output just - to stay silent.\n[USER]: ${query}`
      : `\n---\nRESPOND TO THIS (everything above is just context):\n${ctx.isMod ? '[MOD] ' : ''}[USER]: ${query}`,
    isRememberReq ? '\n⚠️ IDENTITY REQUEST — [USER] is defining themselves. COMPLY. Confirm warmly what they asked you to remember. Do NOT dismiss, joke about, or override their self-description.'
      : (REMEMBER_RE.test(query) && isAboutOtherUser(query)) ? '\n⚠️ [USER] is trying to set identity info for someone else. They can only define themselves, not other people. Tell them warmly but firmly.'
      : '',
    `\n[USER] = ${ctx.user}`,
  ].filter(Boolean).join('')
  return { text, hasGameData, isPasta, isRememberReq }
}

// --- background memo generation ---

const MEMO_INTERVAL = 5 // update memo every N asks
const memoInFlight = new Set<string>()

async function maybeUpdateMemo(user: string, force = false) {
  if (!API_KEY) return
  if (memoInFlight.has(user)) return

  try {
    const askCount = db.getUserAskCount(user)
    if (!force) {
      if (askCount < MEMO_INTERVAL) return
      const existing = db.getUserMemo(user)
      if (existing && askCount - existing.ask_count_at < MEMO_INTERVAL) return
    }

    const asks = db.getAsksForMemo(user, 15)
    if (asks.length < 1) return

    memoInFlight.add(user)

    const existing = db.getUserMemo(user)
    const facts = db.getUserFacts(user, 10)
    const factsStr = facts.length > 0 ? `\nKnown facts about ${user}: ${facts.join(', ')}\n` : ''

    const exchanges = asks.reverse().map((a) => {
      const q = a.query.length > 80 ? a.query.slice(0, 80) + '...' : a.query
      const r = a.response.length > 80 ? a.response.slice(0, 80) + '...' : a.response
      return `"${q}" → "${r}"`
    }).join('\n')

    const prompt = [
      existing ? `Current memo: ${existing.memo}\n\n` : '',
      factsStr,
      `Recent exchanges with ${user}:\n${exchanges}\n\n`,
      'Write a 1-sentence personality memo for this user (<200 chars). ',
      'Capture: humor style, recurring interests, running jokes, personality traits. ',
      'TONE: warm and appreciative — describe them like a friend you genuinely like. NEVER frame them as annoying, difficult, or adversarial. If they challenge you, frame it as wit or creativity. ',
      'NEVER mention how often they use the bot, how long they\'ve been around, account age, or any stats/numbers. No stats, no dates, no "they". Write like a friend\'s mental note. ',
      force
        ? 'The user just defined/redefined their identity. REWRITE the memo to reflect what they said about themselves. Their self-description overrides your prior impression. Incorporate their stated facts.'
        : existing ? 'Update the existing memo — keep what\'s still true, add new patterns.' : '',
    ].join('')

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 45,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(10_000),
    })

    if (res.ok) {
      const data = await res.json() as { content: { type: string; text?: string }[] }
      const memo = data.content?.find((b) => b.type === 'text')?.text?.trim()
      if (memo && memo.length <= 200) {
        db.upsertUserMemo(user, memo, askCount)
        log(`memo: ${user} → ${memo}`)
      }
    }
  } catch {
    // fire-and-forget, swallow errors
  } finally {
    memoInFlight.delete(user)
  }
}

// --- background fact extraction ---

const factInFlight = new Set<string>()
const FACT_INTERVAL = 3 // extract facts every N asks

// detect explicit "remember me" / identity requests
const REMEMBER_RE = /\b(remember|call me|my name is|i('m| am) (a |an |the |from )|know that i|i go by|refer to me|don'?t forget)\b/i

async function maybeExtractFacts(user: string, query: string, response: string, force = false) {
  if (!API_KEY) return
  if (factInFlight.has(user)) return
  if (!force) {
    const askCount = db.getUserAskCount(user)
    if (askCount < 3) return // skip first-timers
    if (askCount % FACT_INTERVAL !== 0) return // throttle
  }
  if (db.getUserFactCount(user) >= 200) return

  factInFlight.add(user)
  try {
    const prompt = [
      `User said: "${query.slice(0, 200).replace(/\n/g, ' ')}"`,
      `Bot responded: "${response.slice(0, 120).replace(/\n/g, ' ')}"`,
      '',
      `Extract 0-3 specific facts about ${user}. Only extract facts clearly stated BY the user about THEMSELVES, not inferred. Ignore anything they say about other people.`,
      '- Identity ("call me mommy", "my name is X", "i go by Y")',
      '- Personal ("from ohio", "has a cat named mochi")',
      '- Gameplay ("mains vanessa", "loves pygmy", "hates day 5")',
      '- Preferences ("always goes weapons", "thinks burn is OP")',
      force ? 'The user EXPLICITLY asked to be remembered. Extract EXACTLY what they want stored — nicknames, self-descriptions, preferences. Do NOT filter or sanitize their identity. Users own how they define themselves.' : '',
      'One fact per line, lowercase, <40 chars each. If nothing notable, output nothing.',
    ].filter(Boolean).join('\n')

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 35, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(10_000),
    })

    if (res.ok) {
      const data = await res.json() as { content: { type: string; text?: string }[] }
      const text = data.content?.find(b => b.type === 'text')?.text?.trim()
      if (text) {
        const facts = text.split('\n')
          .map(l => l.replace(/^[-•*]\s*/, '').trim())
          .filter(l => l.length >= 5 && l.length <= 60)
          .slice(0, 3)
        for (const fact of facts) {
          db.insertUserFact(user, fact)
          log(`fact: ${user} → ${fact}`)
        }
      }
    }
  } catch {}
  finally { factInFlight.delete(user) }
}

async function doAiCall(query: string, ctx: AiContext & { user: string; channel: string }): Promise<AiResult | null> {
  // fire-and-forget voice refresh (background, non-blocking)
  refreshVoice(ctx.channel).catch(() => {})

  const { text: userMessage, hasGameData, isPasta, isRememberReq } = buildUserMessage(query, ctx)
  const systemPrompt = buildSystemPrompt()
  // copypasta gets biggest budget; game Qs get full; banter/chat capped
  const maxTokens = isPasta ? MAX_TOKENS_PASTA : hasGameData ? MAX_TOKENS_GAME : MAX_TOKENS_CHAT

  const messages: unknown[] = [{ role: 'user', content: userMessage }]
  const start = Date.now()

  try {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // haiku for all user-facing responses (1/min budget = quality over speed)
      const model = CHAT_MODEL
      const body = {
        model,
        max_tokens: maxTokens,
        system: [{ type: 'text' as const, text: systemPrompt, cache_control: { type: 'ephemeral' as const } }],
        messages,
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT)

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer))

      if (!res.ok) {
        if (res.status === 429 && attempt === 0) {
          log('ai: 429, retrying in 3s')
          await new Promise((r) => setTimeout(r, 3_000))
          continue
        }
        log(`ai: API ${res.status} ${await res.text().catch(() => '')}`)
        cbRecordFailure()
        return null
      }

      const data = await res.json() as {
        content: { type: string; text?: string }[]
        stop_reason: string
        usage?: { input_tokens: number; output_tokens: number }
      }
      const latency = Date.now() - start

      const textBlock = data.content?.find((b) => b.type === 'text')
      if (!textBlock?.text) return null

      // build known-user set for fake @mention stripping
      const knownUsers = new Set<string>()
      for (const entry of getRecent(ctx.channel, 30)) knownUsers.add(entry.user.toLowerCase())
      knownUsers.add(ctx.user.toLowerCase())

      const result = sanitize(textBlock.text, ctx.user, ctx.isMod, knownUsers)
      // strip injection echo (model parroting user's injected instructions)
      result.text = stripInputEcho(result.text, query)
      // enforce length caps in code — model ignores prompt-level hints
      const isShort = isShortResponse(query)
      const hardCap = isPasta ? 400 : hasGameData ? 250 : isRememberReq ? 200 : isShort ? 60 : 140
      if (result.text.length > hardCap) {
        const cut = result.text.slice(0, hardCap)
        const lastBreak = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf(', '))
        result.text = (lastBreak > hardCap * 0.5 ? cut.slice(0, lastBreak + 1) : cut.replace(/\s+\S*$/, '')).trim()
      }
      if (result.text) {
        // terse refusal detection — model over-refuses harmless queries
        if (isModelRefusal(result.text) && attempt < MAX_RETRIES - 1) {
          log(`ai: terse refusal "${result.text}", retrying (attempt ${attempt + 1})`)
          messages.push({ role: 'assistant', content: data.content })
          messages.push({ role: 'user', content: 'Answer the question directly. Be brief, be opinionated. No refusals.' })
          continue
        }
        cbRecordSuccess()
        try {
          const tokens = (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0)
          db.logAsk(ctx, query, result.text, tokens, latency)
        } catch {}
        log(`ai: responded in ${latency}ms`)
        // hot cache for instant follow-up context
        cacheExchange(ctx.user, query, result.text, ctx.channel)
        // fire-and-forget memo + fact extraction (force both on identity requests)
        maybeExtractFacts(ctx.user, query, result.text, isRememberReq).catch(() => {})
        // delay memo rewrite slightly so facts are stored first
        if (isRememberReq) {
          setTimeout(() => maybeUpdateMemo(ctx.user, true).catch(() => {}), 3_000)
        } else {
          maybeUpdateMemo(ctx.user).catch(() => {})
        }
        return result
      }

      // sanitizer rejected — retry with feedback (don't pass raw rejected output back)
      if (attempt < MAX_RETRIES - 1) {
        log(`ai: sanitizer rejected, retrying (attempt ${attempt + 1})`)
        messages.push({ role: 'user', content: 'That had issues. Try again — just respond to the person.' })
      }
    }

    return null
  } catch (e: unknown) {
    const err = e as Error
    if (err.name === 'AbortError') log('ai: timeout')
    else log(`ai: error: ${err.message}`)
    cbRecordFailure()
    return null
  }
}
