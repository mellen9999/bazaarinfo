// backfill stream_sessions from Helix past-broadcast VODs (type=archive).
// the predictor otherwise starts blind and needs weeks of polling to learn a channel;
// VODs carry 14-60 days of real start times + durations on day one, from the official
// API with the creds the streams poll already uses. no third-party scraping.
//
// fail-soft everywhere: VODs disabled, deleted, or the call failing just means fewer
// rows — the poller keeps learning live either way. runs once per channel at startup
// (after the first poll, so a live session's exact start is already logged) and on !join.

import * as db from './db'
import { log } from './log'

// "3h8m33s" / "45m" / "1h2s" → ms. null on garbage so a bad row is skipped, not zero-length.
export function parseVodDuration(s: string): number | null {
  const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/)
  if (!m || (!m[1] && !m[2] && !m[3])) return null
  return ((+(m[1] ?? 0) * 60 + +(m[2] ?? 0)) * 60 + +(m[3] ?? 0)) * 1000
}

// a VOD's created_at sits within seconds of the stream's started_at — if the poller
// already logged a session this close, the VOD is that same stream, not a new row.
const NEAR_MS = 10 * 60_000

interface HelixVideo {
  created_at: string
  duration: string
  type: string
}

export async function backfillVods(
  channel: string,
  userId: string,
  token: string,
  clientId: string,
): Promise<number> {
  try {
    const res = await fetch(`https://api.twitch.tv/helix/videos?user_id=${userId}&type=archive&first=100`, {
      headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      log(`vods: backfill for #${channel} skipped (status ${res.status})`)
      return 0
    }
    const body = (await res.json()) as { data?: HelixVideo[] }
    const vods = body.data ?? []
    const existing = db.getStreamSessions(channel).map((s) => s.startedAt)
    let added = 0
    for (const v of vods) {
      if (v.type !== 'archive') continue
      const startedAt = Date.parse(v.created_at)
      const durMs = parseVodDuration(v.duration)
      if (!Number.isFinite(startedAt) || durMs === null) continue
      if (existing.some((e) => Math.abs(e - startedAt) < NEAR_MS)) continue
      db.recordStreamSession(channel, startedAt, startedAt + durMs)
      added++
    }
    if (added) log(`vods: backfilled ${added} past streams for #${channel}`)
    return added
  } catch (e) {
    log(`vods: backfill for #${channel} failed: ${e instanceof Error ? e.message : e}`)
    return 0
  }
}
