import * as store from './store'
import { ALIASES } from './store'
import * as db from './db'
import { log } from './log'
import { resolveTooltip } from '@bazaarinfo/shared'
import type { Monster } from '@bazaarinfo/shared'
import { pickEmoteByMood } from './emotes'

let reverseAliasCache: Map<string, string[]> | null = null

// --- precomputed trivia maps (rebuilt on store reload) ---

let tagItemMap: [string, string[]][] = []       // [tag, lowercaseTitles] filtered to TAG_MIN..TAG_MAX
let heroSizeMap: [string, string[]][] = []      // ["Hero|Size", lowercaseTitles] filtered to >=5
let heroTagMap: [string, string[]][] = []       // ["Hero|Tag", lowercaseTitles] filtered to 3..30
let mechanicMap: [string, string[]][] = []      // [keyword, lowercaseTitles] filtered to >=5

function pushToMap(map: Map<string, string[]>, key: string, val: string) {
  let arr = map.get(key)
  if (!arr) { arr = []; map.set(key, arr) }
  arr.push(val)
}

export function rebuildTriviaMaps() {
  const FAKE = new Set(['Common', '???'])
  const items = store.getItems()
  const tMap = new Map<string, string[]>()
  const hsMap = new Map<string, string[]>()
  const htMap = new Map<string, string[]>()
  const mMap = new Map<string, string[]>()

  for (const item of items) {
    const lower = item.Title.toLowerCase()
    const singleHero = item.Heroes.length === 1 && !FAKE.has(item.Heroes[0]) ? item.Heroes[0] : null

    for (const tag of item.HiddenTags) pushToMap(tMap, tag, lower)

    if (singleHero) {
      pushToMap(hsMap, `${singleHero}|${item.Size}`, lower)
      for (const tag of item.DisplayTags) pushToMap(htMap, `${singleHero}|${tag}`, lower)
    }

    for (const t of item.Tooltips) {
      for (const keyword of Object.keys(MECHANIC_VERBS)) {
        if (t.text.includes(keyword)) {
          const arr = mMap.get(keyword)
          if (!arr || !arr.includes(lower)) pushToMap(mMap, keyword, lower)
        }
      }
    }
  }

  tagItemMap = [...tMap.entries()].filter(([, v]) => v.length >= TAG_MIN && v.length <= TAG_MAX)
  heroSizeMap = [...hsMap.entries()].filter(([, v]) => v.length >= 5)
  heroTagMap = [...htMap.entries()].filter(([, v]) => v.length >= 3 && v.length <= 30)
  mechanicMap = [...mMap.entries()].filter(([, v]) => v.length >= 5)
}

export function invalidateAliasCache() {
  reverseAliasCache = null
}

// reverse alias map: "BLU-B33TL3" → ["beetle"], "BLK-SP1D3R" → ["spider"]
function buildReverseAliases(): Map<string, string[]> {
  if (reverseAliasCache) return reverseAliasCache
  const map = new Map<string, string[]>()
  // static aliases
  for (const [nick, title] of Object.entries(ALIASES)) {
    const lower = title.toLowerCase()
    if (!map.has(lower)) map.set(lower, [])
    map.get(lower)!.push(nick.toLowerCase())
  }
  // dynamic aliases
  for (const [nick, title] of store.getDynamicAliases?.() ?? []) {
    const lower = title.toLowerCase()
    if (!map.has(lower)) map.set(lower, [])
    map.get(lower)!.push(nick.toLowerCase())
  }
  reverseAliasCache = map
  return map
}

function addNicknames(accepted: string[]): string[] {
  const reverseAliases = buildReverseAliases()
  const extra: string[] = []
  for (const a of accepted) {
    const nicks = reverseAliases.get(a)
    if (nicks) extra.push(...nicks)
  }
  return extra.length > 0 ? [...accepted, ...extra] : accepted
}

const ROUND_DURATION = 30_000
const COOLDOWN = 60_000
const RECENT_BUFFER_SIZE = 10
const MIN_ANSWER_LENGTH = 1

type SayFn = (channel: string, text: string) => void

interface TriviaState {
  gameId: number
  question: string
  correctAnswer: string
  acceptedAnswers: string[]
  questionType: number
  startedAt: number
  participants: Set<string>
  timeout: Timer
  say: SayFn
}

const activeGames = new Map<string, TriviaState>()
const lastGameEnd = new Map<string, number>()
const recentTypes = new Map<string, number[]>()
let globalSay: SayFn = () => {}

export function setSay(fn: SayFn) {
  globalSay = fn
}

// question generators
type QuestionGen = () => { question: string; answer: string; accepted: string[]; type: number } | null

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

const FAKE_HEROES = new Set(['Common', '???'])
const TAG_MIN = 5
const TAG_MAX = 50

// type 1: what hero uses item?
function genHeroQuestion(): ReturnType<QuestionGen> {
  const items = store.getItems().filter((c) =>
    c.Heroes.length === 1 && !FAKE_HEROES.has(c.Heroes[0]),
  )
  if (items.length === 0) return null
  const item = pickRandom(items)
  const hero = item.Heroes[0]
  return {
    question: `What hero uses ${item.Title}?`,
    answer: hero,
    accepted: [hero.toLowerCase()],
    type: 1,
  }
}

// type 2: name an item with tag X (filtered to fair difficulty)
function genTagQuestion(): ReturnType<QuestionGen> {
  if (tagItemMap.length === 0) return null
  const [tag, validItems] = pickRandom(tagItemMap)
  return {
    question: `Name an item with the "${tag}" tag`,
    answer: `any ${tag} item`,
    accepted: addNicknames(validItems),
    type: 2,
  }
}

// type 3: which item has these abilities? (tooltip → item)
function genTooltipQuestion(): ReturnType<QuestionGen> {
  const items = store.getItems().filter((c) =>
    c.Tooltips.length > 0 && c.Heroes.length > 0 && !FAKE_HEROES.has(c.Heroes[0]),
  )
  if (items.length === 0) return null
  const item = pickRandom(items)
  const abilities = item.Tooltips
    .map((t) => resolveTooltip(t.text, item.TooltipReplacements, item.Tiers[0]))
    .join(' | ')
  // skip if too long for chat or still has unresolved placeholders
  if (abilities.length > 200 || abilities.includes('{')) return null
  return {
    question: `Which item does this: ${abilities}`,
    answer: item.Title,
    accepted: addNicknames([item.Title.toLowerCase()]),
    type: 3,
  }
}

// type 4: name an item on monster's board
function genMonsterBoardQuestion(): ReturnType<QuestionGen> {
  const monsters = store.getMonsters().filter((m) => m.MonsterMetadata.board.length >= 2)
  if (monsters.length === 0) return null
  const monster = pickRandom(monsters)
  const boardItems = [...new Set(monster.MonsterMetadata.board.map((b) => b.title.toLowerCase()))]
  return {
    question: `Name an item on ${monster.Title}'s board`,
    answer: `any of: ${boardItems.slice(0, 5).join(', ')}`,
    accepted: addNicknames(boardItems),
    type: 4,
  }
}

// type 5: name a [Size] [Hero] item
function genHeroSizeQuestion(): ReturnType<QuestionGen> {
  if (heroSizeMap.length === 0) return null
  const [key, items] = pickRandom(heroSizeMap)
  const [hero, size] = key.split('|')
  return {
    question: `Name a ${size} ${hero} item`,
    answer: `any ${size} ${hero} item`,
    accepted: addNicknames(items),
    type: 5,
  }
}

// type 6: name a [Hero] [DisplayTag]
function genHeroTagQuestion(): ReturnType<QuestionGen> {
  if (heroTagMap.length === 0) return null
  const [key, items] = pickRandom(heroTagMap)
  const [hero, tag] = key.split('|')
  return {
    question: `Name a ${hero} ${tag}`,
    answer: `any ${hero} ${tag}`,
    accepted: addNicknames(items),
    type: 6,
  }
}

// type 7: what day do you fight [Monster]?
function genMonsterDayQuestion(): ReturnType<QuestionGen> {
  const valid = store.getMonsters().filter((m) => m.MonsterMetadata.day !== null)
  if (valid.length === 0) return null
  const monster = pickRandom(valid)
  const day = String(monster.MonsterMetadata.day)
  return {
    question: `What day do you fight ${monster.Title}?`,
    answer: `Day ${day}`,
    accepted: [day, `day ${day}`],
    type: 7,
  }
}

// type 8: name an item that [mechanic]s
const MECHANIC_VERBS: Record<string, string> = {
  Freeze: 'Freezes',
  Burn: 'Burns',
  Poison: 'Poisons',
  Shield: 'Shields',
  Heal: 'Heals',
  Slow: 'Slows',
  Haste: 'gives Haste',
  Crit: 'Crits',
  Ammo: 'uses Ammo',
  Destroy: 'Destroys',
  Regen: 'Regens',
}

function genMechanicQuestion(): ReturnType<QuestionGen> {
  if (mechanicMap.length === 0) return null
  const [keyword, items] = pickRandom(mechanicMap)
  const verb = MECHANIC_VERBS[keyword]
  return {
    question: `Name an item that ${verb}`,
    answer: `any item that ${verb}`,
    accepted: addNicknames(items),
    type: 8,
  }
}

// type 9: which hero has the skill: [desc]?
function genHeroSkillQuestion(): ReturnType<QuestionGen> {
  const heroSkills = store.getSkills().filter((s) =>
    s.Heroes.length === 1 && !FAKE_HEROES.has(s.Heroes[0]) && s.Tooltips.length > 0,
  )
  if (heroSkills.length === 0) return null
  const skill = pickRandom(heroSkills)
  const desc = skill.Tooltips
    .map((t) => resolveTooltip(t.text, skill.TooltipReplacements, skill.Tiers[0]))
    .join(' | ')
  if (desc.length > 200 || desc.includes('{')) return null
  const hero = skill.Heroes[0]
  return {
    question: `Which hero has the skill: ${desc}`,
    answer: hero,
    accepted: [hero.toLowerCase()],
    type: 9,
  }
}

// type 10: which monster has [Skill]?
function genMonsterSkillQuestion(): ReturnType<QuestionGen> {
  const valid = store.getMonsters().filter((m) => m.MonsterMetadata.skills.length > 0)
  if (valid.length === 0) return null
  const skillMap = new Map<string, string[]>()
  for (const m of valid) {
    for (const s of m.MonsterMetadata.skills) {
      if (!skillMap.has(s.title)) skillMap.set(s.title, [])
      const lower = m.Title.toLowerCase()
      if (!skillMap.get(s.title)!.includes(lower)) skillMap.get(s.title)!.push(lower)
    }
  }
  const skills = [...skillMap.entries()].filter(([, ms]) => ms.length <= 5)
  if (skills.length === 0) return null
  const [skillName, ms] = pickRandom(skills)
  return {
    question: `Which monster has the skill "${skillName}"?`,
    answer: ms.length === 1 ? ms[0] : `any of: ${ms.join(', ')}`,
    accepted: addNicknames(ms),
    type: 10,
  }
}

const generators: QuestionGen[] = [
  genHeroQuestion,          // 0
  genTagQuestion,           // 1
  genTooltipQuestion,       // 2
  genMonsterBoardQuestion,  // 3
  genHeroSizeQuestion,      // 4
  genHeroTagQuestion,       // 5
  genMonsterDayQuestion,    // 6
  genMechanicQuestion,      // 7
  genHeroSkillQuestion,     // 8
  genMonsterSkillQuestion,  // 9
]

type TriviaCategory = 'items' | 'heroes' | 'monsters'

const CATEGORY_GENERATORS: Record<TriviaCategory, number[]> = {
  items: [1, 2, 4, 5, 7],       // tag, tooltip, hero+size, hero+tag, mechanic
  heroes: [0, 8],                // hero-from-item, hero-from-skill
  monsters: [3, 6, 9],          // board item, day, monster skill
}

function pickQuestionType(channel: string, category?: TriviaCategory): number {
  const recent = recentTypes.get(channel) ?? []
  const allowedIndices = category ? CATEGORY_GENERATORS[category] : generators.map((_, i) => i)
  const available = allowedIndices
    .filter((i) => {
      const recentCount = recent.filter((t) => t === i).length
      return recentCount < 2
    })

  if (available.length === 0) return pickRandom(allowedIndices)
  return pickRandom(available)
}

// answer matching: exact, then startsWith, then includes for long names
function matchAnswer(cleaned: string, accepted: string[]): boolean {
  // exact match first
  if (accepted.some((a) => cleaned === a)) return true
  // for answers 5+ chars, allow startsWith (helps with stylized names)
  if (cleaned.length >= 5 && accepted.some((a) => a.startsWith(cleaned))) return true
  // for answers 8+ chars, allow includes (catches partial matches on long names)
  if (cleaned.length >= 8 && accepted.some((a) => a.includes(cleaned))) return true
  return false
}

// filter out obvious non-answers (random chat, emotes, short noise)
// called on raw trimmed text (before lowercase/punctuation stripping)
// common chat noise that should never count as trivia attempts
const CHAT_NOISE = new Set([
  'gg', 'ez', 'lol', 'lmao', 'pog', 'kek', 'rip', 'oof', 'bruh', 'cope',
  'true', 'based', 'real', 'ratio', 'nice', 'nah', 'yep', 'yea', 'yeah',
  'nope', 'same', 'omg', 'wow', 'hype', 'lets go', 'sadge', 'copium',
  'kekw', 'pepega', 'monkas', 'poggers', 'lul', 'omegalul', 'xd', 'f',
  'w', 'l', 'hi', 'hey', 'yo', 'sup', 'bye',
])

function looksLikeAnswer(text: string, game: TriviaState): boolean {
  if (text.length < MIN_ANSWER_LENGTH) return false
  // skip messages that start with ! (bot commands)
  if (text.startsWith('!')) return false
  // skip pure URL messages
  if (/^https?:\/\/\S+$/i.test(text)) return false
  // skip long messages — likely normal chat, not trivia answers
  if (text.length > 50) return false
  const lower = text.toLowerCase().trim()
  // skip common chat noise
  if (CHAT_NOISE.has(lower)) return false
  // for numeric answers (day questions, count questions), allow short
  if (game.acceptedAnswers.some((a) => /^\d+$/.test(a)) && /\d/.test(lower)) return true
  // skip very short messages (1-2 chars) unless they could be answers
  if (lower.length <= 2 && !game.acceptedAnswers.some((a) => a.length <= 2)) return false
  return true
}

export function startTrivia(channel: string, category?: TriviaCategory): string {
  if (activeGames.has(channel)) {
    const game = activeGames.get(channel)!
    const remaining = Math.ceil((ROUND_DURATION - (Date.now() - game.startedAt)) / 1000)
    return `trivia already active (${remaining}s left): ${game.question}`
  }

  const lastEnd = lastGameEnd.get(channel) ?? 0
  const cooldownLeft = COOLDOWN - (Date.now() - lastEnd)
  if (cooldownLeft > 0) {
    return `trivia on cooldown, ${Math.ceil(cooldownLeft / 1000)}s remaining`
  }

  // try generators until one works
  let q: ReturnType<QuestionGen> = null
  let lastTypeIdx = 0
  let attempts = 0
  while (!q && attempts < 20) {
    lastTypeIdx = pickQuestionType(channel, category)
    q = generators[lastTypeIdx]()
    attempts++
  }
  if (!q) return `couldn't generate a question, try again`

  // track recent types per-channel (use generator index, not 1-indexed q.type)
  const recent = recentTypes.get(channel) ?? []
  recent.push(lastTypeIdx)
  if (recent.length > RECENT_BUFFER_SIZE) recent.shift()
  recentTypes.set(channel, recent)

  const gameId = db.createTriviaGame(channel, q.type, q.question, q.answer)

  const timeout = setTimeout(() => {
    const msg = endTrivia(channel, gameId)
    if (msg) globalSay(channel, msg)
  }, ROUND_DURATION)

  activeGames.set(channel, {
    gameId,
    question: q.question,
    correctAnswer: q.answer,
    acceptedAnswers: q.accepted,
    questionType: q.type,
    startedAt: Date.now(),
    participants: new Set(),
    timeout,
    say: globalSay,
  })

  return `Trivia! ${q.question} (30s to answer)`
}

function endTrivia(channel: string, expectedGameId?: number): string | null {
  const game = activeGames.get(channel)
  if (!game) return null
  // if called from a timer, only end the game that started it
  if (expectedGameId !== undefined && game.gameId !== expectedGameId) return null

  clearTimeout(game.timeout)
  activeGames.delete(channel)
  lastGameEnd.set(channel, Date.now())

  const emote = pickEmoteByMood(channel, 'sad')
  return `Time's up! The answer was: ${game.correctAnswer}${emote ? ` ${emote}` : ''}`
}

// called on every message to check for trivia answers
export function checkAnswer(
  channel: string,
  username: string,
  text: string,
  say: (channel: string, text: string) => void,
) {
  const game = activeGames.get(channel)
  if (!game) return

  const trimmed = text.trim()
  if (!trimmed) return

  // filter non-answers before cleaning/counting as attempt
  if (!looksLikeAnswer(trimmed, game)) return

  const cleaned = trimmed.toLowerCase().replace(/[^\w\s-]/g, '')
  if (!cleaned) return

  const userId = db.getOrCreateUser(username)
  game.participants.add(username)
  db.recordTriviaAttempt(userId)

  const isCorrect = matchAnswer(cleaned, game.acceptedAnswers)

  const answerTimeMs = Date.now() - game.startedAt
  db.recordTriviaAnswer(game.gameId, userId, text, isCorrect, answerTimeMs)

  if (isCorrect) {
    // re-check game is still active (another correct answer could have won in same tick)
    if (!activeGames.has(channel)) return
    db.recordTriviaWin(game.gameId, userId, answerTimeMs, game.participants.size)
    clearTimeout(game.timeout)
    activeGames.delete(channel)
    lastGameEnd.set(channel, Date.now())

    const timeStr = (answerTimeMs / 1000).toFixed(1)
    const emote = pickEmoteByMood(channel, 'celebration', 'hype')
    say(channel, `${username} got it in ${timeStr}s! Answer: ${game.correctAnswer}${emote ? ` ${emote}` : ''}`)
  } else {
    db.resetTriviaStreak(userId)
  }
}

export function cleanupChannel(channel: string) {
  const game = activeGames.get(channel)
  if (game) clearTimeout(game.timeout)
  activeGames.delete(channel)
  lastGameEnd.delete(channel)
  recentTypes.delete(channel)
}

export function isGameActive(channel: string): boolean {
  return activeGames.has(channel)
}

export function getTriviaScore(channel: string): string {
  const leaders = db.getTriviaLeaderboard(channel, 5)
  if (leaders.length === 0) return 'no trivia scores yet'
  const lines = leaders.map((l, i) => `${i + 1}. ${l.username} (${l.trivia_wins} wins)`)
  return `Trivia top 5: ${lines.join(' | ')}`
}

export function formatStats(username: string, channel?: string): string {
  const stats = db.getUserStats(username, channel)
  if (!stats) return `no stats for ${username}`

  const parts = [`[${stats.username}]`]
  if (stats.chat_messages > 0) parts.push(`msgs:${stats.chat_messages}`)
  if (stats.total_commands > 0) parts.push(`cmds:${stats.total_commands}`)
  if (stats.ask_count > 0) parts.push(`asks:${stats.ask_count}`)
  if (stats.trivia_wins > 0) {
    const rate = stats.trivia_attempts > 0
      ? Math.round((stats.trivia_wins / stats.trivia_attempts) * 100)
      : 0
    parts.push(`trivia:${stats.trivia_wins}W/${stats.trivia_attempts}A (${rate}%)`)
    if (stats.trivia_best_streak > 0) parts.push(`streak:${stats.trivia_best_streak}`)
    if (stats.trivia_fastest_ms) parts.push(`fastest:${(stats.trivia_fastest_ms / 1000).toFixed(1)}s`)
  }
  if (stats.favorite_item) parts.push(`fav:${stats.favorite_item}`)
  parts.push(`since:${stats.first_seen.slice(0, 10)}`)
  return parts.join(' | ')
}

export function formatTop(channel: string): string {
  const leaders = db.getChannelLeaderboard(channel, 5)
  if (leaders.length === 0) return 'no activity yet'
  const lines = leaders.map((l, i) => `${i + 1}. ${l.username} (${l.total_commands})`)
  return `Top users: ${lines.join(' | ')}`
}

// exported for testing
export { matchAnswer, looksLikeAnswer }

export function resetForTest() {
  activeGames.clear()
  lastGameEnd.clear()
  recentTypes.clear()
}

export function getActiveGameForTest(channel: string) {
  return activeGames.get(channel)
}
