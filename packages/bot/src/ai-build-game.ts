// game-data context block: card/monster/hero/tag/day/effect lookups plus per-card
// patch deltas, assembled for whatever entities the query resolved to.
import * as store from './store'
import * as db from './db'
import { getPatchInfo } from './patch'
import { OVERLAY, isOverlayFresh, resolvePatch, getCardChange, getHeroChanges } from './patch-notes'
import { serializeCard, serializeMonster, type ResolvedEntities } from './ai-query'
import { stripChatMessage } from './ai-build-chat'

// --- game context builder ---

export function buildGameContext(entities: ResolvedEntities, channel?: string): string {
  const sections: string[] = []

  // authoritative keyword rules first — these are the verified mechanic, the one
  // thing the dump can't give. lead with them so a "what does flying do" answer is
  // the real rule, not a guess off the item list below.
  if (entities.glossary.length > 0) {
    sections.push(`Keyword rules (authoritative — state these exactly, never embellish or add numbers):\n${entities.glossary.join('\n')}`)
  }

  const isBroadHeroQ = !entities.hero && entities.cards.length === 0 && entities.monsters.length === 0
  const isComparisonQ = /\b(tier\s*list|ranking|rank|compare|best|worst|strongest|weakest|meta|patch)\b/i.test(
    entities.effects.join(' '),
  )
  if (isBroadHeroQ || (entities.hero && isComparisonQ)) {
    const heroNames = store.getHeroNames()
    const heroCounts = heroNames.map((h) => {
      const items = store.byHero(h)
      return `${h} (${items.length} items)`
    })
    if (heroCounts.length > 0) sections.push(`Heroes: ${heroCounts.join(', ')}`)
  }

  // per-card patch deltas. the dump gives current stats but never what changed, and on
  // drop day it hasn't even absorbed the new numbers — so the overlay line is the
  // authority where the two disagree. exact-name match only, so it can't mislabel a card.
  const fresh = isOverlayFresh()
  const dbBehind = fresh && resolvePatch(getPatchInfo()).dbBehind
  let sawChange = false
  for (const card of entities.cards) {
    const line = serializeCard(card)
    const change = fresh ? getCardChange(card.Title) : null
    if (change) sawChange = true
    sections.push(change ? `${line}\nPatch ${OVERLAY.version} change to ${card.Title}: ${change.text}` : line)
  }
  if (sawChange && dbBehind) {
    sections.push(
      `NOTE: the stat lines above come from a card database still on the previous patch. Where a "Patch ${OVERLAY.version} change" line disagrees with them, the patch line is correct.`,
    )
  }

  for (const monster of entities.monsters) {
    sections.push(serializeMonster(monster))
  }

  // "what changed for vanessa this patch" — only on a patch-shaped ask, capped so a
  // hero with a dozen changes can't swallow the context budget.
  if (entities.hero && fresh && /\b(patch|change[ds]?|nerf(ed|s)?|buff(ed|s)?|new|update[ds]?)\b/i.test(entities.effects.join(' '))) {
    const hc = getHeroChanges(entities.hero)
    if (hc.length > 0) {
      const shown = hc.slice(0, 8)
      sections.push(
        `Patch ${OVERLAY.version} changes for ${entities.hero}${hc.length > shown.length ? ` (${shown.length} of ${hc.length})` : ''}:\n${shown.map((c) => `- ${c.card}: ${c.text}`).join('\n')}`,
      )
    }
  }

  if (entities.hero) {
    const heroItems = store.byHero(entities.hero)
    if (heroItems.length > 0) {
      if (isComparisonQ || heroItems.length > 30) {
        const tagCounts = new Map<string, number>()
        for (const c of heroItems) {
          for (const t of c.DisplayTags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
          for (const t of c.HiddenTags) {
            if (!t.endsWith('Reference')) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
          }
        }
        const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
        sections.push(`${entities.hero} (${heroItems.length} items): ${sorted.map(([t, n]) => `${t}(${n})`).join(', ')}`)
        const exclusive = heroItems.filter((c) => !c.Heroes.includes('Common'))
        const sample = exclusive.slice(0, 5)
        for (const card of sample) sections.push(serializeCard(card))
      } else {
        sections.push(`${entities.hero} items: ${heroItems.map((c) => c.Title).join(', ')}`)
      }
    }
  }

  if (entities.tag) {
    const tagItems = store.byTag(entities.tag).slice(0, 15)
    if (tagItems.length > 0) {
      sections.push(`${entities.tag} items: ${tagItems.map((c) => c.Title).join(', ')}`)
    }
  }

  if (entities.day != null) {
    const mobs = store.monstersByDay(entities.day)
    if (mobs.length > 0) {
      sections.push(`Day ${entities.day}: ${mobs.map((m) => `${m.Title} (${m.MonsterMetadata.health}HP)`).join(', ')}`)
    }
  }

  if (entities.effects.length > 0) {
    const noNamedEntities = entities.cards.length === 0 && entities.monsters.length === 0
    const effectResults = store.searchByEffect(entities.effects.join(' '), entities.hero, noNamedEntities ? 3 : 5)
    if (effectResults.length > 0) {
      if (noNamedEntities || entities.hero) {
        const already = new Set(entities.cards.map((c) => c.Title))
        for (const card of effectResults) {
          if (!already.has(card.Title)) sections.push(serializeCard(card))
        }
      } else {
        sections.push(`Items with ${entities.effects.join('/')}: ${effectResults.map((c) => c.Title).join(', ')}`)
      }
    }
  }

  if (entities.chatQuery && channel) {
    const hits = db.searchChatFTS(channel, `"${entities.chatQuery}"`, 10)
    if (hits.length > 0) {
      sections.push(`Chat search "${entities.chatQuery}":\n${hits.map((h) => `[${h.created_at}] ${h.username.replace(/[:\n]/g, '')}: ${stripChatMessage(h.message)}`).join('\n')}`)
    }
  }

  let text = sections.join('\n')
  if (text.length > 2400) {
    const lastNl = text.lastIndexOf('\n', 2400)
    text = lastNl > 0 ? text.slice(0, lastNl) : text.slice(0, 2400)
  }
  return text
}
