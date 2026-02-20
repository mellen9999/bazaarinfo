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

export function isEmote(name: string): boolean {
  return allEmoteNames.has(name)
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
    allEmoteNames.add(name)
  }
}

export function removeChannelEmote(channel: string, name: string) {
  const list = channelEmotes.get(channel)
  if (!list) return
  const idx = list.indexOf(name)
  if (idx !== -1) {
    list.splice(idx, 1)
    mergedCache.delete(channel)
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
  rebuildAllEmoteNames()
}

// well-known twitch/bttv/ffz globals the model should know
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

/** format emotes for AI context — prioritizes channel favorites, caps total ~40 */
export function formatEmotesForAI(channel: string, topEmotes?: string[]): string {
  const all = getEmotesForChannel(channel)
  if (all.length === 0) return ''

  const descriptions = getDescriptions()
  const topSet = new Set(topEmotes ?? [])

  const byMood = new Map<string, string[]>()
  const overlays: string[] = []

  for (const name of all) {
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

  // prioritize channel favorites: sort each mood bucket so top emotes come first
  if (topSet.size > 0) {
    for (const [mood, entries] of byMood) {
      byMood.set(mood, entries.sort((a, b) => {
        const aTop = topSet.has(a.split('(')[0]) ? 0 : 1
        const bTop = topSet.has(b.split('(')[0]) ? 0 : 1
        return aTop - bTop
      }))
    }
  }

  const MAX_PER_MOOD = 3
  const MAX_TOTAL = 40
  let total = 0
  const lines: string[] = []
  const sortedMoods = [...byMood.keys()].sort()
  for (const mood of sortedMoods) {
    if (total >= MAX_TOTAL) break
    const take = Math.min(MAX_PER_MOOD, MAX_TOTAL - total)
    const entries = byMood.get(mood)!.slice(0, take)
    lines.push(`  ${mood}: ${entries.join(' ')}`)
    total += entries.length
  }

  if (overlays.length > 0 && total < MAX_TOTAL) {
    lines.push(`  [OVERLAYS]: ${overlays.slice(0, 3).join(' ')}`)
  }

  return `Emotes (0-1 per msg, only when perfect):\n${lines.join('\n')}`
}
