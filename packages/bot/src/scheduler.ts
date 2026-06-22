import { log } from './log'

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
