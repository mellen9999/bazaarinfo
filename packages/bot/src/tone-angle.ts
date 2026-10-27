// per-reply creative assignment for unhinged: a comedy "move" and a comparison "world",
// rotated so two replies in a row never share either. rules alone didn't stop the bot from
// circling one angle ("on loop", "same dart, same board") against a repeat target — handing
// it a fresh lane each time makes the variety structural instead of a plea. pure and
// leaf-level (no imports) so it is trivial to test and to probe.

const MOVES = [
  'fake-formal verdict, delivered like a court ruling or press release',
  'take their words absurdly literally and follow that through',
  'deadpan understatement of something enormous',
  'a compliment that turns out to be the insult',
  'a sudden, oddly specific scenario with a named, mundane detail',
  'flip their own logic back on them in one line',
  'mock sympathy, like a nature documentary narrator',
  'sincerely give terrible advice',
  'treat it as a tiny disaster being reviewed after the fact',
  'escalate one idea until it is ridiculous, then stop dead',
]
const WORLDS = [
  'cooking and restaurants', 'courtrooms and lawyers', 'space and astronomy', 'hospitals and medicine',
  'sports commentary', 'finance and banking', 'airports and travel', 'school and exams', 'office jobs',
  'wildlife and nature', 'construction and tools', 'weather', 'theater and movies', 'real estate', 'archaeology',
]

const last = new Map<string, { move: number; world: number }>()
const pick = (n: number, not: number | undefined): number => {
  let i = Math.floor(Math.random() * n)
  if (i === not) i = (i + 1 + Math.floor(Math.random() * (n - 1))) % n
  return i
}

/** the "this reply" line for a channel; never repeats the previous move or world there. */
export function nextAngle(channel: string): string {
  const ch = channel.toLowerCase()
  const prev = last.get(ch)
  const cur = { move: pick(MOVES.length, prev?.move), world: pick(WORLDS.length, prev?.world) }
  last.set(ch, cur)
  return `\nTHIS REPLY ONLY: move = ${MOVES[cur.move]}; comparison world = ${WORLDS[cur.world]}. use them if they fit, bend them if not, but never fall back on an angle from your last replies.`
}

export function __resetAngleForTest(): void {
  last.clear()
}
