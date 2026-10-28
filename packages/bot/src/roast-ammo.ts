// roast ammo for unhinged tone. a tenure badge is the lazy angle; a person's whole posting
// history is the good one — what they type, how they type it, what they keep saying, how
// they do at trivia. everything here is DERIVED from their own public chat rows in this
// channel (plus memo/facts the bot already keeps), never invented, and '' outside unhinged:
// normal tone never turns history into material.
import * as db from './db'
import { findReferencedUser } from './ai-query'
import { getEmotesForChannel } from './emotes'
import { effectiveTone } from './tone'

const HISTORY_FETCH = 500
const RECENT_LINES = 3
const LINE_MAX = 80
const MIN_HISTORY = 15 // under this there is no pattern, only noise

const STOP = new Set([
  'about', 'after', 'again', 'because', 'before', 'being', 'could', 'doing', 'every', 'going',
  'great', 'think', 'their', 'there', 'these', 'thing', 'things', 'those', 'which', 'would',
  'where', 'while', 'really', 'still', 'right', 'maybe', 'always', 'something', 'someone',
  'people', 'should', 'actually', 'literally', 'though', 'wanna', 'gonna', 'little', 'other',
])

const words = (m: string) => m.split(/\s+/).filter(Boolean)
const realWords = (m: string) => words(m).filter((w) => /[a-z]{2,}/i.test(w))

function top(counts: Map<string, number>, min: number): [string, number] | null {
  let best: [string, number] | null = null
  for (const e of counts) if (e[1] >= min && (!best || e[1] > best[1])) best = e
  return best
}

/** habits read off a full message history (newest first). pure, deterministic. */
export function personaFromMessages(msgs: string[], emotes: ReadonlySet<string> = new Set()): string[] {
  if (msgs.length < MIN_HISTORY) return []
  const bits: string[] = []
  const n = msgs.length

  const avg = msgs.reduce((a, m) => a + words(m).length, 0) / n
  if (avg <= 3) bits.push('writes in one-liners')
  else if (avg >= 14) bits.push('writes essays')

  if (msgs.filter((m) => /\?\s*$/.test(m)).length / n >= 0.35) bits.push('mostly asks questions')

  const shouty = msgs.filter((m) => {
    const letters = m.replace(/[^a-z]/gi, '')
    return letters.length >= 5 && letters.replace(/[^A-Z]/g, '').length / letters.length >= 0.7
  })
  if (shouty.length / n >= 0.2) bits.push('types in caps a lot')

  const emoteCounts = new Map<string, number>()
  const wordCounts = new Map<string, number>()
  const lineCounts = new Map<string, number>()
  for (const m of msgs) {
    const seen = new Set<string>()
    for (const w of words(m)) {
      const bare = w.replace(/[^\w]/g, '')
      if (emotes.has(bare)) emoteCounts.set(bare, (emoteCounts.get(bare) ?? 0) + 1)
      const lw = w.toLowerCase().replace(/[^a-z']/g, '')
      if (lw.length >= 5 && !STOP.has(lw) && !seen.has(lw) && !emotes.has(w.replace(/[^\w]/g, ''))) {
        seen.add(lw)
        wordCounts.set(lw, (wordCounts.get(lw) ?? 0) + 1)
      }
    }
    if (realWords(m).length >= 2 && !m.startsWith('!')) {
      const k = m.toLowerCase().replace(/\s+/g, ' ').trim()
      lineCounts.set(k, (lineCounts.get(k) ?? 0) + 1)
    }
  }
  const line = top(lineCounts, 3)
  if (line) bits.push(`keeps saying "${line[0].slice(0, 50)}"`)
  const emote = top(emoteCounts, Math.max(5, Math.ceil(n * 0.1)))
  if (emote) bits.push(`spams ${emote[0]}`)
  const topic = top(wordCounts, Math.max(5, Math.ceil(n * 0.04)))
  if (topic) bits.push(`keeps bringing up "${topic[0]}"`)
  return bits
}

/** their newest real lines: no commands, no one-word noise, no repeats. pure. */
export function pickAmmo(rows: { message: string }[], max = RECENT_LINES): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of rows) {
    const m = r.message.replace(/\s+/g, ' ').trim()
    if (m.startsWith('!') || realWords(m).length < 3) continue
    const key = m.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(m.length > LINE_MAX ? m.slice(0, LINE_MAX - 1) + '…' : m)
    if (out.length >= max) break
  }
  return out
}

function dossier(user: string, channel: string, withMemo: boolean): string {
  const parts: string[] = []
  try {
    const history = db.getUserMessages(user, channel, HISTORY_FETCH)
    const count = db.getUserStats(user, channel)?.chat_messages ?? history.length
    if (count > 0) parts.push(`${count} msgs here`)
    parts.push(...personaFromMessages(history, new Set(getEmotesForChannel(channel))))
  } catch {}
  try {
    const st = db.getUserStats(user)
    if (st && st.trivia_attempts >= 10) parts.push(`trivia ${st.trivia_wins} wins in ${st.trivia_attempts} tries`)
    const items = db.getUserTopItems(user, 3)
    if (items.length) parts.push(`keeps looking up ${items.join(', ')}`)
  } catch {}
  if (withMemo) {
    try {
      const memo = db.getUserMemo(user)?.memo
      if (memo) parts.push(`memo: ${memo.slice(0, 160)}`)
      const facts = db.getUserFacts(user, 3)
      if (facts.length) parts.push(`facts: ${facts.join(', ')}`)
    } catch {}
  }
  try {
    const lines = pickAmmo(db.getUserMessagesDetailed(user, channel, 30))
    if (lines.length) parts.push(`latest: ${lines.map((l) => `"${l}"`).join(' | ')}`)
  } catch {}
  return parts.length > 1 ? `${user}: ${parts.join('; ')}` : ''
}

/** the asker, plus the named chatter when the ask is about someone else. */
export function buildRoastAmmoLine(query: string, asker: string, channel: string): string {
  if (effectiveTone(channel) !== 'unhinged') return ''
  const botName = (process.env.TWITCH_USERNAME ?? 'bazaarinfo').toLowerCase()
  const me = asker.toLowerCase()
  const blocks: string[] = []
  const mine = dossier(me, channel, false) // the asker's memo/facts already ride their own block
  if (mine) blocks.push(mine)
  try {
    const ref = findReferencedUser(query, channel)
    if (ref && ref !== me && ref !== botName) {
      const theirs = dossier(ref, channel, true)
      if (theirs) blocks.push(theirs)
    }
  } catch {}
  if (blocks.length === 0) return ''
  return `\nWho they are — real, derived from their whole chat history here (roast the PERSONA: flip a habit, the catchphrase, the contradiction between what they say and how they play; pick the single most telling thing; never invent; never count or say how many times or "in a row"; never lead with account age or sub length):\n${blocks.join('\n')}`
}
