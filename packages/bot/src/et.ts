// the one zone the bot states times in: kripp's chat is US-east. DST-aware via Intl, so
// "ET" is EDT/EST as the calendar says. schedule.ts and the "Right now:" line share this
// so two clocks never disagree inside one answer.
const ZONE = 'America/New_York'
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
})

export interface EtParts {
  year: number
  month: number // 0-11
  day: number
  hour: number
  minute: number
  weekday: number // 0 = sun
}

export function etParts(at: number | Date): EtParts {
  const p: Record<string, string> = {}
  for (const x of fmt.formatToParts(at)) p[x.type] = x.value
  return {
    year: Number(p.year),
    month: Number(p.month) - 1,
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: WEEKDAYS.indexOf(p.weekday.toLowerCase().slice(0, 3)),
  }
}

// calendar-day index in ET (comparable across timestamps, DST-safe)
export function etDayIndex(at: number): number {
  const p = etParts(at)
  return Math.floor(Date.UTC(p.year, p.month, p.day) / 86_400_000)
}

export function etClock(at: number): string {
  const p = etParts(at)
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} ET`
}

export const etWeekday = (at: number): string => WEEKDAYS[etParts(at).weekday]
