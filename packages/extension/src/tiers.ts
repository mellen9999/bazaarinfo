import type { BazaarCard, TierName } from '@bazaarinfo/shared/src/types'

export interface TierStyle {
  color: string
  glow: string
  gradient: string
  hzColor: string
  hzGlow: string
}

const FALLBACK: TierStyle = {
  color: '#9aa0a6',
  glow: 'rgba(154, 160, 166, 0.3)',
  gradient: 'linear-gradient(90deg, #9aa0a6 0%, #5f6368 100%)',
  hzColor: 'rgba(154, 160, 166, 0.6)',
  hzGlow: 'rgba(154, 160, 166, 0.18)',
}

const TIER_STYLES: Record<string, TierStyle> = {
  Bronze: {
    color: '#cd7f32',
    glow: 'rgba(205, 127, 50, 0.35)',
    gradient: 'linear-gradient(90deg, #cd7f32 0%, #a0522d 100%)',
    hzColor: 'rgba(205, 127, 50, 0.7)',
    hzGlow: 'rgba(205, 127, 50, 0.22)',
  },
  Silver: {
    color: '#c0c0c0',
    glow: 'rgba(192, 192, 192, 0.28)',
    gradient: 'linear-gradient(90deg, #c0c0c0 0%, #888 100%)',
    hzColor: 'rgba(192, 192, 192, 0.6)',
    hzGlow: 'rgba(192, 192, 192, 0.18)',
  },
  Gold: {
    color: '#ffd700',
    glow: 'rgba(255, 215, 0, 0.38)',
    gradient: 'linear-gradient(90deg, #ffd700 0%, #b8860b 100%)',
    hzColor: 'rgba(255, 215, 0, 0.75)',
    hzGlow: 'rgba(255, 215, 0, 0.26)',
  },
  Diamond: {
    color: '#b9f2ff',
    glow: 'rgba(185, 242, 255, 0.32)',
    gradient: 'linear-gradient(90deg, #b9f2ff 0%, #5bb8d4 100%)',
    hzColor: 'rgba(185, 242, 255, 0.65)',
    hzGlow: 'rgba(185, 242, 255, 0.22)',
  },
  Legendary: {
    color: '#b060ff',
    glow: 'rgba(176, 96, 255, 0.42)',
    gradient: 'linear-gradient(90deg, #b060ff 0%, #6a0daa 100%)',
    hzColor: 'rgba(176, 96, 255, 0.72)',
    hzGlow: 'rgba(176, 96, 255, 0.28)',
  },
}

export function tierStyle(tier: string): TierStyle {
  return TIER_STYLES[tier] ?? FALLBACK
}

export function deriveValidTiers(cards: Iterable<BazaarCard>): Set<string> {
  const set = new Set<string>()
  for (const c of cards) for (const t of c.Tiers) set.add(t)
  return set
}

export function isPlausibleTierString(s: unknown, valid: Set<string>): s is TierName {
  if (typeof s !== 'string' || s.length === 0 || s.length > 32) return false
  if (valid.size > 0) return valid.has(s)
  return s in TIER_STYLES
}
