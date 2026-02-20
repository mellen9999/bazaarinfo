import * as db from './db'
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
    const since = stats.first_seen?.slice(0, 7) ?? '?'
    parts.push(`since ${since}`)
    if (stats.total_commands > 0) parts.push(`${stats.total_commands} lookups`)
    if (stats.trivia_wins > 0) parts.push(`${stats.trivia_wins}W trivia`)
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
  if (regulars.size > 0) parts.push(`${regulars.size} regulars profiled`)

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



function ensureCache(channel: string) {
  const now = Date.now()
  const last = lastRefresh.get(channel) ?? 0
  if (now - last > REFRESH_INTERVAL || !styleCache.has(channel)) {
    const style = buildStyle(channel)
    styleCache.set(channel, style)
    lastRefresh.set(channel, now)
  }
}

export function preloadStyles(channels: string[]) {
  for (const ch of channels) ensureCache(ch)
  log(`preloaded style cache for ${channels.length} channels`)
}
