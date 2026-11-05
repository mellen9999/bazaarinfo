// zone math for any IANA zone, DST-aware via Intl. et.ts is the ET specialisation, clock.ts
// renders every other place. formatters are cached per zone: building one is the slow part.

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export interface ZoneParts {
  year: number
  month: number // 0-11
  day: number
  hour: number
  minute: number
  weekday: number // 0 = sun
}

const partFmts = new Map<string, Intl.DateTimeFormat>()

function partFmt(tz: string): Intl.DateTimeFormat {
  let f = partFmts.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    })
    partFmts.set(tz, f)
  }
  return f
}

/** wall-clock parts of an instant in a zone. throws RangeError on an unknown zone. */
export function zoneParts(tz: string, at: number | Date): ZoneParts {
  const p: Record<string, string> = {}
  for (const x of partFmt(tz).formatToParts(at)) p[x.type] = x.value
  return {
    year: Number(p.year),
    month: Number(p.month) - 1,
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: WEEKDAYS.indexOf(p.weekday.toLowerCase().slice(0, 3)),
  }
}

export function isZone(tz: string): boolean {
  try {
    partFmt(tz)
    return true
  } catch {
    return false
  }
}

/** minutes east of UTC at that instant: +780 for NZDT, -300 for EST */
export function offsetMinutes(tz: string, at: number): number {
  const p = zoneParts(tz, at)
  const wall = Date.UTC(p.year, p.month, p.day, p.hour, p.minute)
  return Math.round((wall - Math.floor(at / 60_000) * 60_000) / 60_000)
}

/**
 * the instant a wall-clock time happens in a zone. the second pass settles a DST edge: the
 * first guess uses the offset at the naive instant, which is wrong on the far side of a switch.
 * hour/day overflow is fine (Date.UTC rolls it).
 */
export function wallToInstant(tz: string, year: number, month: number, day: number, hour: number, minute: number): number {
  const naive = Date.UTC(year, month, day, hour, minute)
  const first = naive - offsetMinutes(tz, naive) * 60_000
  return naive - offsetMinutes(tz, first) * 60_000
}

/** on its summer offset right now (either hemisphere) */
export function isDst(tz: string, at: number): boolean {
  const y = zoneParts(tz, at).year
  const jan = offsetMinutes(tz, Date.UTC(y, 0, 1))
  const jul = offsetMinutes(tz, Date.UTC(y, 6, 1))
  return jan !== jul && offsetMinutes(tz, at) === Math.max(jan, jul)
}

// no single locale names every zone: en-US knows EST but calls Auckland "GMT+13", en-AU knows
// NZDT and AEDT, en-GB knows CET/BST, en-IN knows IST, en-CA knows NST. first purely
// alphabetic answer wins.
const ABBR_LOCALES = ['en-US', 'en-GB', 'en-AU', 'en-IN', 'en-CA']
const abbrFmts = new Map<string, Intl.DateTimeFormat>()

/** "NZDT", "CEST", "EST" — '' when no locale has a name for it (Tokyo is just UTC+9) */
export function zoneAbbr(tz: string, at: number): string {
  for (const loc of ABBR_LOCALES) {
    const key = `${loc}|${tz}`
    let f = abbrFmts.get(key)
    if (!f) {
      f = new Intl.DateTimeFormat(loc, { timeZone: tz, timeZoneName: 'short' })
      abbrFmts.set(key, f)
    }
    const v = f.formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? ''
    if (/^[A-Z]{2,5}$/.test(v)) return v
  }
  return ''
}

/** "UTC+13", "UTC-3:30", "UTC" */
export function utcLabel(offsetMin: number): string {
  if (offsetMin === 0) return 'UTC'
  const a = Math.abs(offsetMin)
  const mm = a % 60
  return `UTC${offsetMin > 0 ? '+' : '-'}${Math.floor(a / 60)}${mm ? `:${String(mm).padStart(2, '0')}` : ''}`
}
