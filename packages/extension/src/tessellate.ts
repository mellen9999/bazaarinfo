// Fill the dead gaps between adjacent card zones without ever overlapping them.
//
// Companion zones are exactly card-sized, so a hover that lands in the thin gap
// between two cards hits nothing — and under a slightly-off calibration the real
// card sits a few percent from its zone, so near-misses are common. Extending
// each zone's edge to the midpoint of the gap with its neighbor removes the dead
// strip, so a small miss still lands on *a* zone.
//
// Overlap is worse than a gap: a gap shows no tooltip (safe), an overlap could
// show the WRONG card's tooltip (misinformation). So boundaries are always set
// to the split point between two zones — never past it — which also cleans up
// any overlap the companion itself sent. Growth into a large gap is capped so
// two genuinely far-apart cards don't balloon into each other's empty space.

interface Zone {
  x: number
  y: number
  w: number
  h: number
  owner?: string
  type?: string
}

const GAP_GROWTH_CAP = 0.6 // a zone may grow at most 60% of its own width per side

function sameRow(a: Zone, b: Zone): boolean {
  if ((a.owner ?? '') !== (b.owner ?? '')) return false
  if ((a.type ?? '') !== (b.type ?? '')) return false
  // vertical overlap — must share a band to be a horizontal neighbor, so the
  // player row never bleeds into the opponent row or the skill bar.
  const top = Math.max(a.y, b.y)
  const bot = Math.min(a.y + a.h, b.y + b.h)
  return bot - top > 0.25 * Math.min(a.h, b.h)
}

// Returns new zones with x/w adjusted; inputs are never mutated. Non-positional
// fields are preserved. Order of the returned array matches the input.
export function tessellate<T extends Zone>(zones: T[]): T[] {
  if (zones.length < 2) return zones
  const out = zones.map(z => ({ ...z }))
  // group indices by row
  const rows: number[][] = []
  for (let i = 0; i < out.length; i++) {
    const row = rows.find(r => sameRow(out[r[0]], out[i]))
    if (row) row.push(i)
    else rows.push([i])
  }
  for (const row of rows) {
    if (row.length < 2) continue
    row.sort((a, b) => out[a].x - out[b].x)
    for (let k = 0; k < row.length - 1; k++) {
      const a = out[row[k]]
      const b = out[row[k + 1]]
      const aRight = a.x + a.w
      const gap = b.x - aRight
      if (gap <= 0) {
        // touching or overlapping — split at the shared midpoint (removes overlap)
        const m = (aRight + b.x) / 2
        a.w = Math.max(0, m - a.x)
        const bRight = b.x + b.w
        b.x = m
        b.w = Math.max(0, bRight - m)
      } else {
        const half = gap / 2
        const aGrow = Math.min(half, a.w * GAP_GROWTH_CAP)
        const bGrow = Math.min(half, b.w * GAP_GROWTH_CAP)
        a.w = a.w + aGrow
        b.x = b.x - bGrow
        b.w = b.w + bGrow
      }
    }
  }
  return out
}

// Pull apart zones from different rows that overlap vertically, splitting the
// overlap at the shared midpoint — the vertical twin of tessellate.
//
// The item rows are quoted as socket-panel heights and the panels sit flush on
// screen, so the player row's top and the opponent row's bottom already cross by
// about a percent of frame height before any padding. That band runs across the top
// edge of every player card, and inside it whichever zone painted last wins the
// hover — i.e. the opponent's card tooltip over the player's card. A wrong tooltip
// is worse than no tooltip, so the rows are separated before anything grows.
export function separateRows<T extends Zone>(zones: T[]): T[] {
  if (zones.length < 2) return zones
  const out = zones.map(z => ({ ...z }))
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const a = out[i]
      const b = out[j]
      if (sameRow(a, b)) continue
      const [top, bot] = a.y <= b.y ? [a, b] : [b, a]
      const topBottom = top.y + top.h
      if (topBottom <= bot.y) continue // already disjoint
      // Never collapse a zone to nothing: a row fully swallowed by another is a
      // calibration failure, not an overlap to trim, and blanking it would lose the
      // card entirely. Leave it and let the caller's ordering decide.
      if (topBottom >= bot.y + bot.h || bot.y <= top.y) continue
      const m = (topBottom + bot.y) / 2
      top.h = m - top.y
      bot.h = bot.y + bot.h - m
      bot.y = m
    }
  }
  return out
}

// Grow each zone vertically by a capped margin so a hover a few percent above or
// below a card still lands. Complements tessellate (which forgives horizontal
// misses): together they absorb the small residual drift left after calibration
// and any per-card error in the companion's constants.
//
// The growth is clamped to the midpoint of the gap with the nearest zone above and
// below, so it can never reach into another row. That clamp is not just belt-and-
// braces: the player and opponent item rows are quoted as socket-panel heights, and
// those panels are flush against each other on screen — the raw boxes already touch
// (player top 0.5028, opponent bottom 0.5134), so unclamped padding put an opponent
// zone ~4% of frame height *inside* the top of every player card, and whichever
// painted last swallowed the hover. Overlap shows the WRONG card, which is worse
// than showing none, so a boundary is always the split point, never past it.
// Only y/h change.
export function padVertical<T extends { y: number; h: number }>(zones: T[], frac: number, cap: number): T[] {
  if (!zones.length) return zones
  return zones.map((z, i) => {
    const grow = Math.min(z.h * frac, cap)
    const bottom = z.y + z.h
    let ceil = 0
    let floor = 1
    for (let j = 0; j < zones.length; j++) {
      if (j === i) continue
      const o = zones[j]
      const oBottom = o.h > 0 ? o.y + o.h : o.y
      // Only zones in a different vertical band constrain us. Same-band zones (a
      // horizontal neighbour, or an overlapping duplicate) share this row's space.
      if (oBottom <= z.y && oBottom > ceil) ceil = (z.y + oBottom) / 2
      if (o.y >= bottom && o.y < floor) floor = (bottom + o.y) / 2
    }
    const top = Math.max(0, ceil, z.y - grow)
    const bot = Math.min(1, floor, bottom + grow)
    return { ...z, y: top, h: Math.max(0, bot - top) }
  })
}
