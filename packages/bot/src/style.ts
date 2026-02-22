import * as db from './db'
import { formatAccountAge } from './db'
import { getEmotesForChannel } from './emotes'
import { log } from './log'

// --- channel style ---

interface ChannelStyle {
  topEmotes: string[]
  profile: string
  regulars: Map<string, string> // username → compact profile
}

const styleCache = new Map<string, ChannelStyle>()
const REFRESH_INTERVAL = 6 * 60 * 60_000 // 6 hours
const lastRefresh = new Map<string, number>()

function countEmotes(messages: string[], knownEmotes: Set<string>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const msg of messages) {
    for (const w of msg.split(/\s+/)) {
      if (knownEmotes.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1)
    }
  }
  return counts
}

function topN(counts: Map<string, number>, n: number): string[] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k)
}

function buildUserProfile(username: string, channel: string, knownEmotes: Set<string>): string {
  const parts: string[] = []

  // user stats from users table
  let stats: db.UserStats | null = null
  try { stats = db.getUserStats(username) } catch {}

  if (stats) {
    // prefer real Twitch account age over first_seen
    const twitchUser = db.getCachedTwitchUser(username)
    if (twitchUser?.account_created_at) {
      parts.push(`account ${formatAccountAge(twitchUser.account_created_at)}`)
    } else if (stats.first_seen) {
      parts.push(`around since ${stats.first_seen.slice(0, 7)}`)
    }
    if (stats.total_commands > 0) parts.push(stats.total_commands > 50 ? 'power user' : 'casual user')
    if (stats.trivia_wins > 0) parts.push(stats.trivia_wins > 10 ? 'trivia regular' : 'plays trivia')
    if (stats.favorite_item) parts.push(`fav: ${stats.favorite_item}`)
  }

  // top items they look up
  let topItems: string[] = []
  try { topItems = db.getUserTopItems(username, 3) } catch {}
  if (topItems.length > 0 && !stats?.favorite_item) {
    parts.push(`into: ${topItems.join(', ')}`)
  }

  // their emote usage
  let userMsgs: string[] = []
  try { userMsgs = db.getUserMessages(username, channel, 200) } catch {}
  if (userMsgs.length > 0) {
    const emoteCounts = countEmotes(userMsgs, knownEmotes)
    const favEmotes = topN(emoteCounts, 3)
    if (favEmotes.length > 0) parts.push(`emotes: ${favEmotes.join(' ')}`)
  }

  return parts.join(', ')
}

function buildStyle(channel: string): ChannelStyle {
  let messages: string[]
  try { messages = db.getChannelMessages(channel, 2000) } catch { messages = [] }

  const knownEmotes = new Set(getEmotesForChannel(channel))

  // channel-wide top emotes
  const emoteCounts = countEmotes(messages, knownEmotes)
  const topEmotes = topN(emoteCounts, 15)

  // channel regulars — profile each
  let regularsRaw: { username: string; msgs: number }[] = []
  try { regularsRaw = db.getChannelRegulars(channel, 15) } catch {}

  const regulars = new Map<string, string>()
  for (const r of regularsRaw) {
    if (r.msgs < 10) continue // skip lurkers
    const profile = buildUserProfile(r.username, channel, knownEmotes)
    if (profile) regulars.set(r.username, profile)
  }

  // build compact channel profile
  const parts: string[] = []
  if (topEmotes.length > 0) parts.push(`Channel emotes: ${topEmotes.join(' ')}`)
  if (regulars.size > 0) parts.push(`Active community`)

  const profile = parts.join('. ')
  if (profile) log(`style #${channel}: ${topEmotes.length} emotes, ${regulars.size} regulars`)

  return { topEmotes, profile, regulars }
}

export function getChannelStyle(channel: string): string {
  ensureCache(channel)
  return styleCache.get(channel)?.profile ?? ''
}

export function getChannelTopEmotes(channel: string): string[] {
  ensureCache(channel)
  return styleCache.get(channel)?.topEmotes ?? []
}



const buildingStyle = new Set<string>()

function ensureCache(channel: string) {
  const now = Date.now()
  const last = lastRefresh.get(channel) ?? 0
  if (now - last > REFRESH_INTERVAL || !styleCache.has(channel)) {
    if (buildingStyle.has(channel)) return // in-flight guard
    buildingStyle.add(channel)
    try {
      const style = buildStyle(channel)
      styleCache.set(channel, style)
      lastRefresh.set(channel, now)
    } finally {
      buildingStyle.delete(channel)
    }
  }
}

export function getUserProfile(channel: string, username: string): string {
  ensureCache(channel)
  return styleCache.get(channel)?.regulars.get(username.toLowerCase()) ?? ''
}

export function preloadStyles(channels: string[]) {
  for (const ch of channels) ensureCache(ch)
  for (const ch of channels) refreshVoice(ch).catch(() => {})
  log(`preloaded style cache for ${channels.length} channels`)
}

// --- channel voice analysis ---

const API_KEY = process.env.ANTHROPIC_API_KEY
const VOICE_MODEL = 'claude-haiku-4-5-20251001'
const VOICE_REFRESH = 6 * 60 * 60_000 // 6 hours

interface VoiceData {
  profile: string
  samples: string[]
  updatedAt: number
}

const voiceData = new Map<string, VoiceData>()
const voiceInFlight = new Set<string>()

function isGoodVoiceSample(msg: string, knownEmotes: Set<string>): boolean {
  const words = msg.split(/\s+/)
  if (words.length < 3) return false
  const nonEmote = words.filter(w => !knownEmotes.has(w))
  return nonEmote.length >= 2
}

export function getChannelVoiceContext(channel: string, compact = false): string {
  const data = voiceData.get(channel.toLowerCase())
  if (!data) return ''
  const parts: string[] = []
  if (data.profile) parts.push(`Voice: ${data.profile}`)
  if (!compact && data.samples.length > 0) {
    parts.push(`Chat voice:\n${data.samples.map(s => `> ${s}`).join('\n')}`)
  }
  return parts.join('\n')
}

export async function refreshVoice(channel: string) {
  const ch = channel.toLowerCase()
  const now = Date.now()
  const existing = voiceData.get(ch)
  if (existing && now - existing.updatedAt < VOICE_REFRESH) return
  if (voiceInFlight.has(ch)) return
  voiceInFlight.add(ch)

  try {
    const raw = db.getVoiceMessages(ch, 500)
    if (raw.length < 20) return

    const botName = (process.env.TWITCH_USERNAME ?? 'bazaarinfo').toLowerCase()
    const knownEmotes = new Set(getEmotesForChannel(ch))
    const good = raw.filter(m =>
      m.username.toLowerCase() !== botName &&
      isGoodVoiceSample(m.message, knownEmotes)
    )
    if (good.length < 10) return

    // diverse samples — 1 per user, shuffled
    const byUser = new Map<string, string[]>()
    for (const m of good) {
      const list = byUser.get(m.username) ?? []
      list.push(m.message)
      byUser.set(m.username, list)
    }

    const samples: string[] = []
    for (const [, msgs] of byUser) {
      if (samples.length >= 10) break
      samples.push(msgs[Math.floor(Math.random() * msgs.length)])
    }

    // haiku voice analysis
    let profile = ''
    const cached = db.getChannelVoiceProfile(ch)

    if (API_KEY && good.length >= 30) {
      const sampleText = good.slice(0, 80).map(m => m.message).join('\n')

      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: VOICE_MODEL,
            max_tokens: 40,
            messages: [{ role: 'user', content: [
              `Analyze these Twitch chat messages from #${channel}:\n`,
              sampleText,
              '\n\nDescribe how to mimic this chat style in <150 chars.',
              '\nFocus: slang, abbreviations, grammar patterns, energy, humor style.',
              '\nWrite as instructions: "use X, do Y, never Z"',
            ].join('') }],
          }),
          signal: AbortSignal.timeout(10_000),
        })

        if (res.ok) {
          const json = await res.json() as { content: { type: string; text?: string }[] }
          const text = json.content?.find(b => b.type === 'text')?.text?.trim()
          if (text && text.length <= 200) {
            profile = text
            db.upsertChannelVoice(ch, profile)
            log(`voice #${ch}: ${profile}`)
          }
        }
      } catch {}
    }

    if (!profile && cached) profile = cached.voice

    voiceData.set(ch, { profile, samples, updatedAt: now })
  } finally {
    voiceInFlight.delete(ch)
  }
}
