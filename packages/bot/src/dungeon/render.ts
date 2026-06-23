// every line the dungeon ever posts. terse mechanical one-liners by default; flavor only
// on highlight moments (special fire / boss phase / death / victory). one line per call.
import type { Run, Enemy, Hero, ForkOption } from './types'
import type { TurnResult } from './combat'

function telegraph(e: Enemy): string {
  switch (e.intent) {
    case 'heavy': return '⚠ winding up to STRIKE HARD'
    case 'special': return '⚠ readying something vicious'
    case 'guard': return 'bracing'
    default: return 'circling'
  }
}

function flavor(h: Hero, e: Enemy): string {
  return h.moveFlavor.replace(/\{enemy\}/g, e.name)
}

function heroState(h: Hero): string {
  return `hero ${Math.max(0, h.hp)}/${h.maxHp}${h.shield > 0 ? ` +${h.shield}sh` : ''} · sp×${h.special}`
}

function enemyLabel(e: Enemy): string {
  return e.isBoss ? `BOSS ${e.name}` : e.isElite ? `elite ${e.name}` : e.name
}

// the mid-fight action summary (enemy + hero both still standing)
function action(h: Hero, e: Enemy, res: TurnResult): string {
  if (res.special) {
    const f = flavor(h, e)
    if (h.specialKind === 'heal') return `✦ ${f} — heals ${res.healed}`
    if (h.specialKind === 'guard') return `✦ ${f} — shield ${res.shield}`
    if (h.specialKind === 'stun') return `✦ ${f} — ${res.heroDmg}, ${e.name} stunned!`
    return `✦ ${f} — ${res.heroDmg} dmg`
  }
  if (res.parried) return `🛡 PARRY! ${e.name}'s blow turned aside — it staggers`
  if (res.verb === 'defend') return `chat braces${res.enemyDmg ? ` (−${res.enemyDmg})` : ''}`
  // attack
  let s = res.staggeredHit ? `chat smashes the staggered ${e.name} for ${res.heroDmg}` : `chat strikes for ${res.heroDmg}`
  if (res.enemyDmg) s += `, takes ${res.enemyDmg}`
  return s
}

export function renderRecruit(): string {
  return `the gates of the Depths grind open. who descends? vote a hero. (~60s)`
}

export function renderHeroReveal(run: Run): string {
  const h = run.hero!, e = run.enemy!
  return `⚔ ${h.title} descends — ${h.blurb}. Floor 1: ${e.name} (${e.hp}hp), ${telegraph(e)}. → attack · defend · special · flee`
}

// mid-fight turn (enemy alive, hero alive, no flee). includes the boss phase-shift beat.
export function renderTurn(run: Run, res: TurnResult): string {
  const h = run.hero!, e = run.enemy!
  const head = `F${run.floor} ${action(h, e, res)}`
  const phase = res.bossPhase ? ` · ${e.name} ENRAGES — phase 2!` : ''
  return `${head}${phase} · ${heroState(h)} · ${enemyLabel(e)} ${Math.max(0, e.hp)}hp ${telegraph(e)} → vote`
}

export function renderFloorIntro(run: Run): string {
  const e = run.enemy!
  const lead = e.isBoss ? `Floor 5 — the ${enemyLabel(e)} looms` : `Floor ${run.floor}: ${enemyLabel(e)}`
  return `${lead} (${e.hp}hp), ${telegraph(e)}. → vote`
}

// fled this floor — one line that both reports the flee and introduces the next floor.
export function renderFled(run: Run, lost: number): string {
  const e = run.enemy!
  return `🏃 chat flees, banking HP (−${lost}). Floor ${run.floor}: ${enemyLabel(e)} (${e.hp}hp), ${telegraph(e)}. → vote`
}

export function renderCleared(run: Run, downed: string): string {
  const f = run.fork ?? []
  const opts = f.map((o: ForkOption) => `${o.n}) ${o.label}`).join(' · ')
  return `${downed} falls! Floor ${run.floor} cleared. a fork — ${opts}`
}

// a fork/advance outcome line: a short note + the next floor's intro (one line).
export function renderAdvance(run: Run, note: string): string {
  if (run.phase === 'over' || !run.enemy) return note
  return `${note} ${renderFloorIntro(run)}`
}

export function renderDeath(run: Run, killer: string): string {
  const h = run.hero!
  return `💀 ${h.title} falls on Floor ${run.floor} to ${killer}. the Depths claim another. type \`descend\` to brave it anew.`
}

export function renderVictory(run: Run, top: string[]): string {
  const h = run.hero!
  const credit = top.length ? ` — carried by ${top.join(', ')}` : ''
  return `🏆 ${h.title} SLAYS the boss — chat CONQUERS the Depths! a legendary day${credit}. type \`descend\` to go again.`
}

export function renderStatus(run: Run | null, record: number): string {
  const best = record > 0 ? `deepest ever: Floor ${record}` : 'no one has descended yet'
  if (!run || run.phase === 'idle' || run.phase === 'over') {
    return `the Depths lie silent — type \`descend\` to begin. ${best}.`
  }
  if (run.phase === 'recruiting') return `the Depths are choosing a hero — vote one. ${best}.`
  const h = run.hero, e = run.enemy
  if (!h) return `the Depths stir. ${best}.`
  const foe = e ? ` vs ${enemyLabel(e)} ${Math.max(0, e.hp)}hp (${telegraph(e)})` : ''
  return `Floor ${run.floor}: ${h.title} ${Math.max(0, h.hp)}/${h.maxHp}hp sp×${h.special}${foe}. ${best}.`
}
