// heatsync personal emotes: a chatter's inventory names count as emotes for this bot, so a
// heatsync emote in chat is never read as a word. public read, no key; every failure is silent.
import { addHeatsyncEmotes } from './emotes'

const TTL = 10 * 60_000
const MAX_SEEN = 5000
const MAX_NAMES = 500
const seen = new Map<string, number>()

function base(): string {
  return (process.env.HEATSYNC_URL || 'https://heatsync.org').replace(/\/+$/, '')
}

export async function noteChatterEmotes(userId: string): Promise<void> {
  if (!/^\d{1,20}$/.test(userId)) return
  const now = Date.now()
  if ((seen.get(userId) ?? 0) > now) return
  seen.delete(userId)
  seen.set(userId, now + TTL)
  while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value as string)
  try {
    const token = `twitch:${userId}`
    const res = await fetch(`${base()}/api/users/emotes/batch?ids=${token}`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return
    const body = await res.json() as { sets?: Record<string, { custom_name?: unknown }[]> }
    const rows = body.sets?.[token]
    if (!Array.isArray(rows)) return
    const names = rows.map((r) => r.custom_name).filter((n): n is string => typeof n === 'string').slice(0, MAX_NAMES)
    addHeatsyncEmotes(names)
  } catch {}
}
