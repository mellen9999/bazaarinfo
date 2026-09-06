// Everything Helix tells an app token about a chatter, fetched on demand: their own
// channel (what they stream, the title, live right now, the last vod), their bio and
// partner/affiliate status, and their followage on any channel the bot moderates —
// not just the one they're typing in. "does X stream", "what does X play", "how long has
// X followed rogue" used to be answered from nothing.
//
// What Helix will NOT give any bot: followage on a channel the bot isn't a moderator of
// (channels/followers needs that channel's moderator scope), who a user follows, their
// sub status, their watch time. Those stay unknown and the bot says so.
//
// Fail-soft: every export returns null/'' on any failure, nothing here is awaited by a
// reply — asks prefetch in the background and the next ask lands warm.

import { getAccessToken, hasScope } from './auth'
import { getUserInfo, getFollowage } from './twitch'
import { getChannelId, getJoinedChannels, formatAge, isBotModIn } from './ai-cache'
import * as db from './db'
import { log } from './log'

const HELIX_URL = 'https://api.twitch.tv/helix'
const TTL_MS = 60 * 60 * 1000
const MAX_ENTRIES = 500
const FETCH_TIMEOUT_MS = 8_000

export interface ChannelSnapshot {
  login: string
  fetchedAt: number
  description: string
  broadcasterType: '' | 'affiliate' | 'partner'
  game: string
  title: string
  live: boolean
  viewers: number
  startedAt: string
  lastVodAt: string
  lastVodTitle: string
  lastVodDuration: string
}

const snapshots = new Map<string, ChannelSnapshot>()
const inflight = new Set<string>()
// a failed or empty read is not retried per ask — helix 429s would otherwise make the bot
// retry harder. keyed like inflight; the entry expires on its own.
const MISS_TTL_MS = 10 * 60 * 1000
const missUntil = new Map<string, number>()
function missed(key: string): boolean {
  const until = missUntil.get(key)
  if (until === undefined) return false
  if (Date.now() < until) return true
  missUntil.delete(key)
  return false
}
function noteMiss(key: string): void {
  missUntil.set(key, Date.now() + MISS_TTL_MS)
  if (missUntil.size > MAX_ENTRIES) {
    const first = missUntil.keys().next().value
    if (first) missUntil.delete(first)
  }
}

// an ask about someone's own streaming, not the channel we're in
export const STREAMER_ASK_RE = /\b(?:stream(?:s|ing|er|ed)?|channel|vods?|broadcasts?|partner(?:ed)?|affiliate|live)\b/i
export const FOLLOW_ASK_RE = /\bfollow(?:age|ing|ed|ers?|s)?\b/i

/** followers is a moderator-scoped read: the token needs the scope AND we must be a mod there. */
export function canReadFollowage(channel: string): boolean {
  return hasScope('moderator:read:followers') && isBotModIn(channel)
}

export function isStreamerAsk(query: string): boolean {
  return STREAMER_ASK_RE.test(query)
}

/** a joined channel the ask names, other than the one it was typed in. */
export function channelNamedIn(query: string, current: string, joined: string[] = getJoinedChannels()): string | null {
  const q = query.toLowerCase()
  for (const ch of joined) {
    const name = ch.toLowerCase()
    if (name === current.toLowerCase()) continue
    if (new RegExp(`(?:^|[^a-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9_])`).test(q)) return name
  }
  return null
}

async function helix<T>(path: string): Promise<T | null> {
  let token: string
  try { token = getAccessToken() } catch { return null }
  const clientId = process.env.TWITCH_CLIENT_ID
  if (!clientId) return null
  try {
    const res = await fetch(`${HELIX_URL}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    return (await res.json() as { data: T }).data
  } catch {
    return null
  }
}

interface HelixUser { id: string; login: string; description?: string; broadcaster_type?: string; created_at: string }
interface HelixChannel { game_name?: string; title?: string }
interface HelixStream { viewer_count?: number; started_at?: string; game_name?: string; title?: string }
interface HelixVideo { created_at?: string; title?: string; duration?: string }

async function fetchSnapshot(login: string): Promise<ChannelSnapshot | null> {
  const users = await helix<HelixUser[]>(`users?login=${encodeURIComponent(login)}`)
  const u = users?.[0]
  if (!u) return null
  // the three reads are independent — one round trip of latency, not three
  const [channels, streams, videos] = await Promise.all([
    helix<HelixChannel[]>(`channels?broadcaster_id=${u.id}`),
    helix<HelixStream[]>(`streams?user_id=${u.id}`),
    helix<HelixVideo[]>(`videos?user_id=${u.id}&first=1&type=archive`),
  ])
  // a failed read (null) is not "no data" ([]): asserting "has never streamed" or "not
  // live" off a timeout would be a lie about a real streamer. miss instead, retry later.
  if (!channels || !streams || !videos) return null
  const c = channels[0]
  const s = streams[0]
  const v = videos[0]
  const bt = u.broadcaster_type === 'affiliate' || u.broadcaster_type === 'partner' ? u.broadcaster_type : ''
  return {
    login: login.toLowerCase(),
    fetchedAt: Date.now(),
    description: (u.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 140),
    broadcasterType: bt,
    game: s?.game_name || c?.game_name || '',
    title: (s?.title || c?.title || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    live: !!s,
    viewers: s?.viewer_count ?? 0,
    startedAt: s?.started_at ?? '',
    lastVodAt: v?.created_at ?? '',
    lastVodTitle: (v?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
    lastVodDuration: shortDuration(v?.duration ?? ''),
  }
}

/** "2h41m3s" → "2h41m"; "47m12s" → "47m" */
export function shortDuration(d: string): string {
  const h = /(\d+)h/.exec(d)?.[1]
  const m = /(\d+)m/.exec(d)?.[1]
  if (h) return `${h}h${m ? m.padStart(2, '0') + 'm' : ''}`
  return m ? `${m}m` : ''
}

/** non-blocking; the ask that triggers it answers from whatever is cached. */
export function maybeFetchChannelSnapshot(login: string): void {
  const key = login.toLowerCase()
  const have = snapshots.get(key)
  if (have && Date.now() - have.fetchedAt < TTL_MS) return
  if (inflight.has(key) || missed(key)) return
  inflight.add(key)
  fetchSnapshot(key)
    .then((snap) => {
      if (!snap) { noteMiss(key); return }
      snapshots.set(key, snap)
      if (snapshots.size > MAX_ENTRIES) {
        let oldest: string | undefined
        let oldestAt = Infinity
        for (const [k, v] of snapshots) if (v.fetchedAt < oldestAt) { oldestAt = v.fetchedAt; oldest = k }
        if (oldest) snapshots.delete(oldest)
      }
    })
    .catch((e) => { noteMiss(key); log(`twitch-profile: ${key} failed: ${e}`) })
    .finally(() => { inflight.delete(key) })
}

export function getChannelSnapshot(login: string): ChannelSnapshot | null {
  const snap = snapshots.get(login.toLowerCase())
  return snap && Date.now() - snap.fetchedAt < TTL_MS ? snap : null
}

/** the context line: what they stream and when they last did. '' when nothing is known. */
export function formatChannelSnapshot(s: ChannelSnapshot, now = Date.now()): string {
  const bits: string[] = []
  if (s.broadcasterType) bits.push(`twitch ${s.broadcasterType}`)
  if (s.live) {
    bits.push(`LIVE right now${s.game ? ` playing ${s.game}` : ''} to ${s.viewers} viewers${s.title ? ` ("${s.title}")` : ''}`)
  } else if (s.lastVodAt) {
    const iso = s.lastVodAt.replace('Z', '')
    bits.push(`streams${s.game ? ` ${s.game}` : ''}, last live ${formatAge(iso, now)}${s.lastVodDuration ? ` (${s.lastVodDuration})` : ''}${s.lastVodTitle ? ` "${s.lastVodTitle}"` : ''}`)
  } else if (s.game || s.title) {
    bits.push(`channel set to ${s.game || 'no game'}${s.title ? ` "${s.title}"` : ''}, no vods`)
  } else {
    bits.push('has never streamed')
  }
  if (s.description) bits.push(`bio: "${s.description}"`)
  return bits.join('; ')
}

export function getChannelSnapshotLine(login: string): string {
  const s = getChannelSnapshot(login)
  return s ? formatChannelSnapshot(s) : ''
}

/**
 * followage on ANOTHER channel the bot moderates. non-blocking, same db cache as the
 * current-channel followage (channel_follows), so the reader in buildUserContext needs
 * no new path — it just asks for the named channel instead of the current one.
 */
export function maybeFetchFollowageFor(user: string, channel: string): void {
  const key = `${user.toLowerCase()}@${channel.toLowerCase()}`
  if (!canReadFollowage(channel)) return
  if (inflight.has(key) || missed(key)) return
  const broadcasterId = getChannelId(channel)
  if (!broadcasterId) return
  if (db.getCachedFollowage(user, channel)) return
  inflight.add(key)
  ;(async () => {
    let done = false
    try {
      let token: string
      try { token = getAccessToken() } catch { return }
      const clientId = process.env.TWITCH_CLIENT_ID
      if (!clientId) return
      const cached = db.getCachedTwitchUser(user)
      const userId = cached?.twitch_id ?? (await getUserInfo(token, clientId, user))?.id
      if (!userId) return
      const followedAt = await getFollowage(token, clientId, userId, broadcasterId)
      if (followedAt === undefined) return
      db.setCachedFollowage(user, channel, followedAt)
      done = true
    } catch (e) {
      log(`twitch-profile: followage ${key} failed: ${e}`)
    } finally {
      if (!done) noteMiss(key)
      inflight.delete(key)
    }
  })()
}

/** test seam */
export function __setSnapshotForTest(login: string, snap: ChannelSnapshot | null): void {
  if (snap) snapshots.set(login.toLowerCase(), snap)
  else snapshots.delete(login.toLowerCase())
}
