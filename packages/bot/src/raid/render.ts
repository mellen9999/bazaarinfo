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
    `🎺 A new run begins. ${hero} walks the Bazaar — @${first} draws first blood for the party. Nine more swords welcome: !b join. The rest of chat IS the crowd — lopsided votes can flip a fight. !b party for today's shop. First combat in ~10min, or when half the party picks.`,
  (hero: string, first: string) =>
    `🎺 The lanterns flare. ${hero} has issued the call, and @${first} answers first. Nine more can take up arms: !b join. Everyone else — you ARE the city, and the crowd decides where the party walks. !b vote to steer the fight. First combat soon. !b party for the shop.`,
  (hero: string, first: string) =>
    `🎺 Day 1 dawns. ${hero} walks the market with @${first} at their side. Nine more swords waiting: !b join. The rest of chat is the crowd — your !b vote can swing a close fight. !b party to see what's for sale. First fight in ~10min.`,
]

export function renderIntro(raid: RaidState, firstUser: string): string {
  const tpl = INTRO_TEMPLATES[raid.raidId % INTRO_TEMPLATES.length]
  return truncate(tpl(raid.hero, firstUser))
}
