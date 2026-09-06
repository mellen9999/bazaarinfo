// What a chatter's badges say about them, read off the tags twitch attaches to every
// message: exact sub months (badge-info carries the cumulative count, the badge itself
// only the tier), founder, the gifted-subs tier, the bits tier, mod/vip/prime/turbo,
// partner, artist, game dev. No API call — it rides in with the message — and it is the
// single richest "what has this person done here" signal twitch exposes to a bot.
//
// Pure: parse + format + compare. The write-through (one row per user per channel, only
// when it changes) lives in index.ts; the readers are buildUserContext and the person
// trivia dossier.

export interface BadgeSnapshot {
  subMonths?: number
  subTier?: 1 | 2 | 3
  founder?: boolean
  gifter?: number
  bits?: number
  mod?: boolean
  vip?: boolean
  broadcaster?: boolean
  prime?: boolean
  turbo?: boolean
  partner?: boolean
  artist?: boolean
  gameDev?: boolean
}

/** `badges=subscriber/2012,sub-gifter/50` + `badge-info=subscriber/14` → snapshot. */
export function parseBadges(badges: string | undefined, badgeInfo: string | undefined): BadgeSnapshot {
  const snap: BadgeSnapshot = {}
  for (const b of (badgeInfo ?? '').split(',')) {
    const [set, ver] = b.split('/')
    if ((set === 'subscriber' || set === 'founder') && ver) {
      const months = parseInt(ver, 10)
      if (Number.isFinite(months) && months > 0) snap.subMonths = months
    }
  }
  for (const b of (badges ?? '').split(',')) {
    const [set, ver] = b.split('/')
    const n = ver ? parseInt(ver, 10) : NaN
    switch (set) {
      case 'subscriber':
        snap.subTier = Number.isFinite(n) && n >= 3000 ? 3 : Number.isFinite(n) && n >= 2000 ? 2 : 1
        if (!snap.subMonths && Number.isFinite(n)) snap.subMonths = Math.max(1, n % 1000)
        break
      case 'founder': snap.founder = true; if (!snap.subTier) snap.subTier = 1; break
      case 'sub-gifter': if (Number.isFinite(n) && n > 0) snap.gifter = n; break
      case 'bits': if (Number.isFinite(n) && n > 0) snap.bits = n; break
      case 'moderator': snap.mod = true; break
      case 'vip': snap.vip = true; break
      case 'broadcaster': snap.broadcaster = true; break
      case 'premium': snap.prime = true; break
      case 'turbo': snap.turbo = true; break
      case 'partner': snap.partner = true; break
      case 'artist-badge': snap.artist = true; break
      case 'game-developer': snap.gameDev = true; break
    }
  }
  return snap
}

function short(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

/** the context line: `sub 14 months (tier 2), founder, gifted 50+ subs, 1k+ bits, vip` — '' when plain. */
export function formatBadges(s: BadgeSnapshot): string {
  const bits: string[] = []
  if (s.broadcaster) bits.push('broadcaster')
  if (s.mod) bits.push('mod')
  if (s.vip) bits.push('vip')
  if (s.subMonths) bits.push(`sub ${s.subMonths} month${s.subMonths === 1 ? '' : 's'}${s.subTier && s.subTier > 1 ? ` (tier ${s.subTier})` : ''}${s.prime ? ' (prime)' : ''}`)
  else if (s.subTier) bits.push(`sub${s.prime ? ' (prime)' : ''}`)
  if (s.founder) bits.push('founder')
  if (s.gifter) bits.push(`gifted ${short(s.gifter)}+ subs`)
  if (s.bits) bits.push(`${short(s.bits)}+ bits`)
  if (s.partner) bits.push('twitch partner')
  if (s.artist) bits.push('channel artist')
  if (s.gameDev) bits.push('game dev')
  if (s.turbo) bits.push('turbo')
  return bits.join(', ')
}

/** stable serialisation so a write-through can skip unchanged snapshots. */
export function badgeKey(s: BadgeSnapshot): string {
  return JSON.stringify(Object.entries(s).filter(([, v]) => v).sort())
}
