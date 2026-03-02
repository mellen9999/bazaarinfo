import type { TierName } from '@bazaarinfo/shared/src/types'

interface DetectedSlot {
  title: string
  tier: TierName
  x: number
  y: number
  w: number
  h: number
}

interface Props extends DetectedSlot {
  onHover: (slot: DetectedSlot) => void
  onLeave: () => void
}

export function HoverZone({ title, tier, x, y, w, h, onHover, onLeave }: Props) {
  return (
    <div
      class="hover-zone"
      style={{
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        width: `${w * 100}%`,
        height: `${h * 100}%`,
      }}
      onMouseEnter={() => onHover({ title, tier, x, y, w, h })}
      onMouseLeave={onLeave}
    />
  )
}

export type { DetectedSlot }
