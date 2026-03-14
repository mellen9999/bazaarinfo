import { memo } from 'preact/compat'
import { useCallback, useMemo } from 'preact/hooks'
import type { TierName } from '@bazaarinfo/shared/src/types'

const TIER_HZ_COLOR: Record<TierName, string> = {
  Bronze: 'rgba(205, 127, 50, 0.7)',
  Silver: 'rgba(192, 192, 192, 0.6)',
  Gold: 'rgba(255, 215, 0, 0.75)',
  Diamond: 'rgba(185, 242, 255, 0.65)',
  Legendary: 'rgba(176, 96, 255, 0.72)',
}

const TIER_HZ_GLOW: Record<TierName, string> = {
  Bronze: 'rgba(205, 127, 50, 0.22)',
  Silver: 'rgba(192, 192, 192, 0.18)',
  Gold: 'rgba(255, 215, 0, 0.26)',
  Diamond: 'rgba(185, 242, 255, 0.22)',
  Legendary: 'rgba(176, 96, 255, 0.28)',
}

interface DetectedSlot {
  title: string
  tier: TierName
  x: number
  y: number
  w: number
  h: number
  owner?: string
  type?: string
  enchantment?: string
}

interface Props extends DetectedSlot {
  onHover: (slot: DetectedSlot) => void
  onLeave: () => void
}

export const HoverZone = memo(function HoverZone({ title, tier, x, y, w, h, owner, type, enchantment, onHover, onLeave }: Props) {
  const isSkill = type === 'Skill'
  const isOpponent = owner === 'opponent'
  const cls = `hover-zone${isSkill ? ' hover-zone--skill' : ''}${isOpponent ? ' hover-zone--opponent' : ''}`

  const slot = useMemo(
    () => ({ title, tier, x, y, w, h, owner, type, enchantment }),
    [title, tier, x, y, w, h, owner, type, enchantment],
  )

  const style = useMemo(() => ({
    left: `${Math.max(0, Math.min(1 - w, x)) * 100}%`,
    top: `${Math.max(0, Math.min(1 - h, y)) * 100}%`,
    width: `${Math.min(w, 1) * 100}%`,
    height: `${Math.min(h, 1) * 100}%`,
    '--hz-color': isOpponent ? undefined : TIER_HZ_COLOR[tier],
    '--hz-glow': isOpponent ? undefined : TIER_HZ_GLOW[tier],
  } as Record<string, string>), [x, y, w, h, tier, isOpponent])

  const handleEnter = useCallback(() => onHover(slot), [onHover, slot])

  return (
    <div
      class={cls}
      role="button"
      aria-label={`${title} (${tier})`}
      style={style}
      onMouseEnter={handleEnter}
      onMouseLeave={onLeave}
    >
    </div>
  )
})

export type { DetectedSlot }
