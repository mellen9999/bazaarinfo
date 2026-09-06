// per-user context block: the asker's own profile (account age, followage, badges,
// memory, facts, recent asks) and the "about @someone" line for a named chatter.
import * as db from './db'
import { getChannelRecentResponses, formatAge } from './ai-cache'
import { getChannelSnapshotLine, isStreamerAsk, FOLLOW_ASK_RE, channelNamedIn } from './twitch-profile'
import { formatBadges, type BadgeSnapshot } from './badges'
import { formatUserEvents } from './stream-events'
import { getUserProfile } from './style'
import { maybeFetchTwitchInfo } from './ai-background'
import { findReferencedUser } from './ai-query'

// --- user context builder ---

// self-referential query — "my facts", "do I like X", "am I a regular" — worth restating
// every time it's actually asked about. anything else only earns the Facts line if none
// of them has already been said in this channel recently (see the facts block below).
const SELF_REF_RE = /\b(my|me|i|i'm|im|mine|myself)\b/i

// a fact counts as already-said when a recent bot response in this channel contains a
// ≥6-char lowercase substring of it — the fact's first long-enough word, or (for a short
// fact with none) the whole fact. too-short facts can't be checked and are never flagged.
function isFactEchoed(fact: string, channel: string): boolean {
  const lower = fact.trim().toLowerCase()
  const probe = lower.split(/\s+/).find((w) => w.length >= 6) ?? (lower.length >= 6 ? lower : '')
  if (!probe) return false
  return getChannelRecentResponses(channel).some((r) => r.toLowerCase().includes(probe))
}

// "does X stream" / "how long has X followed rogue": the named chatter's twitch-readable
// facts — account age, followage here and on the named channel, their own channel. only
// on those ask shapes, only when X is a real chatter here, never for the asker (their
// own block already carries it).
// badges + the event log, one compact fragment. shared by the asker's own block, the
// about-@someone block and the person-trivia dossier — one reader, one rendering.
export function userStandingLine(user: string, channel: string): string {
  const bits: string[] = []
  try {
    const badges = db.getUserBadges(user, channel) as BadgeSnapshot | null
    const b = badges ? formatBadges(badges) : ''
    if (b) bits.push(b)
    const ev = formatUserEvents(db.getUserEvents(user, 6), channel)
    if (ev) bits.push(`recently: ${ev}`)
  } catch {}
  return bits.join('; ')
}

// "does X stream" / "how long has X followed rogue" / any @X: the named chatter's
// twitch-readable record — account age, followage here and on a named channel, badges,
// what they've done, their own channel on a streamer ask. only when X is a real chatter
// here, never for the asker (their own block already carries it).
export function buildAboutUserLine(query: string, asker: string, channel: string): string {
  if (!isStreamerAsk(query) && !FOLLOW_ASK_RE.test(query) && !/@\w+/.test(query)) return ''
  const ref = findReferencedUser(query, channel)
  if (!ref || ref === asker.toLowerCase()) return ''
  const bits: string[] = []
  try {
    const tu = db.getCachedTwitchUser(ref)
    if (tu?.account_created_at) bits.push(`account ${db.formatAccountAge(tu.account_created_at)}`)
    const standing = userStandingLine(ref, channel)
    if (standing) bits.push(standing)
    const here = db.getCachedFollowage(ref, channel)
    if (here?.followed_at) bits.push(`following #${channel} since ${db.formatAccountAge(here.followed_at).replace(' old', '')}`)
    const other = FOLLOW_ASK_RE.test(query) ? channelNamedIn(query, channel) : null
    if (other) {
      const of = db.getCachedFollowage(ref, other)
      if (of) bits.push(of.followed_at ? `following #${other} since ${db.formatAccountAge(of.followed_at).replace(' old', '')}` : `not following #${other}`)
    }
  } catch {}
  const snap = isStreamerAsk(query) ? getChannelSnapshotLine(ref) : ''
  if (snap) bits.push(snap)
  if (bits.length === 0) return ''
  const limit = FOLLOW_ASK_RE.test(query) ? ` followage is only readable on channels i moderate — for any other channel say so plainly, never guess a date.` : ''
  return `\nAbout ${ref} (twitch, real): ${bits.join('; ')}.${limit}`
}

export function buildUserContext(user: string, channel: string, skipAsks = false, suppressMemo = false, query = '', flags?: { firstMsg?: boolean; returningChatter?: boolean }): string {
  // kick off background Twitch data fetch (non-blocking)
  maybeFetchTwitchInfo(user, channel)

  // try style cache first (regulars with pre-built profiles)
  let profile = getUserProfile(channel, user)

  // non-regular: build minimal profile on the fly
  if (!profile) {
    const parts: string[] = []

    // prefer real Twitch account age over first_seen
    try {
      const twitchUser = db.getCachedTwitchUser(user)
      if (twitchUser?.account_created_at) {
        parts.push(`account ${db.formatAccountAge(twitchUser.account_created_at)}`)
      } else {
        const stats = db.getUserStats(user)
        if (stats?.first_seen) {
          const since = stats.first_seen.slice(0, 7)
          parts.push(`around since ${since}`)
        }
      }
    } catch {
      try {
        const stats = db.getUserStats(user)
        if (stats?.first_seen) parts.push(`around since ${stats.first_seen.slice(0, 7)}`)
      } catch {}
    }

    try {
      const stats = db.getUserStats(user)
      if (stats) {
        if (stats.total_commands > 0) parts.push(stats.total_commands > 50 ? 'regular' : 'casual')
        if (stats.trivia_wins > 0) parts.push(stats.trivia_wins > 10 ? 'trivia regular' : 'plays trivia')
        if (stats.favorite_item) parts.push(`fav: ${stats.favorite_item}`)
      }
    } catch {}
    try {
      const topItems = db.getUserTopItems(user, 3)
      if (topItems.length > 0) parts.push(`into: ${topItems.join(', ')}`)
    } catch {}
    profile = parts.join(', ')
  }

  // followage line — this channel, plus another joined channel the ask names ("how long
  // have i followed rogue") when its followage is cached (twitch-profile prefetches it)
  let followLine = ''
  try {
    const follow = db.getCachedFollowage(user, channel)
    if (follow?.followed_at) {
      followLine = `following #${channel} since ${db.formatAccountAge(follow.followed_at).replace(' old', '')}`
    }
    const other = FOLLOW_ASK_RE.test(query) ? channelNamedIn(query, channel) : null
    if (other) {
      const of = db.getCachedFollowage(user, other)
      const line = of ? (of.followed_at ? `following #${other} since ${db.formatAccountAge(of.followed_at).replace(' old', '')}` : `not following #${other}`) : ''
      if (line) followLine = followLine ? `${followLine}, ${line}` : line
    }
  } catch {}

  // their own channel — only ever fetched on a streamer-shaped ask, so this is '' for
  // the ordinary chatter and never spends budget
  const streamsLine = isStreamerAsk(query) ? getChannelSnapshotLine(user) : ''

  // what their badges say + what they've done here (resubs, gifts, raids) — the twitch
  // record of this person, read from the message tags and the event log. always on: it is
  // the difference between "some viewer" and "the 3-year sub who just gifted 20".
  const standingLine = userStandingLine(user, channel)

  // persistent AI memory memo (suppressed on identity requests to avoid stale echoes)
  let memoLine = ''
  if (!suppressMemo) {
    try {
      const memo = db.getUserMemo(user)
      if (memo) memoLine = `Memory: ${memo.memo}`
    } catch {}
  }

  // recent AI interactions (skip if recall context already covers this)
  let asksLine = ''
  if (!skipAsks) {
    try {
      const asks = db.getRecentAsks(user, 3)
      if (asks.length > 0) {
        const now = Date.now()
        const parts = asks.map((a) => {
          const label = formatAge(a.created_at, now)
          const q = a.query.length > 50 ? a.query.slice(0, 50) + '...' : a.query
          const r = a.response ? (a.response.length > 120 ? a.response.slice(0, 120) + '...' : a.response) : '?'
          return `${label}: "${q}" → "${r}"`
        })
        asksLine = `Previously chatted about: ${parts.join(' | ')}`
      }
    } catch {}
  }

  // extracted facts (long-term memory) — a callback once is warm, every reply is a tic.
  // a self-referential ask always gets them; otherwise drop any fact this channel has
  // already heard back recently so the bot doesn't restate the same fact every message.
  let factsLine = ''
  try {
    const facts = db.getUserFacts(user, 5)
    if (facts.length > 0) {
      const kept = SELF_REF_RE.test(query) ? facts : facts.filter((f) => !isFactEchoed(f, channel))
      if (kept.length > 0) factsLine = `Facts: ${kept.join(', ')}`
    }
  } catch {}

  // twitch's own first-message/returning-chatter signal — leads the section (and alone is
  // enough to return one) so it colours whatever the model was already going to say, never
  // triggering a greeting on its own.
  const flagLine = flags?.firstMsg ? 'first message ever in this chat' : flags?.returningChatter ? 'returning chatter' : ''

  const sections = [flagLine, profile, followLine, standingLine, streamsLine, memoLine, factsLine, asksLine].filter(Boolean)
  if (sections.length === 0) return ''
  return `[${user}] ${sections.join('. ')}`
}
