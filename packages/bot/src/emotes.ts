import { log } from './log'

interface SevenTVEmote {
  name: string
}

const channelEmotes = new Map<string, string[]>()
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

async function fetch7TVGlobal(): Promise<string[]> {
  try {
    const res = await fetch('https://7tv.io/v3/emote-sets/global', {
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return []
    const data = await res.json() as { emotes?: { name: string }[] }
    return (data.emotes ?? []).map((e) => e.name)
  } catch {
    return []
  }
}

async function fetch7TVChannel(channelId: string): Promise<string[]> {
  try {
    const res = await fetch(`https://7tv.io/v3/users/twitch/${channelId}`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return []
    const data = await res.json() as { emote_set?: { emotes?: { name: string }[] } }
    return (data.emote_set?.emotes ?? []).map((e) => e.name)
  } catch {
    return []
  }
}

export async function refreshGlobalEmotes() {
  const fetched = await fetch7TVGlobal()
  if (fetched.length > 0) {
    globalEmotes = fetched
    lastGlobalFetch = Date.now()
    log(`loaded ${globalEmotes.length} 7TV global emotes`)
  }
}

export async function refreshChannelEmotes(channel: string, channelId: string) {
  const fetched = await fetch7TVChannel(channelId)
  if (fetched.length > 0) {
    channelEmotes.set(channel, fetched)
    log(`loaded ${fetched.length} 7TV emotes for #${channel}`)
  }
}

export function getEmotesForChannel(channel: string): string[] {
  const ch = channelEmotes.get(channel) ?? []
  return [...new Set([...KNOWN_GLOBALS, ...globalEmotes, ...ch])]
}

export function needsGlobalRefresh(): boolean {
  return Date.now() - lastGlobalFetch > REFRESH_INTERVAL
}
