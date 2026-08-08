import { memo } from 'preact/compat'
import { forwardRef } from 'preact/compat'
import { useMemo, useState, useCallback } from 'preact/hooks'
import type { BazaarCard, TierName } from '@bazaarinfo/shared/src/types'
import { resolveTooltip, isDisplayTooltip } from '@bazaarinfo/shared/src/format'
import { EBS_BASE } from '../twitch'
import { tierColor } from '../tiers'

const SIZE_LABEL: Record<string, string> = { Small: 'small', Medium: 'medium', Large: 'large' }
const TIER_SEQ: TierName[] = ['Bronze', 'Silver', 'Gold', 'Diamond', 'Legendary']

interface Props {
  card: BazaarCard
  tier: TierName
  enchantment?: string
  tierKnown?: boolean
  visible: boolean
  style?: Record<string, string>
}

export const CardTooltip = memo(forwardRef<HTMLDivElement, Props>(function CardTooltip(
  { card, tier, enchantment, tierKnown, visible, style },
  ref,
) {
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
    '--tier-color': tierColor(tier),
  } as Record<string, string>), [style, tier])

  const tags = useMemo(
    () => card.DisplayTags ?? card.Tags ?? [],
    [card.DisplayTags, card.Tags],
  )

  const resolvedTooltips = useMemo(
    () => (card.Tooltips ?? []).filter(isDisplayTooltip).map((tip) => ({
      type: tip.type,
      text: resolveTooltip(tip.text, card.TooltipReplacements ?? {}, tier),
    })),
    [card.Tooltips, card.TooltipReplacements, tier],
  )

  // Cooldown — the single most important stat on a Bazaar weapon. Flat number or
  // per-tier; if this exact tier isn't listed, use the nearest defined tier (down
  // first, since cooldowns are defined from the item's base tier up, then up).
  const cooldown = useMemo(() => {
    const cd = card.Cooldown
    if (cd == null) return null
    if (typeof cd === 'number') return cd
    if (cd[tier] != null) return cd[tier]
    const idx = TIER_SEQ.indexOf(tier)
    for (let i = idx - 1; i >= 0; i--) if (cd[TIER_SEQ[i]] != null) return cd[TIER_SEQ[i]]
    for (let i = idx + 1; i < TIER_SEQ.length; i++) if (cd[TIER_SEQ[i]] != null) return cd[TIER_SEQ[i]]
    return null
  }, [card.Cooldown, tier])

  // What the applied enchantment actually does on this card (not just its name).
  const enchantEffect = useMemo(() => {
    if (!enchantment) return null
    const e = card.Enchantments?.[enchantment]
    if (!e?.tooltips?.length) return null
    return e.tooltips
      .map((t) => resolveTooltip(t.text, e.tooltipReplacements ?? {}, tier))
      .join(' ')
  }, [enchantment, card.Enchantments, tier])

  // One dense stat line instead of a row of chips — the chips were 9px and unreadable
  // over moving video, and the labels cost more pixels than the values they framed.
  // [slug, label, value]. The slug drives styling and stays fixed even when the
  // label changes, so the colour tracks the fact rather than the wording.
  const stats = useMemo(() => {
    // A sender that only knows the card's *starting* tier says so, and we label it
    // "base" rather than "tier". The numbers below are that tier's numbers, so
    // claiming it as the live tier would put wrong damage on screen after any
    // upgrade — and a confidently wrong number is worse than an honest one.
    const out: Array<[string, string, string]> = [
      ['tier', tierKnown === false ? 'base' : 'tier', tier.toLowerCase()],
    ]
    out.push(['size', 'size', SIZE_LABEL[card.Size] ?? String(card.Size).toLowerCase()])
    if (cooldown != null) out.push(['cd', 'cd', `${cooldown}s`])
    // Named here too, not only as the effect block's label — an enchant whose text
    // we can't resolve would otherwise vanish from the card entirely.
    if (enchantment) out.push(['ench', 'ench', enchantment.toLowerCase()])
    return out
  }, [tier, card.Size, cooldown, enchantment, tierKnown])

  return (
    <div
      ref={ref}
      class={`card-tooltip${visible ? ' visible' : ''}`}
      style={tooltipStyle}
      role="tooltip"
    >
      <div class="tt-head">
        <div class="tt-art">
          {artUrl && !imgFailed ? (
            <img
              src={artUrl}
              class={`tt-art-img${imgLoaded ? ' loaded' : ''}`}
              onLoad={handleImgLoad}
              onError={handleImgError}
              alt=""
              aria-hidden="true"
            />
          ) : (
            <div class="tt-art-fallback" aria-hidden="true">
              {card.Type === 'Skill' ? '*' : '#'}
            </div>
          )}
        </div>
        <div class="tt-head-text">
          <div class="tt-name">{card.Title}</div>
          <div class="tt-stats">
            {stats.map(([slug, label, v], i) => (
              <span class="tt-stat" key={slug}>
                <span class="tt-stat-k">{label}</span>
                <span class={`tt-stat-v tt-stat-v--${slug}`}>{v}</span>
                {/* trailing, so a wrapped line opens on a key rather than a bullet */}
                {i < stats.length - 1 && <span class="tt-sep">·</span>}
              </span>
            ))}
          </div>
        </div>
      </div>

      {resolvedTooltips.length > 0 && (
        <div class="tt-blocks">
          {resolvedTooltips.map((tip, i) => (
            <div class="tt-block" key={i}>
              <div class="tt-label">{tip.type}</div>
              <div class="tt-text">{tip.text}</div>
            </div>
          ))}
        </div>
      )}

      {enchantEffect && (
        <div class="tt-block tt-block--ench">
          <div class="tt-label">{enchantment}</div>
          <div class="tt-text">{enchantEffect}</div>
        </div>
      )}

      {tags.length > 0 && (
        <div class="tt-tags">
          {tags.map((tag, i) => (
            <span class="tt-tag" key={`${tag}-${i}`}>{tag.toLowerCase()}</span>
          ))}
        </div>
      )}
    </div>
  )
}))
