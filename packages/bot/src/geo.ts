import { log } from './log'

// place-name → coordinates + IANA zone via Open-Meteo's geocoder (no key, no auth, no
// tracking). shared by weather.ts and clock.ts so "time in tokyo" then "weather in tokyo"
// costs one lookup. places don't move: 24h cache, misses included; a failed fetch is never
// cached, so the next ask retries.

const UA = 'BazaarInfo/1.0 (Twitch bot; github.com/mellen9999/bazaarinfo)'
const GEO_API = 'https://geocoding-api.open-meteo.com/v1/search'
const TTL_MS = 24 * 60 * 60_000
const FETCH_TIMEOUT_MS = 4_000
const MAX_CACHE = 128

export interface GeoLoc {
  name: string
  region: string // admin1, may be ''
  country: string // country code, e.g. "CA"
  lat: number
  lon: number
  /** '' when the place spans several zones — the geocoder returns none for the US, AU, CA */
  timezone: string
  population?: number
  /** geonames feature code: PCLI country, PPLC capital, PPLA admin seat, PPL town */
  feature?: string
}

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
    timezone: typeof r.timezone === 'string' ? r.timezone : '',
    population: typeof r.population === 'number' ? r.population : undefined,
    feature: typeof r.feature_code === 'string' ? r.feature_code : undefined,
  }
}

const cache = new Map<string, { ts: number; loc: GeoLoc | null }>()
const inflight = new Map<string, Promise<GeoLoc | null | undefined>>()

export function placeKey(place: string): string {
  return place.toLowerCase().replace(/\s+/g, ' ').trim()
}

function put(key: string, loc: GeoLoc | null) {
  cache.delete(key)
  cache.set(key, { ts: Date.now(), loc })
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!)
}

/** cached result: a place, null = no such place, undefined = never looked up or the lookup failed */
export function cachedPlace(place: string): GeoLoc | null | undefined {
  const hit = cache.get(placeKey(place))
  return hit && Date.now() - hit.ts < TTL_MS ? hit.loc : undefined
}

/** same contract as cachedPlace; concurrent asks for one place share a request. never throws. */
export async function lookupPlace(place: string): Promise<GeoLoc | null | undefined> {
  const key = placeKey(place)
  const hit = cachedPlace(key)
  if (hit !== undefined) return hit
  let p = inflight.get(key)
  if (!p) {
    p = geocode(key)
      .then((loc) => {
        put(key, loc)
        return loc
      })
      .catch((e) => {
        log(`geo: lookup failed for ${key}: ${e}`)
        return undefined
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, p)
  }
  return p
}

export function __setPlaceForTest(place: string, loc: GeoLoc | null | undefined) {
  if (loc === undefined) cache.delete(placeKey(place))
  else put(placeKey(place), loc)
}
