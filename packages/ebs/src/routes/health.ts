// GET /health/ready — pure staleness check, factored out so it's testable without
// booting the server (index.ts loads a real file + calls Bun.serve at import time)

import type { CardCache } from '@bazaarinfo/shared'

// daily 4am refresh rewrites fetchedAt; >30h means a refresh cycle was missed
export const STALE_READY_HOURS = 30

export interface ReadyStatus {
  cacheAgeHours: number | null
  stale: boolean
}

export function readyStatus(cache: CardCache, now = Date.now()): ReadyStatus {
  const fetchedAt = Date.parse(cache.fetchedAt)
  if (!Number.isFinite(fetchedAt)) return { cacheAgeHours: null, stale: true }

  const cacheAgeHours = Math.round(((now - fetchedAt) / 3_600_000) * 10) / 10
  return { cacheAgeHours, stale: cacheAgeHours > STALE_READY_HOURS }
}
