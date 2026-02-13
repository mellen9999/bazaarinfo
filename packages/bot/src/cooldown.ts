const userCooldowns = new Map<string, number>()
let globalLast = 0

const USER_CD = 3000
const GLOBAL_CD = 1000
const CLEANUP_INTERVAL = 3600_000 // 1h
const STALE_THRESHOLD = 86400_000 // 24h

export function checkCooldown(userId: string): boolean {
  const now = Date.now()

  if (now - globalLast < GLOBAL_CD) return false

  const last = userCooldowns.get(userId) ?? 0
  if (now - last < USER_CD) return false

  globalLast = now
  userCooldowns.set(userId, now)
  return true
}

// prune stale entries every hour
setInterval(() => {
  const now = Date.now()
  for (const [id, ts] of userCooldowns) {
    if (now - ts > STALE_THRESHOLD) userCooldowns.delete(id)
  }
}, CLEANUP_INTERVAL)
