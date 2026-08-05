// hand-maintained patch overlay.
//
// bazaardb's dump stays the source of truth for *current* card stats, but it lags a
// patch drop by hours-to-days, and it never records what actually CHANGED. this file
// closes both gaps: it floors the reported latest version so the bot isn't confidently
// a patch behind on drop day, and it indexes the per-card deltas so "did X get nerfed"
// is answerable from real data instead of guessed.
//
// maintenance: when the next patch lands, replace the OVERLAY block wholesale. stale
// entries here are harmless for stats (the dump wins on numbers) but the delta text is
// only true for the patch it describes — one patch at a time, never accumulate.

import type { PatchInfo } from './patch'

export interface PatchChange {
  card: string
  hero: string
  text: string
}

export interface PatchOverlay {
  version: string
  name: string
  /** "Aug 5" — same shape as PatchInfo.patchDate */
  date: string
  /** ISO release date; used to age the overlay out rather than trusting it forever */
  released: string
  headline: string
  /** heroes shipped in this patch that the dump may not list yet */
  newHeroes: string[]
  /** general / meta bullets, terse enough to drop straight into a 480-char reply */
  notes: string[]
  changes: PatchChange[]
}

export const OVERLAY: PatchOverlay = {
  version: '17.0',
  name: 'Roughtown Rockstars',
  date: 'Aug 5',
  released: '2026-08-05',
  headline:
    "patch 17.0 Roughtown Rockstars (aug 5 2026): the Dragons expansion — 120+ items, skills and encounters, a new hero (the Dragons), and the Instrument item type.",
  newHeroes: ['The Dragons'],
  notes: [
    'new hero: the Dragons — a band. paid now, free for everyone after the Bazaar mobile launch (no ETA). buying before then earns a Founders skin later.',
    'new item type: Instrument. Bagpipes, Ganjo, Jabalian Drum and Piano all gained the Instrument type.',
    'new encounters: Uitar Center (Dragons only, sells Instruments), Equipment Van (Dragons only, grants an Instrument), Mama Bear (Dragons only, unique skill trainer), Ledger (Pyg only, improves properties), the Dragons merchant (every other hero, sells Dragons items).',
    'max health gained from leveling is now capped at 800 — mostly bites from level 12 on.',
    'gold-tier items were over-nerfed last season: the ramp now starts higher and catches back up to old values by day 9-10. days 6-8 are still down.',
    'Golden enchant on value-gain items now buffs the value GAIN instead of the item’s own value.',
    'season 17 started. season 16 leaderboard rewards are the Annexian Invasion titles (Champion top 10, Paragon top 100, Elite top 1000).',
    'prize pass: Machine Dreams carpet + Secrets of Shred Mak skin. chests: Heavy Metal Stelle skin and Dragons item skins.',
    'tournament mode is still test-only — it lives on a Steam public-test branch with its own separate account, access code is in the official patch notes. streamers are free to show it.',
    'the Cult encounter can now be declined, but declining gives no XP.',
    'Prospero no longer spawns Golden items. Wishing Fountain has slightly better odds on high-value items. Likit can now show up on days 2-5 instead of only day 2. Pyg can see Pol from day 4.',
    'monster changes: Yerdan is now diamond-tier with a whole new board. Ahexa dropped to silver Solar Farm. Drone Operator gained Pyrotechnic Drone, Ghost Pepper gained Dragon Lighter, Harkuvian Rocket Trooper gained Sparkler, Weapons Platform gained Power Bank, Stew gained Dragon’s Breath Mints, Street Gamer gained Rin Chibi, Product Demonstrator gained the It Still Works skill.',
  ],
  changes: [
    // monsters + encounters (hero: 'Monster'/'Encounter' — not hero-scoped, so they never
    // show up in a "what changed for <hero>" answer, only on a direct lookup)
    { card: 'Yerdan', hero: 'Monster', text: 'now diamond-tier with a new board: Tournament Arena (D), Yo-Yo (D), Obsidian Premium Red + Green Piggles (D), Shielded Piggles Launcher (G), Streaming Setup (G)' },
    { card: 'Ahexa', hero: 'Monster', text: 'nerf: its Solar Farm is now silver-tier (was gold)' },
    { card: 'Drone Operator', hero: 'Monster', text: 'gained Pyrotechnic Drone, replacing Lightning Butterfly' },
    { card: 'Ghost Pepper', hero: 'Monster', text: 'gained Dragon Lighter (replacing Lighter) and lost its Fiery skill' },
    { card: 'Harkuvian Rocket Trooper', hero: 'Monster', text: 'gained Sparkler, replacing Eagle Talisman' },
    { card: 'Weapons Platform', hero: 'Monster', text: 'gained Power Bank, replacing Battery' },
    { card: 'Stew', hero: 'Monster', text: 'gained Dragon’s Breath Mints, replacing Curry' },
    { card: 'Street Gamer', hero: 'Monster', text: 'gained Rin Chibi' },
    { card: 'Product Demonstrator', hero: 'Monster', text: 'gained the It Still Works skill — the first 1/2 times your items are destroyed, it repairs them' },
    { card: 'Likit', hero: 'Encounter', text: 'can now spawn on days 2-5 (was day 2 only)' },
    { card: 'Pol', hero: 'Encounter', text: 'Pyg can now see Pol from day 4 on' },
    { card: 'Prospero', hero: 'Encounter', text: 'no longer spawns Golden items — stops the strange item rolls' },
    { card: 'Wishing Fountain', hero: 'Encounter', text: 'slightly better odds of finding higher-value items' },
    { card: 'The Cult', hero: 'Encounter', text: 'you can decline it now, but declining gives no XP' },
    { card: 'Advanced Training', hero: 'Encounter', text: 'can now add an Instrument' },
    { card: 'Chronos', hero: 'Encounter', text: 'fixed: this merchant sometimes spawned the wrong number of items' },
    { card: 'Cobweb', hero: 'Encounter', text: 'fixed: this merchant sometimes spawned the wrong number of items' },
    { card: 'Freiya', hero: 'Encounter', text: 'fixed: this merchant sometimes spawned the wrong number of items' },
    { card: 'Hef', hero: 'Encounter', text: 'fixed: this merchant sometimes spawned the wrong number of items' },
    { card: 'Knightshade', hero: 'Encounter', text: 'fixed: this merchant sometimes spawned the wrong number of items' },

    // common
    { card: 'Cosmic Amulet', hero: 'Common', text: 'enchants now trigger off Crit or Flying item use' },
    { card: 'Coupon', hero: 'Common', text: 'fixed: it used to work on Nufu' },
    { card: 'Foundation Robe', hero: 'Common', text: 'enchants now reference your Regen instead of the target’s damage — kills several infinite recursions' },

    // dooley
    { card: 'Armored Core', hero: 'Dooley', text: 'nerf: base shield 30/60/120 (was 40/80/160)' },
    { card: 'Bellelista', hero: 'Dooley', text: 'buff: cooldown 6s (was 8s)' },
    { card: 'Chemsnail', hero: 'Dooley', text: 'starts gold now. slows 1/2 items (was 1/2/3), poison 6/12 (was 4/6)' },
    { card: 'Cybersecurity', hero: 'Dooley', text: 'gained the Tech type' },
    { card: 'Hologram Projector', hero: 'Dooley', text: 'buff: can now transform into legendaries' },
    { card: 'Power Drill', hero: 'Dooley', text: 'starts silver now. cooldown 10/8/6 (was 12/10/8/6)' },
    { card: 'Rampage Module', hero: 'Dooley', text: 'nerf: damage buff 6/12/18 (was 7/14/21)' },
    { card: 'Remote Control', hero: 'Dooley', text: 'nerf: cooldown 8/7/6 (was 7/6/5)' },
    { card: 'Solar Farm', hero: 'Dooley', text: 'starts silver now. cooldown 8/7/6 (was 7/6), regen 10/20/30 (was 10/20), haste flat 1s (was 1/2)' },
    { card: 'Weaponized Core', hero: 'Dooley', text: 'nerf: base damage 30/60/120 (was 40/80/160)' },

    // karnok
    { card: 'Burning Temper', hero: 'Karnok', text: 'skill fixed: +5/10/15/20 burn while enraged (was wrongly 3/6/9/12)' },
    { card: 'Piercing Rage', hero: 'Karnok', text: 'skill buff: damage buff 10/20/40/80 (was 10/20/30/40)' },
    { card: 'Piercing Temper', hero: 'Karnok', text: 'skill buff: damage buff 20/40/80/160 (was 20/40/60/80)' },
    { card: 'Aurora Vista', hero: 'Karnok', text: 'starts silver now. cooldown flat 4s, crit chance 20/30/40 (was flat 20)' },
    { card: 'Beast Call', hero: 'Karnok', text: 'starts silver now. hastes a Friend AND the items adjacent to it for 1/2/3s (was just adjacent friends)' },
    { card: 'Black Mamba', hero: 'Karnok', text: 'big buff: poison 3/6/9/12 (was 1)' },
    { card: 'Bagpipes', hero: 'Karnok', text: 'gained the Instrument type' },
    { card: 'Honey Badger', hero: 'Karnok', text: 'buff: cooldown 6/5/4/3 (was 7/6/5/4)' },
    { card: 'Outlands Terror', hero: 'Karnok', text: 'starts silver now. cooldown 8/7/6, damage 200/400/800 (was 300/600). enraged now gives lifesteal + half cooldown' },
    { card: 'Rope', hero: 'Karnok', text: 'buff: cooldown 4s (was 5s)' },
    { card: 'Shotgun', hero: 'Karnok', text: 'starts bronze now, damage 20/40/80/160 (was 30/60/120)' },
    { card: 'Tranquil Sigil', hero: 'Karnok', text: 'reworked: heal gives 4/6/8 rage (was flat 8), enrage gives items +50/100/150 heal (was a % of max hp)' },
    { card: 'Utility Belt', hero: 'Karnok', text: 'rebuilt: bronze, 4s cooldown, reloads an item, adjacent items get 3/6/9/12% cooldown reduction' },

    // jules
    { card: 'Apron', hero: 'Jules', text: 'cooldown 6s (was 7), shield 20 (was 40), and it now scales +10/20/40/80 shield when you USE a food (was sell)' },
    { card: 'Attachment Set', hero: 'Jules', text: 'now shields when you use any Tool (was weapon tools only)' },
    { card: 'Baked Potato', hero: 'Jules', text: 'cooldown 6s (was 4), multicast 2 (was 1), heated is now -2s cooldown (was +1 multicast)' },
    { card: 'Birthday Cake', hero: 'Jules', text: 'base crit 25% (was 30), and it gains +5/10/15/20% crit per DAY of the run — buy it silver on day 5 and it’s already +50%' },
    { card: 'Blueberry Pie', hero: 'Jules', text: 'buff: cooldown 4s (was 5), shield 25/50/100/200 (was 20/40/80/160)' },
    { card: 'Chopsticks', hero: 'Jules', text: 'starts silver now. cooldown flat 6s, damage 10 (was 5), multicast 2/3/4 (was 2)' },
    { card: 'Decanter', hero: 'Jules', text: 'buff: chilled now cuts 2s of cooldown (was 1s)' },
    { card: 'Durian', hero: 'Jules', text: 'big buff: shield 20/40/80/160 (was 10/20/40/80)' },
    { card: 'Excellent Vintage', hero: 'Jules', text: 'buff: cooldown 6s (was 7s)' },
    { card: 'Jambalaya', hero: 'Jules', text: 'starts bronze now. burn 1/2/3/4 (was 2/4/6), no longer regens — gaining regen now gives this and another item +1/2/3/4 burn for the fight' },
    { card: 'Pancakes', hero: 'Jules', text: 'cooldown 6s (was 4), multicast 2 (was 1), heated is now -2s cooldown (was +1 multicast)' },

    // mak
    { card: 'Bloodthirst', hero: 'Mak', text: 'skill buff: damage buff 15/30/60/120 (was 20/30/40/50)' },
    { card: 'Apothecary', hero: 'Mak', text: 'buff: now also charges on Freeze' },
    { card: 'Barbed Claws', hero: 'Mak', text: 'buff: cooldown 5s (was 6s)' },
    { card: 'Cloud Wisp', hero: 'Mak', text: 'buff: cooldown 4s (was 5s)' },
    { card: 'Goop Flail', hero: 'Mak', text: 'big buff: damage 10 (was 1)' },
    { card: 'Infused Bracers', hero: 'Mak', text: 'buff: flat 4s cooldown at every tier (was 6/5/4)' },
    { card: 'Mirror', hero: 'Mak', text: 'buff: can now transform into legendaries' },
    { card: 'Pendulum', hero: 'Mak', text: 'starts gold now, charge 1/1.5 (was flat 1)' },
    { card: 'Runic Daggers', hero: 'Mak', text: 'starts gold now. flat 4s cooldown, damage 20/40 (was 10)' },
    { card: 'Staff of the Wise', hero: 'Mak', text: 'buff: cooldown 9s (was 10s)' },
    { card: 'Viper Cane', hero: 'Mak', text: 'buff: cooldown 4s (was 6s), damage 10/20/40 (was flat 10)' },
    { card: 'Vitality Potion', hero: 'Mak', text: 'enchants now scale off the item’s heal — roughly double at diamond' },

    // pygmalien
    { card: 'Apropos Chapeau', hero: 'Pygmalien', text: 'buff: cooldown 6s (was 7), scaling 10/20/30 (was 6/9/12)' },
    { card: 'Dragon Tooth', hero: 'Pygmalien', text: 'reworked: starts silver, 5s cooldown (was 10), 10 damage. each fight it spends 3 gold to permanently give your weapons +4/8/12 damage, and it now tracks the total' },
    { card: 'Ganjo', hero: 'Pygmalien', text: 'gained the Instrument type. cooldown 4s (was 5), buffs 10/20/30/40 (was 10/15/20/25)' },
    { card: 'Golf Clubs', hero: 'Pygmalien', text: 'buff: damage scaling 10/20/40/80 (was 10/20/30/40) and it now also triggers off Slow, not just heal' },
    { card: 'Jabalian Drum', hero: 'Pygmalien', text: 'gained the Instrument type' },
    { card: 'Laser Security System', hero: 'Pygmalien', text: 'starts gold now. damage 50 (was 20), cooldown 7/6 (was 9/8/7), and it scales off Relic use too, not just properties' },
    { card: 'Lemonade Stand', hero: 'Pygmalien', text: 'gained the Food type' },
    { card: 'Piggles Launcher', hero: 'Pygmalien', text: 'buff: cooldown 6s (was 7s)' },
    { card: 'Skyscraper', hero: 'Pygmalien', text: 'cooldown flat 9s (was 10/8). also gained a Golden enchant' },
    { card: 'Spacescraper', hero: 'Pygmalien', text: 'cooldown flat 5s (was 6/5). also gained a Golden enchant' },
    { card: 'Subscraper', hero: 'Pygmalien', text: 'buff: cooldown 6s (was 7s)' },
    { card: 'Spiky Shield', hero: 'Pygmalien', text: 'reworked: flat 6s cooldown (was 9/8/7/6), shield 20/40/80/160 (was flat 40)' },
    { card: 'Truffles', hero: 'Pygmalien', text: 'buff: value buff 1/2/4/8 (was 1/2/3/4)' },
    { card: 'Hypergreens', hero: 'Pygmalien', text: 'gained a missing Golden enchant' },
    { card: 'Premium Piggles', hero: 'Pygmalien', text: 'gained a missing Golden enchant' },
    { card: 'Riceballer', hero: 'Pygmalien', text: 'gained a missing Golden enchant' },
    { card: 'Sponsored Apparel', hero: 'Pygmalien', text: 'gained a missing Golden enchant' },
    { card: 'Streaming Setup', hero: 'Pygmalien', text: 'gained a missing Golden enchant' },
    { card: 'Investment Pitch', hero: 'Pygmalien', text: 'now enchants your leftmost item Golden instead of doubling your income' },

    // stelle
    { card: 'Expert Pilot', hero: 'Stelle', text: 'skill buff: buffs 10/20/40/80 (was 10/20/30/40)' },
    { card: 'Airplane Glue', hero: 'Stelle', text: 'nerf: buffs 8/16/24/32 (was 10/20/30/40). timing also made consistent' },
    { card: 'Chicken Cannon', hero: 'Stelle', text: 'starts silver now' },
    { card: 'Compass', hero: 'Stelle', text: 'starts silver now' },
    { card: 'Flare Gun', hero: 'Stelle', text: 'nerf: burn 5 (was 10)' },
    { card: 'Observatory', hero: 'Stelle', text: 'enchants now trigger off adjacent OR flying item use' },
    { card: 'Portable Shield Generator', hero: 'Stelle', text: 'reworked: starts gold, charges adjacent shield items 1/2s instead of shielding 10, scaling 10/15 (was 6/12/18)' },
    { card: 'Ramming Balloon', hero: 'Stelle', text: 'reworked: starts bronze and starts the fight FLYING. 20 damage base, +10/20/40/80 per shield (was 15/30/60)' },
    { card: 'Security Drone', hero: 'Stelle', text: 'flat 5s cooldown (was 8/7/6/5) and it now starts each fight flying instead of getting -2s while flying' },
    { card: 'Solar Drone', hero: 'Stelle', text: 'big buff: cooldown 4s (was 6), starts flying, shield 10/20/40/80 (was flat 10), burn 1/2/3/4' },
    { card: 'Squirrel Suit', hero: 'Stelle', text: 'timing fixed so it lines up with same-cooldown items (same fix hit Bird Cage, Airplane Glue and Tugboat)' },
    { card: 'Weather Machine', hero: 'Stelle', text: 'cooldown 5/4/3 (was flat 5) but freeze and slow no longer scale their duration' },
    { card: 'Bird Cage', hero: 'Stelle', text: 'start/stop timing fixed to match same-cooldown items' },
    { card: 'Tugboat', hero: 'Stelle', text: 'start/stop timing fixed to match same-cooldown items' },

    // vanessa
    { card: 'Barrel', hero: 'Vanessa', text: 'big buff: base shield 30 (was 10), scaling 15/30/60/120 (was 10/20/40/80)' },
    { card: 'Cannonade', hero: 'Vanessa', text: 'nerf: damage 200/300 (was 200/400)' },
    { card: 'Cove', hero: 'Vanessa', text: 'buff: +1/2/3/4 value per item sold (was 1/1/1/2)' },
    { card: 'Cyber-Sai', hero: 'Vanessa', text: 'nerf: damage scaling 10/15/20 (was 10/20/30)' },
    { card: 'Katana', hero: 'Vanessa', text: 'big buff: damage 15/30/60/120 (was 8/16/32/64)' },
    { card: 'Musket', hero: 'Vanessa', text: 'now triggers on ANY burn, not just an adjacent item’s — but scaling dropped to 15/30/60 (was 25/50/100)' },
    { card: 'Piano', hero: 'Vanessa', text: 'gained the Instrument type' },
    { card: 'Powder Keg', hero: 'Vanessa', text: 'fixed: it now counts as used when it fires from being destroyed' },
    { card: 'Scimitar of the Deep', hero: 'Vanessa', text: 'nerf: poison equal to 25% (was 50%)' },
    { card: 'Turtle Shell', hero: 'Vanessa', text: 'starts silver now. cooldown 8s (was 10), scaling 10/20/30 (was 15/30)' },
    { card: 'Wetware', hero: 'Vanessa', text: 'reworked: cooldown 5s (was 6), and shielding now gives an item +5/10/20/40 damage (was gaining shield on weapon use)' },
  ],
}

/** normalize a card name for matching — lowercase, alnum only (apostrophes/hyphens/spaces drop) */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

const byCard = new Map<string, PatchChange>()
for (const c of OVERLAY.changes) byCard.set(norm(c.card), c)

/** semver-ish compare: 1 if a > b, -1 if a < b, 0 if equal. non-numeric parts sort as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

/**
 * the overlay only speaks for itself while it's plausibly current. once the scraped
 * data catches up (compareVersions in patch.ts) the overlay stops flooring the version,
 * and after this window it stops volunteering "what's new" entirely — a hand-written
 * file must never become a permanently-wrong source of truth.
 */
const OVERLAY_LIFETIME_MS = 60 * 24 * 60 * 60 * 1000 // 60 days

export function isOverlayFresh(now: number = Date.now()): boolean {
  const t = new Date(OVERLAY.released + 'T00:00:00Z').getTime()
  if (isNaN(t)) return false
  return now - t < OVERLAY_LIFETIME_MS
}

export interface PatchStatus {
  /** best known patch — the scraped one, or the overlay's while upstream lags */
  info: PatchInfo | null
  /** true while the overlay describes a patch the card database hasn't absorbed yet */
  dbBehind: boolean
}

/**
 * merge the scraped patch info with the overlay. the scraper is authoritative the moment
 * it catches up (>= overlay version); until then — and only while the overlay is fresh —
 * the overlay floors the answer so the bot isn't a patch behind on drop day.
 */
export function resolvePatch(scraped: PatchInfo | null, now: number = Date.now()): PatchStatus {
  if (!isOverlayFresh(now)) return { info: scraped, dbBehind: false }
  if (scraped && compareVersions(scraped.latestPatch, OVERLAY.version) >= 0) {
    return { info: scraped, dbBehind: false }
  }
  return {
    info: {
      latestPatch: OVERLAY.version,
      patchDate: OVERLAY.date,
      sizeBadge: '', // bazaardb's own badge — never invented here
      activeEvent: scraped?.activeEvent ?? null,
      fetchedAt: new Date(now).toISOString(),
    },
    dbBehind: true,
  }
}

/** overlay heroes the dump hasn't listed yet — empty once the scraper catches up */
export function pendingHeroes(dumpHeroes: string[], now: number = Date.now()): string[] {
  if (!isOverlayFresh(now)) return []
  const have = new Set(dumpHeroes.map(norm))
  return OVERLAY.newHeroes.filter(h => !have.has(norm(h)))
}

/** up to `max` general notes, ranked by overlap with the query's words */
export function selectNotes(query: string, max = 3): string[] {
  const words = new Set(
    query.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4),
  )
  const scored = OVERLAY.notes.map((n, i) => {
    const nw = n.toLowerCase()
    let score = 0
    for (const w of words) if (nw.includes(w)) score++
    return { n, i, score }
  })
  scored.sort((a, b) => b.score - a.score || a.i - b.i)
  return scored.slice(0, max).map(s => s.n)
}

/** the delta line for a card, or null. exact-name match only — no fuzzy, no guessing. */
export function getCardChange(name: string): PatchChange | null {
  if (!name) return null
  return byCard.get(norm(name)) ?? null
}

/** every change for a hero (case-insensitive), newest patch only */
export function getHeroChanges(hero: string): PatchChange[] {
  const h = norm(hero)
  return OVERLAY.changes.filter(c => norm(c.hero) === h)
}
