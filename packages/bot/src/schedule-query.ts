// glue between the pure predictor (schedule.ts) and stored session data (db).
// kept separate so schedule.ts stays pure/testable, and both the deterministic command
// (commands.ts) and the AI-context backstop (ai-build.ts) share one snapshot path.
//
// liveness is derived from the DB, not in-memory live state, on purpose: it keeps this
// module out of the ai-cache→ai-sanitize→emotes import chain (which commands.ts must not
// pull in statically), and it survives a bot restart — the poller bumps last_seen every
// ~60s while a channel is live, so a fresh last_seen IS the live signal.

import * as db from './db'
import { predictNextStream, typicalDurationMs, type LiveInfo, type Prediction, type StreamSession } from './schedule'

// a schedule ask can name ANOTHER tracked channel ("when kripp getting on" typed in
// #mellen) — resolve it so the answer is about the channel asked about, not the room.
// candidates = channels with logged history; a login's bare form drops a short prefix
// (nl_kripp → kripp) and tolerates a possessive ("kripps title").
let chanCache: { at: number; list: string[] } | null = null
export function resolveScheduleChannel(query: string, current: string, channels?: string[]): string {
  const cur = current.toLowerCase()
  if (!channels) {
    if (!chanCache || Date.now() - chanCache.at > 60_000) chanCache = { at: Date.now(), list: db.getScheduleChannels() }
    channels = chanCache.list
  }
  for (const ch of channels) {
    if (ch === cur) continue
    const bare = ch.replace(/^[a-z]{1,2}_/, '')
    if (new RegExp(`\\b(?:${ch}|${bare})(?:'?s)?\\b`, 'i').test(query)) return ch
  }
  return cur
}

const DAY = 86_400_000
const WINDOW_MS = 120 * DAY // only predict from the last ~4 months — schedules drift
const LIVE_FRESH_MS = 3 * 60_000 // last_seen newer than this ⇒ live (poll cadence is ~60s)

export function snapshotSchedule(channel: string, now: number): { pred: Prediction; live: LiveInfo; sessions: StreamSession[] } {
  const sessions = db.getStreamSessions(channel, now - WINDOW_MS)
  const pred = predictNextStream(sessions, now)
  const latest = sessions.at(-1)
  const isLive = !!latest && now - latest.lastSeenAt < LIVE_FRESH_MS
  return {
    pred,
    sessions,
    live: {
      isLive,
      liveSince: isLive ? latest!.startedAt : undefined,
      durationMs: typicalDurationMs(sessions),
    },
  }
}
