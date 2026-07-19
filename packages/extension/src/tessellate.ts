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
