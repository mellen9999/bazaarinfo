import { cachedPlace, lookupPlace, type GeoLoc } from './geo'
import { ET_ZONE } from './et'
import { isDst, isZone, offsetMinutes, utcLabel, wallToInstant, zoneAbbr, zoneParts, type ZoneParts } from './tz'

// world clock. the model used to do timezone math itself off the ET "Right now:" line: three
// "time nz" asks on 2026-11-04 got three different answers, off by 1h, 1h and 6h ("8:35am
// thursday in auckland" at 2:35pm). every time in the Clock line is computed here with Intl
// from the system clock — now-in-a-place, a clock time converted between zones, the stream
// schedule in the asker's zone — so the model relays instead of adding hours.

export interface Zone {
  name: string
  tz: string
}
export interface Instant {
  label: string
  at: number
}
export interface ClockOpts {
  now?: number
  /** the ask is about the stream schedule: convert its instants into the named zone */
  schedAsked?: boolean
  /** ET instants the context already states (predicted next stream, went live) */
  instants?: Instant[]
  /** the bot's own last line, for "what's that in cet?" */
  said?: string
}

/** marks the section; ai-verify keys its time check off it */
export const CLOCK_HEAD = 'Clock (REAL'

const zone = (name: string, tz: string): Zone => ({ name, tz })
const ET = zone('ET', ET_ZONE)
const CT = zone('CT', 'America/Chicago')
const MT = zone('MT', 'America/Denver')
const PT = zone('PT', 'America/Los_Angeles')
const AT = zone('atlantic (halifax)', 'America/Halifax')
const NT = zone('newfoundland', 'America/St_Johns')
const UK = zone('UK', 'Europe/London')
const CEU = zone('central europe', 'Europe/Paris')
const EEU = zone('eastern europe', 'Europe/Athens')
const MSK = zone('moscow', 'Europe/Moscow')
const PER = zone('perth', 'Australia/Perth')
const ADL = zone('adelaide', 'Australia/Adelaide')
const BNE = zone('brisbane', 'Australia/Brisbane')
const SYD = zone('sydney', 'Australia/Sydney')

// zone abbreviations, nicknames, and countries the geocoder can't put in one zone. checked
// BEFORE geocoding: the geocoder returns no zone for the US/AU/CA, sends "uk" to a village in
// siberia, "est" to estonia, "usa" to uşak. an empty list = several zones, ask which city.
const GROUPS: [string[], Zone[]][] = [
  [['et', 'est', 'edt', 'eastern', 'eastern time', 'eastern standard time', 'eastern daylight time'], [ET]],
  [['ct', 'cst', 'cdt', 'central', 'central time'], [CT]],
  [['mt', 'mst', 'mdt', 'mountain', 'mountain time'], [MT]],
  [['pt', 'pst', 'pdt', 'pacific', 'pacific time'], [PT]],
  [['akst', 'akdt', 'alaska'], [zone('alaska', 'America/Anchorage')]],
  [['hst', 'hawaii'], [zone('hawaii', 'Pacific/Honolulu')]],
  [['ast', 'adt', 'atlantic'], [AT]],
  [['nst', 'ndt', 'newfoundland'], [NT]],
  [['utc', 'gmt', 'zulu'], [zone('UTC', 'UTC')]],
  [['bst', 'uk', 'u.k.', 'britain', 'great britain', 'england', 'scotland', 'wales', 'united kingdom'], [UK]],
  [['cet', 'cest', 'mez', 'central europe', 'central european', 'central european time'], [CEU]],
  [['eet', 'eest', 'eastern europe', 'eastern european'], [EEU]],
  [['eu', 'europe'], [UK, CEU, EEU]],
  [['msk'], [MSK]],
  [['ist'], [zone('india', 'Asia/Kolkata')]],
  [['jst'], [zone('japan', 'Asia/Tokyo')]],
  [['kst'], [zone('korea', 'Asia/Seoul')]],
  [['hkt'], [zone('hong kong', 'Asia/Hong_Kong')]],
  [['sgt'], [zone('singapore', 'Asia/Singapore')]],
  [['pht'], [zone('philippines', 'Asia/Manila')]],
  [['aest', 'aedt'], [SYD]],
  [['acst', 'acdt'], [ADL]],
  [['awst'], [PER]],
  [['australia', 'aus'], [PER, ADL, BNE, SYD]],
  [['nz', 'nzst', 'nzdt', 'nzt', 'new zealand', 'aotearoa'], [zone('new zealand', 'Pacific/Auckland')]],
  [['usa', 'u.s.', 'u.s.a.', 'the us', 'united states', 'the states', 'america', 'north america'], [ET, CT, MT, PT]],
  [['canada'], [zone('vancouver', PT.tz), zone('edmonton', MT.tz), zone('winnipeg', CT.tz), zone('toronto', ET.tz), zone('halifax', AT.tz), zone("st. john's", NT.tz)]],
  [['brazil'], [zone('brazil (brasília time)', 'America/Sao_Paulo')]],
  [['mexico'], [zone('mexico city', 'America/Mexico_City')]],
  [['russia'], [MSK, zone('novosibirsk', 'Asia/Novosibirsk'), zone('vladivostok', 'Asia/Vladivostok')]],
  [['indonesia'], [zone('jakarta', 'Asia/Jakarta'), zone('bali', 'Asia/Makassar'), zone('jayapura', 'Asia/Jayapura')]],
  [['south america', 'latin america', 'central america', 'africa', 'asia'], []],
]

const ALIAS = new Map<string, Zone[]>()
for (const [keys, zones] of GROUPS) for (const k of keys) ALIAS.set(k, zones)
const KEYS = [...ALIAS.keys()].sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
// letters either side = inside a word: "c'est", "está", "uk" in "ukraine"
const EDGE_L = "(?<![\\p{L}\\p{N}_'.])"
const EDGE_R = "(?![\\p{L}\\p{N}_'])"
const ZONE_RE = new RegExp(`${EDGE_L}(${KEYS})${EDGE_R}`, 'giu')
// "nz time", "eastern time"
const ZONE_TIME = new RegExp(`${EDGE_L}(?:${KEYS})\\s+time\\b`, 'iu')
// "in cet", "to the uk", "nz time" — a zone named as where a time should land
const ZONE_REF = new RegExp(`\\b(?:in|to|into|for)\\s+(?:the\\s+)?(?:${KEYS})${EDGE_R}|${EDGE_L}(?:${KEYS})\\s+time\\b`, 'iu')

interface ZoneHit {
  key: string
  zones: Zone[]
  index: number
  end: number
}

function zoneHits(text: string): ZoneHit[] {
  const out: ZoneHit[] = []
  for (const m of text.matchAll(ZONE_RE)) {
    const key = m[1].toLowerCase()
    out.push({ key, zones: ALIAS.get(key) ?? [], index: m.index!, end: m.index! + m[0].length })
  }
  return out
}

// --- clock times ---

export interface ClockTime {
  raw: string
  /** minutes past midnight; two readings for an am/pm-less "8:30" */
  mins: number[]
  hourOnly: boolean
  index: number
  end: number
}

// "8pm", "8:30 p.m.", "20:00". not after +/-/: so "UTC+5:30" and "7-9pm" ranges stay out.
const TIME_RE = /(?<![\d+\-:.])(?:(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?\s?m\b\.?|(\d{1,2}):(\d{2})(?![\d:]))/giu

export function parseClockTimes(text: string): ClockTime[] {
  const out: ClockTime[] = []
  for (const m of text.matchAll(TIME_RE)) {
    const mer = m[3]?.toLowerCase()
    const h = Number(mer ? m[1] : m[4])
    const min = Number((mer ? m[2] : m[5]) ?? 0)
    let mins: number[] = []
    if (min <= 59) {
      if (mer) {
        if (h >= 1 && h <= 12) mins = [((h % 12) + (mer === 'p' ? 12 : 0)) * 60 + min]
      } else if (h <= 23) {
        mins = h >= 1 && h <= 12 ? [h * 60 + min, (h === 12 ? 0 : h + 12) * 60 + min] : [h * 60 + min]
      }
    }
    if (mins.length) out.push({ raw: m[0], mins, hourOnly: !!mer && m[2] === undefined, index: m.index!, end: m.index! + m[0].length })
  }
  return out
}

// --- query shape ---

const PLACE_ASK = String.raw`(?:what\s+time\s+is\s+it|time\s+is\s+it|wh?at'?s\s+the\s+(?:current\s+|local\s+)?time|(?:current|local)\s+time|what\s+day\s+is\s+it|what(?:'?s|\s+is)\s+the\s+date|how\s+(?:late|early)\s+is\s+it|is\s+it\s+(?:morning|night|nighttime|daytime|evening|afternoon|tomorrow|today|late|early)|time\s*zone)`
// a question about the clock or the calendar — "first time in chat" is not one
const CLOCK_ASK = new RegExp(`\\b(?:${PLACE_ASK}|what\\s+time|hours?\\s+(?:ahead|behind)|convert)\\b`, 'i')
// a place runs to the next preposition/conjunction: "in tokyo for my friend" → "tokyo"
const PLACE_CAP = String.raw`([^,?!;]+?)(?=\s+(?:in|to|into|for|at|and|or|but|when|if)\s|[,?!;]|$)`
const ASK_PLACE = new RegExp(`\\b${PLACE_ASK}\\s+(?:right\\s+now\\s+|rn\\s+|now\\s+|currently\\s+)?(?:in|over\\s+in|at|of|for)\\s+${PLACE_CAP}`, 'i')
// the whole ask is "time <place>": "time nz", "local time tokyo", "time in gimli"
const BARE = /^(?:the\s+|current\s+|local\s+)?time\s+(?:(in|at|of)\s+)?([^,?!;]+?)$/i
// a short follow-up to the bot's last reply: "in cet?", "what's that in bst", "convert to aest"
const FOLLOW = /^(?:(?:and|ok|okay|so|now|but)\s+)?(?:(?:wh?at'?s|what\s+is)\s+(?:that|it|this)\s+|convert(?:\s+(?:that|it))?\s+|(?:that|it)\s+)?(?:in|to|into|for)\s+(?:the\s+)?([^,?!;]{2,30}?)(?:\s+time)?$/i
const PREP_ANY = new RegExp(`(?:^|\\s)(?:in|to|into|for)\\s+${PLACE_CAP}`, 'gi')
const MY_TIME = /\b(?:my|our)\s+(?:local\s+)?(?:time|timezone|time\s+zone|tz)\b/i

const FILLER = /\b(?:right\s+now|at\s+the\s+moment|currently|rn|now|today|tonight|atm|pls|plz|please|exactly|again|local\s+time|time\s*zone|time)\b/gi
// words that make the capture a sentence rather than a place
const STOP = new Set(('to for in at on from by is are was were be of left until till since out zone travel machine my your his her our their its it this that these those me you we he she they them him us and or but with when what who how why if so a an any some '
  + 'chat here there game games bazaar stream streams twitch kripp bot vod run item items day night morning evening afternoon week weekend '
  + 'minute minutes min mins hour hours second seconds sec moment year years life lol lmao bro').split(' '))

// trailing "?" and "!" go; a trailing "." stays for "u.s." and cleanPlace trims it otherwise
function norm(q: string): string {
  return q.replace(/\s+/g, ' ').trim().replace(/[\s?!]+$/, '')
}

function cleanPlace(raw: string): string | null {
  const s = raw.toLowerCase()
    .replace(/\s+at\s+\d.*$/, '') // "london at 5pm" → "london"
    .replace(FILLER, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:the|a)\s+/, '')
    .replace(/^[\s.'"-]+|[\s.'"-]+$/g, '')
  if (!s || s.length > 40 || /[^\p{L}\s.'-]/u.test(s)) return null
  const words = s.split(' ')
  if (words.length > 4 || words.some((w) => STOP.has(w))) return null
  return s
}

/**
 * the place to geocode, when the ask names one the alias table doesn't know. `major` = the
 * form is loose ("time X", "in X?") so only a real city or country counts — "time for bed"
 * must not find a village called Bed. `loose` = a schedule ask, where "in X" means a zone.
 */
export function placeCandidate(query: string, loose = false): { place: string; major: boolean } | null {
  const q = norm(query)
  const bare = BARE.exec(q)
  // "time in X" names a place outright; bare "time X" could be "time bed"
  const tries: [string | undefined, boolean][] = [[ASK_PLACE.exec(q)?.[1], false], [bare?.[2], !bare?.[1]]]
  if (loose || FOLLOW.test(q) || parseClockTimes(q).length) for (const m of q.matchAll(PREP_ANY)) tries.push([m[1], true])
  for (const [raw, major] of tries) {
    if (!raw || zoneHits(raw).length) continue
    const place = cleanPlace(raw)
    if (place) return { place, major }
  }
  return null
}

/** awaited before the context build. geocodes the named place (24h cache in geo.ts). never throws. */
export async function refreshClockIfNeeded(query: string, schedAsked = false): Promise<void> {
  const c = placeCandidate(query, schedAsked)
  if (c) await lookupPlace(c.place)
}

// --- format ---

const pad = (n: number) => String(n).padStart(2, '0')
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const minsOf = (p: ZoneParts) => p.hour * 60 + p.minute

function hm12(mins: number): string {
  const h = Math.floor(mins / 60) % 24
  const m = mins % 60
  return `${h % 12 || 12}${m ? `:${pad(m)}` : ''}${h < 12 ? 'am' : 'pm'}`
}
const both = (mins: number) => `${hm12(mins)} (${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)})`

const shortTag = (z: Zone, at: number) => zoneAbbr(z.tz, at) || utcLabel(offsetMinutes(z.tz, at))

function gapVsEt(diff: number): string {
  if (diff === 0) return 'same clock as ET'
  const a = Math.abs(diff)
  return `${Math.floor(a / 60)}h${a % 60 ? `${a % 60}m` : ''} ${diff > 0 ? 'ahead of' : 'behind'} ET`
}

function nowIn(z: Zone, now: number, vsEt: boolean): string {
  const p = zoneParts(z.tz, now)
  const off = offsetMinutes(z.tz, now)
  const abbr = zoneAbbr(z.tz, now)
  const utc = utcLabel(off)
  const tags = [abbr && abbr !== utc ? `${abbr} ${utc}` : utc, isDst(z.tz, now) ? 'daylight saving' : '']
  if (vsEt && z.tz !== ET_ZONE) tags.push(gapVsEt(off - offsetMinutes(ET_ZONE, now)))
  return `now in ${z.name}: ${DAYS[p.weekday]} ${p.day} ${MONTHS[p.month]} ${both(minsOf(p))}, ${tags.filter(Boolean).join(', ')}`
}

const dayIndex = (p: ZoneParts) => Math.round(Date.UTC(p.year, p.month, p.day) / 86_400_000)

/** a wall-clock time in `src` (today there) as it reads in each target */
function convertWall(mins: number, src: Zone, targets: Zone[], now: number, note: string): string {
  const sp = zoneParts(src.tz, now)
  const at = wallToInstant(src.tz, sp.year, sp.month, sp.day, Math.floor(mins / 60), mins % 60)
  const s = zoneParts(src.tz, at)
  const there = targets.map((dst) => {
    const d = zoneParts(dst.tz, at)
    const shift = dayIndex(d) - dayIndex(s)
    const rel = shift === 0 ? 'same day' : shift === 1 ? 'the next day' : shift === -1 ? 'the day before' : `${shift} days`
    return `${both(minsOf(d))} ${shortTag(dst, at)} in ${dst.name}, ${rel}`
  })
  return `${hm12(mins)} ${src.tz === ET_ZONE ? 'ET' : shortTag(src, at)}${note} = ${there.join('; ')}`
}

function instantIn(i: Instant, targets: Zone[]): string {
  const et = zoneParts(ET_ZONE, i.at)
  const there = targets.map((z) => {
    const p = zoneParts(z.tz, i.at)
    return `${DAYS[p.weekday]} ${both(minsOf(p))} ${shortTag(z, i.at)} in ${z.name}`
  })
  return `${i.label}: ${DAYS[et.weekday]} ${hm12(minsOf(et))} ET = ${there.join('; ')}`
}

const placeName = (loc: GeoLoc) => [loc.name, loc.region !== loc.name ? loc.region : '', loc.country].filter(Boolean).join(', ')
// a capital, an admin seat, a country, or a real city — not a hamlet that shares a word
const isMajor = (loc: GeoLoc) => /^(?:PCL\w*|PPLC|PPLA)$/.test(loc.feature ?? '') || (loc.population ?? 0) >= 50_000
const EXPLICIT_HINT = 'relay these exactly, never add or subtract hours yourself, give the asked place its own local time'

/**
 * the injected Clock section — '' unless the ask is about the time somewhere. every time in
 * it is computed; the fallbacks (unknown place, lookup down, no zone named) keep the bot
 * honest instead of letting it estimate.
 */
export function getClockLine(query: string, o: ClockOpts = {}): string {
  const q = norm(query)
  const now = o.now ?? Date.now()
  const hits = zoneHits(q)
  const times = parseClockTimes(q).slice(0, 2)
  const cand = placeCandidate(q, o.schedAsked)
  const followUp = FOLLOW.test(q)
  const instants = o.instants ?? []
  const said = followUp && o.said
    ? parseClockTimes(o.said).filter((t) => /^\s*\(?\s*(?:ET|EST|EDT|eastern)\b/i.test(o.said!.slice(t.end))).slice(0, 2)
    : []
  const explicit = CLOCK_ASK.test(q) || BARE.test(q) || ZONE_TIME.test(q)
  const schedZone = !!o.schedAsked && instants.length > 0 && (ZONE_REF.test(q) || cand !== null)
  const fire = explicit
    || (times.length > 0 && (hits.length > 0 || cand !== null))
    || schedZone
    || (followUp && (instants.length > 0 || said.length > 0))
  if (!fire) return ''

  const zones: Zone[] = []
  const add = (z: Zone) => {
    if (!zones.some((x) => x.tz === z.tz && x.name === z.name)) zones.push(z)
  }
  const several: string[] = []
  for (const h of hits) {
    if (h.zones.length) h.zones.forEach(add)
    else several.push(h.key)
  }
  let note = ''
  if (cand) {
    const loc = cachedPlace(cand.place)
    if (loc === undefined) note = `the place lookup for "${cand.place}" is down right now: say so, never work the time out yourself`
    else if (loc === null) {
      if (!cand.major) note = `no place called "${cand.place}" was found: say so and ask for a city, never guess a time`
    } else if (cand.major && !isMajor(loc)) {
      // a word that happens to be a village — not what they meant
    } else if (!loc.timezone || !isZone(loc.timezone)) note = `${placeName(loc)} spans several time zones: ask which city`
    else add(zone(placeName(loc), loc.timezone))
  }
  for (const k of several) note ||= `${k} spans several time zones: ask which city, never guess a time`

  if (!zones.length) {
    if (note) return `\nClock: ${note}.`
    if (MY_TIME.test(q)) return `\nClock: the asker wants a time in their own zone but didn't say which: ask their city or time zone, never guess one.`
    return ''
  }

  const parts: string[] = []
  // a clock time they gave, read in the zone written right after it ("8pm est") or, with
  // none, in ET — the zone the bot itself states times in
  for (const t of times) {
    const h = hits.find((x) => x.index >= t.end && /^[\s(]*$/.test(q.slice(t.end, x.index)))
    if (h && h.zones.length !== 1) continue
    const src = h ? h.zones[0] : ET
    let targets = zones.filter((z) => z.tz !== src.tz)
    if (!targets.length && src.tz !== ET_ZONE) targets = [ET]
    if (!targets.length) continue
    for (const m of t.mins) parts.push(convertWall(m, src, targets, now, h ? '' : ' (no zone given, read as ET)'))
  }
  const away = zones.filter((z) => z.tz !== ET_ZONE)
  if (away.length) {
    for (const t of said) for (const m of t.mins) parts.push(convertWall(m, ET, away, now, ' (from your last reply)'))
    if (schedZone || followUp) for (const i of instants) parts.push(instantIn(i, away))
  }
  // "kripp said 8pm est" names a time and a zone but asks nothing — no section at all
  if (!parts.length && !explicit && !schedZone && !followUp) return ''
  if (!parts.length || (explicit && !times.length)) parts.unshift(zones.map((z) => nowIn(z, now, zones.length === 1)).join('; '))
  return `\n${CLOCK_HEAD}, computed from the system clock — ${EXPLICIT_HINT}): ${parts.join('. ')}.${note ? ` also: ${note}.` : ''}`
}
