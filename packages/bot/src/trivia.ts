import * as store from './store'
import { ALIASES } from './store'
import * as db from './db'
import { log } from './log'
import type { BazaarCard, Monster, ReplacementValue, TierName } from '@bazaarinfo/shared'

// reverse alias map: "BLU-B33TL3" → ["beetle"], "BLK-SP1D3R" → ["spider"]
function buildReverseAliases(): Map<string, string[]> {
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
    accepted: addNicknames(validItems),
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
  const valid = store.getItems().filter((c) =>
    c.Heroes.length === 1 && !FAKE_HEROES.has(c.Heroes[0]),
  )
  const comboMap = new Map<string, string[]>()
  for (const item of valid) {
    const key = `${item.Heroes[0]}|${item.Size}`
    if (!comboMap.has(key)) comboMap.set(key, [])
    comboMap.get(key)!.push(item.Title.toLowerCase())
  }
  const combos = [...comboMap.entries()].filter(([, items]) => items.length >= 5)
  if (combos.length === 0) return null
  const [key, items] = pickRandom(combos)
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
  const valid = store.getItems().filter((c) =>
    c.Heroes.length === 1 && !FAKE_HEROES.has(c.Heroes[0]) && c.DisplayTags.length > 0,
  )
  const comboMap = new Map<string, string[]>()
  for (const item of valid) {
    for (const tag of item.DisplayTags) {
      const key = `${item.Heroes[0]}|${tag}`
      if (!comboMap.has(key)) comboMap.set(key, [])
      comboMap.get(key)!.push(item.Title.toLowerCase())
    }
  }
  const combos = [...comboMap.entries()].filter(([, items]) => items.length >= 3 && items.length <= 30)
  if (combos.length === 0) return null
  const [key, items] = pickRandom(combos)
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
  const mechMap = new Map<string, string[]>()
  for (const item of store.getItems()) {
    for (const t of item.Tooltips) {
      for (const keyword of Object.keys(MECHANIC_VERBS)) {
        if (t.text.includes(keyword)) {
          if (!mechMap.has(keyword)) mechMap.set(keyword, [])
          const lower = item.Title.toLowerCase()
          if (!mechMap.get(keyword)!.includes(lower)) mechMap.get(keyword)!.push(lower)
        }
      }
    }
  }
  const fair = [...mechMap.entries()].filter(([, items]) => items.length >= 5)
  if (fair.length === 0) return null
  const [keyword, items] = pickRandom(fair)
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
    .map((t) => resolveTooltip(t.text, skill.TooltipReplacements))
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
