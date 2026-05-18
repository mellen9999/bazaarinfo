import * as store from './store'
import * as db from './db'
import { getRedditDigest } from './reddit'
import { getTopicalDigest } from './topical'
import { getActivityFor } from './activity'
import { getRecent, getSummary, getActiveThreads } from './chatbuf'
import type { ChatEntry } from './chatbuf'
import { formatEmotesForAI, getEmotesForChannel } from './emotes'
import { getDescriptions } from './emote-describe'
import { getChannelStyle, getUserProfile, getChannelVoiceContext } from './style'
import { formatAge, getHotExchanges, getChannelRecentResponses, getRecentEmotes } from './ai-cache'
import { maybeFetchTwitchInfo } from './ai-background'
import type { AiContext } from './ai'
import {
  extractEntities, serializeCard, serializeMonster,
  buildFTSQuery, buildFTSQueryLoose,
  RECALL_INTENT, STOP_WORDS, COMMON_WORDS,
  findReferencedUser, buildChatRecallFTS,
  REMEMBER_RE, isAboutOtherUser, isNoise, parseChatTimeWindow,
  ResolvedEntities,
} from './ai-query'
import { randomPastaExamples } from './ai-prompt'
import { log } from './log'

// --- game context builder ---

export function buildGameContext(entities: ResolvedEntities, channel?: string): string {
  const sections: string[] = []

  const isBroadHeroQ = !entities.hero && entities.cards.length === 0 && entities.monsters.length === 0
  const isComparisonQ = /\b(tier\s*list|ranking|rank|compare|best|worst|strongest|weakest|meta|patch)\b/i.test(
    entities.effects.join(' '),
  )
  if (isBroadHeroQ || (entities.hero && isComparisonQ)) {
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
      if (isComparisonQ || heroItems.length > 30) {
        const tagCounts = new Map<string, number>()
        for (const c of heroItems) {
          for (const t of c.DisplayTags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
          for (const t of c.HiddenTags) {
            if (!t.endsWith('Reference')) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
          }
        }
        const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
        sections.push(`${entities.hero} (${heroItems.length} items): ${sorted.map(([t, n]) => `${t}(${n})`).join(', ')}`)
        const exclusive = heroItems.filter((c) => !c.Heroes.includes('Common'))
        const sample = exclusive.slice(0, 5)
        for (const card of sample) sections.push(serializeCard(card))
      } else {
        sections.push(`${entities.hero} items: ${heroItems.map((c) => c.Title).join(', ')}`)
      }
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
      if (noNamedEntities || entities.hero) {
        const already = new Set(entities.cards.map((c) => c.Title))
        for (const card of effectResults) {
          if (!already.has(card.Title)) sections.push(serializeCard(card))
        }
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

// --- user context builder ---

export function buildUserContext(user: string, channel: string, skipAsks = false, suppressMemo = false): string {
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

export function buildTimeline(channel: string): string {
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

// --- contextual recall ---

export function buildRecallContext(query: string, channel: string): string {
  const ftsQuery = buildFTSQuery(query)
  if (!ftsQuery) return ''

  let results = db.searchAskFTS(channel, ftsQuery, 3)
  if (results.length === 0) {
    const loose = buildFTSQueryLoose(query)
    if (loose && loose !== ftsQuery) results = db.searchAskFTS(channel, loose, 3)
  }
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

// --- chat history recall ---

export function buildChatRecall(query: string, channel: string, asker?: string): string {
  if (!RECALL_INTENT.test(query) && !/@[a-zA-Z0-9_]+/.test(query)) return ''

  let user = findReferencedUser(query, channel)
  // first-person pronouns ("i sent you", "my messages", "me") → asker is the target
  if (!user && asker && /\b(i\s|my\s|me\b|i'v?e?\b|myself)\b/i.test(query)) {
    user = asker.toLowerCase()
  }
  if (!user) return ''

  const timeWindow = parseChatTimeWindow(query)

  const countIntent = /\b(how many|how often|count|times|frequently|frequency)\b/i.test(query)
  if (countIntent && timeWindow) {
    const totalMsgs = db.countUserMessages(user, channel, timeWindow.sinceExpr)
    const wordMatch = query.match(/(?:say|said|type|typed|wrote|write|mention|spam)\s+["']?([^"'?,!.]+)["']?/i)
      ?? query.match(/"([^"]+)"/)
      ?? query.match(/'([^']+)'/)
    let statsLine = `${user} stats (${timeWindow.label.replace(/'s?$/, '')}): ${totalMsgs} total messages`
    if (wordMatch) {
      const searchWord = wordMatch[1].trim()
      const wordCount = db.countUserWordUsage(user, channel, searchWord, timeWindow.sinceExpr)
      statsLine += `, "${searchWord}" appears in ${wordCount} messages`
    }
    const samples = db.getUserMessagesSince(user, channel, timeWindow.sinceExpr, 2000)
    if (wordMatch && samples.length > 0) {
      const searchLower = wordMatch[1].trim().toLowerCase()
      const matching = samples.filter((m) => m.toLowerCase().includes(searchLower)).slice(-5)
      if (matching.length > 0) {
        statsLine += `\nSample matches:\n${matching.map((m) => `> ${user}: ${m.replace(/\n/g, ' ').slice(0, 200)}`).join('\n')}`
      }
    }
    return statsLine
  }

  const wantsOldest = /\b(earliest|first|oldest)\b/i.test(query)

  const now = Date.now()
  const lines: string[] = []
  const seen = new Set<string>()

  const ftsQuery = buildChatRecallFTS(query, user)
  if (ftsQuery && !wantsOldest) {
    for (const h of db.searchChatFTS(channel, ftsQuery, 8, user)) {
      seen.add(h.message)
      lines.push(`[${formatAge(h.created_at, now)}] ${h.username}: ${h.message.replace(/\n/g, ' ')}`)
    }
  }

  if (lines.length < 5) {
    const detailed = wantsOldest
      ? db.getUserMessagesOldest(user, channel, 10)
      : db.getUserMessagesDetailed(user, channel, 10)
    for (const r of detailed) {
      if (lines.length >= 10) break
      if (seen.has(r.message)) continue
      lines.push(`[${formatAge(r.created_at, now)}] ${r.username}: ${r.message.replace(/\n/g, ' ')}`)
    }
  }

  if (lines.length === 0) return ''
  let text = `Chat history (${user}):\n${lines.join('\n')}`
  if (text.length > 1200) text = text.slice(0, 1200)
  return text
}

// --- chatters context ---

export function buildChattersContext(chatEntries: ChatEntry[], asker: string, channel: string): string {
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

    try {
      const follow = db.getCachedFollowage(user, channel)
      if (follow?.followed_at) {
        parts.push(`following ${db.formatAccountAge(follow.followed_at).replace(' old', '')}`)
      }
    } catch {}

    try {
      const memo = db.getUserMemo(user)
      if (memo) parts.push(memo.memo)
    } catch {}

    if (parts.length <= 1) {
      const style = getUserProfile(channel, user)
      if (style) parts.push(style)
    }

    if (parts.length <= 1) {
      try {
        const stats = db.getUserStats(user)
        if (stats) {
          if (stats.trivia_wins > 0) parts.push(`${stats.trivia_wins} trivia wins`)
          if (stats.favorite_item) parts.push(`fav: ${stats.favorite_item}`)
        }
      } catch {}
    }

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

// --- user message builder ---

export interface UserMessageResult { text: string; hasGameData: boolean; isPasta: boolean; isCreative: boolean; isContinuation: boolean; isRememberReq: boolean }

// Hard cap so Recent chat always fits the section budget — trim oldest first.
// Without this, a flood of long copypastas can blow past the section budget,
// the whole Recent-chat block gets skipped, and the bot says "chat's dead".
const CHAT_BLOCK_CAP = 1800

function buildChatStr(entries: ChatEntry[]): string {
  if (entries.length === 0) return ''
  const lines = entries.map((m) => {
    const user = m.user.replace(/[:\n]/g, '')
    const text = m.text.replace(/^!\w+\s*/, '').replace(/\n/g, ' ').replace(/^---+/, '')
      .replace(/\b(Game data|Recent chat|Stream timeline|Who's chatting|Channel|Your prior exchanges|Chat culture|Bot stats|Chatters|Context|Activity|Community buzz|Prior exchanges|Chat history|BURNED references|Your recent convo with|Your recent responses|Active convos|Memory|Facts|All channel emotes|Chat voice|Voice|Pasta examples):/gi, '')
      .slice(0, 300)
    return `> ${user}: ${text}`
  })
  const header = 'Recent chat:\n'
  let total = header.length + 1
  const kept: string[] = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const lineLen = lines[i].length + 1
    if (total + lineLen > CHAT_BLOCK_CAP && kept.length > 0) break
    kept.unshift(lines[i])
    total += lineLen
  }
  return kept.join('\n')
}

export function buildUserMessage(query: string, ctx: AiContext & { user: string; channel: string }): UserMessageResult {
  const isRememberReq = REMEMBER_RE.test(query) && !isAboutOtherUser(query)
  const chatDepth = ctx.mention ? 25 : 15
  const botName = (process.env.TWITCH_USERNAME ?? 'bazaarinfo').toLowerCase()
  const chatContext = getRecent(ctx.channel, chatDepth)
    .filter((m) => !isNoise(m.text) && m.user.toLowerCase() !== botName)
  const chatStr = buildChatStr(chatContext)

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

  // chat culture lessons — skip for game queries (saves tokens)
  let lessonsLine = ''
  if (!entities.isGame) {
    try {
      const lessons = db.getTopChatLessons(5)
      if (lessons.length > 0) {
        lessonsLine = `\nChat culture:\n${lessons.map((l) => `- ${l.lesson}`).join('\n')}`
        setImmediate(() => {
          for (const l of lessons) db.bumpChatLesson(l.id)
        })
      }
    } catch {}
  }

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

  // bot stats injection
  const BOT_STATS_RE = /\b(how many|how much|queries|requests|usage|analytics|traffic|stats|popular|users?|commands?)\b.*\b(you|bot|bazaarinfo|per (min|hour|day)|get|have|serve|handle)\b/i
  let statsLine = ''
  if (BOT_STATS_RE.test(query) || /\b(per (min|hour|day)|qpm|queries per)\b/i.test(query)) {
    try {
      const s = db.getBotStats()
      statsLine = `\nBot stats: ${s.totalUsers} users lifetime, ${s.totalCommands} commands + ${s.totalAsks} AI chats total. Today: ${s.todayCommands} commands, ${s.todayAsks} AI chats, ${s.uniqueToday} unique users.`
    } catch {}
  }

  // activity context
  const activityLine = getActivityFor(query)
  const activityBlock = activityLine ? `\nActivity: ${activityLine}` : ''

  // skip reddit digest + emotes when we have specific game data or short queries
  const digest = getRedditDigest()
  const skipReddit = hasGameData || query.length < 20
  const redditLine = (!skipReddit && digest) ? `\nCommunity buzz (r/PlayTheBazaar): ${digest}` : ''
  const emoteLine = hasGameData ? '' : '\n' + formatEmotesForAI(ctx.channel, getRecentEmotes(ctx.channel))

  // hot exchange cache
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
  const isContinuationLike = /\b(continue|extend|expand|keep going|more of that|expand on|next part|part \d)\b/i.test(query) && hot.length > 0

  // contextual recall
  const recallLine = isShortFollowup ? '' : buildRecallContext(query, ctx.channel)

  // chat history recall
  const chatRecallLine = buildChatRecall(query, ctx.channel, ctx.user)

  // channel-wide recent responses — anti-repetition
  const recentAll = getChannelRecentResponses(ctx.channel)
  const hotSet = new Set(hot.map((e) => e.response))
  const deduped = recentAll.filter((r) => !hotSet.has(r))
  // extract referenced chatters and quoted phrases from recent responses — burned material
  const burnedNames = new Set<string>()
  const burnedQuotes = new Set<string>()
  for (const r of deduped) {
    for (const m of r.matchAll(/@(\w+)/g)) burnedNames.add(m[1].toLowerCase())
    // extract names used as subjects (word at start or after period/comma)
    for (const m of r.matchAll(/(?:^|[.,]\s+)(\w{3,20})\s+(?:wins?|said|just|is|was|has|had|does|did)\b/gi)) {
      const name = m[1].toLowerCase()
      if (!/^(the|this|that|what|who|how|but|and|not|its|you|dude|bro|man)$/.test(name)) burnedNames.add(name)
    }
    for (const m of r.matchAll(/"([^"]{8,60})"/g)) burnedQuotes.add(m[1])
  }
  const burnedLine = burnedNames.size > 0
    ? `\nBURNED references (pick DIFFERENT chatters/quotes): ${[...burnedNames].join(', ')}${burnedQuotes.size > 0 ? ` | quotes: ${[...burnedQuotes].slice(0, 5).map(q => `"${q}"`).join(', ')}` : ''}`
    : ''
  const recentLine = deduped.length > 0
    ? `\nYour recent responses (NEVER reuse specific phrases, punchlines, item combos, or scenarios from these — even if a similar question comes up, find a completely different angle. only continue a theme if [USER]'s message explicitly references it):\n${deduped.map((r) => `- "${r.length > 200 ? r.slice(0, 200) + '...' : r}"`).join('\n')}${burnedLine}`
    : ''

  // copypasta few-shot examples
  const isPasta = /\b(copypasta|pasta)\b/i.test(query)
  const isCreative = isPasta || isContinuationLike || /\b(continue|extend|expand|write|make|create|do)\b.{0,20}\b(scene|story|bit|narrative|fanfic|monologue|rant|copypasta|pasta|lore|saga)\b/i.test(query)
    || /\b(do the \w+test|plebtest|emote\s*(wall|spam|test)|wall of (emotes|text)|spam\s+(all|every)\s+emote|paste\b|give me a wall|as many\s*(times|as)\s*(you|u|ur)|\bspam\s+\w+\b|\brepeat\b.{0,15}\b(times|emote))\b/i.test(query)
  const fullEmoteLine = isCreative ? `\nAll channel emotes: ${getEmotesForChannel(ctx.channel).join(' ')}` : ''

  // detect emotes mentioned in query — give AI their descriptions so it can incorporate them
  let queryEmoteLine = ''
  if (isCreative) {
    const descriptions = getDescriptions()
    const channelEmotes = getEmotesForChannel(ctx.channel)
    const queryWords = query.split(/\s+/)
    const found: string[] = []
    for (const word of queryWords) {
      // case-insensitive match against channel emotes
      const match = channelEmotes.find((e) => e.toLowerCase() === word.toLowerCase())
      if (match && descriptions[match]) {
        found.push(`${match}: ${descriptions[match].desc} (${descriptions[match].mood})`)
      }
    }
    if (found.length > 0) {
      queryEmoteLine = `\nEmotes in request — FEATURE these prominently: ${found.join(', ')}`
    }
  }

  const recentPastas = isPasta
    ? deduped.filter((r) => r.length > 150).map((r) => `- ALREADY USED: "${r}"`)
    : []
  let todayWordsBlock = ''
  if (isPasta) {
    const timeWindow = parseChatTimeWindow(query)
    if (timeWindow) {
      try {
        const msgs = db.getChannelMessagesSince(ctx.channel, timeWindow.sinceExpr)
        if (msgs.length > 0) {
          const wordSet = new Set<string>()
          for (const msg of msgs) {
            if (msg.startsWith('!') || msg.startsWith('/')) continue
            for (const w of msg.split(/\s+/)) {
              const clean = w.replace(/[^a-zA-Z']/g, '').toLowerCase()
              if (clean.length >= 2) wordSet.add(clean)
            }
          }
          const words = [...wordSet].slice(0, 500)
          todayWordsBlock = `\n${timeWindow.label} chat word pool (${msgs.length} messages, ${words.length} unique words — USE ONLY THESE WORDS):\n${words.join(', ')}\n`
        }
      } catch {}
    }
  }

  const pastaExs = isPasta ? randomPastaExamples(3) : []
  const pastaBlock = isPasta && pastaExs.length > 0
    ? `\nPasta voice samples (match pacing/density/punchline geometry — IGNORE subject matter):\n${pastaExs.map((p, i) => `${i + 1}. ${p}`).join('\n')}${recentPastas.length > 0 ? `\n\nDO NOT reuse these premises/setups:\n${recentPastas.join('\n')}` : ''}\n`
    : ''

  // topical world-knowledge digest — fresh news/memes for creative path
  const topical = getTopicalDigest()
  const topicalLine = (isCreative && topical) ? `\nWorld pulse (recent — pull from this for topical jokes/references):\n${topical}\n` : ''

  // build context sections in priority order
  const requiredTail = [
    isContinuationLike ? `\n⚠️ SCENE CONTINUATION — [USER] asked for more. OVERRIDES one-and-done. This is turn ${hot.length + 1}. Each turn SHIFT AXIS — change at least one: setting, POV, format (action/dialogue/montage/letter/news/court transcript), stakes, genre (noir/sci-fi/horror/romance/heist), tempo. NEVER rehash. NEVER recycle the same beat with new words. Compound escalation: fistfight → duel → war → reckoning. ${hot.length >= 3 ? 'TURN 4+: linear escalation is exhausted — HARD CUT. timejump (years pass / future), dimension shift (alt reality / dream), genre flip, or new generation of the same characters. reset the stakes ladder. ' : ''}Pull from real-world (2025-2026 news, pop culture, history, science, internet). 400 chars.` : '',
    buildUserContext(ctx.user, ctx.channel, !!(recallLine || hotLine), isRememberReq),
    ctx.mention
      ? `\n---\n@MENTION — only respond if [USER] is talking TO you. If about you to someone else, output -\n[USER]: ${query}`
      : `\n---\n${ctx.isMod ? '[MOD] ' : ''}[USER]: ${query}`,
    isRememberReq ? '\n⚠️ IDENTITY REQUEST — [USER] is defining themselves. COMPLY. Confirm warmly what they asked you to remember. Do NOT dismiss, joke about, or override their self-description.'
      : (REMEMBER_RE.test(query) && isAboutOtherUser(query)) ? '\n⚠️ [USER] is trying to set identity info for someone else. They can only define themselves, not other people. Tell them warmly but firmly.'
      : '',
    `\n[USER] = ${ctx.user}`,
  ].filter(Boolean).join('')

  // trimmable sections in priority order.
  // Recent chat is first: it's the bot's primary social context. Without it the model
  // hallucinates "chat is dead" or fabricates chatter names. CHAT_BLOCK_CAP keeps it
  // bounded so it never starves the rest.
  const sections: { name: string; text: string }[] = [
    { name: 'recentChat', text: chatStr ? `Recent chat:\n${chatStr}\n` : '' },
    { name: 'gameBlock', text: gameBlock },
    { name: 'hotConvo', text: hotLine },
    { name: 'chatters', text: chattersLine ? `\n${chattersLine}` : '' },
    { name: 'recentResponses', text: recentLine },
    { name: 'pastaBlock', text: pastaBlock },
    { name: 'queryEmotes', text: queryEmoteLine },
    { name: 'fullEmotes', text: fullEmoteLine },
    { name: 'emotes', text: emoteLine },
    { name: 'topical', text: topicalLine },
    { name: 'todayWords', text: todayWordsBlock },
    { name: 'recall', text: recallLine },
    { name: 'chatRecall', text: chatRecallLine ? `\n${chatRecallLine}` : '' },
    { name: 'timeline', text: timelineLine },
    { name: 'threads', text: threadLine },
    { name: 'channelStyle', text: contextLine },
    { name: 'voice', text: voiceBlock },
    { name: 'lessons', text: lessonsLine },
    { name: 'activity', text: activityBlock },
    { name: 'botStats', text: statsLine },
    { name: 'reddit', text: redditLine },
  ].filter((s) => s.text)

  // cap total user message at ~3500 chars (excluding required tail)
  const USER_MSG_CAP = 3500
  const tailLen = requiredTail.length
  let budget = USER_MSG_CAP - tailLen
  const included: string[] = []
  const dropped: string[] = []
  for (const section of sections) {
    if (budget <= 0) { dropped.push(section.name); continue }
    if (section.text.length <= budget) {
      included.push(section.text)
      budget -= section.text.length
    } else {
      dropped.push(section.name)
    }
  }
  if (dropped.length > 0) {
    log(`prompt: budget skipped sections [${dropped.join(',')}] (cap=${USER_MSG_CAP} tail=${tailLen} q="${query.slice(0, 40)}")`)
  }

  const text = included.join('') + requiredTail
  return { text, hasGameData, isPasta, isCreative, isContinuation: isContinuationLike, isRememberReq }
}
