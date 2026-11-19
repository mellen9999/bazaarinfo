// Dev announcements from The Bazaar's steam news — the earliest place a new event shows up.
//
// bazaardb's patchnotes page only names an event once someone logs it, so for a stretch
// after launch "is there an event" had no answer ("Partner Portal" ran live while the bot
// said none). The devs announce on steam, which only they can post to (no author filter
// needed): poll the feed, persist posts (an event outlives its stay at the top of the
// feed), serve the newest event post.
//
// Fail-soft like every grounding feed: any failure leaves the last good cache in place.
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { log } from './log'
import { writeAtomic } from './fs-util'
import { fetchSteamNews, type NewsItem } from './steam-news'

const CACHE_PATH = resolve(import.meta.dir, '../../../cache/official-posts.json')
const APPID = 1617400
const KEEP_MS = 30 * 24 * 60 * 60_000
const EVENT_FRESH_MS = 21 * 24 * 60 * 60_000
const MAX_BODY = 500
const MAX_POSTS = 20

export interface OfficialPost {
  title: string
  body: string
  updated: string
}

function cachePath(): string {
  return process.env.BAZAARINFO_OFFICIAL_CACHE || CACHE_PATH
}

let posts: OfficialPost[] | null = null

function load(): OfficialPost[] {
  if (posts) return posts
  try {
    posts = existsSync(cachePath()) ? (JSON.parse(readFileSync(cachePath(), 'utf8')) as OfficialPost[]) : []
    if (!Array.isArray(posts)) posts = []
  } catch {
    posts = []
  }
  return posts
}

/** steam news items → posts (undated dropped), newest first, body capped. pure. */
export function pickOfficial(items: NewsItem[]): OfficialPost[] {
  return items
    .filter((n) => n.iso)
    .map((n) => ({ title: n.title, body: n.summary.slice(0, MAX_BODY), updated: n.iso }))
}

/** fold fresh posts into the stored set: dedupe by title (newest wins), drop the old. pure. */
export function mergePosts(old: OfficialPost[], fresh: OfficialPost[], now: number): OfficialPost[] {
  const byTitle = new Map<string, OfficialPost>()
  for (const p of [...old, ...fresh]) {
    const prev = byTitle.get(p.title)
    if (!prev || Date.parse(p.updated) >= Date.parse(prev.updated)) byTitle.set(p.title, p)
  }
  return [...byTitle.values()]
    .filter((p) => now - Date.parse(p.updated) < KEEP_MS)
    .sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated))
    .slice(0, MAX_POSTS)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** the newest fresh event announcement as a prompt line, or '' when there is none. */
export function eventLineFrom(list: OfficialPost[], now: number = Date.now()): string {
  const ev = list.find((p) => /\bevent\b/i.test(p.title) && now - Date.parse(p.updated) < EVENT_FRESH_MS)
  if (!ev) return ''
  const d = new Date(ev.updated)
  const date = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
  return `Official event announcement (devs' own steam announcement, ${date} — real, answer from this, don't invent details; the end date in it is the source of truth): "${ev.title}" — ${ev.body}`
}

export function getOfficialEventLine(): string {
  return eventLineFrom(load())
}

export async function refreshOfficialPosts(): Promise<void> {
  try {
    const items = await fetchSteamNews(APPID, { max: MAX_POSTS, maxSummary: MAX_BODY })
    // fetch failed (already logged) — hold what we have
    if (items.length === 0) return
    const merged = mergePosts(load(), pickOfficial(items), Date.now())
    posts = merged
    await writeAtomic(cachePath(), JSON.stringify(merged, null, 2))
    log(`official-posts: ${merged.length} kept`)
  } catch (e) {
    log(`official-posts: refresh failed: ${e}`)
  }
}
