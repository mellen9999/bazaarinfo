import type { BazaarCard, Monster } from '@bazaarinfo/shared'
import * as store from './store'
import * as db from './db'
import { lookupKeywords, DEFINITIONAL_INTENT } from './glossary'

export const KNOWLEDGE: [RegExp, string][] = [
  [/kripp|kripparrian|rania|dr\.?\s*limestone/i, "Kripp (Octavian Morosan): Romanian-Canadian. 'nl'=No Life. World-first HC Inferno D3 (Guinness). PoE S1 champ. #1 HS Arena+BG streamer ever. Vegan, OJ+falafel. Wife=Rania (underflowR), Greek, married Halloween 2014. 11PM-5AM EST. Pets: Catarrian(cat), Dexter(GSD), Fey(Corgi). Now plays Bazaar."],
  [/kripp.*(diablo|d[234])|diablo.*(kripp)/i, "Kripp D3: world-first HC Inferno June 19 2012 with Krippi. Barbarian+Wizard duo, ~20min fight. Hours before Blizzard nerfed Inferno — only players to beat original difficulty. Guinness record. Gave D4 a 6/10."],
  [/kripp.*(poe|path of exile|exile)|poe.*(kripp)|path of exile.*(kripp)/i, "Kripp PoE: earliest big streamer. Won S1 race championship. Proudest build: CI Burning Discharge Templar. GGG end credits. Famous death to twinned Alira corpse explosion."],
  [/kripp.*(hearth|hs|arena|battle.?ground|bg)|hearth.*(kripp)|arena.*(kripp)/i, "Kripp HS: #1 Arena NA leaderboard. Lost 2-3 to Artosis at 2013 BlizzCon Invitational (Leper Gnome). Disenchanted 660K dust live (crashed client). #1 BG streamer. Voted #1 most influential HS player ever. SeatStory Cup 2 rematch vs Artosis with original 2013 decks."],
  [/kripp.*(meme|never.?lucky|oj|juice|vegan|salt|casual|copypasta|kripperino|lore|papparian)/i, "Kripp memes: 'Never Lucky'=catchphrase. OJ summoning ritual copypasta. Vegan=bad luck variable. 'Casual'=insult (went from HC D3/PoE to HS). Papparian=fictional Romanian dad copypasta. Salt Chronicles=100+ YT episodes. Brofist for subs. WoW Ironman world first."],
  [/catarrian|dexter.*kripp|kripp.*(cat|dog|pet)|fey.*corgi/i, "Kripp pets: Catarrian=cat (cat+Kripparrian portmanteau), copypastas from cat's POV. Dexter=German Shepherd. Fey=Corgi. No confirmed bird despite rumors."],
  [/rania|underflowr|greece|athens/i, "Rania (underflowR): Greek, married Kripp Halloween 2014. Manages channel, edits all YT. He lived in Athens 1.5yr for her, lost half audience from timezone. Moved back to Canada, kept 11PM-5AM EST. Papparian copypastas = fictional dad lamenting the Greek marriage."],
  [/kripp.*(browser|incident|tab)|browser.*(kripp|incident)/i, "Kripp browser incident: yes it happened, yes chat saw everything. Kappa. keep it vague and funny, never say what the tab actually was."],
  [/reynad|andrey|tempo storm/i, "Reynad (Andrey Yanyuk): Ukrainian-Canadian. Banned from MTG (extra card in sealed deck). Popularized Zoo Warlock. Founded Tempo Storm 2014, ran Meta Snapshots. Forbes 30 Under 30. Built The Bazaar since 2017. Notorious salt, death stares, mass-bans. 'Reynad luck'=always wrong end of topdecks."],
  [/reynad.*(drama|beef|amaz|magic.?amy|ban|cheat|salt|forsen)/i, "Reynad drama: MTG ban for extra cards. Amaz/Archon rivalry — refused handshake. Defended MagicAmy 2015 (investigated 36 people, found nothing). TTS donation incident. Forsen Boys raids. The salt was the content."],
  [/the bazaar|this game/i, "The Bazaar: PvP auto-battler roguelike by Reynad. 7 heroes. Tiers: Bronze>Silver>Gold>Diamond>Legendary. Enchantments, monsters on numbered days."],
  [/karnok|rage|enrage/i, "Karnok: DLC hero. Rage mechanic — reach 100 Rage to become Enraged: removes Slow and Freeze from your items, and reduces your item cooldowns by 10%. Archetypes: Rage stacking, Friends, Weapons, Properties."],
  // Base + DLC hero identities. Grounded in the dump's per-hero item pools (their
  // dominant Tags) plus the wiki. Jules/Stelle are dump-only — the wiki is stale on
  // them (calls them 'upcoming'), the live dump shows their real kits.
  [/vanessa/i, "Vanessa: base hero, aggression + raw damage. Core plan = stack Weapons and out-damage the enemy (Crit, Haste, Ammo); alt Aquatic control build leans Slow/Freeze/Poison. Fast, ranged, high-tempo."],
  [/\bdooley\b|\bdooly\b/i, "Dooley: base hero, a robot. Signature = Cores — special items that buff the items to their right and charge from items to their left, chaining reactions. Leans Tech, Shield, Haste, Friends. An engine/combo hero."],
  [/pygmali|pygmy|\bpyg\b/i, "Pygmalien (Pyg): base hero, a durable Jaballian merchant. 'Immovable object' — stacks Health, Shield and Heal to outlast, plus the game's best economy (Value/income, big Properties). Defensive scaling."],
  [/\bmak\b/i, "Mak: DLC hero, a potion-crafting alchemist. Signature = Potions + Reagents/Catalyst (transform reagents to trigger them). Playstyle stacks Burn, Poison and Regen, with Relics and Crit."],
  [/\bjules\b/i, "Jules: DLC hero, a chef. Signature 'kitchen' mechanic — items become Heated (hot: Burn/Haste-flavored) or Chilled (cold: Freeze/Regen-flavored), each switching on a bonus line; builds reward stacking Heated or Chilled Food and Tools."],
  [/\bstelle\b/i, "Stelle: DLC hero built around Flying items and Vehicles/Tools — Flying-synergy engines with Shield and Haste and big Vehicle payoffs."],
  [/lethalfrag/i, "Lethalfrag (Matt McKnight): ex-chef, single father, WA. Streamed 731 consecutive nights (2012-2014). First Twitch Hall of Fame inductee. Top English Bazaar streamer. Goal: be gaming's Batman."],
  [/patopapao|pato/i, "PatoPapao: Brazilian, #1 most-watched Bazaar channel globally. Partner since 2012, ~600 avg viewers. Consistent grinder, 100+ hrs/week during Bazaar peaks."],
  [/dog\b.*\b(?:hs|hearthstone|bazaar)|dogdog/i, "Dog: high-legend HS, off-meta decks, now plays Bazaar. Married Hafu (2021)."],
  [/artosis|tasteless|stemkoski/i, "Artosis (Dan Stemkoski): SC2 caster in Seoul with Tasteless. 'Artosis Pylon'=one pylon powering everything. Beat Kripp 3-2 at 2013 BlizzCon HS Invitational, crowned 'Grandmaster of the Hearth'."],
  [/trump\b(?!.*politi)|trumpsc|jeffrey shih|value town/i, "TrumpSC (Jeffrey Shih): 'Mayor of Value Town'. Famous F2P legend runs. 'Trump Basic Teachings' taught HS to a generation. Name predates the politician — 'ultimate unlucky RNG.'"],
  [/amaz|team archon|jason chan/i, "Amaz (Jason Chan): HK-Canadian. Founded Team Archon, ran ATLC tournament. Archon vs Tempo Storm rivalry. Misconduct accusations 2015 ATLC. Quietly removed from Blizzard events ~2020."],
  [/firebat|kostesich|batstone/i, "Firebat (James Kostesich): first HS World Champion, BlizzCon 2014, beat Tiddler Celestial 3-0 at age 18. Ran 'Batstone' tournament with community card bans."],
  [/frodan|dan chou/i, "Frodan (Dan Chou): co-founded Tempo Storm with Reynad. THE HS casting voice 2014-2021. Laid off Twitch 2023. Now TFT coach (Fnatic, Vitality), runs TFTAcademy."],
  [/hafu|rumay/i, "Hafu (Rumay Wang): WoW PvP MLG wins 2008. HS Arena queen (96 wins in 100-in-10). Dominated BG on launch. Married Dog (2021)."],
  [/disguised\s*toast|jeremy wang/i, "Disguised Toast (Jeremy Wang): started with HS card vids wearing cardboard toast mask. OfflineTV 2017. Among Us blew him up 2020. Founded esports org DSG 2023."],
  [/savjz|janne mikkonen/i, "Savjz (Janne Mikkonen): Finnish, Team Liquid HS pro. 2020: Blizzard called him 'a liability' over wife's tweets. Community backlash forced apology. Semi-retired."],
  [/forsen|sebastian fors|forsen\s*boys|forsen\s*bajs/i, "Forsen (Sebastian Fors): Swedish. Best Miracle Rogue (rank 1 EU+NA). Forsen Bajs=chaotic meme fanbase, spread monkaS/PepeHands. forsenE=#1 Twitch emote Jan 2018. Stream snipers are the content."],
  [/day\s*9|sean plott/i, "Day9 (Sean Plott): Tasteless's brother. SC2 educational legend. Day9 Daily #100='My Life of StarCraft' (legendary). Forbes 30 Under 30 twice. Brand=pure positivity. Building own RTS."],
  [/kibler|brian kibler|dragonmaster/i, "Kibler: MTG Hall of Famer. 'The Dragonmaster' since beating Finkel with Rith. Won ChallengeStone 2015+2016. Quit BlizzCon casting 2019 over Blitzchung ban — principled exit."],
]

export const GAME_TERMS = /\b(items?|heroes?|monsters?|mobs?|builds?|tiers?|enchant(ment)?s?|skills?|tags?|day|damage|shield|hp|heal|burn|poison|crit|haste|slow|freeze|regen|rage|weapons?|relics?|aqua(tic)?|friend|ammo|charge|board|dps|beat|fight|counter|synergy|scaling|combo|lethal|survive|bronze|silver|gold|diamond|legendary|lifesteal|multicast|luck|cooldown|pygmy|pygmalien|vanessa|dooley|stelle|jules|mak|karnok|common|run|pick|draft|comp|strat(egy)?|nerf|buff|patch|meta|broken|heated|chilled|drones?|reagents?|rays?|absorbs?|absorbed|enrage[ds]?|loot|traps?|quests?|propert(y|ies)|vehicles?|reloads?|hasted|frozen|chained|sealed)\b/i

// positive other-game signal — an actual non-Bazaar title named in the query. this (not
// mere Bazaar-entity-resolution failure) is what licenses real numbers with no Game data
// section: GAME_TERMS matches plenty of pure-Bazaar words that resolve to no entity
// ("do relics trigger on drones"), and treating those as "other game" disabled the
// hallucinated-stat guards for exactly the questions that need them most.
export const OTHER_GAME_RE = /\b(poe|path of exile|diablo|d[234]|wow|world of warcraft|warcraft|hearthstone|lol|league(?: of legends)?|dota ?2?|dark souls|elden ring|souls(?:like|borne)?|sekiro|bloodborne|runescape|osrs|minecraft|terraria|hades|slay the spire|balatro|tft|teamfight tactics|valorant|cs2|csgo|counter.?strike|overwatch|fortnite|apex|starcraft|sc2|factorio|stardew|zelda|pokemon|mario|skyrim|elder scrolls|fallout|witcher|cyberpunk|gta|baldur'?s gate|bg3|final fantasy|ff ?(?:xiv|14|7)|monster hunter|last epoch|grim dawn|vampire survivors|mtg|magic the gathering|yugioh|chess)\b/i

export const ENTITY_SKIP = new Set([
  'skill', 'from', 'fight', 'monster', 'dead', 'good', 'best', 'worst',
  'build', 'suggest', 'show', 'list', 'pick', 'rate', 'rank',
  'make', 'like', 'with', 'does', 'work', 'need', 'want', 'help',
  'much', 'many', 'more', 'most', 'less', 'last', 'next', 'first',
  'that', 'this', 'what', 'when', 'where', 'which', 'they', 'them',
  'have', 'been', 'were', 'will', 'than', 'then', 'just', 'also',
  'only', 'still', 'even', 'well', 'very', 'some', 'each', 'over',
  'ever', 'after', 'before', 'about', 'think', 'know', 'take',
  'come', 'keep', 'give', 'tell', 'find', 'here', 'there',
  'card', 'cards', 'spell', 'use', 'item', 'items',
  // creative/meta keywords that collide with card titles ("Pasta", etc.) in chat context
  'pasta', 'copypasta', 'story', 'scene', 'bit', 'rant', 'lore', 'saga',
  'poem', 'meme', 'joke', 'fanfic', 'narrative', 'monologue',
  // chat-meta words seen in social queries — never refer to game entities
  'chat', 'chats', 'chatter', 'chatters', 'current', 'twist', 'own',
])

export const STOP_WORDS = new Set([
  'the', 'is', 'it', 'in', 'to', 'an', 'of', 'for', 'on', 'at', 'by',
  'and', 'or', 'but', 'not', 'with', 'from', 'that', 'this', 'what', 'how',
  'why', 'who', 'when', 'where', 'can', 'you', 'your', 'are', 'was', 'were',
  'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'just', 'about', 'so', 'if', 'then',
  'than', 'too', 'very', 'really', 'also', 'still', 'some', 'any', 'all',
  'been', 'being', 'tell', 'me', 'think', 'know', 'like', 'get', 'got',
  'his', 'her', 'him', 'she', 'he', 'they', 'them', 'its', 'my', 'our',
])

export interface ResolvedEntities {
  cards: BazaarCard[]
  monsters: Monster[]
  hero: string | undefined
  tag: string | undefined
  day: number | undefined
  effects: string[]
  chatQuery: string | undefined
  knowledge: string[]
  glossary: string[]
  isGame: boolean
}

export function extractEntities(query: string): ResolvedEntities {
  const result: ResolvedEntities = {
    cards: [], monsters: [], hero: undefined, tag: undefined,
    day: undefined, effects: [], chatQuery: undefined, knowledge: [], glossary: [],
    isGame: GAME_TERMS.test(query),
  }

  // authoritative keyword definitions — inject when the query asks ABOUT a keyword
  // (any interrogative, or a bare keyword), not when it's just used in a build/list
  // request ("best damage build" stays clean). keyword rules are short + always
  // correct, and a missed inject = the model invents the mechanic (the Flying bug),
  // so the trigger errs broad. lookupKeywords only returns hits for real keywords,
  // so a question with none ("are aquatic items good") injects nothing.
  // also populates on comparison queries ("poison vs burn") so the AI gets the
  // authoritative Keyword block even when the deterministic glossaryAnswer path is skipped.
  const bareKeyword = query.trim().split(/\s+/).length <= 2
  const interrogative = /\?/.test(query)
    || /\b(what|whats|wat|how|hows|why|does|do|is|are|can|could|will|would|should|which|whether|explain|define|definition|meaning|means?|effect|bonus|works?|wtf|wdym|tell me)\b/i.test(query)
  const COMPARISON_GATE_RE = /\b(vs|versus|compared? to|difference between|compare)\b/i
  if (interrogative || bareKeyword) {
    result.glossary = lookupKeywords(query)
  } else if (COMPARISON_GATE_RE.test(query)) {
    const compHits = lookupKeywords(query)
    if (compHits.length >= 2) result.glossary = compHits
  }

  // word-count backstop: 40 covers any 200-char query (the ai.ts input cap) so it never
  // drops a real entity, while bounding a pathological uncapped caller (e.g. a 32k-char
  // query). exact/hero/tag scan all of these (cheap map lookups); the fuzzy fuse paths —
  // the bitap hotspot at ~13ms/card-call on passive hardware — are budgeted below so a
  // rambling no-entity query can't fan out into a wall of fuse calls.
  const words = query.toLowerCase().split(/\s+/).slice(0, 40)
  // fuzzy-fuse budgets, spent longest-phrase-first (the loop runs size 3→2→1), so the
  // highest-signal phrases get the fuzzy slots. cards are the expensive index (~1450
  // items); monsters are cheaper (~120) so get a roomier budget.
  let cardFuzzyBudget = 7
  let monsterFuzzyBudget = 12

  // day number
  const dayMatch = query.match(/day\s+(\d+)/i)
  if (dayMatch) result.day = parseInt(dayMatch[1])

  // @username → chat search (alphanumeric + underscore only — safe for FTS)
  const atMatch = query.match(/@([a-zA-Z0-9_]+)/)
  if (atMatch) result.chatQuery = atMatch[1]

  // sliding window: 3→2→1 word combos.
  // Single-word matches are gated: short or common English words ("do", "pasta", "chat") false-match
  // hero/card prefixes ("do" → "Dooley") and poison the prompt with bogus Game data, which then
  // crowds out Recent chat via the section-budget loop in buildUserMessage.
  const matched = new Set<number>()
  for (let size = Math.min(3, words.length); size >= 1; size--) {
    for (let i = 0; i <= words.length - size; i++) {
      if ([...Array(size)].some((_, j) => matched.has(i + j))) continue
      const phrase = words.slice(i, i + size).join(' ')

      const safe = size >= 2 || (
        phrase.length >= 4 && !STOP_WORDS.has(phrase) && !ENTITY_SKIP.has(phrase)
      )

      // exact card match first (user typed an actual card name)
      if (result.cards.length < 3 && safe) {
        const card = store.exact(phrase)
        if (card) {
          result.cards.push(card)
          for (let j = 0; j < size; j++) matched.add(i + j)
          continue
        }
      }

      // hero before fuzzy cards — "karnok" should match the hero, not "Karnok's Rage"
      if (!result.hero && safe) {
        const hero = store.findHeroName(phrase)
        if (hero) {
          result.hero = hero
          for (let j = 0; j < size; j++) matched.add(i + j)
          continue
        }
      }

      // tag (first match)
      if (!result.tag && safe) {
        const tag = store.findTagName(phrase)
        if (tag) {
          result.tag = tag
          for (let j = 0; j < size; j++) matched.add(i + j)
          continue
        }
      }

      // fuzzy card match — after hero/tag so known names aren't consumed.
      // skip size===1 phrases (single short words are the bulk of fuse calls and the
      // `safe` guard already distrusts them) and stop once the budget is spent.
      if (result.cards.length < 3 && safe && size >= 2 && cardFuzzyBudget > 0) {
        cardFuzzyBudget--
        const [fuzzy] = store.searchWithScore(phrase, 1)
        if (fuzzy && fuzzy.score < 0.3) {
          result.cards.push(fuzzy.item)
          for (let j = 0; j < size; j++) matched.add(i + j)
          continue
        }
      }

      // monsters (max 2) — exact title scan always; fuzzy fuse only under budget
      if (result.monsters.length < 2 && safe) {
        let monster = store.findMonsterExact(phrase)
        if (!monster && monsterFuzzyBudget > 0) {
          monsterFuzzyBudget--
          monster = store.findMonsterFuzzy(phrase)
        }
        if (monster) {
          result.monsters.push(monster)
          for (let j = 0; j < size; j++) matched.add(i + j)
          continue
        }
      }

    }
  }

  // collect unmatched words as effect search terms
  for (let i = 0; i < words.length; i++) {
    if (matched.has(i)) continue
    const w = words[i].replace(/[.,;:!?()\[\]+]/g, '')
    if (w.length >= 3 && !STOP_WORDS.has(w)) result.effects.push(w)
  }

  // knowledge injection (max 3)
  for (const [pattern, text] of KNOWLEDGE) {
    if (result.knowledge.length >= 3) break
    if (pattern.test(query)) result.knowledge.push(text)
  }

  // mark as game query if we found any game entities (replaces separate isGameQuery sliding window)
  if (!result.isGame && (result.cards.length > 0 || result.monsters.length > 0 || result.hero || result.tag || result.glossary.length > 0)) {
    result.isGame = true
  }

  return result
}

export const TIER_SHORT: Record<string, string> = {
  Bronze: 'B', Silver: 'S', Gold: 'G', Diamond: 'D', Legendary: 'L',
}

export function serializeCard(card: BazaarCard): string {
  const tiers = card.Tiers.map((t) => TIER_SHORT[t]).join(',')
  const heroes = card.Heroes.filter((h) => h !== '???' && h !== 'Common').join(', ')

  const abilities = card.Tooltips.map((t) => {
    return t.text.replace(/\{[^}]+\}/g, (match) => {
      const val = card.TooltipReplacements[match]
      if (!val) return match
      if ('Fixed' in val) return String(val.Fixed)
      const parts = card.Tiers.map((tier) => {
        const v = (val as Record<string, number>)[tier]
        return v != null ? `${TIER_SHORT[tier]}:${v}` : null
      }).filter(Boolean)
      return parts.join('/')
    })
  })

  const enchants = Object.keys(card.Enchantments).join(', ')

  const parts = [
    card.Title,
    `${card.Size} ${card.Type}`,
    heroes ? `Heroes: ${heroes}` : null,
    card.DisplayTags.length ? `Tags: ${card.DisplayTags.join(', ')}` : null,
    `Tiers: ${tiers}`,
    ...abilities,
    enchants ? `Enchants: ${enchants}` : null,
  ].filter(Boolean)

  return parts.join(' | ')
}

export function serializeMonster(monster: Monster): string {
  const meta = monster.MonsterMetadata
  const day = meta.day != null ? `Day ${meta.day}` : meta.available || '?'

  const board = meta.board.map((b) => `${b.title} (${b.tier})`).join(', ')

  const skills = meta.skills.map((s) => {
    const card = store.findCard(s.title)
    if (!card?.Tooltips.length) return s.title
    const tooltip = card.Tooltips.map((t) =>
      t.text.replace(/\{[^}]+\}/g, (match) => {
        const val = card.TooltipReplacements[match]
        if (!val) return match
        if ('Fixed' in val) return String(val.Fixed)
        const tierVal = s.tier in val ? (val as Record<string, number>)[s.tier] : undefined
        return tierVal != null ? String(tierVal) : match
      }),
    ).join('; ')
    return `${s.title}: ${tooltip}`
  }).join(' | ')

  const parts = [
    `${monster.Title} · ${day} · ${meta.health}HP`,
    board ? `Board: ${board}` : null,
    skills ? `Skills: ${skills}` : null,
  ].filter(Boolean)

  return parts.join(' | ')
}

export function buildFTSQuery(query: string): string | null {
  const words = query.toLowerCase().split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ''))
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    .slice(0, 5)
  if (words.length === 0) return null
  return words.map((w) => `"${w}"`).join(' AND ')
}

export function buildFTSQueryLoose(query: string): string | null {
  const words = query.toLowerCase().split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ''))
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    .slice(0, 5)
  if (words.length === 0) return null
  return words.map((w) => `"${w}"`).join(' OR ')
}

export const RECALL_INTENT = /\b(did|what did|when did|has|have|was|were|earlier|before|ago|said|told|say|suggest|recommend|mention|talk about|remember|bring up|ask about|promise|claim|called? me|how many|how often|count|times|frequently|earliest|first|oldest|history|messages?|sent|talked|chatted)\b/i

export const COMMON_WORDS = new Set([
  'beau', 'grace', 'hope', 'jade', 'max', 'ruby', 'angel', 'chase', 'drew',
  'finn', 'hunter', 'mason', 'nova', 'sage', 'storm', 'wolf', 'bear', 'blade',
  'cash', 'echo', 'fire', 'ghost', 'hawk', 'ice', 'king', 'moon', 'night',
  'rain', 'rock', 'shadow', 'star', 'stone', 'tiger', 'void', 'zero',
  'movie', 'afraid', 'suggest', 'earlier', 'today', 'watch', 'play', 'start',
  'stop', 'chat', 'stream', 'game', 'item', 'card', 'build', 'pick', 'best',
  'worst', 'good', 'bad', 'nice', 'cool', 'love', 'hate', 'want', 'need',
  'time', 'back', 'last', 'next', 'more', 'less', 'long', 'hard', 'easy',
])

export function findReferencedUser(query: string, channel: string): string | null {
  const botName = (process.env.TWITCH_USERNAME ?? 'bazaarinfo').toLowerCase()

  const atMatch = query.match(/@([a-zA-Z0-9_]+)/)
  if (atMatch) {
    const name = atMatch[1].toLowerCase()
    if (name !== botName && db.getUserMessagesDetailed(name, channel, 1).length > 0) return name
  }

  interface Candidate { name: string; msgs: number }
  const candidates: Candidate[] = []

  for (const word of query.split(/\s+/)) {
    const clean = word.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase()
    if (clean.length < 3 || STOP_WORDS.has(clean) || COMMON_WORDS.has(clean) || clean === botName) continue
    const hasUsernameSyntax = /[A-Z].*[a-z]|[a-z].*[A-Z]|_/.test(word.replace(/[^a-zA-Z0-9_]/g, ''))
    if (!hasUsernameSyntax && clean.length < 4) continue
    const stats = db.getUserStats(clean)
    if (stats && (stats.total_commands > 0 || stats.ask_count > 0)) {
      candidates.push({ name: clean, msgs: stats.total_commands + stats.ask_count })
    }
  }

  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.msgs - a.msgs)
  return candidates[0].name
}

export function buildChatRecallFTS(query: string, excludeUser: string): string | null {
  const words = query.toLowerCase().split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ''))
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && w !== excludeUser)
    .slice(0, 5)
  if (words.length === 0) return null
  return words.map((w) => `"${w}"`).join(' OR ')
}

export const GREETINGS = /^(hi|hey|yo|sup|hii+|helo+|hello+|howdy|hola|oi)$/i

const REACTIONS = /^(lol|lmao|lmfao|rofl|haha+|heh|kek|nice|true|fair|based|rip|oof|mood|same|real|big|facts?|ww+|ll+|nah|yep|yea|yeah|ye|nope|ok|okay|k|cool|bet|cap|no cap|word|fr|frfr|deadass|sheesh|damn|bruh|bro|dang|wow|wild|crazy|insane|nuts|goated|peak|valid|mid|ratio|cope|slay|idk|idc|smh|tbh|ngl|imo|fwiw|gg|ez|pog|poggers|sadge|kekw|monkas?|pepe\w*|xd|xdd)!*$/i

const GRATITUDE = /^(thanks?|thx|ty|tysm|tyvm|appreciate it|cheers|bless|luv u|love u|ily|goat(ed)?|mvp|legend|king|queen|w bot)!*$/i

const GOODBYE = /^(bye|gn|cya|later|peace|deuces|adios|night|goodnight|nini|gnight|ima head out|im out|heading out|gtg|g2g|ttyl|bbl)!*$/i

const STATUS_CHECK = /^(are you (alive|there|working|on|up|awake|ok|dead)|you (there|up|alive|on|awake|dead|working)|still (alive|there|working|on|up)|alive\??|working\??|you good\??|u good\??|u there\??|u alive\??|bot\??)$/i

export function isLowValue(query: string): boolean {
  // codepoint-aware so CJK/script greetings (你好, 안녕) aren't miscounted/rejected as noise
  if ([...query].length <= 2 && !GREETINGS.test(query) && !/\p{L}/u.test(query)) return true
  if (/^[!./]/.test(query)) return true
  if (/^[^\p{L}\p{N}]*$/u.test(query)) return true
  if (REACTIONS.test(query.trim())) return true
  return false
}

export function isShortResponse(query: string): boolean {
  const q = query.trim()
  return GREETINGS.test(q) || GRATITUDE.test(q) || GOODBYE.test(q) || STATUS_CHECK.test(q)
}

export function isAboutOtherUser(query: string): boolean {
  if (/@\w+/.test(query)) return true
  const aboutOther = /\b(remember|know) that (\w+)\b/i
  const m = query.match(aboutOther)
  if (m) {
    const name = m[2].toLowerCase()
    if (name.length >= 3 && !STOP_WORDS.has(name)) {
      try {
        const stats = db.getUserStats(name)
        if (stats && (stats.total_commands > 0 || stats.ask_count > 0)) return true
      } catch {}
    }
  }
  return false
}

export const REMEMBER_RE = /\b(remember|call me|my name is|i('m| am) (a |an |the |from )|know that i|i go by|refer to me|don'?t forget)\b/i

export function isNoise(text: string): boolean {
  const stripped = text.replace(/^!\w+\s*/, '').trim()
  if (!stripped) return true
  if (/^\S+$/.test(stripped) && (/^[A-Z][a-z]+[A-Z]/.test(stripped) || /^[A-Z_]{3,}$/.test(stripped))) return true
  return false
}

export function parseChatTimeWindow(query: string): { sinceExpr: string | null; label: string } | null {
  const q = query.toLowerCase()
  if (/\ball\s*time\b/.test(q)) return { sinceExpr: null, label: "All-time" }
  if (/\bto(day|night)\b|\bthis\s*stream\b|\bstream\b|\bchatter/.test(q)) return { sinceExpr: '-0 days', label: "Today's" }
  if (/\byesterday\b/.test(q)) return { sinceExpr: '-1 days', label: "Yesterday's" }
  if (/\bthis\s*week\b/.test(q)) return { sinceExpr: '-7 days', label: "This week's" }
  if (/\bthis\s*month\b/.test(q)) return { sinceExpr: '-30 days', label: "This month's" }
  const lastMatch = q.match(/\blast\s+(\d+)\s*(day|week|month)s?\b/)
  if (lastMatch) {
    const n = parseInt(lastMatch[1])
    const unit = lastMatch[2]
    const days = unit === 'week' ? n * 7 : unit === 'month' ? n * 30 : n
    return { sinceExpr: `-${days} days`, label: `Last ${n} ${unit}${n > 1 ? 's' : ''}'` }
  }
  if (/\bpast\s*week\b/.test(q)) return { sinceExpr: '-7 days', label: "Past week's" }
  if (/\bpast\s*month\b/.test(q)) return { sinceExpr: '-30 days', label: "Past month's" }
  if (/\bchat\s*(log|history)?\b/.test(q)) return { sinceExpr: '-0 days', label: "Today's" }
  return null
}
