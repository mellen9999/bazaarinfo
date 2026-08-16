import { log } from './log'
import { checkPatchStaleness, fetchPatchInfo, getPatchInfo } from './patch'
import { fetchPatchNotes, loadOverlayCache } from './patch-notes'
import { refreshHsIfNeeded } from './hs'
import { refreshHsCardsIfNeeded } from './hs-cards'

const TZ = 'America/Los_Angeles'
const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
})

function ptNow(): { hour: number; minute: number } {
  const parts = fmt.formatToParts(new Date())
  return {
    hour: Number(parts.find((p) => p.type === 'hour')!.value),
    minute: Number(parts.find((p) => p.type === 'minute')!.value),
  }
}

function msUntil(targetHour: number): number {
  const { hour, minute } = ptNow()
  const currentMinutes = hour * 60 + minute
  const targetMinutes = targetHour * 60
  let diff = targetMinutes - currentMinutes
  if (diff <= 0) diff += 1440 // 24h in minutes
  return diff * 60_000
}

let patchRetryTimer: ReturnType<typeof setInterval> | null = null

// call once from index.ts startup: runs an immediate fetch, arms the daily 4am slot,
// and starts an hourly retry that only fires while the cache has no valid fresh patch info
export async function schedulePatchRefresh() {
  // cached parse first so the bot is grounded before any network call returns
  loadOverlayCache()
  refreshNotes('startup')
  try {
    const info = await fetchPatchInfo()
    if (info) {
      const event = info.activeEvent ? ` [event: ${info.activeEvent}]` : ''
      log(`patch: ${info.latestPatch} (${info.patchDate}) ${info.sizeBadge}${event}`)
    } else {
      log('patch: startup fetch failed, will retry at 4am')
    }
  } catch (e) {
    log(`patch: startup error: ${e}`)
  }
  scheduleDaily(4, async () => {
    try {
      const info = await fetchPatchInfo()
      if (info) log(`patch refresh: ${info.latestPatch} (${info.patchDate})`)
      else log('patch refresh: fetch failed, cache unchanged')
    } catch (e) {
      log(`patch schedule error: ${e}`)
    }
    await refreshNotes('daily')
    // hearthstone ships its own patches on its own days — pull the BG card set on the same
    // 4am slot so a rotation change is grounded within a day of landing
    refreshHsCardsIfNeeded()
    checkPatchStaleness()
  })
  schedulePatchRetry()
  // warm the BG leaderboard so the first rating ask after a restart is grounded rather
  // than silent. non-blocking and fail-soft — a blizzard outage just delays the answer.
  refreshHsIfNeeded()
  // and the BG card set — TTL-gated, so this is a no-op when the on-disk cache is fresh
  refreshHsCardsIfNeeded()
}

// hourly safety net: while getPatchInfo() has no valid fresh cache (startup and/or 4am
// fetch failed), keep retrying every hour until one succeeds. single timer — re-arming
// (e.g. a second schedulePatchRefresh call) clears the prior interval instead of stacking.
function schedulePatchRetry() {
  if (patchRetryTimer) clearInterval(patchRetryTimer)
  patchRetryTimer = setInterval(async () => {
    refreshNotes('hourly')
    if (getPatchInfo()) return // cache already fresh — nothing to do
    try {
      const info = await fetchPatchInfo()
      if (info) {
        log(`patch retry: ${info.latestPatch} (${info.patchDate})`)
      } else {
        log('patch retry: fetch failed')
        checkPatchStaleness()
      }
    } catch (e) {
      log(`patch retry error: ${e}`)
      checkPatchStaleness()
    }
  }, 3600_000)
}

// official patch notes are a separate source from bazaardb's dump and move first —
// fetched on the same cadence so a patch grounds itself within the hour it drops.
// fire-and-forget: never blocks the patch-info path, never throws.
function refreshNotes(when: string): Promise<void> {
  return fetchPatchNotes()
    .then((o) => { if (o) log(`patch notes (${when}): ${o.version} ${o.name}`) })
    .catch((e) => { log(`patch notes (${when}) error: ${e}`) })
}

export function scheduleDaily(hour: number, fn: () => Promise<void>) {
  // sleep toward the target in <=1h chunks, re-deriving the PT wall-clock each chunk. a single
  // fixed setTimeout computed in wall-clock minutes drifts an hour across a DST transition (a
  // PT day is 23h/25h long); chunking makes the final hop recompute against the real clock.
  const schedule = () => {
    const ms = msUntil(hour)
    if (ms > 3600_000) {
      setTimeout(schedule, 3600_000)
      return
    }
    log(`next daily run in ${(ms / 60_000).toFixed(0)}m`)
    setTimeout(async () => {
      try {
        await fn()
      } catch (e) {
        log(`scheduled task error: ${e}`)
      }
      // re-arm past the target minute so msUntil rolls to ~tomorrow (avoids a double-fire)
      setTimeout(schedule, 60_000)
    }, ms)
  }
  schedule()
}
