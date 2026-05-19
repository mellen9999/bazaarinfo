import { truncate } from '@bazaarinfo/shared'
import type { RaidState, SimResult } from './types'

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
  voteWinner?: string,
): string {
  const seed = raid.day * 31 + raid.raidId
  const won = result.winner === 'party'

  const open = `Day ${raid.day} · ${pick(DAY_OPEN, seed)}.`

  // 2-3 named arrivals
  const arrivals: string[] = []
  let i = 0
  for (const [user, item] of namedPicks) {
    arrivals.push(`@${user} brings a ${item}`)
    if (++i >= 3) break
  }
  const arrivalLine = arrivals.length ? `${arrivals.join('. ')}. ` : ''

  // combat beat
  const verb = won ? pick(WIN_VERBS, seed) : pick(LOSS_VERBS, seed)
  const mItem = result.monsterItems[0]
  const mFlavor = mItem ? ` ${mItem} strikes` : ''
  const combatLine = won
    ? `The party meets the ${monsterTitle}.${mFlavor} — the ${monsterTitle} ${verb}.`
    : `The ${monsterTitle} ${verb}.${mFlavor ? ` Its ${mItem} cuts the line.` : ''}`

  // run state
  const hpStr = won ? '' : ` HP:${raid.hp}`
  const record = `${raid.wins}W-${raid.losses}L${hpStr}`

  // vote outcome (last day) + new vote prompt (next day)
  let voteLine = ''
  if (voteWinner) voteLine = ` Chose: ${voteWinner}.`
  let nextVote = ''
  if (raid.pendingVote) {
    const [a, b] = raid.pendingVote.options
    nextVote = ` Next: !b vote ${a.label} | ${b.label}`
  }

  const full = `${open} ${arrivalLine}${combatLine}${voteLine} [${record}]${nextVote}`
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
