// Companion traffic visibility. Frames arrive from programs on streamers' machines, so
// a wrong secret, an old companion or a broken payload used to fail with nothing in the
// journal — "the overlay shows no cards" had no trail to follow. Each route/channel/
// outcome is logged at most once per window: enough to see who is connecting and why
// they're refused, never a line per frame.

const WINDOW_MS = 10 * 60 * 1000
const MAX_KEYS = 10_000

const lastLogged = new Map<string, number>()

export function logCompanion(route: string, channelId: string | null, outcome: string): void {
  const key = `${route}|${channelId ?? '?'}|${outcome}`
  const now = Date.now()
  const prev = lastLogged.get(key)
  if (prev !== undefined && now - prev < WINDOW_MS) return
  if (lastLogged.size >= MAX_KEYS && prev === undefined) lastLogged.clear()
  lastLogged.set(key, now)
  console.log(`[ebs] companion ${route} channel=${channelId ?? '?'}: ${outcome}`)
}

export function __clearCompanionLogForTest(): void {
  lastLogged.clear()
}
