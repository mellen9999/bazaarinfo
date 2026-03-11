import * as db from './db'
import { setSummarizer, setSummaryPersister, setLessonExtractor } from './chatbuf'
import type { ChatEntry } from './chatbuf'
import { getUserInfo, getFollowage } from './twitch'
import { getAccessToken } from './auth'
import { AI_CHANNELS, getChannelId } from './ai-cache'
import { REMEMBER_RE } from './ai-context'
import { log } from './log'

const API_KEY = process.env.ANTHROPIC_API_KEY
const MODEL = 'claude-haiku-4-5-20251001'
const TIMEOUT = 15_000
const MAX_LESSONS = 500

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

// --- chat lesson extraction ---

const lessonInFlight = new Set<string>()
const INSTRUCTION_LESSON = /\b(needs? to|should|must|always|never|don'?t|has to|ought to|make sure|ensure)\b/i

async function extractChatLessons(channel: string, recent: ChatEntry[]): Promise<void> {
  if (!API_KEY) return
  if (!AI_CHANNELS.has(channel.toLowerCase())) return
  if (lessonInFlight.has(channel)) return

  let count = db.getChatLessonCount()
  if (count >= MAX_LESSONS) {
    db.pruneZeroHitLessons()
    count = db.getChatLessonCount()
    if (count >= MAX_LESSONS) return
  }

  lessonInFlight.add(channel)
  try {
    const chatLines = recent.map((m) => `${m.user}: ${m.text}`).join('\n')
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 150,
        messages: [{ role: 'user', content: `Extract 0-4 cultural insights from this Twitch chat. Focus on: slang meanings, emote usage patterns, platform conventions, communication norms, inside jokes. Exclude: game facts, user-specific info, obvious/universal things.

Each insight = one short line (10-80 chars). Output ONLY the insights, one per line. If nothing interesting, output nothing.

Chat:
${chatLines}` }],
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    })

    if (!res.ok) return
    const data = await res.json() as { content: { text: string }[] }
    const text = data.content?.[0]?.text ?? ''
    const lines = text.split('\n')
      .map((l) => l.replace(/^[-•*\d.)\s]+/, '').trim())
      .filter((l) => l.length >= 10 && l.length <= 80)
      .filter((l) => !INSTRUCTION_LESSON.test(l))
      .slice(0, 4)

    for (const lesson of lines) {
      try {
        const ftsQuery = lesson.split(/\s+/).slice(0, 4).map((w) => `"${w.replace(/"/g, '')}"`).join(' ')
        const existing = db.searchChatLessonsFTS(ftsQuery, 1)
        if (existing.length > 0) continue
      } catch {}
      db.insertChatLesson(lesson)
      log(`lesson: ${lesson}`)
    }
  } catch (e) {
    log(`lesson extraction error (${channel}): ${e}`)
  } finally {
    lessonInFlight.delete(channel)
  }
}

export function initLearner() {
  setLessonExtractor(extractChatLessons)
}

// --- background memo generation ---

const MEMO_INTERVAL = 3
const memoInFlight = new Set<string>()

export async function maybeUpdateMemo(user: string, force = false) {
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
        max_tokens: 80,
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
const FACT_INTERVAL = 3

export async function maybeExtractFacts(user: string, query: string, response: string, force = false) {
  if (!API_KEY) return
  if (factInFlight.has(user)) return
  if (!force) {
    const askCount = db.getUserAskCount(user)
    if (askCount < 3) return
    if (askCount % FACT_INTERVAL !== 0) return
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
      body: JSON.stringify({ model: MODEL, max_tokens: 60, messages: [{ role: 'user', content: prompt }] }),
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
        const INSTRUCTION_FACT = /\b(needs? to (know|respond|answer|be|act|sound|say|learn|have)|just (respond|be|act|sound|talk|answer)|don'?t (sound|act|be|look|seem) like|don'?t be (a |so |too )|should (know|respond|answer|be|sound))\b/i
        for (const fact of facts) {
          if (INSTRUCTION_FACT.test(fact)) continue
          db.insertUserFact(user, fact)
          log(`fact: ${user} → ${fact}`)
        }
      }
    }
  } catch {}
  finally { factInFlight.delete(user) }
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
      if (!db.getCachedTwitchUser(user)) {
        const info = await getUserInfo(token, clientId, user)
        if (info) {
          db.setCachedTwitchUser(user, info.id, info.display_name, info.created_at)

          const broadcasterId = getChannelId(channel)
          if (broadcasterId && !db.getCachedFollowage(user, channel)) {
            const followedAt = await getFollowage(token, clientId, info.id, broadcasterId)
            db.setCachedFollowage(user, channel, followedAt)
          }
        }
      } else {
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
