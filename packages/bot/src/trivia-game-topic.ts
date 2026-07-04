import type { BazaarCard, Monster } from '@bazaarinfo/shared'
import { resolveTooltip, compressTooltip } from '@bazaarinfo/shared'
import * as store from './store'

// Game-topic detection + data dossier for custom trivia. "!b trivia about jules items"
// names GAME content — the world-knowledge generator can't know it (the game shipped
// after every model's cutoff and changes each patch), so the verify panel rightly kills
// whatever it invents and the round falls to an unrelated substitute question. This
// module recognizes those topics and assembles a compact, current-patch data block from
// the card cache so the AI writes questions grounded in facts that are TRUE NOW.

export type GameTopicKind = 'hero' | 'item' | 'monster' | 'tag' | 'monsters' | 'general'

export interface GameTopic {
  kind: GameTopicKind
  name: string // canonical entity name ('' for monsters/general)
  tag?: string // optional tag focus on a hero topic ("jules weapons")
}

// filler words that never disambiguate a topic — stripped before entity matching, and
// allowed as leftovers around a hero name ("jules items" is a hero topic, "jules verne"
// is not). includes "bazaar" so "bazaar weapons" leaves only the tag to resolve.
const GENERIC = new Set([
  'item', 'items', 'skill', 'skills', 'card', 'cards', 'stuff', 'gear', 'build', 'builds',
  'the', 'a', 'an', 'of', 'from', 'in', 'on', 'all', 'any', 'his', 'her', 'their', 'its',
  'game', 'trivia', 'question', 'about', 'bazaar',
])

const MONSTER_WORD_RE = /^(?:monsters?|boss(?:es)?|encounters?)$/

// resolve a topic word to a canonical tag, tolerating the plural chat actually types
// ("weapons" -> Weapon). generic fillers never count as tags.
function tagFor(word: string): string | undefined {
  if (GENERIC.has(word)) return undefined
  return store.findTagName(word) ?? (word.endsWith('s') ? store.findTagName(word.slice(0, -1)) : undefined)
}

// conservative on purpose: only an EXACT hero/alias word, an exact item/monster title, or
// an explicit "bazaar" marker routes to game data — "jules verne" or "napoleon" must keep
// flowing to the world-knowledge generator untouched. a false negative costs a fallback
// round; a false positive hijacks a legitimate world topic.
export function detectGameTopic(topic: string): GameTopic | null {
  const t = topic.toLowerCase().replace(/[^a-z0-9\s'&-]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t) return null
  const words = t.split(' ')

  // whole-topic exact titles first — the most specific ask wins ("boomerang", "tommy gun",
  // "coconut crab"). exact()/title equality only; fuzzy would hijack world topics.
  const stripped = words.filter((w) => !GENERIC.has(w)).join(' ')
  for (const phrase of new Set([t, stripped])) {
    if (phrase.length < 3) continue
    const card = store.exact(phrase)
    if (card) return { kind: 'item', name: card.Title }
    const monster = store.getMonsters().find((m) => m.Title.toLowerCase() === phrase)
    if (monster) return { kind: 'monster', name: monster.Title }
  }

  // a hero word ("jules", "jewels", "pyg") + only fillers/tags around it. any other
  // leftover word ("verne") means it's NOT a hero topic.
  for (let i = 0; i < words.length; i++) {
    const hero = store.findExactHero(words[i])
    if (!hero) continue
    let tag: string | undefined
    let clean = true
    for (let j = 0; j < words.length; j++) {
      if (j === i) continue
      const w = words[j]
      if (GENERIC.has(w)) continue
      const tg = tagFor(w)
      if (tg) { tag ??= tg; continue }
      clean = false
      break
    }
    if (clean) return { kind: 'hero', name: hero, tag }
    break
  }

  // an explicit "bazaar" marker always means game content: "the bazaar" -> general,
  // "bazaar monsters" -> monsters, "bazaar weapons" -> that tag.
  if (words.includes('bazaar')) {
    let tag: string | undefined
    for (const w of words) {
      if (MONSTER_WORD_RE.test(w)) return { kind: 'monsters', name: '' }
      tag ??= tagFor(w)
    }
    if (tag) return { kind: 'tag', name: tag }
    return { kind: 'general', name: '' }
  }

  return null
}

// dossier budget in chars (~800 tokens). big enough for a hero's full title list plus a
// varied detail sample, small enough that a trivia round stays cheap.
const DOSSIER_CAP = 3200
const MAX_TITLES = 60

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function cardLine(c: BazaarCard): string {
  const tags = c.DisplayTags?.length ? ` (${c.DisplayTags.join(', ')})` : ''
  const tips = c.Tooltips.map((tp) => compressTooltip(resolveTooltip(tp.text, c.TooltipReplacements, c.BaseTier))).join('; ')
  return `- ${c.Title} [${c.Size} ${c.BaseTier}${tags}] ${tips}`.slice(0, 180)
}

function monsterLine(m: Monster): string {
  const md = m.MonsterMetadata
  const board = md.board.map((b) => b.title).join(', ')
  const skills = md.skills.map((s) => s.title).join(', ')
  return `- ${m.Title}: day ${md.day ?? '?'}, ${md.health} HP${board ? `; board: ${board}` : ''}${skills ? `; skills: ${skills}` : ''}`.slice(0, 220)
}

function titlesLine(label: string, cards: { Title: string }[]): string {
  const names = cards.slice(0, MAX_TITLES).map((c) => c.Title)
  const more = cards.length > MAX_TITLES ? `, +${cards.length - MAX_TITLES} more` : ''
  return `${label} (${cards.length}): ${names.join(', ')}${more}`
}

// join lines under the cap. detail lines are homogeneous, so stopping at the first
// overflow is fine — the sample just gets a little smaller.
function capJoin(lines: string[]): string {
  const out: string[] = []
  let len = 0
  for (const l of lines) {
    if (len + l.length + 1 > DOSSIER_CAP) break
    out.push(l)
    len += l.length + 1
  }
  return out.join('\n')
}

// assemble the data block the generator + verifier treat as sole source of truth.
// detail samples are shuffled so repeat asks on the same topic mine different facts.
// returns null when the cache has nothing for the topic, so the caller misses honestly.
export function buildGameDossier(gt: GameTopic): string | null {
  const lines: string[] = []

  if (gt.kind === 'hero') {
    const cards = store.byHero(gt.name)
    const matched = gt.tag
      ? cards.filter((c) => [...(c.DisplayTags ?? []), ...(c.HiddenTags ?? [])].some((x) => x.toLowerCase() === gt.tag!.toLowerCase()))
      : cards
    const items = matched.filter((c) => c.Type === 'Item')
    const skills = matched.filter((c) => c.Type === 'Skill')
    if (items.length + skills.length === 0) return null
    lines.push(`HERO: ${gt.name}${gt.tag ? ` — ${gt.tag} cards only` : ''}`)
    if (items.length) lines.push(titlesLine('items', items))
    if (skills.length) lines.push(titlesLine('skills', skills))
    lines.push('details (random sample):')
    for (const c of shuffle([...items, ...skills])) lines.push(cardLine(c))
  } else if (gt.kind === 'item') {
    const c = store.exact(gt.name) ?? store.findCard(gt.name)
    if (!c) return null
    lines.push(`CARD: ${c.Title}`)
    lines.push(cardLine(c))
    lines.push(`heroes: ${c.Heroes.join(', ') || 'none'} | tiers: ${c.Tiers.join(', ')}`)
    const enchNames = Object.keys(c.Enchantments ?? {})
    if (enchNames.length) {
      lines.push(`enchantments (${enchNames.length}): ${enchNames.join(', ')}`)
      for (const [name, e] of shuffle(Object.entries(c.Enchantments))) {
        const tip = e.tooltips.map((tp) => compressTooltip(resolveTooltip(tp.text, e.tooltipReplacements ?? {}, c.BaseTier))).join('; ')
        lines.push(`- ${name}: ${tip}`.slice(0, 180))
      }
    }
  } else if (gt.kind === 'monster') {
    const m = store.getMonsters().find((x) => x.Title.toLowerCase() === gt.name.toLowerCase())
    if (!m) return null
    lines.push(`MONSTER: ${m.Title}`)
    lines.push(monsterLine(m))
    lines.push('board card details:')
    for (const b of m.MonsterMetadata.board) {
      const c = store.findCard(b.title)
      if (c) lines.push(cardLine(c))
    }
  } else if (gt.kind === 'monsters') {
    const monsters = store.getMonsters()
    if (monsters.length === 0) return null
    lines.push('MONSTERS (random sample):')
    for (const m of shuffle(monsters)) lines.push(monsterLine(m))
  } else if (gt.kind === 'tag') {
    const cards = store.byTag(gt.name)
    if (cards.length === 0) return null
    lines.push(`TAG: ${gt.name}`)
    lines.push(titlesLine('items', cards))
    lines.push('details (random sample):')
    for (const c of shuffle(cards)) lines.push(cardLine(c))
  } else {
    const items = store.getItems()
    if (items.length === 0) return null
    lines.push(`THE BAZAAR — heroes: ${store.getHeroNames().join(', ')}`)
    lines.push('item details (random sample):')
    for (const c of shuffle(items).slice(0, 16)) lines.push(cardLine(c))
    lines.push('monsters (random sample):')
    for (const m of shuffle(store.getMonsters()).slice(0, 6)) lines.push(monsterLine(m))
  }

  const text = capJoin(lines)
  return text.length >= 40 ? text : null
}
