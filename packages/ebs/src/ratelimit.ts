// Per-IP rate limiter: max req/min, resets every minute.
// On overflow, evict all entries rather than blocking new viewers —
// the map is bounded and the reset was imminent anyway.

export const MAX_RATE_ENTRIES = 100_000
export const hits = new Map<string, number>()
setInterval(() => hits.clear(), 60_000)

export function rateOk(ip: string, max = 60): boolean {
  if (hits.size >= MAX_RATE_ENTRIES && !hits.has(ip)) hits.clear()
  const n = (hits.get(ip) ?? 0) + 1
  hits.set(ip, n)
  return n <= max
}
