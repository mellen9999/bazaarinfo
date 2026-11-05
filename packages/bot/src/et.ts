// the one zone the bot states times in: kripp's chat is US-east. DST-aware via Intl, so
// "ET" is EDT/EST as the calendar says. schedule.ts and the "Right now:" line share this
// so two clocks never disagree inside one answer.
import { WEEKDAYS, zoneParts, type ZoneParts } from './tz'

export const ET_ZONE = 'America/New_York'

export const etParts = (at: number | Date): ZoneParts => zoneParts(ET_ZONE, at)

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
