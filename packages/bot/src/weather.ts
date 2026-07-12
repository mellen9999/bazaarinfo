import { log } from './log'

// real weather via Open-Meteo (open-meteo.com — no key, no auth, no tracking, CC BY 4.0).
// mirrors the worldcup.ts fail-soft contract: every export returns ''/null on any failure —
// the bot never crashes or hallucinates a forecast because the API hiccuped. all unit
// conversions and comfort indices (humidex, wind chill) are computed HERE so the model
// relays numbers instead of doing math.

const UA = 'BazaarInfo/1.0 (Twitch bot; github.com/mellen9999/bazaarinfo)'
const GEO_API = 'https://geocoding-api.open-meteo.com/v1/search'
const WX_API = 'https://api.open-meteo.com/v1/forecast'
const WX_TTL_MS = 10 * 60_000 // conditions older than 10min get refetched
const GEO_TTL_MS = 24 * 60 * 60_000 // places don't move
const HARD_STALE_MS = 30 * 60_000 // never inject conditions older than this
const FETCH_TIMEOUT_MS = 4_000
const MAX_CACHE = 64

// --- query classification ---

// strong: unambiguous weather nouns — fire even without a place (we ask for one).
const STRONG_RE = /\b(weather|temperature|forecast|humidex|humidity|wind\s*-?chill|dew\s*-?point)\b/i
// weak: weather-ish words that collide with game/chat talk (Heated/Chilled builds, temp bans,
// "hot take") — only count when a place was extracted, so bazaar queries never trigger.
const WEAK_RE = /\b(temps?|rain(?:ing|y)?|snow(?:ing)?|sunny|cloudy|overcast|celsius|fahrenheit|degrees|(?:hot|cold|warm|chilly|freezing|humid)\s+(?:out(?:side)?|in)\b|is\s+it\s+(?:hot|cold|warm|chilly|freezing|humid))\b/i

// true when the query is about real-world weather. gates both the on-demand fetch (ai.ts)
// and the context injection (ai-build.ts).
export function isWeatherQuery(query: string): boolean {
  return STRONG_RE.test(query) || (WEAK_RE.test(query) && extractLocation(query) !== null)
}

// --- location extraction ---

const FILLER_RE = /\b(right now|at the moment|currently|today|tonight|tomorrow|this (?:morning|afternoon|evening|week(?:end)?)|outside|out|please|pls|rn|like)\b/gi
const PREP_RE = /^(?:in|for|near|at|around)\s+/i
// places that aren't places — plus unit/aside noise the "in both C and F" pattern produces
const BLOCK_RE = /^(?:both|and|or|the)?\s*(?:°?\s*[cf]|celsius|fahrenheit|degrees|metric|imperial|chat|here|there|game|(?:the\s+)?bazaar|town|city|the\s+(?:chat|game|world|us))?$/i

// pull a place name out of a natural-language weather ask. returns null when nothing
// place-shaped survives cleanup — callers treat that as "no city given".
export function extractLocation(query: string): string | null {
  const re = /(?:^|[\s,])(?:in|for|near|at|around)\s+([^,?.!;\n]+)/gi
  for (const m of query.matchAll(re)) {
    const cleaned = m[1]
      .replace(/\s+at\s+\d.*$/i, '') // "london at 5pm" → "london"
      .replace(FILLER_RE, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(PREP_RE, '')
      .replace(/^[\s'"-]+|[\s'"-]+$/g, '')
      .trim()
    if (!cleaned || cleaned.length > 40) continue
    if (BLOCK_RE.test(cleaned)) continue
    if (STRONG_RE.test(cleaned) || WEAK_RE.test(cleaned)) continue
    if (cleaned.split(/\s+/).length > 4) continue
    return cleaned
  }
  return null
}

// --- data shapes ---

export interface GeoLoc {
  name: string
  region: string // admin1, may be ''
  country: string // country code, e.g. "CA"
  lat: number
  lon: number
  timezone: string
}

export interface WxDay {
  highC: number
  lowC: number
  precipPct: number | null
}

export interface Wx {
  tempC: number
  feelsC: number
  humidity: number
  windKmh: number
  code: number
  isDay: boolean
  today: WxDay | null
  tomorrow: WxDay | null
}

interface CacheEntry {
  ts: number
  loc: GeoLoc | null // null = geocode found nothing (negative-cached)
  wx: Wx | null // null with loc set = conditions fetch failed
}

// --- math (pure, tested) ---

export function cToF(c: number): number {
  return Math.round((c * 9) / 5 + 32)
}

// Magnus formula — dew point from temp + relative humidity. null when RH is unusable.
export function dewPointC(tempC: number, rh: number): number | null {
  if (!Number.isFinite(tempC) || !Number.isFinite(rh) || rh <= 0 || rh > 100) return null
  const g = Math.log(rh / 100) + (17.62 * tempC) / (243.12 + tempC)
  return (243.12 * g) / (17.62 - g)
}

// Environment Canada humidex. null when it wouldn't be reported (below 25, or no dew point).
export function humidexC(tempC: number, rh: number): number | null {
  const td = dewPointC(tempC, rh)
  if (td === null) return null
  const e = 6.11 * Math.exp(5417.753 * (1 / 273.16 - 1 / (273.15 + td)))
  const h = tempC + 0.5555 * (e - 10)
  return h >= 25 && h > tempC ? Math.round(h) : null
}

// Environment Canada wind chill. null outside its validity window (T>10°C or calm wind).
export function windChillC(tempC: number, windKmh: number): number | null {
  if (tempC > 10 || windKmh < 4.8) return null
  const v = Math.pow(windKmh, 0.16)
  const wc = Math.round(13.12 + 0.6215 * tempC - 11.37 * v + 0.3965 * tempC * v)
  return wc < tempC ? wc : null
}

const WMO: Record<number, string> = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'icy fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'violent showers',
  85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail',
}

export function describeWmo(code: number): string {
  return WMO[code] ?? 'unknown conditions'
}

// --- cache ---

const cache = new Map<string, CacheEntry>()

function normKey(place: string): string {
  return place.toLowerCase().replace(/\s+/g, ' ').trim()
}

function setCache(key: string, entry: CacheEntry) {
  cache.delete(key)
  cache.set(key, entry)
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!)
}

export function __setWeatherCacheForTest(place: string, entry: CacheEntry | null) {
  if (entry === null) cache.delete(normKey(place))
  else setCache(normKey(place), entry)
}

// --- fetch ---

async function geocode(place: string): Promise<GeoLoc | null> {
  const url = `${GEO_API}?name=${encodeURIComponent(place)}&count=1&language=en&format=json`
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`geocode ${res.status}`)
  const r = (await res.json() as { results?: unknown[] })?.results?.[0] as Record<string, unknown> | undefined
  if (!r || typeof r.latitude !== 'number' || typeof r.longitude !== 'number') return null
  return {
    name: String(r.name ?? place),
    region: typeof r.admin1 === 'string' ? r.admin1 : '',
    country: typeof r.country_code === 'string' ? r.country_code.toUpperCase() : '',
    lat: r.latitude,
    lon: r.longitude,
    timezone: typeof r.timezone === 'string' ? r.timezone : 'UTC',
  }
}

function parseDay(daily: Record<string, unknown[]> | undefined, i: number): WxDay | null {
  const hi = Number(daily?.temperature_2m_max?.[i])
  const lo = Number(daily?.temperature_2m_min?.[i])
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null
  const p = Number(daily?.precipitation_probability_max?.[i])
  return { highC: hi, lowC: lo, precipPct: Number.isFinite(p) ? p : null }
}

// pure parser over the Open-Meteo forecast payload — used by fetch and tests; no network.
export function parseForecast(raw: unknown): Wx | null {
  try {
    const c = (raw as { current?: Record<string, unknown> })?.current
    const temp = Number(c?.temperature_2m)
    const rh = Number(c?.relative_humidity_2m)
    if (!Number.isFinite(temp) || !Number.isFinite(rh)) return null
    const daily = (raw as { daily?: Record<string, unknown[]> })?.daily
    return {
      tempC: temp,
      feelsC: Number.isFinite(Number(c?.apparent_temperature)) ? Number(c?.apparent_temperature) : temp,
      humidity: rh,
      windKmh: Number.isFinite(Number(c?.wind_speed_10m)) ? Number(c?.wind_speed_10m) : 0,
      code: Number.isFinite(Number(c?.weather_code)) ? Number(c?.weather_code) : -1,
      isDay: c?.is_day === 1,
      today: parseDay(daily, 0),
      tomorrow: parseDay(daily, 1),
    }
  } catch {
    return null
  }
}

async function fetchWx(loc: GeoLoc): Promise<Wx | null> {
  const params = new URLSearchParams({
    latitude: String(loc.lat),
    longitude: String(loc.lon),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,is_day',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: '2',
  })
  const res = await fetch(`${WX_API}?${params}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`forecast ${res.status}`)
  return parseForecast(await res.json())
}

const inflight = new Map<string, Promise<void>>()

// awaited in doAiCall before context build, like refreshWorldCupIfNeeded. geocodes the
// place (24h cache, misses negative-cached) then fetches conditions (10min TTL).
// concurrent callers for the same place share one request. never throws.
export async function refreshWeatherIfNeeded(query: string): Promise<void> {
  const place = extractLocation(query)
  if (!place) return
  const key = normKey(place)
  const hit = cache.get(key)
  const now = Date.now()
  if (hit) {
    if (hit.loc === null && now - hit.ts < GEO_TTL_MS) return // known non-place
    if (hit.wx && now - hit.ts < WX_TTL_MS) return // fresh conditions
  }
  let p = inflight.get(key)
  if (!p) {
    p = (async () => {
      try {
        const loc = hit?.loc ?? await geocode(key)
        if (!loc) {
          setCache(key, { ts: Date.now(), loc: null, wx: null })
          return
        }
        const wx = await fetchWx(loc)
        setCache(key, { ts: Date.now(), loc, wx })
        if (!wx) log(`weather: forecast parse failed for ${key} — payload shape may have changed`)
      } catch (e) {
        log(`weather: fetch failed for ${key}: ${e}`)
        // keep a stale-but-real entry over recording a failure; only record failure fresh
        if (!hit?.wx) setCache(key, { ts: Date.now(), loc: hit?.loc ?? null, wx: null })
      } finally {
        inflight.delete(key)
      }
    })()
    inflight.set(key, p)
  }
  await p
}

// --- format ---

function t(c: number): string {
  return `${Math.round(c)}°C/${cToF(c)}°F`
}

function dayStr(label: string, d: WxDay): string {
  const p = d.precipPct !== null ? `, precip ${Math.round(d.precipPct)}%` : ''
  return `${label}: high ${t(d.highC)}, low ${t(d.lowC)}${p}`
}

function ageStr(ms: number): string {
  return ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))}s ago` : `${Math.round(ms / 60_000)}m ago`
}

// the injected context section — '' unless the query is weather-shaped. instructive
// fallback lines (no city / unknown place / fetch down) keep the bot honest and engaged
// instead of deflecting or inventing a forecast.
export function getWeatherLine(query: string, now = Date.now()): string {
  const strong = STRONG_RE.test(query)
  const place = extractLocation(query)
  if (!strong && !(place && WEAK_RE.test(query))) return ''
  if (!place) {
    return `\nUser asked about real-world weather but named no city. You DO have live weather data — ask which city they mean, don't deflect.`
  }
  const e = cache.get(normKey(place))
  if (!e || (e.loc && !e.wx)) {
    return `\nUser asked about weather in "${place}" but the live weather lookup is down right now — say so briefly, don't invent conditions.`
  }
  if (e.loc === null) {
    return `\nUser asked about weather in "${place}" but no such place was found — say you couldn't find it, don't invent conditions.`
  }
  const age = now - e.ts
  if (!Number.isFinite(age) || age > HARD_STALE_MS) return ''
  const { loc, wx } = e
  if (!wx) return ''
  const where = [loc.name, loc.region, loc.country].filter(Boolean).join(', ')
  const hx = humidexC(wx.tempC, wx.humidity)
  const wc = windChillC(wx.tempC, wx.windKmh)
  let localTime = ''
  try {
    localTime = new Intl.DateTimeFormat('en-US', { timeZone: loc.timezone, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(now))
  } catch {}
  const parts = [
    `${t(wx.tempC)}, ${describeWmo(wx.code)}`,
    `feels like ${t(wx.feelsC)}`,
    hx !== null ? `humidex ${hx}°C/${cToF(hx)}°F` : '',
    wc !== null ? `wind chill ${wc}°C/${cToF(wc)}°F` : '',
    `humidity ${Math.round(wx.humidity)}%`,
    `wind ${Math.round(wx.windKmh)} km/h (${Math.round(wx.windKmh * 0.621371)} mph)`,
    localTime ? `local time ${localTime}` : '',
  ].filter(Boolean).join(', ')
  const days = [wx.today ? dayStr('today', wx.today) : '', wx.tomorrow ? dayStr('tomorrow', wx.tomorrow) : ''].filter(Boolean).join('; ')
  return `\nCurrent weather in ${where} (REAL, from open-meteo.com as of ${ageStr(age)} — answer weather questions from THIS ONLY; all conversions and indices are precomputed, relay them, never do unit math yourself): ${parts}.${days ? ` ${days}.` : ''}`
}
