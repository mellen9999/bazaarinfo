// in-memory per-channel vote tally for the currently-open window. transient — never
// persisted (a restart mid-window just reopens). one vote per user (last wins), so no
// single spammer can stack a window.
const tallies = new Map<string, Map<string, string>>() // channel -> (user -> choice)

export function castVote(channel: string, user: string, choice: string): void {
  let t = tallies.get(channel)
  if (!t) { t = new Map(); tallies.set(channel, t) }
  t.set(user.toLowerCase(), choice)
}

export function voteCount(channel: string): number {
  return tallies.get(channel)?.size ?? 0
}

// winner among a FIXED option set (verbs / fork numbers). ties broken by `order` (earlier
// option wins) for deterministic resolution. null when there are no votes for any option.
export function tallyWinner(channel: string, order: string[]): { choice: string; count: number; total: number } | null {
  const t = tallies.get(channel)
  if (!t || t.size === 0) return null
  const counts = new Map<string, number>()
  for (const c of t.values()) counts.set(c, (counts.get(c) ?? 0) + 1)
  let best: string | null = null
  let bestN = 0
  for (const opt of order) {
    const n = counts.get(opt) ?? 0
    if (n > bestN) { bestN = n; best = opt }
  }
  return best === null ? null : { choice: best, count: bestN, total: t.size }
}

// top free-text suggestions by count (for the archetype blend). desc by votes.
export function topChoices(channel: string, n: number): { choice: string; count: number }[] {
  const t = tallies.get(channel)
  if (!t || t.size === 0) return []
  const counts = new Map<string, number>()
  for (const c of t.values()) counts.set(c, (counts.get(c) ?? 0) + 1)
  return [...counts.entries()]
    .map(([choice, count]) => ({ choice, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n)
}

// users who voted a given choice this window (for kill-credit attribution).
export function votersFor(channel: string, choice: string): string[] {
  const t = tallies.get(channel)
  if (!t) return []
  const out: string[] = []
  for (const [user, c] of t) if (c === choice) out.push(user)
  return out
}

export function clearVotes(channel: string): void {
  tallies.delete(channel)
}
