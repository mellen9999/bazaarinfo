// offline channel titles via helix /channels — a streamer's title often carries the
// real plan ("NEXT STREAM WEDNESDAY"), which outranks any statistical prediction
// (schedule.ts withTitleOverride / TITLE_SCHEDULE_RE decide whether to surface it).
// async fetch is called from the command path and ai.ts pre-build; the sync cached
// getter feeds the synchronous prompt builder. fail-soft everywhere.

import { getAccessToken } from './auth'
import { log } from './log'

// an ask for the title itself — the one ask where a missing title is a visible failure.
// the bare word is not enough: cards carry a Title field, and "title screen"/"title track"/
// "item titles" are all somebody else's title. a loose gate injected the channel title with
// "quote it" on asks that were about none of that (live 2026-09-19). shape mirrors
// isShirtQuery: the word, minus the other owners, plus a subject or a bare ask.
const TITLE_WORD_RE = /\btitles?\b/i
const OTHER_TITLE_RE = /\btitles?\s+(?:screen|card|track|belt|fight|defen[cs]e|shot|holder|match|sequence)\b|\b(?:item|card|hero|song|album|video|clip|book|movie|anime|manga|episode|game|job)\s+titles?\b/i
const TITLE_SUBJECT_RE = /\b(?:stream|channel|he|his|him|kripp\w*|krip|streamer|nl_?kripp)\b/i
const BARE_TITLE_RE = /^\W*(?:!\w+\s+)?(?:whats?\s+(?:the\s+)?)?titles?\W*$/i // the command prefix is stripped upstream; tolerated here so the gate never depends on that

export function isTitleQuery(q: string): boolean {
  if (!TITLE_WORD_RE.test(q) || OTHER_TITLE_RE.test(q)) return false
  return BARE_TITLE_RE.test(q) || TITLE_SUBJECT_RE.test(q)
}

const TITLE_TTL_MS = 5 * 60_000
const FETCH_TIMEOUT_MS = 2_000

const idCache = new Map<string, string>() // login → broadcaster id (stable)
const titleCache = new Map<string, { title: string; at: number }>()

async function helix(url: string): Promise<{ data?: Record<string, string>[] } | null> {
  const token = getAccessToken()
  const clientId = process.env.TWITCH_CLIENT_ID
  if (!token || !clientId) {
    log(`title: no ${!token ? 'token' : 'client id'} for helix`)
    return null
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) {
    log(`title: helix ${res.status} for ${url.replace(/^https:\/\/api\.twitch\.tv\/helix\//, '')}`)
    return null
  }
  return (await res.json()) as { data?: Record<string, string>[] }
}

export async function refreshChannelTitle(login: string): Promise<void> {
  const ch = login.toLowerCase()
  const hit = titleCache.get(ch)
  if (hit && Date.now() - hit.at < TITLE_TTL_MS) return
  try {
    let id = idCache.get(ch)
    if (!id) {
      const users = await helix(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(ch)}`)
      id = users?.data?.[0]?.id ?? ''
      if (!id) {
        if (users) log(`title: no twitch user for ${ch}`)
        return
      }
      idCache.set(ch, id)
    }
    const info = await helix(`https://api.twitch.tv/helix/channels?broadcaster_id=${id}`)
    if (!info) return
    const title = (info.data?.[0]?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 140)
    titleCache.set(ch, { title, at: Date.now() })
  } catch (e) {
    // fail-soft: no cache entry, callers see null — but never silently. a 2s timeout here is
    // exactly the kind of failure that read as "the bot doesn't know the title" for weeks.
    log(`title: fetch failed for ${ch} — ${(e as Error)?.name === 'TimeoutError' ? 'timed out' : (e as Error)?.message ?? e}`)
  }
}

export function getCachedChannelTitle(login: string): string | null {
  const hit = titleCache.get(login.toLowerCase())
  if (!hit || Date.now() - hit.at > TITLE_TTL_MS) return null
  return hit.title || null
}

export async function getChannelTitle(login: string): Promise<string | null> {
  await refreshChannelTitle(login)
  return getCachedChannelTitle(login)
}

export function __setTitleCacheForTest(login: string, title: string | null): void {
  if (title === null) titleCache.delete(login.toLowerCase())
  else titleCache.set(login.toLowerCase(), { title, at: Date.now() })
}
