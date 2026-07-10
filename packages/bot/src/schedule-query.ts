// glue between the pure predictor (schedule.ts) and stored session data (db).
// kept separate so schedule.ts stays pure/testable, and both the deterministic command
// (commands.ts) and the AI-context backstop (ai-build.ts) share one snapshot path.
//
// liveness is derived from the DB, not in-memory live state, on purpose: it keeps this
// module out of the ai-cache→ai-sanitize→emotes import chain (which commands.ts must not
// pull in statically), and it survives a bot restart — the poller bumps last_seen every
// ~60s while a channel is live, so a fresh last_seen IS the live signal.

import * as db from './db'
import { predictNextStream, typicalDurationMs, type LiveInfo, type Prediction } from './schedule'

const DAY = 86_400_000
const WINDOW_MS = 120 * DAY // only predict from the last ~4 months — schedules drift
const LIVE_FRESH_MS = 3 * 60_000 // last_seen newer than this ⇒ live (poll cadence is ~60s)

export function snapshotSchedule(channel: string, now: number): { pred: Prediction; live: LiveInfo } {
  const sessions = db.getStreamSessions(channel, now - WINDOW_MS)
  const pred = predictNextStream(sessions, now)
  const latest = sessions.at(-1)
  const isLive = !!latest && now - latest.lastSeenAt < LIVE_FRESH_MS
  return {
    pred,
    live: {
      isLive,
      liveSince: isLive ? latest!.startedAt : undefined,
      durationMs: typicalDurationMs(sessions),
    },
  }
}
