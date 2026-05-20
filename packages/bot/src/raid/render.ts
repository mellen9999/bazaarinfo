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
  const mFlavor = mItem ? ` ${mItem} strikes` : ''
  const combatLine = won
    ? `The party meets the ${monsterTitle}.${mFlavor} — the ${monsterTitle} ${verb}.`
    : `The ${monsterTitle} ${verb}.${mFlavor ? ` Its ${mItem} cuts the line.` : ''}`

  // crowd impact: only narrate when meaningful (>3% swing).
  let crowdLine = ''
  if (vote && crowdBoost - 1 > 0.03) {
    const total = vote.winnerCount + vote.loserCount
    crowdLine = ` The crowd's roar lifts the party (${vote.winnerCount}-${vote.loserCount}/${total}).`
  }

  const hpStr = won ? '' : ` HP:${raid.hp}`
  const record = `${raid.wins}W-${raid.losses}L${hpStr}`

  const voteChoiceLine = vote ? ` Chose: ${vote.winner.label}.` : ''
  let nextVote = ''
  if (raid.pendingVote) {
    const [a, b] = raid.pendingVote.options
    nextVote = ` Next: !b vote ${a.label} | ${b.label}`
  }

  const full = `${open} ${arrivalLine}${combatLine}${voteChoiceLine}${crowdLine} [${record}]${nextVote}`
  return truncate(full)
}

export function renderParty(raid: RaidState, shopItems: Array<{ shopSlot: number; card: { Title: string } }>): string {
  const filled = raid.slots.filter((s) => s.username !== null)
  const slotStr = filled.map((s) => `@${s.username}`).join(', ') || 'empty'
  const shopStr = shopItems.map((s) => `${s.shopSlot}:${s.card.Title}`).join(', ')
  const status = raid.status !== 'active' ? ` [${raid.status.toUpperCase()}]` : ''
  return truncate(
    `[${raid.hero}]${status} Day${raid.day} HP:${raid.hp} ${raid.wins}W-${raid.losses}L | Party(${filled.length}/10): ${slotStr} | Shop: ${shopStr} | !b join / !b pick <n>`,
  )
}

export function renderHistory(raid: RaidState): string {
  if (!raid.lastResolution) return 'no resolution yet this run — !b join to participate'
  return truncate(raid.lastResolution.narrative)
}

const INTRO_TEMPLATES = [
  (hero: string, first: string) =>
    `A horn sounds — ${hero} walks the market again. @${first} steps in first. !b join for a slot (10 max), !b party to see today's shop, !b pick <n> to commit your item. Townsfolk: !b vote — lopsided turnout can flip combat. Day 1 resolves when half the party picks, or in 10min.`,
  (hero: string, first: string) =>
    `A new run begins under ${hero}. @${first} answers the call first. Up to 10 take slots (!b join), the rest become townsfolk who !b vote on the path. !b party to peek the shop, !b pick <n> to commit. First combat fires on threshold or after 10min.`,
  (hero: string, first: string) =>
    `The Bazaar reopens. ${hero} surveys the stalls; @${first} stands ready. 9 slots remain — !b join. Everyone else: !b vote to sway the fight (one tipping vote can decide it). !b party for the shop, !b pick <n> to lock your item.`,
]

export function renderIntro(raid: RaidState, firstUser: string): string {
  const tpl = INTRO_TEMPLATES[raid.raidId % INTRO_TEMPLATES.length]
  return truncate(tpl(raid.hero, firstUser))
}
