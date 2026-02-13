const userCooldowns = new Map<string, number>()
let globalLast = 0

const USER_CD = 3000
const GLOBAL_CD = 1000

export function checkCooldown(userId: string): boolean {
  const now = Date.now()

  if (now - globalLast < GLOBAL_CD) return false

  const last = userCooldowns.get(userId) ?? 0
  if (now - last < USER_CD) return false

  globalLast = now
  userCooldowns.set(userId, now)
  return true
}
