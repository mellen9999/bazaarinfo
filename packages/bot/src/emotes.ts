import { log } from './log'

const channelEmotes = new Map<string, string[]>()
const mergedCache = new Map<string, string[]>()
let globalEmotes: string[] = []
let lastGlobalFetch = 0
const REFRESH_INTERVAL = 24 * 60 * 60_000 // 1 day

// well-known twitch/bttv/ffz globals the model should know
const KNOWN_GLOBALS = [
  // twitch
  'Kappa', 'KappaPride', 'Keepo', 'PogChamp', 'LUL', 'OMEGALUL', 'monkaS',
  'PepeHands', 'FeelsBadMan', 'FeelsGoodMan', 'FeelsStrongMan', 'Sadge', 'widepeepoHappy',
  'widepeepoSad', 'peepoClap', 'EZ', 'Clap', 'KEKW', 'LULW', 'catJAM',
  'modCheck', 'Copium', 'Copege', 'Clueless', 'Aware', 'Stare',
  'BASED', 'Chatting', 'ICANT', 'Susge', 'NOTED', 'ppOverheat',
  'monkaW', 'monkaHmm', 'PepeLaugh', 'pepeMeltdown', 'peepoGiggle',
  'GIGACHAD', 'Chad', 'BBoomer', 'forsenCD', 'xqcL',
  'POGGERS', 'PagMan', 'PagChomp', 'D:', 'NODDERS', 'NOPERS',
  'pepega', 'WideHardo', '5Head', '3Head', 'pepeDS', 'RainTime',
]

async function fetch7TV(url: string, extract: (data: any) => { name: string }[]): Promise<string[]> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return []
    return extract(await res.json()).map((e) => e.name)
  } catch {
    return []
  }
}

export async function refreshGlobalEmotes() {
  const fetched = await fetch7TV(
    'https://7tv.io/v3/emote-sets/global',
    (d) => d.emotes ?? [],
  )
  if (fetched.length > 0) {
    globalEmotes = fetched
    lastGlobalFetch = Date.now()
    mergedCache.clear()
    log(`loaded ${globalEmotes.length} 7TV global emotes`)
  }
}

export async function refreshChannelEmotes(channel: string, channelId: string) {
  const fetched = await fetch7TV(
    `https://7tv.io/v3/users/twitch/${channelId}`,
    (d) => d.emote_set?.emotes ?? [],
  )
  if (fetched.length > 0) {
    channelEmotes.set(channel, fetched)
    mergedCache.delete(channel)
    log(`loaded ${fetched.length} 7TV emotes for #${channel}`)
  }
}

export function getEmotesForChannel(channel: string): string[] {
  const cached = mergedCache.get(channel)
  if (cached) return cached
  const ch = channelEmotes.get(channel) ?? []
  const merged = [...new Set([...KNOWN_GLOBALS, ...globalEmotes, ...ch])]
  mergedCache.set(channel, merged)
  return merged
}

export function needsGlobalRefresh(): boolean {
  return Date.now() - lastGlobalFetch > REFRESH_INTERVAL
}
