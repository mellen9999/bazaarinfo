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

// emote mood taxonomy — lets the AI pick the right emote for the moment
// only categorize well-known emotes; channel-specific ones listed separately
const MOOD_MAP: Record<string, string[]> = {
  'hype/pog': ['PogChamp', 'POGGERS', 'PagMan', 'PagChomp', 'peepoClap', 'Clap', 'NODDERS', 'PogU', 'Pog', 'WideHardo'],
  'funny/laughing': ['KEKW', 'LUL', 'LULW', 'OMEGALUL', 'ICANT', 'PepeLaugh', 'peepoGiggle'],
  'sad/pain': ['Sadge', 'PepeHands', 'FeelsBadMan', 'widepeepoSad', 'pepeMeltdown', 'D:'],
  'happy/warm': ['FeelsGoodMan', 'FeelsStrongMan', 'widepeepoHappy', 'catJAM', 'pepeDS', 'RainTime'],
  'sarcasm/troll': ['Kappa', 'Keepo', 'KappaPride', 'Copium', 'Copege', 'Clueless', 'EZ'],
  'shock/concern': ['monkaS', 'monkaW', 'Susge', 'ppOverheat'],
  'thinking/aware': ['monkaHmm', 'Aware', 'Stare', 'NOTED', 'modCheck', 'Chatting', '5Head'],
  'chad/based': ['GIGACHAD', 'Chad', 'BASED'],
  'cringe/dumb': ['pepega', '3Head', 'BBoomer'],
  'misc': ['NOPERS', 'forsenCD', 'xqcL'],
}

const categorized = new Set(Object.values(MOOD_MAP).flat())

/** format emotes for AI context — categorized by mood + uncategorized extras */
export function formatEmotesForAI(channel: string): string {
  const all = getEmotesForChannel(channel)
  if (all.length === 0) return ''

  // build categorized section from known emotes that are available
  const available = new Set(all)
  const lines: string[] = []
  for (const [mood, emotes] of Object.entries(MOOD_MAP)) {
    const present = emotes.filter((e) => available.has(e))
    if (present.length > 0) lines.push(`  ${mood}: ${present.join(' ')}`)
  }

  // uncategorized = channel-specific + unknown 7TV emotes
  const extras = all.filter((e) => !categorized.has(e))
  if (extras.length > 0) lines.push(`  channel/other: ${extras.join(' ')}`)

  return `Emotes (IMAGES, use sparingly — pick by mood):\n${lines.join('\n')}`
}
