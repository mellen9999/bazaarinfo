import * as store from './store'
import * as db from './db'
import { log } from './log'
import type { BazaarCard, Monster, ReplacementValue, TierName } from '@bazaarinfo/shared'

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
const recentTypes: number[] = []
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

// resolve tooltip placeholders to Bronze-tier values
function resolveTooltip(text: string, replacements: Record<string, ReplacementValue>): string {
  return text.replace(/\{[^}]+\}/g, (match) => {
    const val = replacements[match]
    if (!val) return match
    if ('Fixed' in val) return String(val.Fixed)
    const tierOrder: TierName[] = ['Bronze', 'Silver', 'Gold', 'Diamond', 'Legendary']
    for (const t of tierOrder) {
      if (t in val) return String((val as Record<string, number>)[t])
    }
    return match
  })
}

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
  // build tag→items map, filter to tags with 5-50 items
  const tagMap = new Map<string, string[]>()
  for (const item of store.getItems()) {
    for (const tag of item.HiddenTags) {
      if (!tagMap.has(tag)) tagMap.set(tag, [])
      tagMap.get(tag)!.push(item.Title.toLowerCase())
    }
  }
  const fairTags = [...tagMap.entries()].filter(
    ([, items]) => items.length >= TAG_MIN && items.length <= TAG_MAX,
  )
  if (fairTags.length === 0) return null
  const [tag, validItems] = pickRandom(fairTags)
  return {
    question: `Name an item with the "${tag}" tag`,
    answer: `any ${tag} item`,
    accepted: validItems,
    type: 2,
  }
}

// type 3: which item has these abilities? (tooltip → item)
function genTooltipQuestion(): ReturnType<QuestionGen> {
  const items = store.getItems().filter((c) =>
    c.Tooltips.length > 0 && !FAKE_HEROES.has(c.Heroes[0]),
  )
  if (items.length === 0) return null
  const item = pickRandom(items)
  const abilities = item.Tooltips
    .map((t) => resolveTooltip(t.text, item.TooltipReplacements))
    .join(' | ')
  // skip if too long for chat or still has unresolved placeholders
  if (abilities.length > 200 || abilities.includes('{')) return null
  return {
    question: `Which item does this: ${abilities}`,
    answer: item.Title,
    accepted: [item.Title.toLowerCase()],
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
    accepted: boardItems,
    type: 4,
  }
}

const generators: QuestionGen[] = [
  genHeroQuestion,          // 0
  genTagQuestion,           // 1
  genTooltipQuestion,       // 2
  genMonsterBoardQuestion,  // 3
]

type TriviaCategory = 'items' | 'heroes' | 'monsters'

const CATEGORY_GENERATORS: Record<TriviaCategory, number[]> = {
  items: [1, 2],             // tag, tooltip
  heroes: [0],               // hero
  monsters: [3],             // monster board
}

function pickQuestionType(category?: TriviaCategory): number {
  const allowedIndices = category ? CATEGORY_GENERATORS[category] : generators.map((_, i) => i)
  const available = allowedIndices
    .filter((i) => {
      const recentCount = recentTypes.filter((t) => t === i).length
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
function looksLikeAnswer(text: string, game: TriviaState): boolean {
  if (text.length < MIN_ANSWER_LENGTH) return false
  // skip messages that start with ! (bot commands)
  if (text.startsWith('!')) return false
  // skip pure URL messages
  if (/^https?:\/\/\S+$/i.test(text)) return false
  // skip long messages — likely normal chat, not trivia answers
  if (text.length > 50) return false
  const lower = text.toLowerCase()
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
  let attempts = 0
  while (!q && attempts < 20) {
    const typeIdx = pickQuestionType(category)
    q = generators[typeIdx]()
    attempts++
  }
  if (!q) return `couldn't generate a question, try again`

  // track recent types
  recentTypes.push(q.type)
  if (recentTypes.length > RECENT_BUFFER_SIZE) recentTypes.shift()

  const gameId = db.createTriviaGame(channel, q.type, q.question, q.answer)

  const timeout = setTimeout(() => {
    const msg = endTrivia(channel)
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

function endTrivia(channel: string): string | null {
  const game = activeGames.get(channel)
  if (!game) return null

  clearTimeout(game.timeout)
  activeGames.delete(channel)
  lastGameEnd.set(channel, Date.now())

  return `Time's up! The answer was: ${game.correctAnswer}`
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
    db.recordTriviaWin(game.gameId, userId, answerTimeMs, game.participants.size)
    clearTimeout(game.timeout)
    activeGames.delete(channel)
    lastGameEnd.set(channel, Date.now())

    const timeStr = (answerTimeMs / 1000).toFixed(1)
    say(channel, `${username} got it in ${timeStr}s! Answer: ${game.correctAnswer}`)
  } else {
    db.resetTriviaStreak(userId)
  }
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

export function formatStats(username: string): string {
  const stats = db.getUserStats(username)
  if (!stats) return `no stats for ${username}`

  const parts = [`[${stats.username}]`]
  if (stats.total_commands > 0) parts.push(`cmds:${stats.total_commands}`)
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
  recentTypes.length = 0
}

export function getActiveGameForTest(channel: string) {
  return activeGames.get(channel)
}
