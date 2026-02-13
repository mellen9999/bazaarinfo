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
  const schedule = () => {
    const ms = msUntil(hour)
    log(`next daily run in ${(ms / 3600_000).toFixed(1)}h`)
    setTimeout(async () => {
      try {
        await fn()
      } catch (e) {
        log(`scheduled task error: ${e}`)
      }
      schedule()
    }, ms)
  }
  schedule()
}
