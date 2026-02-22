import { log } from './log'
import { getAccessToken } from './auth'

const USER_AGENT = 'BazaarInfo/1.0 (Twitch bot; github.com/mellen9999/bazaarinfo)'
const FETCH_TIMEOUT = 15_000

// --- tracked accounts ---

interface TrackedAccount {
  name: string           // display name for AI context
  twitchLogin?: string   // twitch username (for stream status)
  youtubeChannelId?: string // youtube channel ID (for RSS)
  aliases: RegExp        // pattern to match in user queries
}

const ACCOUNTS: TrackedAccount[] = [
  {
    name: 'Kripp',
    twitchLogin: 'nl_kripp',
    youtubeChannelId: 'UCeBMccz-PDZf6OB4aV6a3eA',
    aliases: /\b(kripp|kripparrian|nl_kripp)\b/i,
  },
  {
    name: 'Reynad',
    twitchLogin: 'reynad27',
    youtubeChannelId: 'UCrZTN5qnHqGhZglG3wUWKng',
    aliases: /\b(reynad|andrey|reynad27)\b/i,
  },
  {
    name: 'Underflowr',
    twitchLogin: 'underflowr',
    youtubeChannelId: 'UCOB38b8OOKAx7sutxBw0ATw',
    aliases: /\b(underflowr|underflow)\b/i,
  },
  {
    name: 'The Bazaar',
    youtubeChannelId: 'UCG8MB4DWHpi6fP1ISMev8bQ',
    aliases: /\b(the bazaar|bazaar (official|game|channel|youtube|yt))\b/i,
  },
]

// --- state ---

interface StreamStatus {
  live: boolean
  game?: string
  title?: string
  checkedAt: number
}

interface YouTubeVideo {
  title: string
  published: string // ISO date
}

interface AccountActivity {
  name: string
  stream?: StreamStatus
  recentVideos: YouTubeVideo[]
  updatedAt: number
}

const activityCache = new Map<string, AccountActivity>()

// --- YouTube RSS fetcher ---

async function fetchYouTubeRecent(channelId: string): Promise<YouTubeVideo[]> {
  try {
    const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    })
    if (!res.ok) return []
    const xml = await res.text()

    // parse entries from Atom XML (lightweight, no deps)
    const entries: YouTubeVideo[] = []
    const entryRe = /<entry>([\s\S]*?)<\/entry>/g
    let match
    while ((match = entryRe.exec(xml)) && entries.length < 5) {
      const entry = match[1]
      const title = entry.match(/<title>([^<]+)<\/title>/)?.[1]
        ?.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      const published = entry.match(/<published>([^<]+)<\/published>/)?.[1]
      if (title && published) entries.push({ title, published })
    }
    return entries
  } catch {
    return []
  }
}

// --- Twitch stream status fetcher ---

async function fetchStreamStatus(login: string): Promise<StreamStatus> {
  const now = Date.now()
  try {
    const token = getAccessToken()
    const clientId = process.env.TWITCH_CLIENT_ID
    if (!token || !clientId) return { live: false, checkedAt: now }

    const res = await fetch(
      `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(login)}`,
      {
        headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      },
    )
    if (!res.ok) return { live: false, checkedAt: now }

    const data = await res.json() as { data: { type: string; game_name?: string; title?: string }[] }
    const stream = data.data[0]
    if (stream?.type === 'live') {
      return { live: true, game: stream.game_name, title: stream.title, checkedAt: now }
    }
    return { live: false, checkedAt: now }
  } catch {
    return { live: false, checkedAt: now }
  }
}

// --- refresh ---

export async function refreshActivity(): Promise<void> {
  for (const acct of ACCOUNTS) {
    const existing = activityCache.get(acct.name) ?? { name: acct.name, recentVideos: [], updatedAt: 0 }

    if (acct.youtubeChannelId) {
      const videos = await fetchYouTubeRecent(acct.youtubeChannelId)
      if (videos.length > 0) existing.recentVideos = videos
    }

    if (acct.twitchLogin) {
      existing.stream = await fetchStreamStatus(acct.twitchLogin)
    }

    existing.updatedAt = Date.now()
    activityCache.set(acct.name, existing)
  }

  log(`activity: refreshed ${ACCOUNTS.length} accounts`)
}

// --- query interface ---

function formatAge(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime()
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

/** Get activity summary for a specific person (matched by aliases in query) */
export function getActivityFor(query: string): string | null {
  for (const acct of ACCOUNTS) {
    if (!acct.aliases.test(query)) continue
    const data = activityCache.get(acct.name)
    if (!data) continue

    const parts: string[] = []

    if (data.stream) {
      if (data.stream.live) {
        const game = data.stream.game ? ` playing ${data.stream.game}` : ''
        parts.push(`${acct.name} is LIVE on Twitch${game}`)
      } else {
        parts.push(`${acct.name} is not currently streaming`)
      }
    }

    if (data.recentVideos.length > 0) {
      const recent = data.recentVideos.slice(0, 3)
      const vids = recent.map((v) => `"${v.title}" (${formatAge(v.published)})`).join(', ')
      parts.push(`Recent YT: ${vids}`)
    }

    if (parts.length === 0) continue
    return parts.join('. ')
  }
  return null
}

/** Get full activity digest for all tracked accounts */
export function getActivityDigest(): string {
  if (activityCache.size === 0) return ''

  const lines: string[] = []
  for (const acct of ACCOUNTS) {
    const data = activityCache.get(acct.name)
    if (!data) continue

    const parts: string[] = []

    if (data.stream) {
      parts.push(data.stream.live ? `LIVE${data.stream.game ? ` (${data.stream.game})` : ''}` : 'offline')
    }

    if (data.recentVideos.length > 0) {
      const latest = data.recentVideos[0]
      parts.push(`latest YT: "${latest.title}" ${formatAge(latest.published)}`)
    }

    if (parts.length > 0) lines.push(`${acct.name}: ${parts.join(', ')}`)
  }

  return lines.length > 0 ? lines.join(' | ') : ''
}
