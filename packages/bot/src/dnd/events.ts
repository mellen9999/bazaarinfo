// Event-floor encounters — variety, risk/reward, Kripp/Bazaar flavor. Pure module:
// all logic is here (seeded → deterministic given inputs); the engine just applies
// the returned deltas. Keeps event content testable and the engine thin.
import type { Character } from './types'

export type EventId = 'shrine' | 'altar' | 'gamble' | 'chest' | 'spring' | 'fountain'

export interface EventDef {
  id: EventId
  name: string
  intro: string  // narration on arrival; ends with what to type
}

// every event is reached via `!b explore`
export const EVENTS: Record<EventId, EventDef> = {
  shrine:   { id: 'shrine',   name: 'Ancient Shrine',   intro: "an ancient shrine hums with pale light. it judges what you carry. → !b explore to approach" },
  altar:    { id: 'altar',    name: 'Cursed Altar',     intro: "a cursed altar drips shadow. sacrifice 50g and its dark power is yours, permanently. → !b explore to offer" },
  gamble:   { id: 'gamble',   name: "Merchant's Gamble", intro: "a hooded merchant rattles loaded dice. 'feeling lucky, friend? 30g, double or nothing.' → !b explore to roll" },
  chest:    { id: 'chest',    name: 'Mysterious Chest',  intro: "a battered chest sits alone. could be loot. could be teeth. → !b explore to open" },
  spring:   { id: 'spring',   name: 'Healing Spring',    intro: "a clear spring bubbles, plant-based and pure. → !b explore to drink" },
  fountain: { id: 'fountain', name: 'Fountain of Power',  intro: "a fountain of raw power churns. drink deep and a new gift awaits. → !b explore to drink" },
}

const POOL: EventId[] = ['shrine', 'altar', 'gamble', 'chest', 'spring', 'fountain']

function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s |= 0; s = s + 0x6D2B79F5 | 0
    let t = Math.imul(s ^ s >>> 15, 1 | s)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

// deterministic event for an event floor. The shrine stays special-cased to floor 9
// (Kripp's vegan shrine is canon there); other event floors roll the wider pool.
export function pickEvent(season: number, floor: number): EventDef {
  if (floor === 9) return EVENTS.shrine                  // shrine is canon to floor 9 only
  const pool = POOL.filter((id) => id !== 'shrine')
  const rng = mulberry32(((season * 6151 + floor * 3083 + 17) >>> 0))
  return EVENTS[pool[Math.floor(rng() * pool.length)]]
}

export interface EventContext {
  char: Character
  hasMeat: boolean       // for the shrine's vegan judgment
  itemReward: string | null  // a tier-appropriate item the engine pre-rolled
}

export interface EventResult {
  message: string
  goldDelta: number       // applied to the explorer
  healAmount: number      // flat HP healed (engine clamps to maxHp)
  fullHeal: boolean
  grantItem: string | null
  boonOffer: boolean      // engine rolls a pick-1-of-3 offer
  blessed: boolean        // add 'blessed' status
  maxHpDelta: number      // permanent max-HP change (altar sacrifice)
}

function blank(message: string): EventResult {
  return { message, goldDelta: 0, healAmount: 0, fullHeal: false, grantItem: null, boonOffer: false, blessed: false, maxHpDelta: 0 }
}

// resolve an event. seed makes gambles/chests deterministic per (season, floor, user).
export function resolveEvent(ev: EventDef, ctx: EventContext, seed: number): EventResult {
  const rng = mulberry32(seed >>> 0)
  const { char } = ctx

  switch (ev.id) {
    case 'shrine': {
      if (!ctx.hasMeat) {
        return { ...blank(`the shrine pulses for @${char.username}. "worthy." full heal + blessed. plant-based and pure.`), fullHeal: true, blessed: true }
      }
      return blank(`the shrine recoils from @${char.username}'s tainted, meat-tinged pack. "no luck." the blessing is denied.`)
    }

    case 'altar': {
      const cost = 50
      if (char.gold < cost) return blank(`the Cursed Altar demands ${cost}g (you have ${char.gold}g). it stays dormant.`)
      return { ...blank(`@${char.username} sacrifices ${cost}g to the Cursed Altar — dark power surges. +8 max HP, permanently.`), goldDelta: -cost, maxHpDelta: 8 }
    }

    case 'gamble': {
      if (char.gold < 30) return blank(`@${char.username} can't cover the 30g ante. the merchant tuts. "no value, no game."`)
      const win = rng() < 0.5
      if (win) {
        return { ...blank(`@${char.username} rolls... WINS! 30g becomes 75g. ACTUALLY SICK. (+45g net)`), goldDelta: 45 }
      }
      return { ...blank(`@${char.username} rolls... no luck. the merchant pockets the 30g. (-30g)`), goldDelta: -30 }
    }

    case 'chest': {
      if (rng() < 0.7 && ctx.itemReward) {
        return { ...blank(`@${char.username} opens the chest — [${ctx.itemReward}] inside! not bad value.`), grantItem: ctx.itemReward }
      }
      const bite = 4 + Math.floor(rng() * 6)
      return { ...blank(`@${char.username} opens the chest — MIMIC! it chomps for ${bite} dmg before fleeing.`), healAmount: -bite }
    }

    case 'spring': {
      const heal = Math.max(10, Math.floor(char.maxHp * 0.5))
      return { ...blank(`@${char.username} drinks from the spring — restored ${heal}HP. plant-based, naturally.`), healAmount: heal }
    }

    case 'fountain': {
      return { ...blank(`@${char.username} drinks from the Fountain of Power — a new gift stirs within. choose it.`), boonOffer: true }
    }
  }
}
