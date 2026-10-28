// heatsync personal emotes. a chatter's inventory names count as emotes for this bot (so a
// heatsync emote in chat is never read as a word), and when a chatter uses one the bot lacks it
// adds it to its OWN heatsync inventory so it can post it back. reads are public; the add needs
// HEATSYNC_EMOTES_KEY (an api key acting as the bot's account) and is a no-op without it.
// every failure is silent.
import { addHeatsyncEmotes, noteBotHsEmote } from './emotes'
import { warn } from './log'

const TTL = 10 * 60_000
const MAX_SEEN = 5000
const MAX_NAMES = 500
const MAX_ADOPT_PER_MSG = 3
const DAY_CAP = 25
const seen = new Map<string, { exp: number; rows: Row[] }>()
const botOwned = new Set<string>()
let botOwnedExp = 0
let botId = ''
let adoptDay = ''
let adoptedToday = 0
let pausedUntil = 0

interface Row { custom_name?: unknown; name?: unknown; url?: unknown; width?: unknown; height?: unknown; source?: unknown; source_id?: unknown; zero_width?: unknown }

function base(): string {
  return (process.env.HEATSYNC_URL || 'https://heatsync.org').replace(/\/+$/, '')
}

export function setBotHeatsyncId(id: string): void { botId = id }

async function fetchSet(userId: string): Promise<Row[] | null> {
  try {
    const token = `twitch:${userId}`
    const res = await fetch(`${base()}/api/users/emotes/batch?ids=${token}`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    const body = await res.json() as { sets?: Record<string, Row[]> }
    const rows = body.sets?.[token]
    return Array.isArray(rows) ? rows : null
  } catch { return null }
}

const nameOf = (r: Row): string | null => (typeof r.custom_name === 'string' && r.custom_name ? r.custom_name : null)

// shared in-flight promise: started alongside the chatter's fetch so the two run in parallel,
// and a second message mid-refresh waits on the same one instead of reading a half-built set
let ownedRefresh: Promise<void> | null = null

function refreshBotOwned(): Promise<void> {
  if (!botId || Date.now() < botOwnedExp) return ownedRefresh ?? Promise.resolve()
  botOwnedExp = Date.now() + TTL
  ownedRefresh = (async () => {
    const rows = await fetchSet(botId)
    if (!rows) { botOwnedExp = 0; return }
    botOwned.clear()
    for (const r of rows) { const n = nameOf(r); if (n) { botOwned.add(n); noteBotHsEmote(n) } }
  })().finally(() => { ownedRefresh = null })
  return ownedRefresh
}

async function adopt(rows: Row[], text: string): Promise<void> {
  const key = process.env.HEATSYNC_EMOTES_KEY
  if (!key || !botId || !text || Date.now() < pausedUntil) return
  const words = new Set(text.split(/\s+/))
  const used = rows.filter((r) => { const n = nameOf(r); return n && words.has(n) })
  if (used.length === 0) return
  await refreshBotOwned()
  const day = new Date().toISOString().slice(0, 10)
  if (day !== adoptDay) { adoptDay = day; adoptedToday = 0 }
  let added = 0
  for (const r of used) {
    const customName = nameOf(r)!
    if (botOwned.has(customName)) { noteBotHsEmote(customName); continue }
    if (added >= MAX_ADOPT_PER_MSG || adoptedToday >= DAY_CAP) return
    if (typeof r.url !== 'string') continue
    const body: Record<string, unknown> = { emoteUrl: r.url, emoteName: typeof r.name === 'string' ? r.name : customName, customName }
    if (typeof r.source === 'string') body.source = r.source
    if (typeof r.source_id === 'string') body.sourceId = r.source_id
    if (typeof r.width === 'number') body.width = r.width
    if (typeof r.height === 'number') body.height = r.height
    if (r.zero_width === true) body.zeroWidth = true
    try {
      const res = await fetch(`${base()}/api/v1/emotes`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': 'bazaarinfo/0.1.0' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) { botOwned.add(customName); noteBotHsEmote(customName); added++; adoptedToday++; continue }
      if (res.status === 429) { pausedUntil = Date.now() + 3_600_000; return }
      if (res.status === 401 || res.status === 403) { pausedUntil = Date.now() + 3_600_000; warn(`hs-emotes: add refused ${res.status}, check HEATSYNC_EMOTES_KEY`); return }
      botOwned.add(customName) // 4xx on this emote (blocked/invalid): don't retry it every message
    } catch { return }
  }
}

export async function noteChatterEmotes(userId: string, text = ''): Promise<void> {
  if (!/^\d{1,20}$/.test(userId)) return
  let hit = seen.get(userId)
  if (process.env.HEATSYNC_EMOTES_KEY) void refreshBotOwned()
  if (!hit || hit.exp <= Date.now()) {
    const rows = await fetchSet(userId)
    hit = { exp: Date.now() + TTL, rows: (rows ?? []).slice(0, MAX_NAMES) }
    seen.delete(userId)
    seen.set(userId, hit)
    while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value as string)
    addHeatsyncEmotes(hit.rows.map(nameOf).filter((n): n is string => !!n))
  }
  if (hit.rows.length) await adopt(hit.rows, text).catch(() => {})
}
