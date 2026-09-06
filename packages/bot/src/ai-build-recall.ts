// recall blocks: stream timeline, prior-exchange FTS recall, pasta recite, and
// chat-history recall (a named chatter's messages, or content-only when none is named).
import * as db from './db'
import { getSummary } from './chatbuf'
import { formatAge } from './ai-cache'
import { buildFTSQuery, buildFTSQueryLoose, buildChatRecallFTS, findReferencedUser, RECALL_INTENT, parseChatTimeWindow } from './ai-query'
import { isPastaRecall, findChatPasta, pastaText } from './pasta'
import { stripChatMessage } from './ai-build-chat'

// --- timeline builder ---

export function buildTimeline(channel: string): string {
  const rows = db.getLatestSummaries(channel, 3)
  if (rows.length === 0) return 'No stream history yet'

  const now = Date.now()
  const lines = rows.reverse().map((r) => {
    return `${formatAge(r.created_at, now)}: ${r.summary}`
  })

  const current = getSummary(channel)
  if (current) lines.push(`Now: ${current}`)

  return lines.join('\n')
}

// --- contextual recall ---

export function buildRecallContext(query: string, channel: string): string {
  const ftsQuery = buildFTSQuery(query)
  if (!ftsQuery) return ''

  let results = db.searchAskFTS(channel, ftsQuery, 3)
  if (results.length === 0) {
    const loose = buildFTSQueryLoose(query)
    if (loose && loose !== ftsQuery) results = db.searchAskFTS(channel, loose, 3)
  }
  if (results.length === 0) return ''

  const now = Date.now()
  const lines = results.map((r) => {
    const label = formatAge(r.created_at, now)
    const q = r.query.length > 60 ? r.query.slice(0, 60) + '...' : r.query
    const resp = r.response
      ? (r.response.replace(/---+/g, '').length > 120 ? r.response.replace(/---+/g, '').slice(0, 120) + '...' : r.response.replace(/---+/g, ''))
      : '?'
    return `> [${label}] ${r.username}: "${q}" → you: "${resp}"`
  })

  return `\nPrior exchanges:\n${lines.join('\n')}`
}

// --- chat history recall ---

const PASTA_INTENT_RE = /\b(copypasta|pasta|meme|bit|joke|rant|trend|spam(ming|med)?|chat'?s? (current|latest|recent|new))\b/i

function buildPastaRecall(query: string, channel: string): string {
  const hit = findChatPasta(query, channel)
  if (!hit) {
    return 'Requested pasta: NOT in chat logs. Tell [USER] plainly you don\'t have that one logged — do NOT invent a "retired/burned/not reheating" excuse. Offer to write a fresh one if they want.'
  }
  return `Requested pasta — recite this VERBATIM (exact text, no rewrite, no refusal, never call it retired/burned). Do NOT substitute or inject emotes into it:\n"${pastaText(hit)}"`
}

// Content-only recall when query references chat history with no specific user
// ("what was that copypasta from yesterday", "anything funny earlier today").
// Two paths: (1) FTS across all users when query has substantive keywords;
// (2) repeated-message detection when query asks about pastas/memes/bits
//     where the keyword "copypasta" isn't in the pasta itself.
function buildContentRecall(query: string, channel: string, timeWindow: ReturnType<typeof parseChatTimeWindow>): string {
  const now = Date.now()
  const label = timeWindow ? timeWindow.label.toLowerCase().replace(/'s?$/, '') : 'history'

  // Path 2: pasta/meme/bit lookup — surface most-repeated long messages in window
  if (PASTA_INTENT_RE.test(query)) {
    try {
      const since = timeWindow?.sinceExpr ?? '-2 days'
      const repeats = db.findRepeatedMessages(channel, since, 3, 80, 5)
      if (repeats.length > 0) {
        const lines = repeats.map((r) => `[${formatAge(r.created_at, now)} ×${r.count}] ${r.message.replace(/\n/g, ' ').slice(0, 280)}`)
        let text = `Repeated chat (${label}):\n${lines.join('\n')}`
        if (text.length > 1200) text = text.slice(0, 1200)
        return text
      }
    } catch {}
  }

  // Path 1: FTS keyword search
  const ftsQuery = buildChatRecallFTS(query, '')
  if (!ftsQuery) return ''

  const hits = db.searchChatFTS(channel, ftsQuery, 20)
  if (hits.length === 0) return ''

  let filtered = hits
  if (timeWindow?.sinceExpr) {
    const days = parseInt(timeWindow.sinceExpr.match(/-(\d+) days/)?.[1] ?? '0')
    const cutoffMs = now - days * 86_400_000 - 86_400_000
    filtered = hits.filter((h) => new Date(h.created_at + 'Z').getTime() >= cutoffMs)
    if (filtered.length === 0) return ''
  }

  const seen = new Set<string>()
  const unique: typeof filtered = []
  for (const h of filtered) {
    const key = h.message.slice(0, 80).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(h)
    if (unique.length >= 8) break
  }

  const lines = unique.map((h) => `[${formatAge(h.created_at, now)}] ${h.username}: ${h.message.replace(/\n/g, ' ').slice(0, 220)}`)
  let text = `Chat ${label} (no specific user):\n${lines.join('\n')}`
  if (text.length > 1200) text = text.slice(0, 1200)
  return text
}

export function buildChatRecall(query: string, channel: string, asker?: string): string {
  // recite an existing chat pasta verbatim — must run before the generic recall gate,
  // which misses "remind me of the X copypasta" (no time window / @mention / recall verb)
  if (isPastaRecall(query)) return buildPastaRecall(query, channel)

  const hasMention = /@[a-zA-Z0-9_]+/.test(query)
  const hasIntent = RECALL_INTENT.test(query)
  const timeWindow = parseChatTimeWindow(query)
  // any recall signal counts as entry — time-window alone catches "yesterday's pasta"
  if (!hasIntent && !hasMention && !timeWindow) return ''

  let user = findReferencedUser(query, channel)
  // first-person pronouns ("i sent you", "my messages", "me") → asker is the target
  if (!user && asker && /\b(i\s|my\s|me\b|i'v?e?\b|myself)\b/i.test(query)) {
    user = asker.toLowerCase()
  }
  if (!user) return buildContentRecall(query, channel, timeWindow)

  const countIntent = /\b(how many|how often|count|times|frequently|frequency)\b/i.test(query)
  if (countIntent && timeWindow) {
    const totalMsgs = db.countUserMessages(user, channel, timeWindow.sinceExpr)
    const wordMatch = query.match(/(?:say|said|type|typed|wrote|write|mention|spam)\s+["']?([^"'?,!.]+)["']?/i)
      ?? query.match(/"([^"]+)"/)
      ?? query.match(/'([^']+)'/)
    let statsLine = `${user} stats (${timeWindow.label.replace(/'s?$/, '')}): ${totalMsgs} total messages`
    if (wordMatch) {
      const searchWord = wordMatch[1].trim()
      const wordCount = db.countUserWordUsage(user, channel, searchWord, timeWindow.sinceExpr)
      statsLine += `, "${searchWord}" appears in ${wordCount} messages`
    }
    const samples = db.getUserMessagesSince(user, channel, timeWindow.sinceExpr, 2000)
    if (wordMatch && samples.length > 0) {
      const searchLower = wordMatch[1].trim().toLowerCase()
      const matching = samples.filter((m) => m.toLowerCase().includes(searchLower)).slice(-5)
      if (matching.length > 0) {
        statsLine += `\nSample matches:\n${matching.map((m) => `> ${user}: ${m.replace(/\n/g, ' ').slice(0, 200)}`).join('\n')}`
      }
    }
    return statsLine
  }

  const wantsOldest = /\b(earliest|first|oldest)\b/i.test(query)

  const now = Date.now()
  const lines: string[] = []
  const seen = new Set<string>()

  const ftsQuery = buildChatRecallFTS(query, user)
  if (ftsQuery && !wantsOldest) {
    for (const h of db.searchChatFTS(channel, ftsQuery, 8, user)) {
      seen.add(h.message)
      lines.push(`[${formatAge(h.created_at, now)}] ${h.username}: ${stripChatMessage(h.message)}`)
    }
  }

  if (lines.length < 5) {
    const detailed = wantsOldest
      ? db.getUserMessagesOldest(user, channel, 10)
      : db.getUserMessagesDetailed(user, channel, 10)
    for (const r of detailed) {
      if (lines.length >= 10) break
      if (seen.has(r.message)) continue
      lines.push(`[${formatAge(r.created_at, now)}] ${r.username}: ${stripChatMessage(r.message)}`)
    }
  }

  if (lines.length === 0) return ''
  let text = `Chat history (${user}):\n${lines.join('\n')}`
  if (text.length > 1200) text = text.slice(0, 1200)
  return text
}
