import { memo } from 'preact/compat'
import { useMemo } from 'preact/hooks'
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

// matches TIER_EMOJI in shared/format.ts — single source kept there, mirrored here for display
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

export const CardTooltip = memo(function CardTooltip({ card, tier, enchantment, visible, style }: Props) {
  const color = TIER_COLORS[tier] ?? TIER_COLORS.Bronze

  const tierBarStyle = useMemo(() => ({ background: color }), [color])
  const nameStyle = useMemo(() => ({ color }), [color])

  const tags = useMemo(
    () => card.DisplayTags ?? card.Tags ?? [],
    [card.DisplayTags, card.Tags],
  )

  const resolvedTooltips = useMemo(
    () => (card.Tooltips ?? []).map((tip) => ({
      type: tip.type,
      text: resolveTooltip(tip.text, card.TooltipReplacements ?? {}, tier),
    })),
    [card.Tooltips, card.TooltipReplacements, tier],
  )

  return (
    <div
      class={`card-tooltip${visible ? ' visible' : ''}`}
      style={style}
    >
      <div class="tooltip-tier-bar" style={tierBarStyle} />
      <div class="tooltip-body">
        <div class="tooltip-header">
          <div class="tooltip-art">{TIER_ART[tier]}</div>
          <div class="tooltip-title-block">
            <div class="tooltip-name" style={nameStyle}>{card.Title}</div>
            <div class="tooltip-badges">
              <span class="tooltip-size">{SIZE_LABEL[card.Size] ?? card.Size}</span>
              {enchantment && <span class="tooltip-enchantment">{enchantment}</span>}
            </div>
          </div>
        </div>
        {resolvedTooltips.length > 0 && (
          <div class="tooltip-tooltips">
            {resolvedTooltips.map((tip, i) => (
              <div class="tooltip-tip" key={i}>
                <div class="tooltip-tip-type">{tip.type}</div>
                {tip.text}
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
})
