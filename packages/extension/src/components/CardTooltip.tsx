import type { BazaarCard, TierName } from '@bazaarinfo/shared/src/types'
import { resolveTooltip } from '@bazaarinfo/shared/src/format'

const TIER_COLORS: Record<TierName, string> = {
  Bronze: '#cd7f32',
  Silver: '#c0c0c0',
  Gold: '#ffd700',
  Diamond: '#b9f2ff',
  Legendary: '#9b59b6',
}

const SIZE_LABEL: Record<string, string> = { Small: 'S', Medium: 'M', Large: 'L' }

const TIER_ART: Record<TierName, string> = {
  Bronze: '🟤',
  Silver: '⚪',
  Gold: '🟡',
  Diamond: '💎',
  Legendary: '🟣',
}

interface Props {
  card: BazaarCard
  tier: TierName
  enchantment?: string
  visible: boolean
  style?: Record<string, string>
}

export function CardTooltip({ card, tier, enchantment, visible, style }: Props) {
  const color = TIER_COLORS[tier] ?? TIER_COLORS.Bronze
  const tooltips = card.Tooltips ?? []
  const tags = card.DisplayTags ?? card.Tags ?? []

  return (
    <div
      class={`card-tooltip${visible ? ' visible' : ''}`}
      style={style}
    >
      <div class="tooltip-tier-bar" style={{ background: color }} />
      <div class="tooltip-body">
        <div class="tooltip-header">
          <div class="tooltip-art">{TIER_ART[tier]}</div>
          <div class="tooltip-title-block">
            <div class="tooltip-name" style={{ color }}>{card.Title}</div>
            <span class="tooltip-size">{SIZE_LABEL[card.Size] ?? card.Size}</span>
            {enchantment && <span class="tooltip-enchantment">{enchantment}</span>}
          </div>
        </div>
        {tooltips.length > 0 && (
          <div class="tooltip-tooltips">
            {tooltips.map((tip, i) => (
              <div class="tooltip-tip" key={i}>
                <div class="tooltip-tip-type">{tip.type}</div>
                {resolveTooltip(tip.text, card.TooltipReplacements ?? {}, tier)}
              </div>
            ))}
          </div>
        )}
        {tags.length > 0 && (
          <div class="tooltip-tags">
            {tags.map((tag) => (
              <span class="tooltip-tag" key={tag}>{tag}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
