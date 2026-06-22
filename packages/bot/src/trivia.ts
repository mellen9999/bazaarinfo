import * as store from './store'
import { ALIASES, HERO_ALIASES } from './store'
import * as db from './db'
import * as dndDb from './dnd/db'
import { log } from './log'
import { resolveTooltip } from '@bazaarinfo/shared'
import type { Monster } from '@bazaarinfo/shared'
import { pickEmoteByMood } from './emotes'
import { readFileSync } from 'fs'
import { join } from 'path'

// --- channel-scoped streamer trivia packs (e.g. Kripp lore in nl_kripp) ---
// these are curated, adversarially fact-checked real-world facts about the streamer,
// only ever mixed into THAT streamer's channel. accuracy is non-negotiable (they show
// in his own chat), so the pack is human-vetted before a channel is switched on.
interface PackQ { question: string; answer: string; accept: string[]; difficulty?: string }
// channels that get the kripp pack mixed in. add a channel here only after vetting.
const KRIPP_CHANNELS = new Set<string>(['mellen', 'nl_kripp']) // vetted + shipped
const KRIPP_MIX = 0.3 // ~30% of un-categorized rounds in a kripp channel are kripp questions

let krippPack: PackQ[] = []
try {
  const raw = readFileSync(join(import.meta.dir, '../data/kripp-trivia.json'), 'utf-8')
  const parsed = JSON.parse(raw) as { questions?: PackQ[] }
  krippPack = (parsed.questions ?? []).filter((q) => q.question && q.answer)
} catch (e) { log(`trivia: kripp pack parse failed: ${e}`); krippPack = [] }

// test seam
export function setKrippPackForTest(pack: PackQ[]) { krippPack = pack }
function isKrippChannel(channel: string): boolean {
  return KRIPP_CHANNELS.has(channel.toLowerCase().replace(/^#/, ''))
}

// canonical answer normalizer — THE single source of truth for comparing a guess
// to an accepted answer. applied symmetrically to both sides so punctuation in item
// names ("Philosopher's Stone", "Mortar & Pestle", "Dr. Vortex", "Z-Sword") can never
// make a correct answer unwinnable. & -> "and", drop punctuation, hyphen -> space,
// strip a leading "the ", collapse whitespace.
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\w\s-]/g, '')
    .replace(/-/g, ' ')
    .replace(/^the\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

let reverseAliasCache: Map<string, string[]> | null = null

// --- precomputed trivia maps (rebuilt on store reload) ---

let tagItemMap: [string, string[]][] = []       // [tag, lowercaseTitles] filtered to TAG_MIN..TAG_MAX
let heroSizeMap: [string, string[]][] = []      // ["Hero|Size", lowercaseTitles] filtered to >=5
let heroTagMap: [string, string[]][] = []       // ["Hero|Tag", lowercaseTitles] filtered to 3..30
let mechanicMap: [string, string[]][] = []      // [keyword, lowercaseTitles] filtered to >=5
// blanked tooltip shell -> distinct fill-blank answers. shells with many answers
// ("Deal ___ Damage") are guess-the-common-number lotteries; type 16 rejects them.
let fillBlankSpread = new Map<string, Set<string>>()

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
      const resolved = resolveTooltip(t.text, item.TooltipReplacements, item.Tiers[0])
      // skip negations/references so the bucket stays factually true: "immune to Freeze",
      // "Cleanse", "If you have another item with ... Burn" do NOT make the item a Freezer/Burner.
      if (/immune to|cleanse|if you have another item with/i.test(resolved)) continue
      for (const keyword of Object.keys(MECHANIC_VERBS)) {
        // "Crit Chance" GRANTS crit to other items — the item itself doesn't crit. strip
        // the grant phrase first so "name an item that Crits" only buckets true critters.
        const text = keyword === 'Crit' ? resolved.replace(/crit chance/gi, '') : resolved
        // word-boundary match on resolved text — "Heal" must not fire on "Max Health".
        if (new RegExp(`\\b${keyword}(s|es|ing)?\\b`, 'i').test(text)) {
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

  // fill-blank spread: group distinct answers per blanked shell so the generator can
  // reject lottery shells (many items share "Deal ___ Damage" with a guessable number).
  const fbMap = new Map<string, Set<string>>()
  for (const item of items) {
    if (item.Tooltips.length === 0) continue
    const resolved = resolveTooltip(item.Tooltips[0].text, item.TooltipReplacements, item.Tiers[0])
    if (resolved.includes('{') || resolved.length > 90) continue
    const nums = resolved.match(/\d+/g)
    if (!nums || nums.length !== 1) continue
    const shell = resolved.replace(nums[0], '___')
    if (!fbMap.has(shell)) fbMap.set(shell, new Set())
    fbMap.get(shell)!.add(nums[0])
  }
  fillBlankSpread = fbMap
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

// reverse hero-alias map: "Mak" -> ["mark","mac"], "Pygmalien" -> ["pig","pyg"].
// built once from store's HERO_ALIASES so a player typing the documented alias for a
// hero-answer question (type 1, 9) isn't marked wrong.
let heroAliasCache: Map<string, string[]> | null = null
function heroAliasesFor(hero: string): string[] {
  if (!heroAliasCache) {
    heroAliasCache = new Map()
    for (const [alias, canonical] of Object.entries(HERO_ALIASES)) {
      const arr = heroAliasCache.get(canonical) ?? []
      arr.push(alias)
      heroAliasCache.set(canonical, arr)
    }
  }
  return heroAliasCache.get(hero) ?? []
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
const HINT1_DELAY = 10_000 // weak hint: shape/count only
const HINT2_DELAY = 20_000 // strong hint: first-letter skeleton
const COOLDOWN = 0
const RECENT_BUFFER_SIZE = 10
const RECENT_QUESTIONS_SIZE = 10
const MIN_ANSWER_LENGTH = 1
const MAX_CLOSE_MISS_PER_ROUND = 2

// question types that get NO hint: tiny closed enums (hero/size/tier/enchant) where a
// hint uniquely identifies, plus numeric types (day/HP/fill-blank) where a range hint
// either leaks the suffix or is identical at both stages — for those, no hint > a bad one.
// types whose answer pool is tiny enough that a shape/first-letter hint would leak it
const NO_HINT_TYPES = new Set([1, 7, 9, 10, 11, 12, 13, 14, 16, 19])

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
  hintTimers: Timer[]
  closeMissCount: number
  say: SayFn
}

// clear all pending hint timers for a round — single chokepoint so no timer can leak
// on win/skip/timeout/cleanup.
function clearHints(game: TriviaState) {
  for (const t of game.hintTimers) clearTimeout(t)
  game.hintTimers = []
}

const activeGames = new Map<string, TriviaState>()
const lastGameEnd = new Map<string, number>()
const recentTypes = new Map<string, number[]>()
const recentQuestions = new Map<string, string[]>()
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
    accepted: [hero.toLowerCase(), ...heroAliasesFor(hero)],
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
  // skip if the tooltip leaks the item's own name (e.g. Virus "for each Virus...",
  // Spiky Shield "equal to your Shield") — that's a free, skill-less win. ~18 items,
  // 896 valid candidates remain, so dropping them costs nothing.
  const leaks = item.Title.toLowerCase().split(/\s+/).some((w) =>
    w.length > 3 && new RegExp(`\\b${w.replace(/[^\w]/g, '')}\\b`, 'i').test(abilities),
  )
  if (leaks) return null
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
  // != null (loose) rejects both null AND undefined — 13 monsters carry an undefined
  // day and otherwise produce an unwinnable "What day...? Day undefined" round.
  const valid = store.getMonsters().filter((m) => m.MonsterMetadata.day != null)
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
  if (desc.trim().length < 8 || desc.length > 200 || desc.includes('{')) return null // empty/garbled tooltip -> no question
  const hero = skill.Heroes[0]
  return {
    question: `Which hero has the skill: ${desc}`,
    answer: hero,
    accepted: [hero.toLowerCase(), ...heroAliasesFor(hero)],
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
      if (!s.title?.trim()) continue // a future data refresh could carry an empty skill title — never ask "has the skill """
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

// type 11: how much health does [Monster] have?
function genMonsterHealthQuestion(): ReturnType<QuestionGen> {
  const valid = store.getMonsters().filter((m) => m.MonsterMetadata.health > 0)
  if (valid.length === 0) return null
  const monster = pickRandom(valid)
  const hp = String(monster.MonsterMetadata.health)
  return {
    question: `How much health does ${monster.Title} have?`,
    answer: `${hp} HP`,
    accepted: [hp],
    type: 11,
  }
}

// type 12: what size is [Item]?
function genItemSizeQuestion(): ReturnType<QuestionGen> {
  const items = store.getItems().filter((c) =>
    c.Heroes.length > 0 && !FAKE_HEROES.has(c.Heroes[0]),
  )
  if (items.length === 0) return null
  const item = pickRandom(items)
  return {
    question: `What size is ${item.Title}?`,
    answer: item.Size,
    accepted: [item.Size.toLowerCase()],
    type: 12,
  }
}

// type 13: what tier does [Item] start at?
function genBaseTierQuestion(): ReturnType<QuestionGen> {
  const items = store.getItems().filter((c) =>
    c.Heroes.length > 0 && !FAKE_HEROES.has(c.Heroes[0]) && c.BaseTier,
  )
  if (items.length === 0) return null
  const item = pickRandom(items)
  return {
    question: `What tier does ${item.Title} start at?`,
    answer: item.BaseTier,
    accepted: [item.BaseTier.toLowerCase()],
    type: 13,
  }
}

// type 14: which enchantment grants a keyword effect? closed 8-pair game rule (not
// per-round data), tiny enum → no hint. Shiny (wildcard) deliberately excluded.
const ENCHANT_BY_KEYWORD: [string, string][] = [
  ['Freeze', 'Icy'], ['Burn', 'Fiery'], ['Poison', 'Toxic'], ['Shield', 'Shielded'],
  ['Heal', 'Restorative'], ['Slow', 'Heavy'], ['Haste', 'Turbo'], ['Crit', 'Deadly'],
]
function genEnchantKeywordQuestion(): ReturnType<QuestionGen> {
  const [keyword, enchant] = pickRandom(ENCHANT_BY_KEYWORD)
  return {
    question: `Which enchantment makes an item ${keyword}?`,
    answer: enchant,
    accepted: [enchant.toLowerCase()],
    type: 14,
  }
}

// type 15: which monster has more health, A or B? reroll on equal HP so there's
// always exactly one correct answer.
function genHpCompareQuestion(): ReturnType<QuestionGen> {
  const valid = store.getMonsters().filter((m) => m.MonsterMetadata.health > 0)
  if (valid.length < 2) return null
  const a = pickRandom(valid)
  let b = pickRandom(valid)
  let tries = 0
  while ((b.Title === a.Title || b.MonsterMetadata.health === a.MonsterMetadata.health) && tries < 25) {
    b = pickRandom(valid); tries++
  }
  if (b.Title === a.Title || b.MonsterMetadata.health === a.MonsterMetadata.health) return null
  const winner = a.MonsterMetadata.health > b.MonsterMetadata.health ? a : b
  return {
    question: `Which has more health, ${a.Title} or ${b.Title}?`,
    answer: winner.Title,
    accepted: addNicknames([winner.Title.toLowerCase()]),
    type: 15,
  }
}

// type 16: fill the blank in an item's tooltip. require EXACTLY one number in the
// resolved text so the blank is unambiguous.
function genFillBlankQuestion(): ReturnType<QuestionGen> {
  const items = store.getItems().filter((c) =>
    c.Tooltips.length > 0 && c.Heroes.length > 0 && !FAKE_HEROES.has(c.Heroes[0]),
  )
  if (items.length === 0) return null
  const item = pickRandom(items)
  const resolved = resolveTooltip(item.Tooltips[0].text, item.TooltipReplacements, item.Tiers[0])
  if (resolved.includes('{') || resolved.length > 90) return null
  const nums = resolved.match(/\d+/g)
  if (!nums || nums.length !== 1) return null
  const answer = nums[0]
  if (answer.length === 1) return null // single-digit (0-9) is a coin-flip guess, not knowledge
  const blanked = resolved.replace(answer, '___')
  // reject lottery shells: if many items share this blanked template, the number is a
  // common-value guess (e.g. "Deal ___ Damage"), not a deducible fact.
  if ((fillBlankSpread.get(blanked)?.size ?? 1) > 5) return null
  return {
    question: `Fill the blank — ${item.Title}: "${blanked}"`,
    answer,
    accepted: [answer],
    type: 16,
  }
}

// type 17: name a monster you fight on a given day (reverse of type 7). multi-answer.
function genMonsterByDayQuestion(): ReturnType<QuestionGen> {
  const byDay = new Map<number, Set<string>>()
  for (const m of store.getMonsters()) {
    const d = m.MonsterMetadata.day
    if (d == null) continue
    if (!byDay.has(d)) byDay.set(d, new Set())
    byDay.get(d)!.add(m.Title.toLowerCase())
  }
  const days = [...byDay.entries()].filter(([, s]) => s.size >= 3)
  if (days.length === 0) return null
  const [day, titles] = pickRandom(days)
  return {
    question: `Name a monster you fight on day ${day}`,
    answer: `any day ${day} monster`,
    accepted: addNicknames([...titles]),
    type: 17,
  }
}

// type 18: name an item that can reach Legendary tier. multi-answer recall.
function genLegendaryItemQuestion(): ReturnType<QuestionGen> {
  // legendary items are hero-less specials (Sword of Swords, Dragon Heart...) — don't
  // filter by hero, just by the tier ceiling.
  const legendaries = store.getItems()
    .filter((c) => c.Tiers.includes('Legendary'))
    .map((c) => c.Title.toLowerCase())
  if (legendaries.length < 5) return null
  return {
    question: `Name an item that can reach Legendary tier`,
    answer: `any Legendary-tier item`,
    accepted: addNicknames(legendaries),
    type: 18,
  }
}

// type 19: which monster carries a given item on its board? fire only when 1-4 carriers
// so the answer set is tight and fair.
function genItemCarrierQuestion(): ReturnType<QuestionGen> {
  const carriers = new Map<string, Set<string>>()
  for (const m of store.getMonsters()) {
    for (const b of m.MonsterMetadata.board ?? []) {
      if (!b.title?.trim()) continue // guard an empty board-item title -> "Which monster has  on its board?"
      if (!carriers.has(b.title)) carriers.set(b.title, new Set())
      carriers.get(b.title)!.add(m.Title.toLowerCase())
    }
  }
  const pool = [...carriers.entries()].filter(([, ms]) => ms.size >= 1 && ms.size <= 4)
  if (pool.length === 0) return null
  const [item, ms] = pickRandom(pool)
  return {
    question: `Which monster has ${item} on its board?`,
    answer: ms.size === 1 ? [...ms][0] : `any of: ${[...ms].join(', ')}`,
    accepted: addNicknames([...ms]),
    type: 19,
  }
}

// type 20: channel-scoped streamer trivia (kripp pack). only reachable in KRIPP_CHANNELS
// via pickQuestionType — never fires elsewhere. answer matching reuses norm() + accept[].
function genKrippQuestion(): ReturnType<QuestionGen> {
  if (krippPack.length === 0) return null
  const q = pickRandom(krippPack)
  return {
    question: q.question,
    answer: q.answer,
    accepted: [q.answer.toLowerCase(), ...q.accept],
    type: 20,
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
  genMonsterHealthQuestion, // 10
  genItemSizeQuestion,      // 11
  genBaseTierQuestion,      // 12
  genEnchantKeywordQuestion,// 13 (type 14)
  genHpCompareQuestion,     // 14 (type 15)
  genFillBlankQuestion,     // 15 (type 16)
  genMonsterByDayQuestion,  // 16 (type 17)
  genLegendaryItemQuestion, // 17 (type 18)
  genItemCarrierQuestion,   // 18 (type 19)
  genKrippQuestion,         // 19 (type 20) — channel-scoped, gated in pickQuestionType
]

const KRIPP_GEN_INDEX = generators.length - 1

type TriviaCategory = 'items' | 'heroes' | 'monsters' | 'kripp'

const CATEGORY_GENERATORS: Record<TriviaCategory, number[]> = {
  items: [1, 2, 4, 5, 7, 11, 12, 13, 15, 17],  // tag, tooltip, hero+size, hero+tag, mechanic, size, tier, enchant, fill-blank, legendary
  heroes: [0, 8],                              // hero-from-item, hero-from-skill
  monsters: [3, 6, 9, 10, 14, 16, 18],         // board, day, monster-skill, health, hp-compare, monster-by-day, item-carrier
  kripp: [KRIPP_GEN_INDEX],                    // channel-scoped streamer pack
}

// the default (un-categorized) Bazaar pool — NEVER includes the channel-scoped kripp
// generator; that is mixed in only for kripp channels via pickQuestionType.
const BAZAAR_INDICES = generators.map((_, i) => i).filter((i) => i !== KRIPP_GEN_INDEX)

// disabled generators (array indices) — coin-flip questions a guesser wins on luck, not
// knowledge: 11 = "what size is X?" (1-of-3), 14 = "which has more HP, A or B?" (50/50).
// kept in the array (indices are load-bearing) but never selected. filtered in pickQuestionType.
const DISABLED_GENERATORS = new Set([11, 14])

// strip alternate-answer cruft so a hint counts the REAL answer, not the extras a
// custom-trivia answer can carry. "Ti (or Si)" -> "Ti" (else the hint said
// "3 words, 8 letters" / "T_________ (10 letters)" for a 2-letter answer). Drops a
// trailing parenthetical, and a "/alt" or " or alt" tail. Falls back to the input
// if cleaning leaves nothing.
export function hintBase(answer: string): string {
  const a = answer
    .replace(/\s*[([][^)\]]*[)\]]\s*/g, ' ') // (…) / […]
    .replace(/\s*(?:\/|\sor\s).+$/i, '')      // "/ si", " or si"
    .trim()
  return a.length >= 1 ? a : answer.trim()
}

// weak first-stage hint: shape/count only (no letters revealed), so the round
// escalates count(10s) -> skeleton(20s) instead of dumping everything at once.
function generateWeakHint(rawAnswer: string): string {
  const answer = hintBase(rawAnswer)
  if (/^\d+$/.test(answer)) {
    const n = parseInt(answer)
    if (n < 10) return `Hint: single digit` // log10(0) is -Infinity → guard tiny values
    const magnitude = Math.pow(10, Math.floor(Math.log10(n)))
    const low = Math.floor(n / magnitude) * magnitude
    return `Hint: between ${low} and ${low + magnitude}`
  }
  const words = answer.split(/\s+/)
  if (words.length > 1) return `Hint: ${words.length} words, ${answer.replace(/\s+/g, '').length} letters`
  return `Hint: ${answer.length} letters`
}

function generateHint(rawAnswer: string): string {
  const answer = hintBase(rawAnswer)
  // for numeric answers, give a range
  if (/^\d+$/.test(answer)) {
    const n = parseInt(answer)
    if (n < 10) return `Hint: single digit` // guard log10(0) = -Infinity (NaN range)
    const magnitude = Math.pow(10, Math.floor(Math.log10(n)))
    const low = Math.floor(n / magnitude) * magnitude
    const high = low + magnitude
    return `Hint: between ${low} and ${high}`
  }
  // letter count never includes spaces ("Old One" is 6 letters, not 7).
  const letterCount = answer.replace(/\s+/g, '').length
  // for short answers (size, tier, hero), give first letter + length. multi-word answers
  // keep their spaces as spaces (not underscores) and reveal each word's first letter, so
  // "Old One" -> "O__ O__ (6 letters)", never "O______ (7 letters)".
  if (answer.length <= 10) {
    const words = answer.split(/\s+/).filter(Boolean)
    if (words.length > 1) {
      const skel = words.map((w) => w[0].toUpperCase() + '_'.repeat(w.length - 1)).join(' ')
      return `Hint: ${skel} (${letterCount} letters)`
    }
    const blanks = '_'.repeat(answer.length - 1)
    return `Hint: ${answer[0].toUpperCase()}${blanks} (${letterCount} letters)`
  }
  // for long answers, reveal first letter of each word
  const words = answer.split(/\s+/).filter(Boolean)
  const initials = words.map((w) => w[0].toUpperCase() + '_'.repeat(w.length - 1))
  return `Hint: ${initials.join(' ')}`
}

// adaptive weighting: types with mid-range solve rates get higher weight.
// types nobody ever solves (too hard / broken) or always solves in 2s (boring)
// get down-weighted. Laplace smoothing handles cold-start.
// the generator-index → question_type mapping is +1 (see generators[]), so we
// translate when looking up DB stats.
function typeWeights(channel: string, allowed: number[]): number[] {
  const stats = db.getTriviaTypeStats(channel)
  const byType = new Map<number, { games: number; wins: number }>()
  for (const s of stats) byType.set(s.question_type, { games: s.games, wins: s.wins })
  return allowed.map((idx) => {
    const qType = idx + 1
    const s = byType.get(qType)
    // Laplace: pretend everyone goes 1/2 with no data, so cold start is uniform
    const games = (s?.games ?? 0) + 2
    const wins = (s?.wins ?? 0) + 1
    const rate = wins / games
    // peak weight at 50% solve rate, decay toward 0% and 100%
    // 4 * rate * (1 - rate) maps [0..1] → [0..1] with peak 1.0 at 0.5
    return Math.max(0.15, 4 * rate * (1 - rate))
  })
}

function weightedPick<T>(items: T[], weights: number[]): T {
  const total = weights.reduce((a, b) => a + b, 0)
  let r = Math.random() * total
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]
    if (r <= 0) return items[i]
  }
  return items[items.length - 1]
}

// test-only: pin the generator index so type-specific tests are deterministic
// instead of looping on random selection (which flakes when a type never comes up).
let forcedGenIdxForTest: number | null = null
export function __forceGenIdxForTest(idx: number | null): void { forcedGenIdxForTest = idx }

function pickQuestionType(channel: string, category?: TriviaCategory): number {
  if (forcedGenIdxForTest !== null) return forcedGenIdxForTest
  const recent = recentTypes.get(channel) ?? []
  // kripp pack is channel-scoped and only when the vetted pack is non-empty.
  if (isKrippChannel(channel) && krippPack.length > 0) {
    if (category === 'kripp') return KRIPP_GEN_INDEX
    if (!category && Math.random() < KRIPP_MIX) return KRIPP_GEN_INDEX // mix in ~KRIPP_MIX of rounds
  } else if (category === 'kripp') {
    category = undefined // not a kripp channel (or empty pack) → fall back to the Bazaar pool
  }
  const allowedIndices = (category ? CATEGORY_GENERATORS[category] : BAZAAR_INDICES)
    .filter((i) => !DISABLED_GENERATORS.has(i))
  const available = allowedIndices.filter((i) => recent.filter((t) => t === i).length < 2)
  const pool = available.length > 0 ? available : allowedIndices
  return weightedPick(pool, typeWeights(channel, pool))
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 999
  const m = a.length, n = b.length
  const dp = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array(n + 1)
    row[0] = i
    return row
  })
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}

// 0 = not a close miss; else the smallest edit distance to an accepted answer (1 or 2).
function closeMissDistance(cleaned: string, accepted: string[]): number {
  const threshold = cleaned.length <= 5 ? 1 : 2
  let best = 0
  for (const a of accepted) {
    const d = editDistance(cleaned, a)
    if (d > 0 && d <= threshold && (best === 0 || d < best)) best = d
  }
  return best
}

// difficulty currency: the number encodes GUESSABILITY (not raw enum size) — a small
// enum like size is a coin-flip you can win blind, so it must pay LESS, not more. a
// bigger number => more guessable => fewer points. base = 5 - clamp(floor(log2(n)),0,4).
// recall types (no entry) fall through to acceptedLen: naming the ONE item that matches
// a tooltip (accepted~1) pays 5; naming any-of-40 from a pool (accepted~40) pays 1.
const ENUM_ANSWER_SPACE: Record<number, number> = {
  1: 7, 9: 7, // hero — must recall the right hero from 7 (base 3)
  14: 8,      // enchant — must know the exact enchant (base 2)
  11: 8,      // monster HP — ±10% band softens exact recall (base 2)
  13: 12,     // base tier — binary-ish, fairly guessable (base 2)
  7: 16,      // monster day — guessable range (base 1)
  12: 24,     // size — 1-in-3 coin flip, cheap (base 1)
  15: 24,     // hp compare — binary guess, cheap (base 1)
  16: 24,     // fill-the-blank — guess the modal number, cheap (base 1)
  20: 6,      // kripp lore — real recall, moderate pay (base 3)
  21: 3,      // custom AI topic — hard open-ended recall (base 4)
}
function difficultyBase(type: number, acceptedLen: number): number {
  const ansCount = ENUM_ANSWER_SPACE[type] ?? Math.max(1, acceptedLen)
  return 5 - Math.min(4, Math.max(0, Math.floor(Math.log2(ansCount))))
}

// answer matching: exact, then startsWith, then includes for long names.
// fuzzy (startsWith/includes) is ONLY safe for single-title questions — on a
// multi-answer pool (e.g. "name any Weapon", 60+ titles) a 5-char prefix like
// "dragon" would falsely win on "Dragonscale" without naming a real answer, so
// the caller passes allowFuzzy=false for "any ..." questions (exact+alias only).
function matchAnswer(cleaned: string, accepted: string[], allowFuzzy = true): boolean {
  // exact match first
  if (accepted.some((a) => cleaned === a)) return true
  if (!allowFuzzy) return false
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

  // try generators until one works AND its question isn't a recent repeat.
  // recent-question check is independent of type-buffer so e.g. the same tag
  // doesn't fire twice in 5 rounds even though "tag question" is a permitted type.
  const recentQ = recentQuestions.get(channel) ?? []
  let q: ReturnType<QuestionGen> = null
  let lastTypeIdx = 0
  let attempts = 0
  while (!q && attempts < 20) {
    lastTypeIdx = pickQuestionType(channel, category)
    const candidate = generators[lastTypeIdx]()
    if (candidate && !recentQ.includes(candidate.question)) q = candidate
    attempts++
  }
  if (!q) return `couldn't generate a question, try again`

  // (recentQuestions recording is centralized in launchRound so the custom AI path
  // is deduped too — see below. the loop above still reads recentQ to pick a fresh one.)

  // track recent types per-channel (use generator index, not 1-indexed q.type)
  const recent = recentTypes.get(channel) ?? []
  recent.push(lastTypeIdx)
  if (recent.length > RECENT_BUFFER_SIZE) recent.shift()
  recentTypes.set(channel, recent)

  return launchRound(channel, q)
}

// 1-indexed type id for AI-generated custom-topic rounds. never produced by a
// generator, so it never enters the adaptive type picker / recent-type buffer.
const CUSTOM_TYPE = 21

// launch a round from a ready question object — shared by built-in (startTrivia)
// and custom AI (startCustomTrivia) paths. assumes the channel has no active game
// (callers guard); purely creates the DB row, timers, hint schedule, and state.
function launchRound(channel: string, q: NonNullable<ReturnType<QuestionGen>>): string {
  // normalize every accepted answer through the canonical normalizer so the guess
  // (also normed) compares symmetrically — no punctuation/hyphen/"the" false-negatives.
  q.accepted = [...new Set(q.accepted.map(norm).filter(Boolean))]

  const gameId = db.createTriviaGame(channel, q.type, q.question, q.answer)

  const timeout = setTimeout(() => {
    const msg = endTrivia(channel, gameId)
    if (msg) globalSay(channel, msg)
  }, ROUND_DURATION)

  // for multi-answer questions ("any of: X,Y,Z" or "any <hero> <tag>"), the
  // answer field is a description, not a real title — pick a random accepted
  // answer so hints vary per round instead of deterministically leaking the
  // same board item / monster every time.
  const hintAnswer = q.answer.startsWith('any') && q.accepted.length > 0
    ? pickRandom(q.accepted)
    : q.answer
  // progressive hints: weak shape/count @10s, then first-letter skeleton @20s. each
  // gated on participants.size>0 so we never announce hints to dead chat. skipped
  // entirely for tiny-enum types where any hint uniquely identifies the answer.
  const hintTimers: Timer[] = []
  if (!NO_HINT_TYPES.has(q.type)) {
    const fire = (text: string) => () => {
      const game = activeGames.get(channel)
      if (game && game.gameId === gameId && game.participants.size > 0) globalSay(channel, text)
    }
    hintTimers.push(setTimeout(fire(generateWeakHint(hintAnswer)), HINT1_DELAY))
    hintTimers.push(setTimeout(fire(generateHint(hintAnswer)), HINT2_DELAY))
  }

  activeGames.set(channel, {
    gameId,
    question: q.question,
    correctAnswer: q.answer,
    acceptedAnswers: q.accepted,
    questionType: q.type,
    startedAt: Date.now(),
    participants: new Set(),
    timeout,
    hintTimers,
    closeMissCount: 0,
    say: globalSay,
  })

  // record the question for BOTH built-in and custom rounds so neither repeats it
  // soon (the custom AI path skipped this before, so it could ask the same Q twice).
  const rq = recentQuestions.get(channel) ?? []
  rq.push(q.question)
  if (rq.length > RECENT_QUESTIONS_SIZE) rq.shift()
  recentQuestions.set(channel, rq)
  // diagnostic: every launch is logged so a round that later "goes dead" can be traced
  // (when it started, its id) against answer/timeout activity.
  log(`trivia: launched #${channel} game ${gameId} type ${q.type} "${q.question.slice(0, 50)}"`)

  return `Trivia! ${q.question} (30s)`
}

// recent-question check for the custom AI path (commands.ts) — avoids asking a near
// duplicate of something asked in the last RECENT_QUESTIONS_SIZE rounds.
export function recentQuestionList(channel: string): string[] {
  return recentQuestions.get(channel) ?? []
}

export function isRecentQuestion(channel: string, question: string): boolean {
  const n = norm(question)
  return (recentQuestions.get(channel) ?? []).some((q) => norm(q) === n)
}

// start a round from an AI-generated question on a user-supplied topic. the active
// check here is the single race guard: the caller awaits an async API call before
// this runs, so a built-in round (or another custom round) could have started in the
// gap — JS is single-threaded, so checking immediately before the synchronous
// launchRound is sufficient to prevent clobbering a live round.
export function startCustomTrivia(
  channel: string,
  raw: { question: string; answer: string; accept: string[] },
): string {
  if (activeGames.has(channel)) {
    const game = activeGames.get(channel)!
    const remaining = Math.ceil((ROUND_DURATION - (Date.now() - game.startedAt)) / 1000)
    return `trivia already active (${remaining}s left): ${game.question}`
  }
  // canonical answer always counts as accepted; norm/dedupe happens in launchRound.
  const accepted = [raw.answer, ...raw.accept]
  return launchRound(channel, {
    question: raw.question,
    answer: raw.answer,
    accepted,
    type: CUSTOM_TYPE,
  })
}

function endTrivia(channel: string, expectedGameId?: number): string | null {
  const game = activeGames.get(channel)
  if (!game) return null
  // if called from a timer, only end the game that started it
  if (expectedGameId !== undefined && game.gameId !== expectedGameId) return null

  clearTimeout(game.timeout)
  clearHints(game)
  activeGames.delete(channel)
  lastGameEnd.set(channel, Date.now())
  log(`trivia: ended #${channel} game ${game.gameId} (${game.participants.size} players, timeout)`)

  // ALWAYS reveal the answer when a round ends — a posted question must get a posted
  // answer so the bot is never seen to "go dead" mid-round (even if answers failed to
  // register for any reason), and revealing teaches chat the answer.
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

  const cleaned = norm(trimmed)
  if (!cleaned) return

  const userId = db.getOrCreateUser(username)
  game.participants.add(username)
  db.recordTriviaAttempt(userId)

  // "any ..." questions are multi-answer pools — exact+alias only (no fuzzy false-wins).
  const allowFuzzy = !game.correctAnswer.startsWith('any')
  let isCorrect = matchAnswer(cleaned, game.acceptedAnswers, allowFuzzy)
  // type 11 (exact monster HP) is brutal — accept a guess within ±10% of the true value
  // so "4400" wins for a 4700 HP monster instead of enraging a close, knowledgeable guess.
  if (!isCorrect && game.questionType === 11 && game.acceptedAnswers.length === 1) {
    const truth = parseInt(game.acceptedAnswers[0])
    const guess = parseInt(cleaned)
    if (!isNaN(truth) && !isNaN(guess) && truth > 0 && Math.abs(guess - truth) <= truth * 0.1) {
      isCorrect = true
    }
  }
  // custom AI topics yield obscure answers ("rete mirabile", "archaeopteryx") that are
  // easy to fat-finger. accept a single-character typo on a real attempt so a player who
  // clearly knows it isn't denied by one slipped letter. gated to answers >=5 chars (a
  // 1-edit neighbor of a short word is too often a different valid word) and to non-numeric
  // answers (a 1-digit slip is a different number, not a typo).
  if (!isCorrect && game.questionType === CUSTOM_TYPE) {
    isCorrect = game.acceptedAnswers.some(
      (a) => a.length >= 5 && !/^\d+$/.test(a) && editDistance(cleaned, a) === 1,
    )
  }

  const answerTimeMs = Date.now() - game.startedAt
  db.recordTriviaAnswer(game.gameId, userId, text, isCorrect, answerTimeMs)

  if (isCorrect) {
    // re-check game is still active (another correct answer could have won in same tick)
    if (!activeGames.has(channel)) return
    const secs = answerTimeMs / 1000
    // points = difficulty base × speed multiplier + streak bonus (min 1). this is the
    // real leaderboard currency — knowing a hard answer fast beats spamming easy wins.
    const streak = db.getTriviaStreak(userId) + 1 // recordTriviaWin will set this value
    const firstWin = db.getTriviaWins(userId) === 0 // before recordTriviaWin increments it
    const base = difficultyBase(game.questionType, game.acceptedAnswers.length)
    // continuous speed decay (no 3s/5s/10s cliffs): 0s -> 1.5x, full round -> 0.5x.
    const speedMult = Math.max(0.5, Math.min(1.5, 1.5 - answerTimeMs / ROUND_DURATION))
    const streakBonus = streak >= 5 ? 2 : streak >= 3 ? 1 : 0
    const points = Math.max(1, Math.round(base * speedMult) + streakBonus)

    db.recordTriviaWin(game.gameId, userId, answerTimeMs, game.participants.size, points)
    clearTimeout(game.timeout)
    clearHints(game)
    activeGames.delete(channel)
    lastGameEnd.set(channel, Date.now())

    // non-blocking D&D XP grant for trivia wins
    setImmediate(() => {
      try {
        const char = dndDb.getCharacter(username.toLowerCase(), channel.toLowerCase())
        if (char) {
          const { newLevel, leveledUp } = dndDb.addCharacterXp(username.toLowerCase(), channel.toLowerCase(), 15)
          if (leveledUp) say(channel, `trivia win bonus: @${username} gains 15 XP in the Depths — Lv${newLevel} ${char.class}!`)
        }
      } catch (e) { log(`dnd: trivia xp error: ${e}`) }
    })

    const timeStr = secs.toFixed(1)
    const speedTag = secs < 3 ? ' LEGENDARY' : secs < 5 ? ' FAST' : secs < 10 ? ' nice' : ''
    const streakTag = streak >= 5 ? ` (${streak} STREAK!!)` : streak >= 3 ? ` (${streak} streak)` : ''
    const emote = secs < 3 || streak >= 5
      ? pickEmoteByMood(channel, 'hype', 'celebration')
      : secs < 5 || streak >= 3
        ? pickEmoteByMood(channel, 'celebration', 'hype')
        : pickEmoteByMood(channel, 'happy', 'celebration')
    const firstTag = firstWin ? ' first win!' : ''
    say(channel, `${username} got it in ${timeStr}s!${speedTag}${streakTag} +${points}pt${firstTag} Answer: ${game.correctAnswer}${emote ? ` ${emote}` : ''}`)
  } else {
    db.resetTriviaStreak(userId)
    // close-miss taunt — capped per round so 10 chatters guessing close
    // don't produce 10 bot lines.
    const missDist = cleaned.length >= 4 ? closeMissDistance(cleaned, game.acceptedAnswers) : 0
    if (missDist > 0 && game.closeMissCount < MAX_CLOSE_MISS_PER_ROUND) {
      game.closeMissCount++
      const emote = pickEmoteByMood(channel, 'sarcasm', 'thinking')
      const phrase = missDist === 1 ? `${username} — 1 letter off!` : `${username} so close!`
      say(channel, `${phrase}${emote ? ` ${emote}` : ''}`)
    }
  }
}

export function skipTrivia(channel: string, username?: string): string | null {
  const game = activeGames.get(channel)
  if (!game) return null
  clearTimeout(game.timeout)
  clearHints(game)
  activeGames.delete(channel)
  lastGameEnd.set(channel, Date.now())
  const emote = pickEmoteByMood(channel, 'sad', 'thinking')
  const who = username ? `${username} skipped` : 'Skipped'
  return `${who}. Answer: ${game.correctAnswer}${emote ? ` ${emote}` : ''}`
}

export function cleanupChannel(channel: string) {
  const game = activeGames.get(channel)
  if (game) {
    clearTimeout(game.timeout)
    clearHints(game)
  }
  activeGames.delete(channel)
  lastGameEnd.delete(channel)
  recentTypes.delete(channel)
  recentQuestions.delete(channel)
}

export function isGameActive(channel: string): boolean {
  return activeGames.has(channel)
}

export function getTriviaScore(channel: string): string {
  const leaders = db.getTriviaLeaderboard(channel, 5)
  if (leaders.length === 0) return 'no trivia scores yet'
  const lines = leaders.map((l, i) => `${i + 1}. ${l.username} (${l.points}pts)`)
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
    if (stats.trivia_points > 0) parts.push(`${stats.trivia_points}pts`)
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
export { matchAnswer, looksLikeAnswer, difficultyBase, generateHint, generateWeakHint }

export function resetForTest() {
  activeGames.clear()
  lastGameEnd.clear()
  recentTypes.clear()
  recentQuestions.clear()
  forcedGenIdxForTest = null
}

export function getActiveGameForTest(channel: string) {
  return activeGames.get(channel)
}
