import * as store from './store'
import * as db from './db'
import { log } from './log'
import type { BazaarCard, Monster } from '@bazaarinfo/shared'

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

function getItemsWithAttr(attr: string): BazaarCard[] {
  return store.getItems().filter((c) => c.BaseAttributes[attr] != null && c.BaseAttributes[attr] > 0)
}

// type 1: which item deals X damage?
// fix: accept ALL items with that damage value, not just the picked one
function genDamageQuestion(): ReturnType<QuestionGen> {
  const items = getItemsWithAttr('DamageAmount')
  if (items.length === 0) return null
  const item = pickRandom(items)
  const dmg = item.BaseAttributes.DamageAmount
  const allMatches = items
    .filter((c) => c.BaseAttributes.DamageAmount === dmg)
    .map((c) => c.Title.Text.toLowerCase())
  return {
    question: `Which item deals ${dmg} damage? (base tier)`,
    answer: item.Title.Text,
    accepted: allMatches,
    type: 1,
  }
}

// type 2: what hero uses item?
function genHeroQuestion(): ReturnType<QuestionGen> {
  const items = store.getItems().filter((c) => c.Heroes.length === 1)
  if (items.length === 0) return null
  const item = pickRandom(items)
  const hero = item.Heroes[0]
  return {
    question: `What hero uses ${item.Title.Text}?`,
    answer: hero,
    accepted: [hero.toLowerCase()],
    type: 2,
  }
}

// type 3: what day does monster appear?
function genMonsterDayQuestion(): ReturnType<QuestionGen> {
  const monsters = store.getMonsters().filter((m) => m.MonsterMetadata.day != null)
  if (monsters.length === 0) return null
  const monster = pickRandom(monsters)
  const day = String(monster.MonsterMetadata.day)
  return {
    question: `What day does ${monster.Title.Text} appear?`,
    answer: `Day ${day}`,
    accepted: [day, `day ${day}`],
    type: 3,
  }
}

// type 4: name an item with tag X
function genTagQuestion(): ReturnType<QuestionGen> {
  const items = store.getItems().filter((c) => c.HiddenTags.length > 0)
  if (items.length === 0) return null
  const item = pickRandom(items)
  const tag = pickRandom(item.HiddenTags)
  const validItems = store.getItems()
    .filter((c) => c.HiddenTags.some((t) => t.toLowerCase() === tag.toLowerCase()))
    .map((c) => c.Title.Text.toLowerCase())
  return {
    question: `Name an item with the "${tag}" tag`,
    answer: `any ${tag} item`,
    accepted: validItems,
    type: 4,
  }
}

// type 5: higher or lower — does item deal more or less than N damage?
// fix: proportional offset so high-damage items aren't obvious
function genHigherLowerQuestion(): ReturnType<QuestionGen> {
  const items = getItemsWithAttr('DamageAmount')
  if (items.length < 2) return null
  const item = pickRandom(items)
  const dmg = item.BaseAttributes.DamageAmount
  // offset is 10-30% of the damage value, minimum 3
  const pct = 0.1 + Math.random() * 0.2
  const offset = Math.max(3, Math.round(dmg * pct))
  const compare = Math.random() > 0.5 ? dmg + offset : Math.max(1, dmg - offset)
  const isHigher = dmg > compare
  const answer = isHigher ? 'higher' : 'lower'
  return {
    question: `Higher or lower: ${item.Title.Text} deals more or less than ${compare} damage?`,
    answer,
    accepted: isHigher
      ? ['higher', 'more', 'h']
      : ['lower', 'less', 'l'],
    type: 5,
  }
}

// type 6: item A or B — which has more stat?
// fix: removed CooldownMax (confusing — "more cooldown" = worse), use "faster" framing would
// require separate logic. Keep it simple with 3 clear stats.
function genCompareQuestion(): ReturnType<QuestionGen> {
  const attrs = ['DamageAmount', 'ShieldApplyAmount', 'HealAmount']
  const attr = pickRandom(attrs)
  const items = getItemsWithAttr(attr)
  if (items.length < 2) return null

  let a: BazaarCard, b: BazaarCard
  let attempts = 0
  do {
    a = pickRandom(items)
    b = pickRandom(items)
    attempts++
  } while ((a.Id === b.Id || a.BaseAttributes[attr] === b.BaseAttributes[attr]) && attempts < 20)
  if (a.Id === b.Id || a.BaseAttributes[attr] === b.BaseAttributes[attr]) return null

  const statLabels: Record<string, string> = {
    DamageAmount: 'damage',
    ShieldApplyAmount: 'shield',
    HealAmount: 'healing',
  }
  const label = statLabels[attr] ?? attr
  const winner = a.BaseAttributes[attr] > b.BaseAttributes[attr] ? a : b

  return {
    question: `${a.Title.Text} or ${b.Title.Text}: which has more ${label}? (base tier)`,
    answer: winner.Title.Text,
    accepted: [winner.Title.Text.toLowerCase()],
    type: 6,
  }
}

// type 7: how many items does hero have?
function genHeroCountQuestion(): ReturnType<QuestionGen> {
  const heroNames = store.getHeroNames()
  if (heroNames.length === 0) return null
  const hero = pickRandom(heroNames)
  const items = store.getItems().filter((c) => c.Heroes.some((h) => h.toLowerCase() === hero.toLowerCase()))
  if (items.length === 0) return null
  const count = String(items.length)
  return {
    question: `How many items does ${hero} have?`,
    answer: count,
    accepted: [count],
    type: 7,
  }
}

const generators: QuestionGen[] = [
  genDamageQuestion,     // 0
  genHeroQuestion,       // 1
  genMonsterDayQuestion, // 2
  genTagQuestion,        // 3
  genHigherLowerQuestion,// 4
  genCompareQuestion,    // 5
  genHeroCountQuestion,  // 6
]

type TriviaCategory = 'items' | 'heroes' | 'monsters'

const CATEGORY_GENERATORS: Record<TriviaCategory, number[]> = {
  items: [0, 3, 4, 5],    // damage, tag, higher/lower, compare
  heroes: [1, 6],          // hero question, hero count
  monsters: [2],           // monster day
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
  const lower = text.toLowerCase()
  // for numeric answers (day questions, count questions), allow short
  if (game.acceptedAnswers.some((a) => /^\d+$/.test(a)) && /\d/.test(lower)) return true
  // for higher/lower, accept short answers
  if (game.questionType === 5) return true
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
  if (stats.ask_count > 0) parts.push(`asks:${stats.ask_count}`)
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
