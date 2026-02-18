import { log } from './log'

interface SevenTVEmote {
  name: string
}

interface SevenTVEmoteSet {
  emotes: SevenTVEmote[]
}

interface SevenTVUserResponse {
  emote_set?: SevenTVEmoteSet
}

const FETCH_TIMEOUT = 10_000
const channelEmotes = new Map<string, string[]>()
let globalEmotes: string[] = []
let refreshTimer: Timer | null = null

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) })
    if (!res.ok) return null
    return await res.json() as T
  } catch {
    return null
  }
}

async function fetchGlobalEmotes(): Promise<string[]> {
  const data = await fetchJson<SevenTVEmoteSet>('https://7tv.io/v3/emote-sets/global')
  if (!data?.emotes) return []
  return data.emotes.map((e) => e.name)
}

async function fetchChannelEmotes(twitchUserId: string): Promise<string[]> {
  const data = await fetchJson<SevenTVUserResponse>(`https://7tv.io/v3/users/twitch/${twitchUserId}`)
  if (!data?.emote_set?.emotes) return []
  return data.emote_set.emotes.map((e) => e.name)
}

export async function loadEmotes(channels: { name: string; userId: string }[]) {
  globalEmotes = await fetchGlobalEmotes()
  log(`loaded ${globalEmotes.length} global 7TV emotes`)

  for (const ch of channels) {
    const emotes = await fetchChannelEmotes(ch.userId)
    channelEmotes.set(ch.name, emotes)
    if (emotes.length > 0) log(`loaded ${emotes.length} 7TV emotes for #${ch.name}`)
  }
}

export function getEmotes(channel: string): string[] {
  const ch = channelEmotes.get(channel) ?? []
  return [...ch, ...globalEmotes]
}

export async function loadChannelEmotes(channel: string, userId: string) {
  const emotes = await fetchChannelEmotes(userId)
  channelEmotes.set(channel, emotes)
}

export function startDailyRefresh(channels: { name: string; userId: string }[]) {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = setInterval(() => {
    loadEmotes(channels).catch((e) => log(`emote refresh error: ${e}`))
  }, 24 * 60 * 60_000)
}

export function stopRefresh() {
  if (refreshTimer) clearInterval(refreshTimer)
}
