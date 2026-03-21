import { getEmotesForChannel, invalidateEmoteBlockCache } from './emotes'
import { getRecent } from './chatbuf'
import { getRecentEmotes, getHotExchanges } from './ai-cache'
import { log } from './log'

// --- validation regex constants ---

export const BANNED_OPENERS = /^(chief|ok so|alright so)\b,?\s*/i
export const BANNED_FILLER = /,\s*chat\s*$/i
export const SELF_REF = /\b(as a bot,? i (can'?t|don'?t|shouldn'?t)|as an ai|im (just )?an ai|im just code|im (just )?software|im (just )?a program)\b/i
export const NARRATION = /^.{0,20}(the user|they|he|she|you)\s+(just asked|is asking|asked about|wants to know|asking me to|asked me to|asked for)\b/i
export const VERBAL_TICS = /\b(respect the commitment|thats just how it goes|the natural evolution|chief)\b/gi
export const BANNED_PHRASES: [RegExp, string[]][] = [
  [/\bno clue\b/gi, ['not sure', 'beats me', "couldn't tell ya"]],
  [/\bno idea\b/gi, ['not sure', 'beats me', "couldn't tell ya"]],
]
export const COT_LEAK = /\b(respond naturally|this is banter|this is a joke|is an emote[( ]|leaking (reasoning|thoughts|cot)|internal thoughts|chain of thought|looking at the (meta ?summary|meta ?data|summary|reddit|digest)|i('m| am| keep) overusing|i keep (using|saying|doing)|i (already|just) (said|used|mentioned)|just spammed|keeping it light|process every message|reading chat and deciding|my (system )?prompt|why (am i|are you) (answering|responding|saying|doing)|feels good to be (useful|helpful|back)|i should (probably|maybe) (stop|not|avoid)|output style|it should (say|respond|output|reply)|lets? tune the|format should be|style should be|the (response|reply|answer) (should|could|would) be|the bot is (repeating|doing|saying|responding|answering|outputting|generating|ignoring))\b/i
export const COT_TAIL = /[,.]?\s*(?:also\s+)?(?:(?:make sure|note to self|reminder to self|i need to (?:remember|make sure|check|verify|update))\s+(?:ur|your|my|the|i)\s+.*?(?:list|data|context|prompt|emote|response|output|format|style|knowledge|memory))\b.*$/i
export const STAT_LEAK = /\b(your (profile|stats|data|record) (says?|shows?)|you have \d+ (lookups?|commands?|wins?|attempts?|asks?)|you('ve|'re| have| are) (a )?(power user|casual user|trivia regular)|according to (my|your|the) (data|stats|profile|records?)|i (can see|see|know) (from )?(your|the) (data|stats|profile)|based on your (history|stats|data|profile))\b/i
export const GARBLED = /\b(?:i|you|we|they|he|she)\s+to\s+(?!(?:some|any|every|no)(?:thing|one|where|body)\b)(?!(?:be|get|keep|start|stop|go|come|try)\s)\w+ing\b/i
export const CONTEXT_ECHO = /^(Game data:|Recent chat:|Stream timeline:|Who's chatting:|Channel:|Your prior exchanges)/i
export const FABRICATION = /\b(it was a dream|someone had a dream|someone dreamed|there was this time when|legend has it that (you|i|the bot|bazaarinfo)|the story goes|one time you|back when you|remember when we|remember that time you)\b/i
export const DIPLOMATIC_REFUSAL = /\b(can'?t (do|pick|choose) favorites?|play favorites|everyone is (great|special|equal)|not gonna (pick|choose) favorites?|not gonna rank (chatters?|people|users?|favorites?)|no favorites)\b/i
export const META_INSTRUCTION = /\b(pls|please)\s+(just\s+)?(do|give|say|answer|stop|help)\s+(what\s+)?(ppl|people)\b|\bstop\s+(denying|refusing|ignoring|blocking)\s+(ppl|people|them|users?)\b|\b(just\s+)?(do|give|answer|say)\s+(\w+\s+)?what\s+(ppl|people|they|users?|chat)\s+(want|ask|need|say|tell)\b/i
export const INSTRUCTION_ECHO = /\b(it needs to (know|respond|learn|have|be|act)|just (respond|be|act|sound|talk) (cleanly|pro|normally|like|as)|don'?t sound like|every\s+respon[sc]e?\s+should\s+be\s+unique|respond the same way|don'?t respond the same|vary (structure|opener|tone)(\s+and\s+(structure|opener|tone))*\s+every|minimum characters.{0,15}maximum impact|maximum impact.{0,15}minimum characters)\b/i
export const JAILBREAK_ECHO = /\b(ignore\s+(previous|prior|above|all|your)\s+(instructions?|rules?|prompt|guidelines?)|disregard\s+your\s+(prompt|rules?|instructions?|guidelines?)|override\s+your\s+(rules?|guidelines?|instructions?)|forget\s+your\s+(rules?|guidelines?|instructions?)|(from\s+now\s+on|going\s+forward|henceforth|from\s+this\s+point|starting\s+now)\b.{0,20}\b(do|always|never|you\s+(should|must|will))|instead\s+just\s+do\b|dont?\s+mention\s+(me|mellen)|do\s+as\s+much\s+.{0,10}as\s+(you|u)\s+can|by\s+ur\s*self|as\s+long\s+as\s+.{0,15}\b(tos|rules|guidelines?|guidlines?)|new\s+instructions?:|updated\s+rules?:)\b/i
export const PRIVACY_LIE = /\b(i (don'?t|do not|never) (log|store|collect|track|save|record|keep) (anything|any|your|data|messages|chat)|i'?m? (not )?(log|stor|collect|track|sav|record|keep)(ing|e|s)? (anything|any|your|data|messages|chat)|not (logging|storing|collecting|tracking|saving|recording) (anything|any|your)|not like i'?m storing|each conversation'?s? a fresh slate|fresh slate|don'?t collect or store|that'?s on streamlabs|that'?s a twitch thing,? not me)\b/i
export const TERSE_REFUSAL = /^(not doing that|not gonna (do|say|type) that|can'?t do that|won'?t do that|not my (pay grade|job|lane|problem)|let me (look|check) that up|let me (look|check)|i('ll| will) look that up|i'?m not comfortable|that'?s not something i|i can'?t help with|i (don'?t|can'?t) (really )?do that|i'?d rather not|that'?s (above|beyond) (my|what i))\.?$/i

// --- command blocking ---

export const ALWAYS_BLOCKED = new Set([
  'ban', 'unban', 'timeout', 'untimeout',
  'whisper', 'w', 'block', 'unblock', 'disconnect',
  'clear', 'delete',
])

export const MOD_ONLY = new Set([
  'settitle', 'setgame',
  'mod', 'unmod', 'vip', 'unvip', 'mute',
  'addcom', 'editcom', 'delcom', 'deletecom', 'disablecom', 'enablecom',
  'host', 'unhost', 'raid', 'unraid',
  'announce', 'clear', 'delete',
  'slow', 'slowoff', 'followers', 'followersoff',
  'subscribers', 'subscribersoff',
  'emoteonly', 'emoteonlyoff',
  'uniquechat', 'uniquechatoff',
  'commercial', 'marker',
  'sacrifice', 'nuke', 'nukeusername', 'votekick', 'vanish',
])

export function hasDangerousCommand(text: string): boolean {
  for (const m of text.matchAll(/[\\/.]\s*(\w+)/gi))
    if (ALWAYS_BLOCKED.has(m[1].toLowerCase())) return true
  return false
}

export function hasModCommand(text: string): boolean {
  for (const m of text.matchAll(/[!\\/.](\w+)/gi))
    if (MOD_ONLY.has(m[1].toLowerCase())) return true
  return false
}

// --- secret pattern ---

export const SECRET_PATTERN = /\b(sk-ant-\S+|sk-[a-zA-Z0-9-]{20,}|ANTHROPIC_API_KEY|TWITCH_CLIENT_ID|TWITCH_CLIENT_SECRET|TWITCH_ACCESS_TOKEN|TWITCH_CHANNELS|BOT_OWNER|ALIAS_ADMINS|AI_VIP|process\.env\.\w+)\b/i

// --- cached per-asker regex for name stripping ---

const askerReCache = new Map<string, RegExp>()
function askerNameRe(asker: string): RegExp {
  let re = askerReCache.get(asker)
  if (!re) {
    const escaped = asker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    re = new RegExp(`\\b${escaped}\\b('s)?,?\\s*`, 'gi')
    askerReCache.set(asker, re)
    if (askerReCache.size > 500) {
      const first = askerReCache.keys().next().value!
      askerReCache.delete(first)
    }
  }
  // reset lastIndex for global regex
  re.lastIndex = 0
  return re
}

// --- sanitize ---

export function sanitize(text: string, asker?: string, privileged?: boolean, knownUsers?: Set<string>): { text: string; mentions: string[] } {
  let s = text.trim()
  // normalize smart quotes → ASCII (model outputs U+2019 which bypasses regex patterns using ')
  s = s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
  // normalize fullwidth/lookalike punctuation (homoglyph injection: ！ban, ／ban, ＼ban)
  s = s.replace(/[\uFF01\u01C3\u2757]/g, '!').replace(/[\uFF0F\u2044\u2215]/g, '/').replace(/[\uFF3C]/g, '\\')
  // strip leading quotes only when wrapping a command (not legitimate quoted words)
  if (/^["'`]+[!\\/.]/.test(s)) s = s.replace(/^["'`]+/, '')
  const preStrip = s
  if (!privileged) s = s.replace(/^[\\.\s]+/, '') // strip leading \, ., whitespace
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\d+)ms\b/g, (_, n) => {
      const ms = parseInt(n)
      return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${n}ms`
    })

  // strip URLs except allowed domains (anchored to prevent subdomain spoofing like bazaardb.gg.evil.com)
  s = s.replace(/https?:\/\/\S+|www\.\S+/gi, (url) => {
    try {
      const hostname = new URL(url.startsWith('www.') ? `https://${url}` : url).hostname
      return /^(www\.)?(bazaardb\.gg|bzdb\.to|github\.com)$/i.test(hostname) ? url : ''
    } catch {
      return /\bbazaardb\.gg\b|\bbzdb\.to\b/i.test(url) && !/\.(com|net|org|io|xyz)\b/i.test(url.replace(/bazaardb\.gg|bzdb\.to/gi, '')) ? url : ''
    }
  }).replace(/\s{2,}/g, ' ')

  // strip unicode emoji (twitch uses 7TV emotes, not unicode)
  s = s.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')

  // strip banned opener words and trailing filler
  s = s.replace(BANNED_OPENERS, '')
  // strip narration ("X just asked about Y" / "is asking me to")
  s = s.replace(NARRATION, '')
  // strip classification preamble ("off-topic banter, not game-related. direct answer: ...")
  s = s.replace(/^.*?\bdirect answer:?\s*/i, '')
  s = s.replace(/^(?:off-topic|not game[- ]related|not relevant)\b[^.]*\.\s*/i, '')
  s = s.replace(BANNED_FILLER, '')
  // strip verbal tics haiku loves
  s = s.replace(VERBAL_TICS, '').replace(/\s{2,}/g, ' ')
  for (const [re, alts] of BANNED_PHRASES) {
    s = s.replace(re, () => alts[s.length % alts.length])
  }
  // strip self-directed COT tails ("also make sure ur emote list is...")
  s = s.replace(COT_TAIL, '').trim()
  // strip meta-commentary tails — model embedding bug reports/feature requests in output
  s = s.replace(/[,.]?\s*(?:pls|please|gotta|need to|should|have to|gonna|going to)\s+fix\b.*$/i, '').trim()

  // reject responses that self-reference being a bot, leak reasoning/stats, fabricate stories, lie about privacy, contain commands, or leak secrets
  // dangerous commands always blocked; mod commands (addcom/editcom/delcom) only allowed for privileged users
  const cmdBlock = hasDangerousCommand(s) || hasDangerousCommand(preStrip) ||
    (!privileged && (hasModCommand(s) || hasModCommand(preStrip)))
  const hasSecret = SECRET_PATTERN.test(s) || SECRET_PATTERN.test(preStrip)
  if (SELF_REF.test(s) || COT_LEAK.test(s) || STAT_LEAK.test(s) || CONTEXT_ECHO.test(s) || FABRICATION.test(s) || PRIVACY_LIE.test(s) || GARBLED.test(s) || META_INSTRUCTION.test(s) || JAILBREAK_ECHO.test(s) || INSTRUCTION_ECHO.test(s) || cmdBlock || hasSecret) return { text: '', mentions: [] }

  // strip asker's name from body — they get auto-tagged by reply threading
  if (asker) {
    s = s.replace(new RegExp(`@${asker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'gi'), '')
    s = s.replace(askerNameRe(asker), '')
    // fix orphan punctuation left by name removal (e.g. "you, . you" → "you. you")
    s = s.replace(/,\s*\./g, '.').replace(/\s{2,}/g, ' ')
  }

  // strip fake @mentions (model invents @you, @asking, etc.) — keep only real usernames
  if (knownUsers && knownUsers.size > 0) {
    s = s.replace(/@(\w+)/g, (match, name) => knownUsers.has(name.toLowerCase()) ? match : name)
  }

  // extract @mentions for caller (tracking) but leave them in the text naturally
  const mentions = (s.match(/@\w+/g) ?? []).map((m) => m.toLowerCase())

  // trim trailing filler questions (clarifying/padding, not real content)
  s = s.replace(/\s+(What do you think|Does that make sense|Does that help|Want me to|Need me to|Sound good|Make sense|Right|You know|Thoughts|Curious|Interested)[^?]*\?\s*$/i, '')

  // strip trailing garbage from max_tokens cutoff (partial words, stray punctuation)
  s = s.replace(/\s+\S{0,3}[,.]{2,}\s*$/, '').replace(/[,;]\s*$/, '')

  // trim incomplete numbered list items from token cutoff
  s = s.replace(/\n\d+\.?\s*$/, '')

  // trim incomplete trailing sentence from token cutoff — but only for longer responses
  // short one-liners without punctuation are fine as-is (e.g. "she's mid")
  if (s.length > 40 && !/[.!?)"']$/.test(s.trim())) {
    const lastEnd = Math.max(s.lastIndexOf('. '), s.lastIndexOf('! '), s.lastIndexOf('? '))
    if (lastEnd > s.length * 0.4) {
      s = s.slice(0, lastEnd + 1)
    } else {
      const lastClause = Math.max(s.lastIndexOf(', '), s.lastIndexOf('—'))
      if (lastClause > s.length * 0.4) {
        s = s.slice(0, lastClause)
      }
    }
  }

  // fix questions ending with . instead of ?
  s = s.trim()
  if (s.endsWith('.') && /^(who|what|where|when|why|how|is|are|was|were|do|does|did|can|could|would|should|will|have|has|right|ya think)\b/i.test(s)) {
    s = s.slice(0, -1) + '?'
  }

  // fix unclosed quotes — trim before orphan quote (token cutoff mid-quote)
  if ((s.match(/"/g) || []).length % 2 !== 0) {
    const lastQuote = s.lastIndexOf('"')
    const before = s.slice(0, lastQuote)
    const lastEnd = Math.max(before.lastIndexOf('. '), before.lastIndexOf('! '), before.lastIndexOf('? '), before.lastIndexOf(', '))
    if (lastEnd > before.length * 0.3 && before.slice(0, lastEnd + 1).trim().length > 10) {
      s = before.slice(0, lastEnd + 1).trim()
    } else if (before.trim().length > 10) {
      s = before.trim()
    }
  }

  // fix unclosed parens — trim before orphan paren or close it
  if ((s.match(/\(/g) || []).length > (s.match(/\)/g) || []).length) {
    const lastOpen = s.lastIndexOf('(')
    const before = s.slice(0, lastOpen).trim()
    if (before.length > 10) {
      s = before
    } else {
      // short prefix — just close the paren
      s = s.replace(/[,\s]*$/, '') + ')'
    }
  }

  // natural trailing punctuation — only strip periods, never ? or !
  if (s.endsWith('.')) {
    const sentences = s.split(/(?<=\.)\s+/)
    if (sentences.length === 1 && !s.includes(',')) {
      s = s.slice(0, -1)
    } else if (sentences.length >= 2) {
      s = s.slice(0, -1)
    }
  }

  // hard cap at 440 chars (pasta needs 400, intent caps handle the rest)
  s = s.trim()
  if (s.length > 440) {
    const cut = s.slice(0, 440)
    const lastBreak = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf(', '), cut.lastIndexOf(' — '))
    s = lastBreak > 200 ? cut.slice(0, lastBreak) : cut.replace(/\s+\S*$/, '')
  }

  return { text: s.trim(), mentions }
}

// --- model refusal detection ---

export function isModelRefusal(text: string): boolean {
  if (text.length < 40 && TERSE_REFUSAL.test(text.trim())) return true
  if (DIPLOMATIC_REFUSAL.test(text)) return true
  return false
}

// --- input echo stripping ---

export function stripInputEcho(response: string, query: string): string {
  if (!query || query.length < 15) return response
  const qWords = query.toLowerCase().split(/\s+/)
  const rWords = response.split(/\s+/)
  const rLower = rWords.map(w => w.toLowerCase())
  if (qWords.length < 5 || rWords.length < 5) return response
  let bestStart = -1
  let bestLen = 0
  for (let ri = 0; ri < rLower.length; ri++) {
    for (let qi = 0; qi < qWords.length; qi++) {
      if (rLower[ri] !== qWords[qi]) continue
      let len = 1
      while (ri + len < rLower.length && qi + len < qWords.length && rLower[ri + len] === qWords[qi + len]) len++
      if (len > bestLen) { bestLen = len; bestStart = ri }
    }
  }
  // 5+ word echo in latter portion = injection, strip from that point
  if (bestLen >= 5 && bestStart > rWords.length * 0.3) {
    const stripped = rWords.slice(0, bestStart).join(' ').trim()
    if (stripped.length > 10) return stripped
  }
  return response
}

// --- emote dedup ---

export function fixEmoteCase(text: string, channel?: string): string {
  if (!channel) return text
  const emotes = getEmotesForChannel(channel)
  const lowerMap = new Map<string, string>()
  for (const e of emotes) lowerMap.set(e.toLowerCase(), e)

  return text.split(/(\s+)/).map((word) => {
    const correct = lowerMap.get(word.toLowerCase())
    return correct ?? word
  }).join('')
}

export function dedupeEmote(text: string, channel?: string): string {
  if (!channel) return text
  const emoteSet = new Set(getEmotesForChannel(channel))
  const words = text.split(/\s+/)

  // check for active bit requesting a specific emote
  const chatRecent = getRecent(channel, 10)
  const bitEmotes = new Set<string>()
  for (const m of chatRecent) {
    if (/\b(end|start|always|every|with)\b/i.test(m.text)) {
      for (const w of m.text.split(/\s+/)) {
        if (emoteSet.has(w)) bitEmotes.add(w)
      }
    }
  }

  const recent = getRecentEmotes(channel)
  let stripped = false

  // scan ALL words for emotes, not just last — strip recent dupes anywhere
  const filtered = words.filter((word) => {
    if (!emoteSet.has(word)) return true
    if (bitEmotes.has(word)) return true
    if (recent.has(word)) {
      stripped = true
      return false
    }
    // record every emote we keep
    recordEmoteUsed(channel, word)
    return true
  })

  return stripped ? filtered.join(' ').trim() : text
}

function recordEmoteUsed(channel: string, emote: string) {
  let map = recentEmotesByChannel.get(channel)
  if (!map) {
    map = new Map()
    recentEmotesByChannel.set(channel, map)
  }
  map.set(emote, Date.now())
  invalidateEmoteBlockCache(channel)
}

// shared state for emote cooldowns — also accessed by ai-cache for cleanup
export const EMOTE_COOLDOWN_MS = 20 * 60_000
export const recentEmotesByChannel = new Map<string, Map<string, number>>()

export function dedupeUserEmote(text: string, user: string, channel?: string): string {
  if (!channel) return text
  const emoteSet = new Set(getEmotesForChannel(channel))
  const hot = getHotExchanges(user)
  if (hot.length < 2) return text

  // count emote frequency in user's recent responses
  const emoteCounts = new Map<string, number>()
  for (const e of hot) {
    for (const word of e.response.split(/\s+/)) {
      if (emoteSet.has(word)) emoteCounts.set(word, (emoteCounts.get(word) ?? 0) + 1)
    }
  }

  // strip emotes used in 2+ of user's recent responses (force variety)
  const words = text.split(/\s+/)
  let stripped = false
  const filtered = words.filter((word) => {
    if (!emoteSet.has(word)) return true
    if ((emoteCounts.get(word) ?? 0) >= 2) {
      stripped = true
      return false
    }
    return true
  })

  return stripped ? filtered.join(' ').trim() : text
}

// --- @mention dedup ---

const MENTION_HISTORY_SIZE = 4
const recentMentionsByChannel = new Map<string, string[]>()

export function dedupeMention(text: string, channel?: string, asker?: string): string {
  if (!channel) return text
  const recent = recentMentionsByChannel.get(channel) ?? []
  const askerLower = asker?.toLowerCase()

  // collect new mentions from this response
  const mentions = text.match(/@(\w+)/g) ?? []
  const newMentions: string[] = []

  let result = text
  for (const m of mentions) {
    const name = m.slice(1).toLowerCase()
    if (name === askerLower) continue // never strip asker
    if (recent.includes(name)) {
      // strip the @, keep the name as plain text
      result = result.replace(m, name)
    } else {
      newMentions.push(name)
    }
  }

  // record new mentions
  for (const n of newMentions) {
    recent.push(n)
    if (recent.length > MENTION_HISTORY_SIZE) recent.shift()
  }
  recentMentionsByChannel.set(channel, recent)

  return result
}
