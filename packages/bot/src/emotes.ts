import { log } from './log'
import { getDescriptions } from './emote-describe'

export interface EmoteData {
  name: string
  id: string
  overlay: boolean
}

const channelEmotes = new Map<string, string[]>()
const mergedCache = new Map<string, string[]>()
let globalEmotes: string[] = []

// track 7TV emote set IDs for EventAPI subscriptions
const channelEmoteSetIds = new Map<string, string>()
let globalEmoteSetId = ''

// fast lookup set for all known emote names (rebuilt on any mutation)
let allEmoteNames = new Set<string>()

function rebuildAllEmoteNames() {
  const names = new Set<string>(KNOWN_GLOBALS)
  for (const name of globalEmotes) names.add(name)
  for (const names_ of channelEmotes.values()) {
    for (const n of names_) names.add(n)
  }
  allEmoteNames = names
}

export function getEmoteSetId(channel: string): string | undefined {
  return channelEmoteSetIds.get(channel)
}

export function getAllEmoteSetIds(): Map<string, string> {
  return channelEmoteSetIds
}

export function getGlobalEmoteSetId(): string {
  return globalEmoteSetId
}

// mutation fns for real-time EventAPI updates
export function addChannelEmote(channel: string, name: string) {
  const list = channelEmotes.get(channel) ?? []
  if (!list.includes(name)) {
    list.push(name)
    channelEmotes.set(channel, list)
    mergedCache.delete(channel)
    emoteBlockCache.delete(channel)
    rebuildAllEmoteNames()
  }
}

export function removeChannelEmote(channel: string, name: string) {
  const list = channelEmotes.get(channel)
  if (!list) return
  const idx = list.indexOf(name)
  if (idx !== -1) {
    list.splice(idx, 1)
    mergedCache.delete(channel)
    emoteBlockCache.delete(channel)
    rebuildAllEmoteNames()
  }
}

export function renameChannelEmote(channel: string, oldName: string, newName: string) {
  const list = channelEmotes.get(channel)
  if (!list) return
  const idx = list.indexOf(oldName)
  if (idx !== -1) {
    list[idx] = newName
    mergedCache.delete(channel)
    rebuildAllEmoteNames()
  }
}

export function removeChannelEmotes(channel: string) {
  channelEmotes.delete(channel)
  channelEmoteSetIds.delete(channel)
  mergedCache.delete(channel)
  emoteBlockCache.delete(channel)
  rebuildAllEmoteNames()
}

// well-known twitch/bttv/ffz globals the model should know
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

const KNOWN_GLOBALS = [
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

async function fetch7TVData(url: string, extract: (data: any) => EmoteData[]): Promise<EmoteData[]> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return []
    return extract(await res.json())
  } catch (e) {
    log('7TV fetch failed:', url, e instanceof Error ? e.message : e)
    return []
  }
}

function extractEmotes(emotes: any[]): EmoteData[] {
  return emotes.map((e: any) => ({
    name: e.name,
    id: e.data?.id ?? e.id,
    overlay: ((e.flags ?? 0) & 1) === 1, // 7TV ZeroWidth flag = bit 0
  }))
}

export async function refreshGlobalEmotes(): Promise<EmoteData[]> {
  let setId = ''
  const fetched = await fetch7TVData(
    'https://7tv.io/v3/emote-sets/global',
    (d) => {
      setId = d.id ?? ''
      return extractEmotes(d.emotes ?? [])
    },
  )
  if (fetched.length > 0) {
    globalEmotes = fetched.map((e) => e.name)
    if (setId) globalEmoteSetId = setId
    mergedCache.clear()
    rebuildAllEmoteNames()
    log(`loaded ${globalEmotes.length} 7TV global emotes`)
  }
  return fetched
}

export async function refreshChannelEmotes(channel: string, channelId: string): Promise<EmoteData[]> {
  let setId = ''
  const fetched = await fetch7TVData(
    `https://7tv.io/v3/users/twitch/${channelId}`,
    (d) => {
      setId = d.emote_set?.id ?? ''
      return extractEmotes(d.emote_set?.emotes ?? [])
    },
  )
  if (fetched.length > 0) {
    channelEmotes.set(channel, fetched.map((e) => e.name))
    if (setId) channelEmoteSetIds.set(channel, setId)
    mergedCache.delete(channel)
    rebuildAllEmoteNames()
    log(`loaded ${fetched.length} 7TV emotes for #${channel}`)
  }
  return fetched
}

export function getEmotesForChannel(channel: string): string[] {
  const cached = mergedCache.get(channel)
  if (cached) return cached
  const ch = channelEmotes.get(channel) ?? []
  const merged = [...new Set([...KNOWN_GLOBALS, ...globalEmotes, ...ch])]
  mergedCache.set(channel, merged)
  return merged
}

// --- time-windowed emote shuffle (rebuild every 10min for prompt cache hits) ---
const EMOTE_SHUFFLE_WINDOW = 10 * 60_000
const emoteBlockCache = new Map<string, { text: string; ts: number; usedKey: string }>()

function usedSetKey(used?: Set<string>): string {
  if (!used || used.size === 0) return ''
  return [...used].sort().join(',')
}

/** format emotes for AI context — shuffled per time window, filters recently used */
export function formatEmotesForAI(channel: string, topEmotes?: string[], recentlyUsed?: Set<string>): string {
  const all = getEmotesForChannel(channel)
  if (all.length === 0) return ''

  const now = Date.now()
  const uKey = usedSetKey(recentlyUsed)
  const cached = emoteBlockCache.get(channel)
  if (cached && now - cached.ts < EMOTE_SHUFFLE_WINDOW && cached.usedKey === uKey) return cached.text

  const descriptions = getDescriptions()
  const topSet = new Set(topEmotes ?? [])
  const usedSet = recentlyUsed ?? new Set<string>()

  const byMood = new Map<string, string[]>()
  const overlays: string[] = []

  for (const name of all) {
    if (usedSet.has(name)) continue
    const desc = descriptions[name]
    if (!desc) continue
    if (desc.overlay) {
      overlays.push(`${name}(${desc.desc})`)
      continue
    }
    const mood = desc.mood
    if (!byMood.has(mood)) byMood.set(mood, [])
    byMood.get(mood)!.push(`${name}(${desc.desc})`)
  }

  // shuffle non-favorite emotes within each mood bucket
  for (const [mood, entries] of byMood) {
    const pinned: string[] = []
    const rest: string[] = []
    for (const e of entries) {
      if (topSet.has(e.split('(')[0])) pinned.push(e)
      else rest.push(e)
    }
    shuffle(rest)
    byMood.set(mood, [...pinned, ...rest])
  }

  const MOOD_BUDGET: Record<string, number> = {
    love: 2, funny: 2, hype: 2, sad: 1, happy: 2, greeting: 1,
    sarcasm: 2, dance: 1, cute: 1, celebration: 1, chad: 1,
    shock: 1, scared: 1, thinking: 1, rage: 1, cringe: 1,
    cool: 1, confused: 1, neutral: 1,
  }
  const MAX_SPOTLIGHT = 15
  let spotlightTotal = 0
  const lines: string[] = []
  const sortedMoods = [...byMood.keys()].sort((a, b) => (MOOD_BUDGET[b] ?? 1) - (MOOD_BUDGET[a] ?? 1))

  for (const mood of sortedMoods) {
    const entries = byMood.get(mood)!
    const budget = MOOD_BUDGET[mood] ?? 1
    const take = Math.min(budget, MAX_SPOTLIGHT - spotlightTotal)
    if (take <= 0) continue
    // first entry per mood keeps description for context, rest are names only (saves ~300 tokens)
    const parts = entries.slice(0, take).map((e, i) => {
      return (i === 0 || topSet.has(e.split('(')[0])) ? e : e.split('(')[0]
    })
    lines.push(`  ${mood}: ${parts.join(' ')}`)
    spotlightTotal += take
  }

  if (overlays.length > 0) {
    shuffle(overlays)
    const spotlightOv = overlays.slice(0, 3)
    const restOv = overlays.slice(3).map((e) => e.split('(')[0])
    let line = `  overlays: ${spotlightOv.join(' ')}`
    if (restOv.length > 0) line += ` ${restOv.join(' ')}`
    lines.push(line)
  }

  const text = `Emotes:\n${lines.join('\n')}`
  emoteBlockCache.set(channel, { text, ts: now, usedKey: uKey })
  return text
}

export function invalidateEmoteBlockCache(channel?: string) {
  if (channel) emoteBlockCache.delete(channel)
  else emoteBlockCache.clear()
}

/** pick a random emote by mood for a channel — returns empty string if none found */
export function pickEmoteByMood(channel: string, ...moods: string[]): string {
  const all = getEmotesForChannel(channel)
  if (all.length === 0) return ''
  const descriptions = getDescriptions()
  const matches: string[] = []
  for (const name of all) {
    const desc = descriptions[name]
    if (!desc || desc.overlay) continue
    if (moods.includes(desc.mood)) matches.push(name)
  }
  if (matches.length === 0) return ''
  return matches[Math.floor(Math.random() * matches.length)]
}
