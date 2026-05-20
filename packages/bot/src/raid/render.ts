import { truncate } from '@bazaarinfo/shared'
import type { RaidState, SimResult } from './types'
import type { VoteResult } from './state'

const DAY_OPEN = [
  'The Bazaar opens to fog and brine',
  'Lanterns flicker as dawn breaks over the gates',
  'A dry wind rolls through the market stalls',
  'The streets hum with the morning\'s first bargains',
  'Dusk gathers and the merchants light their wares',
  'Rain hisses on the cobbles outside the arena',
]

const WIN_VERBS = ['falls', 'is routed', 'is broken', 'is undone', 'is bested', 'collapses']
const LOSS_VERBS = ['breaks through', 'overwhelms the board', 'tears the line', 'cracks the formation', 'sends the party reeling']

function pick<T>(arr: T[], seed: number): T {
  return arr[Math.abs(seed) % arr.length]
}

export function renderResolution(
  raid: RaidState,
  result: SimResult,
  monsterTitle: string,
  namedPicks: Map<string, string>,
  vote: VoteResult | null,
  crowdBoost: number,
): string {
  const seed = raid.day * 31 + raid.raidId
  const won = result.winner === 'party'

  const open = `Day ${raid.day} · ${pick(DAY_OPEN, seed)}.`

  const arrivals: string[] = []
  let i = 0
  for (const [user, item] of namedPicks) {
    arrivals.push(`@${user} brings a ${item}`)
    if (++i >= 3) break
  }
  const arrivalLine = arrivals.length ? `${arrivals.join('. ')}. ` : ''

  const verb = won ? pick(WIN_VERBS, seed) : pick(LOSS_VERBS, seed)
  const mItem = result.monsterItems[0]
  const mFlavor = mItem ? ` ${mItem} answers` : ''
  const combatLine = won
    ? `The party meets the ${monsterTitle}.${mFlavor} — the ${monsterTitle} ${verb}.`
    : `The ${monsterTitle} ${verb}.${mFlavor ? ` Its ${mItem} cuts the line.` : ''}`

  // crowd: surface the tally whenever a vote happened. boost emphasis when lopsided.
  let crowdLine = ''
  if (vote) {
    const total = vote.winnerCount + vote.loserCount
    if (crowdBoost - 1 > 0.03) {
      crowdLine = ` The crowd roars (${vote.winnerCount}-${vote.loserCount}/${total}) and the party rallies.`
    } else if (total > 0) {
      crowdLine = ` The crowd splits (${vote.winnerCount}-${vote.loserCount}/${total}).`
    }
  }

  const hpStr = won ? '' : ` HP:${raid.hp}`
  const goldStr = won ? ` ${raid.gold}g` : ''
  const record = `${raid.wins}W-${raid.losses}L${hpStr}${goldStr}`

  const voteChoiceLine = vote ? ` Path: ${vote.winner.label}.` : ''
  let nextVote = ''
  if (raid.pendingVote) {
    const [a, b] = raid.pendingVote.options
    nextVote = ` · Next: !b vote ${a.label} | ${b.label}`
  }

  const full = `${open} ${arrivalLine}${combatLine}${voteChoiceLine}${crowdLine} [${record}]${nextVote}`
  return truncate(full)
}

export function renderParty(raid: RaidState, shopItems: Array<{ shopSlot: number; card: { Title: string } }>): string {
  const filled = raid.slots.filter((s) => s.username !== null)
  // slot owners + how many items they've stacked
  const slotStr = filled.map((s) => `@${s.username}(${s.boardItems.length})`).join(' ') || 'empty'
  const shopStr = shopItems.map((s) => `${s.shopSlot}:${s.card.Title}`).join(' ')
  const status = raid.status !== 'active' ? ` [${raid.status.toUpperCase()}]` : ''

  // pending vote tally
  let voteStr = ''
  if (raid.pendingVote) {
    const [a, b] = raid.pendingVote.options
    let ca = 0, cb = 0
    for (const v of raid.pendingVote.tally.values()) {
      if (v === a.label.toLowerCase()) ca++
      else if (v === b.label.toLowerCase()) cb++
    }
    voteStr = ` Vote: ${a.label} ${ca} / ${b.label} ${cb} ·`
  }

  return truncate(
    `[${raid.hero}${status}] D${raid.day} HP:${raid.hp} ${raid.wins}W-${raid.losses}L ${raid.gold}g · Party(${filled.length}/10): ${slotStr} ·${voteStr} Shop: ${shopStr} · !b join / !b pick <n>`,
  )
}

export function renderHistory(raid: RaidState): string {
  if (!raid.lastResolution) return 'no resolution yet this run — !b join to participate'
  return truncate(raid.lastResolution.narrative)
}

// 3 atmospheric intro openers; shop preview appended deterministically
const INTRO_OPENERS = [
  (hero: string, first: string) =>
    `🎺 ${hero} walks the Bazaar again. @${first} draws first blood for the party.`,
  (hero: string, first: string) =>
    `🎺 The lanterns flare. ${hero} has issued the call, and @${first} answers first.`,
  (hero: string, first: string) =>
    `🎺 Day 1 dawns. ${hero} walks the market with @${first} at their side.`,
]

export function renderIntro(raid: RaidState, firstUser: string, shop: Array<{ shopSlot: number; card: { Title: string } }>): string {
  const opener = INTRO_OPENERS[raid.raidId % INTRO_OPENERS.length](raid.hero, firstUser)
  // compact shop preview — first 6 items by name (room budget after opener + footer)
  const previewItems = shop.slice(0, 6).map((s) => `${s.shopSlot}:${s.card.Title}`).join(' · ')
  const footer = `Nine more swords welcome: !b join. Everyone else: !b vote to swing the fight. !b pick <n> for your slot.`
  return truncate(`${opener} Day 1 shop → ${previewItems} · !b shop for the full list. ${footer}`)
}
