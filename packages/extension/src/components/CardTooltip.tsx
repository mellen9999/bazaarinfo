import { memo } from 'preact/compat'
import { useMemo, useState, useCallback } from 'preact/hooks'
import type { BazaarCard, TierName } from '@bazaarinfo/shared/src/types'
import { resolveTooltip } from '@bazaarinfo/shared/src/format'
import { EBS_BASE } from '../twitch'

const TIER_COLORS: Record<TierName, string> = {
  Bronze: '#cd7f32',
  Silver: '#c0c0c0',
  Gold: '#ffd700',
  Diamond: '#b9f2ff',
  Legendary: '#b060ff',
}

const TIER_GLOW: Record<TierName, string> = {
  Bronze: 'rgba(205, 127, 50, 0.35)',
  Silver: 'rgba(192, 192, 192, 0.28)',
  Gold: 'rgba(255, 215, 0, 0.38)',
  Diamond: 'rgba(185, 242, 255, 0.32)',
  Legendary: 'rgba(176, 96, 255, 0.42)',
}

const TIER_GRADIENT: Record<TierName, string> = {
  Bronze: 'linear-gradient(90deg, #cd7f32 0%, #a0522d 100%)',
  Silver: 'linear-gradient(90deg, #c0c0c0 0%, #888 100%)',
  Gold: 'linear-gradient(90deg, #ffd700 0%, #b8860b 100%)',
  Diamond: 'linear-gradient(90deg, #b9f2ff 0%, #5bb8d4 100%)',
  Legendary: 'linear-gradient(90deg, #b060ff 0%, #6a0daa 100%)',
}

const SIZE_LABEL: Record<string, string> = { Small: 'S', Medium: 'M', Large: 'L' }

interface Props {
  card: BazaarCard
  tier: TierName
  enchantment?: string
  visible: boolean
  style?: Record<string, string>
}

export const CardTooltip = memo(function CardTooltip({ card, tier, enchantment, visible, style }: Props) {
  const color = TIER_COLORS[tier] ?? TIER_COLORS.Bronze
  const glow = TIER_GLOW[tier] ?? TIER_GLOW.Bronze
  const gradient = TIER_GRADIENT[tier] ?? TIER_GRADIENT.Bronze

  const [imgLoaded, setImgLoaded] = useState(false)
  const [imgFailed, setImgFailed] = useState(false)

  const handleImgLoad = useCallback(() => setImgLoaded(true), [])
  const handleImgError = useCallback(() => setImgFailed(true), [])

  const artUrl = useMemo(
    () => card.ArtKey ? `${EBS_BASE}/api/images/${card.ArtKey}` : null,
    [card.ArtKey],
  )

  const tooltipStyle = useMemo(() => ({
    ...style,
    '--tier-color': color,
    '--tier-glow': glow,
    '--tier-gradient': gradient,
  } as Record<string, string>), [style, color, glow, gradient])

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
      style={tooltipStyle}
    >
      <div class="tooltip-tier-bar" style={{ background: gradient }} />
      <div class="tooltip-body">
        <div class="tooltip-header">
          <div class="tooltip-art" style={{ '--ring-color': color, '--ring-glow': glow } as Record<string, string>}>
            {artUrl && !imgFailed ? (
              <img
                src={artUrl}
                class={`tooltip-art-img${imgLoaded ? ' loaded' : ''}`}
                onLoad={handleImgLoad}
                onError={handleImgError}
                alt=""
                aria-hidden="true"
              />
            ) : (
              <div class="tooltip-art-fallback" style={{ color }}>
                {card.Type === 'Skill' ? '✦' : '◈'}
              </div>
            )}
          </div>
          <div class="tooltip-title-block">
            <div class="tooltip-name" style={{ color }}>{card.Title}</div>
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
