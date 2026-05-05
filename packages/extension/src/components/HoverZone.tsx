import { memo } from 'preact/compat'
import { useCallback, useMemo } from 'preact/hooks'
import type { TierName } from '@bazaarinfo/shared/src/types'
import { tierStyle } from '../tiers'

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

  const style = useMemo(() => {
    const s = tierStyle(tier)
    return {
      left: `${Math.max(0, Math.min(1 - w, x)) * 100}%`,
      top: `${Math.max(0, Math.min(1 - h, y)) * 100}%`,
      width: `${Math.min(w, 1) * 100}%`,
      height: `${Math.min(h, 1) * 100}%`,
      '--hz-color': isOpponent ? undefined : s.hzColor,
      '--hz-glow': isOpponent ? undefined : s.hzGlow,
    } as Record<string, string>
  }, [x, y, w, h, tier, isOpponent])

  const handleEnter = useCallback(() => onHover(slot), [onHover, slot])

  return (
    <div
      class={cls}
      role="button"
      aria-label={`${title} (${tier})`}
      tabIndex={0}
      style={style}
      onMouseEnter={handleEnter}
      onMouseLeave={onLeave}
      onFocus={handleEnter}
      onBlur={onLeave}
      onClick={handleEnter}
    />
  )
})

export type { DetectedSlot }
