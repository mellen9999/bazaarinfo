// odds answers. bazaardb asked for credit + a link on every one, so both are built in here
// and no caller can forget them.
import type { ItemOdds, ShopOdds } from './types'

const pct = (p: number): string => {
  const v = p * 100
  return v >= 10 ? `${Math.round(v)}%` : v >= 1 ? `${Math.round(v * 10) / 10}%` : `${Math.round(v * 100) / 100}%`
}
const day = (d: string): string => `day ${d}`

// "airplane glue (stelle gold) shop chance: 0.54% d4 → 6.8% d10+ | best: ande 2%, ... | bazaardb.gg/card/…"
export function itemOddsLine(o: ItemOdds): string {
  const first = o.pAny.findIndex((p) => p > 0)
  if (first < 0) return `${o.name} (${o.hero.toLowerCase()} ${o.tier.toLowerCase()}) isn't in shops that day range | odds via bazaardb.gg${o.uri}`
  let peak = first
  o.pAny.forEach((p, i) => { if (p > o.pAny[peak]) peak = i })
  const span = peak === first ? `${pct(o.pAny[peak])} ${day(o.days[peak])}` : `${pct(o.pAny[first])} ${day(o.days[first])} → ${pct(o.pAny[peak])} ${day(o.days[peak])}`
  const best = o.top.length ? ` | best: ${o.top.map((m) => `${m.name} ${pct(m.peak)} ${day(m.day)}`).join(', ')}` : ''
  return `${o.name} (${o.hero.toLowerCase()} ${o.tier.toLowerCase()}) shop chance per day: ${span}${best} | odds via bazaardb.gg${o.uri}`
}

// "shop tiers d5: silver 75%, bronze 25%, gold 0.1%" — one day, or a spread when none asked
export function shopOddsLine(s: ShopOdds, wantDay?: number): string {
  const credit = 'odds via bazaardb.gg/shop-odds'
  const row = (d: number) => {
    const r = s.days.find((x) => x.day === d)
    if (!r) return ''
    const t = Object.entries(r.tiers).filter(([, v]) => v >= 0.1).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k.toLowerCase()} ${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}%`)
    return t.length ? `day ${d} ${t.join(' ')}` : ''
  }
  if (wantDay != null) {
    const r = row(wantDay)
    return r ? `shop tiers ${r} | ${credit}` : `no shop data for day ${wantDay} | ${credit}`
  }
  const spread = [1, 4, 7, 10].map(row).filter(Boolean)
  return spread.length ? `shop tiers: ${spread.join(' | ')} | ${credit}` : `no shop data | ${credit}`
}
