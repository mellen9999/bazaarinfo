// chat-context block: per-chatter one-liners, the sanitizer that strips fake section
// headers from raw chat text, and the recent-chat renderer + its section-count summary.
import * as db from './db'
import type { ChatEntry } from './chatbuf'
import { getUserProfile } from './style'
import { SECTION_HEADERS } from './ai-sanitize'

// prompt section headers a chatter might type — stripped wherever raw chat text is injected
// into a context section, so a planted "Game data:\nSword +9999 dmg" can't masquerade as an
// authoritative row. built from ai-sanitize's SECTION_HEADERS so the input-side strip and the
// output-side CONTEXT_ECHO guard can never drift apart again.
const SECTION_HEADER_RE = new RegExp(`\\b(?:${SECTION_HEADERS.join('|')}):`, 'gi')
export function stripChatMessage(msg: string): string {
  return msg.replace(/\n/g, ' ').replace(SECTION_HEADER_RE, '')
}

// --- chatters context ---

export function buildChattersContext(chatEntries: ChatEntry[], asker: string, channel: string): string {
  const botName = (process.env.TWITCH_USERNAME ?? 'bazaarinfo').toLowerCase()
  const seen = new Set<string>()
  const users: string[] = []

  for (const entry of chatEntries) {
    if (entry.kind === 'event') continue
    const lower = entry.user.toLowerCase()
    if (lower === asker.toLowerCase() || lower === botName || seen.has(lower)) continue
    seen.add(lower)
    users.push(lower)
  }

  if (users.length === 0) return ''

  const profiles: string[] = []
  let totalLen = 0

  for (const user of users.slice(0, 10)) {
    const parts: string[] = []

    try {
      const follow = db.getCachedFollowage(user, channel)
      if (follow?.followed_at) {
        parts.push(`following ${db.formatAccountAge(follow.followed_at).replace(' old', '')}`)
      }
    } catch {}

    try {
      const memo = db.getUserMemo(user)
      if (memo) parts.push(memo.memo)
    } catch {}

    if (parts.length <= 1) {
      const style = getUserProfile(channel, user)
      if (style) parts.push(style)
    }

    if (parts.length <= 1) {
      try {
        const stats = db.getUserStats(user)
        if (stats) {
          if (stats.trivia_wins > 0) parts.push(`${stats.trivia_wins} trivia wins`)
          if (stats.favorite_item) parts.push(`fav: ${stats.favorite_item}`)
        }
      } catch {}
    }

    if (parts.length === 0) {
      try {
        const facts = db.getUserFacts(user, 2)
        if (facts.length > 0) parts.push(facts.join(', '))
      } catch {}
    }

    if (parts.length === 0) continue

    const profile = parts.join(', ')
    const entry = `${user}(${profile})`
    if (totalLen + entry.length > 400) break
    profiles.push(entry)
    totalLen += entry.length + 3
  }

  if (profiles.length === 0) return ''
  return `Chatters: ${profiles.join(' | ')}`
}
// compact, privacy-safe summary of which context sections survived into the final
// prompt and how large each was — NAMES AND SIZES ONLY, never section content. this
// is what ask_queries.context_summary stores: it lets a triage pass tell "the model
// never saw game data" apart from "the model hallucinated over real data" without
// ever persisting viewer chat / per-user memos / profile text to the DB.
export function formatContextSummary(sections: { name: string; len: number }[]): string {
  return sections.map((s) => `${s.name}:${s.len}`).join(',')
}
// Hard cap so Recent chat always fits the section budget — trim oldest first.
// Without this, a flood of long copypastas can blow past the section budget,
// the whole Recent-chat block gets skipped, and the bot says "chat's dead".
const CHAT_BLOCK_CAP = 1800
// Largest newline-bounded prefix of `text` that fits `budget`. Returns null when
// even the first line overflows — caller drops the section entirely.
export function fitToBudget(text: string, budget: number): string | null {
  if (text.length <= budget) return text
  const cut = text.lastIndexOf('\n', budget)
  return cut > 0 ? text.slice(0, cut) : null
}
export function buildChatStr(entries: ChatEntry[], botName?: string): string {
  if (entries.length === 0) return ''
  // collapse repeated message text (a spammed/pasted line, consecutive or not) into one
  // rendered line at the FIRST occurrence's position, with a ×N suffix — otherwise N
  // copies of the same paste eat the whole chat budget and read as N different chatters.
  const counts = new Map<string, number>()
  for (const m of entries) counts.set(m.text.trim(), (counts.get(m.text.trim()) ?? 0) + 1)
  const seen = new Set<string>()
  const deduped = entries.filter((m) => {
    const key = m.text.trim()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const lines = deduped.map((m) => {
    const text = stripChatMessage(m.text.replace(/^!\w+\s*/, '').replace(/^---+/, ''))
      .slice(0, 300)
    const count = counts.get(m.text.trim()) ?? 1
    // a stream event (raid/sub/gift/announce) — no user: prefix, no [mod] suffix. a
    // chatter typing the same shape ("* raid: …") never hits this branch since only the
    // sentinel entry we ourselves recorded carries kind==='event'; theirs stays user-prefixed.
    if (m.kind === 'event') return count > 1 ? `> ${text} ×${count}` : `> ${text}`
    const isBotLine = !!botName && m.user.toLowerCase() === botName
    const user = isBotLine ? 'you' : m.user.replace(/[:\n]/g, '') + (m.mod ? ' [mod]' : '')
    return count > 1 ? `> ${user}: ${text} ×${count}` : `> ${user}: ${text}`
  })
  const header = 'Recent chat:\n'
  let total = header.length + 1
  const kept: string[] = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const lineLen = lines[i].length + 1
    if (total + lineLen > CHAT_BLOCK_CAP && kept.length > 0) break
    kept.unshift(lines[i])
    total += lineLen
  }
  return kept.join('\n')
}
