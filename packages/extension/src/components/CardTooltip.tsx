import { memo } from 'preact/compat'
import { forwardRef } from 'preact/compat'
import { useMemo, useState, useCallback } from 'preact/hooks'
import type { BazaarCard, TierName } from '@bazaarinfo/shared/src/types'
import { resolveTooltip } from '@bazaarinfo/shared/src/format'
import { EBS_BASE } from '../twitch'
import { tierStyle } from '../tiers'

const SIZE_LABEL: Record<string, string> = { Small: 'S', Medium: 'M', Large: 'L' }

interface Props {
  card: BazaarCard
  tier: TierName
  enchantment?: string
  visible: boolean
  style?: Record<string, string>
}

export const CardTooltip = memo(forwardRef<HTMLDivElement, Props>(function CardTooltip(
  { card, tier, enchantment, visible, style },
  ref,
) {
  const styles = tierStyle(tier)

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
    '--tier-color': styles.color,
    '--tier-glow': styles.glow,
    '--tier-gradient': styles.gradient,
  } as Record<string, string>), [style, styles.color, styles.glow, styles.gradient])

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
      ref={ref}
      class={`card-tooltip${visible ? ' visible' : ''}`}
      style={tooltipStyle}
      role="tooltip"
    >
      <div class="tooltip-tier-bar" style={{ background: styles.gradient }} />
      <div class="tooltip-body">
        <div class="tooltip-header">
          <div class="tooltip-art" style={{ '--ring-color': styles.color, '--ring-glow': styles.glow } as Record<string, string>}>
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
              <div class="tooltip-art-fallback" style={{ color: styles.color }}>
                {card.Type === 'Skill' ? '✦' : '◈'}
              </div>
            )}
          </div>
          <div class="tooltip-title-block">
            <div class="tooltip-name" style={{ color: styles.color }}>{card.Title}</div>
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
}))
