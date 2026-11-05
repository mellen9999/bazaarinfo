import { describe, expect, it } from 'bun:test'
import { getClockLine, parseClockTimes, placeCandidate } from './clock'
import { __setPlaceForTest, type GeoLoc } from './geo'
import { isDst, offsetMinutes, utcLabel, wallToInstant, zoneAbbr, zoneParts } from './tz'

// the live failure: 2026-11-05 01:35 UTC = wed 20:35 EST = thu 14:35 NZDT. the bot said 8:35am.
const NOW = Date.UTC(2026, 10, 5, 1, 35, 4)
const at = (q: string, o: Parameters<typeof getClockLine>[1] = {}) => getClockLine(q, { now: NOW, ...o })

const place = (name: string, tz: string, extra: Partial<GeoLoc> = {}): GeoLoc =>
  ({ name, region: '', country: 'XX', lat: 0, lon: 0, timezone: tz, population: 1_000_000, feature: 'PPLC', ...extra })

describe('now in a place — the live "time nz" failures', () => {
  it('states the real NZ time, computed, with the offset spelled out', () => {
    const l = at('time nz')
    expect(l).toContain('Clock (REAL')
    expect(l).toContain('now in new zealand: thursday 5 nov 2:35pm (14:35)')
    expect(l).toContain('NZDT UTC+13')
    expect(l).toContain('daylight saving')
    expect(l).toContain('18h ahead of ET')
  })

  it('the earlier ask the same day (21:53 UTC) is 10:53am, not the 9:53 the bot said', () => {
    expect(getClockLine('time nz', { now: Date.UTC(2026, 10, 4, 21, 53) })).toContain('thursday 5 nov 10:53am (10:53)')
  })

  it('every phrasing of the ask lands', () => {
    for (const q of ['what time is it in New Zealand', 'whats the time in nz rn?', 'nz time', 'time in new zealand', 'current time nz', 'how many hours ahead is nz', 'what day is it in nz', 'is it tomorrow in nz'])
      expect(at(q)).toContain('now in new zealand: thursday')
  })

  it('zone abbreviations beat the geocoder, which sends "uk" to siberia and "est" to estonia', () => {
    expect(at('time in the uk')).toContain('now in UK: thursday 5 nov 1:35am (01:35), GMT')
    expect(at('what time is it in est')).toContain('now in ET: wednesday 4 nov 8:35pm (20:35), EST UTC-5')
    expect(at('time in cet')).toContain('now in central europe: thursday 5 nov 2:35am (02:35), CET UTC+1, 6h ahead of ET')
  })

  it('half-hour zones and zones no locale abbreviates', () => {
    expect(at('time in ist')).toContain('IST UTC+5:30, 10h30m ahead of ET')
    expect(at('time in jst')).toContain('now in japan: thursday 5 nov 10:35am (10:35), UTC+9, 14h ahead of ET')
  })

  it('a multi-zone country lists its zones instead of picking one', () => {
    const l = at('what time is it in australia')
    for (const s of ['perth: thursday 5 nov 9:35am', 'adelaide: thursday 5 nov 12:05pm', 'brisbane: thursday 5 nov 11:35am', 'sydney: thursday 5 nov 12:35pm']) expect(l).toContain(s)
    expect(at('time in the us')).toContain('now in PT: wednesday 4 nov 5:35pm')
    expect(at('time in canada')).toContain("now in st. john's: wednesday 4 nov 10:05pm (22:05), NST UTC-3:30")
  })

  it('a continent asks which city', () => {
    expect(at('time in south america')).toBe('\nClock: south america spans several time zones: ask which city, never guess a time.')
  })
})

describe('geocoded places', () => {
  it('uses the place\'s own zone', () => {
    __setPlaceForTest('tokyo', place('Tokyo', 'Asia/Tokyo', { region: 'Tokyo', country: 'JP' }))
    expect(at('whats the time in tokyo')).toContain('now in Tokyo, JP: thursday 5 nov 10:35am (10:35), UTC+9')
  })

  it('an unknown place says so, a dead lookup says so, a zoneless country asks which city', () => {
    __setPlaceForTest('narnia', null)
    expect(at('time in narnia')).toContain('no place called "narnia" was found')
    __setPlaceForTest('atlantis', undefined)
    expect(at('what time is it in atlantis')).toContain('lookup for "atlantis" is down')
    __setPlaceForTest('chile', place('Chile', ''))
    expect(at('what time is it in chile')).toContain('Chile, XX spans several time zones')
  })

  it('a loose form only accepts a real city, never a village that shares a word', () => {
    __setPlaceForTest('bed', place('Bed', 'Europe/Berlin', { population: 300, feature: 'PPL' }))
    expect(at('time bed')).toBe('')
    __setPlaceForTest('nara', place('Nara', 'Asia/Tokyo', { population: 360_000, feature: 'PPLA' }))
    expect(at('time nara')).toContain('now in Nara')
  })

  it('pulls the place out of a sentence and stops at the next preposition', () => {
    expect(placeCandidate('what time is it in tokyo for my friend')).toEqual({ place: 'tokyo', major: false })
    expect(placeCandidate('time in gimli')).toEqual({ place: 'gimli', major: false })
    expect(placeCandidate('time gimli')).toEqual({ place: 'gimli', major: true })
    expect(placeCandidate('time for bed')).toBeNull()
    expect(placeCandidate('time in the uk')).toBeNull() // alias, no geocode
    expect(placeCandidate('what time is it for me')).toBeNull()
  })
})

describe('conversions — a clock time they gave', () => {
  it('reads the zone written after the time', () => {
    expect(at('8pm est in nz')).toContain('8pm ET = 2pm (14:00) NZDT in new zealand, the next day')
    expect(at('what is 20:00 cet in est')).toContain('8pm CET = 2pm (14:00) EST in ET, same day')
    expect(at('convert 9:30pm pst to cet')).toContain('9:30pm PST = 6:30am (06:30) CET in central europe, the next day')
  })

  it('no zone after the time reads it as ET, and says so', () => {
    __setPlaceForTest('tokyo', place('Tokyo', 'Asia/Tokyo', { region: 'Tokyo', country: 'JP' }))
    expect(at('9pm in tokyo')).toContain('9pm ET (no zone given, read as ET) = 11am (11:00) UTC+9 in Tokyo, JP, the next day')
  })

  it('a non-ET zone with no target converts to ET', () => {
    expect(at('what time is 8pm cet')).toContain('8pm CET = 2pm (14:00) EST in ET, same day')
  })

  it('an am/pm-less 3:30 gets both readings', () => {
    const l = at('what time is 3:30 in pst')
    expect(l).toContain('3:30am ET (no zone given, read as ET) = 12:30am (00:30) PST')
    expect(l).toContain('3:30pm ET (no zone given, read as ET) = 12:30pm (12:30) PST')
  })

  it('the week the US and EU are on different DST rules', () => {
    // 2026-10-28: EU fell back on oct 25, the US not until nov 1 — 5h apart, not 6
    const l = getClockLine('8pm et in cet', { now: Date.UTC(2026, 9, 28, 15, 0) })
    expect(l).toContain('8pm ET = 1am (01:00) CET in central europe, the next day')
  })
})

describe('the schedule and the bot\'s own times, restated in the asker\'s zone', () => {
  const instants = [{ label: "nl_kripp's predicted next stream", at: Date.UTC(2026, 10, 5, 23, 30) }]

  it('a schedule ask naming a zone gets the prediction converted', () => {
    expect(at('when does kripp stream in cet', { schedAsked: true, instants }))
      .toContain("nl_kripp's predicted next stream: thursday 6:30pm ET = friday 12:30am (00:30) CET in central europe")
  })

  it('a follow-up converts the schedule or the bot\'s last ET time', () => {
    expect(at('in cet?', { instants })).toContain('friday 12:30am (00:30) CET in central europe')
    expect(at("what's that in bst", { said: 'next stream likely thursday ~18:30 ET (±1h)' }))
      .toContain('6:30pm ET (from your last reply) = 11:30pm (23:30) GMT in UK, same day')
  })

  it('a plain time ask never drags the schedule in', () => {
    expect(at('time nz', { instants })).not.toContain('predicted next stream')
  })
})

describe('stays silent when the ask is not about the clock', () => {
  it.each([
    'first time in chat', 'STELLE TIME Pog', 'time to buy', "c'est la vie", 'its that time of day',
    'what time is it', 'kripp said 8pm est', 'every time in arena i lose', 'in silver?', 'real time combat in guildrun',
    'best build for vanessa', 'temp ban him',
  ])('%s', (q) => expect(at(q)).toBe(''))

  it('a follow-up with nothing to convert stays silent', () => {
    expect(at('in cet?')).toBe('')
  })

  it('asks for the zone when they say "my time" without one', () => {
    expect(at('what time is it in my time zone')).toContain("didn't say which: ask their city or time zone")
  })
})

describe('parseClockTimes', () => {
  const mins = (s: string) => parseClockTimes(s).map((t) => t.mins)
  it('reads 12h, 24h and dotted forms', () => {
    expect(mins('8pm')).toEqual([[1200]])
    expect(mins('8:30 p.m.')).toEqual([[1230]])
    expect(mins('12am and 12pm')).toEqual([[0], [720]])
    expect(mins('20:00')).toEqual([[1200]])
    expect(mins('3:30')).toEqual([[210, 930]])
    expect(mins('12:15')).toEqual([[735, 15]])
  })
  it('ignores offsets, ranges and words', () => {
    expect(mins('UTC+5:30 or -3:30')).toEqual([])
    expect(mins('7-9pm')).toEqual([])
    expect(mins('8 amazing builds, 25:00, 13pm')).toEqual([])
  })
  it('flags a bare hour', () => {
    expect(parseClockTimes('2pm')[0].hourOnly).toBe(true)
    expect(parseClockTimes('2:35pm')[0].hourOnly).toBe(false)
  })
})

describe('tz math', () => {
  it('offsets and labels', () => {
    expect(offsetMinutes('Pacific/Auckland', NOW)).toBe(780)
    expect(offsetMinutes('America/St_Johns', NOW)).toBe(-210)
    expect(utcLabel(-210)).toBe('UTC-3:30')
    expect(utcLabel(0)).toBe('UTC')
    expect(zoneAbbr('Australia/Sydney', NOW)).toBe('AEDT')
    expect(zoneAbbr('Asia/Tokyo', NOW)).toBe('')
  })
  it('DST either hemisphere', () => {
    expect(isDst('Australia/Sydney', NOW)).toBe(true)
    expect(isDst('America/New_York', NOW)).toBe(false)
    expect(isDst('America/New_York', Date.UTC(2026, 6, 1))).toBe(true)
    expect(isDst('Asia/Tokyo', NOW)).toBe(false)
  })
  it('wall time → instant across a DST switch', () => {
    // 2026-03-08 the US springs forward at 2am: 3:30am that day is EDT (utc-4)
    expect(wallToInstant('America/New_York', 2026, 2, 8, 3, 30)).toBe(Date.UTC(2026, 2, 8, 7, 30))
    expect(wallToInstant('America/New_York', 2026, 2, 7, 3, 30)).toBe(Date.UTC(2026, 2, 7, 8, 30))
    const p = zoneParts('Pacific/Auckland', wallToInstant('Pacific/Auckland', 2026, 10, 5, 14, 35))
    expect([p.hour, p.minute]).toEqual([14, 35])
  })
})
