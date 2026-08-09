import { memo } from 'preact/compat'
import { forwardRef } from 'preact/compat'
import { useMemo, useState, useCallback } from 'preact/hooks'
import type { BazaarCard, TierName } from '@bazaarinfo/shared/src/types'
import type { TooltipPart, LadderStep } from '@bazaarinfo/shared/src/format'
import { resolveTooltipParts, cooldownLadder, isDisplayTooltip } from '@bazaarinfo/shared/src/format'
import { EBS_BASE } from '../twitch'
import { tierColor } from '../tiers'

const SIZE_LABEL: Record<string, string> = { Small: 'small', Medium: 'medium', Large: 'large' }
const TIER_SEQ: TierName[] = ['Bronze', 'Silver', 'Gold', 'Diamond', 'Legendary']

// Why a hovered card has no body. Each of these is a different truth and the
// viewer can act on the difference — wait, reload, or accept that the dump has
// not caught up with the patch — so they are never collapsed into one line.
export type MissingReason = 'loading' | 'failed' | 'unknown'

const MISSING_TEXT: Record<MissingReason, string> = {
  loading: 'loading card data…',
  failed: 'card data unavailable',
  unknown: 'no data for this card yet',
}

// Every rung wears its own tier's hue. Without it the row is unreadable: tier windows
// vary per card (plenty of items exist only at Gold/Diamond), so position does not
// imply tier and a bare "60/80" reads as bronze/silver to anyone counting from the
// left. The hue here IS the label — it's the cheapest way to say which is which, and
// it costs no extra width in a 310px tooltip.
function Ladder({ steps, suffix }: { steps: LadderStep[]; suffix?: string }) {
  return (
    <span class="tt-ladder">
      {steps.map((s, i) => (
        <span key={s.tier}>
          {i > 0 && <span class="tt-step-sep">/</span>}
          <span class="tt-step" style={{ color: tierColor(s.tier) }} title={s.tier.toLowerCase()}>
            {s.value}
          </span>
        </span>
      ))}
      {suffix}
    </span>
  )
}

function Parts({ parts }: { parts: TooltipPart[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.t === 'text' ? p.s : <Ladder key={i} steps={p.steps} />,
      )}
    </>
  )
}

interface Props {
  card: BazaarCard | null
  // the name off the wire — the only thing we know when `card` is null
  title?: string
  tier: TierName
  enchantment?: string
  tierKnown?: boolean
  missing?: MissingReason
  visible: boolean
  style?: Record<string, string>
}

export const CardTooltip = memo(forwardRef<HTMLDivElement, Props>(function CardTooltip(
  { card, title, tier, enchantment, tierKnown, missing, visible, style },
  ref,
) {
  const [imgLoaded, setImgLoaded] = useState(false)
  const [imgFailed, setImgFailed] = useState(false)

  const handleImgLoad = useCallback(() => setImgLoaded(true), [])
  const handleImgError = useCallback(() => setImgFailed(true), [])

  const artUrl = useMemo(
    () => card?.ArtKey ? `${EBS_BASE}/api/images/${card.ArtKey}` : null,
    [card?.ArtKey],
  )

  const tooltipStyle = useMemo(() => ({
    ...style,
    '--tier-color': tierColor(tier),
  } as Record<string, string>), [style, tier])

  const tags = useMemo(
    () => card?.DisplayTags ?? card?.Tags ?? [],
    [card?.DisplayTags, card?.Tags],
  )

  // The sender only knows the card's starting tier (Player.log carries no live tier,
  // ever), so pinning the numbers to it puts stale damage on screen after any upgrade.
  // Passing no tier instead resolves every tier the card has, and the viewer reads off
  // the one they can see on the card's border. A sender that DOES know the tier
  // (`tierKnown`) still gets the single exact value.
  const ladderTier = tierKnown === false ? undefined : tier

  const resolvedTooltips = useMemo(
    () => (card?.Tooltips ?? []).filter(isDisplayTooltip).map((tip) => ({
      type: tip.type,
      parts: resolveTooltipParts(tip.text, card?.TooltipReplacements ?? {}, ladderTier),
    })),
    [card?.Tooltips, card?.TooltipReplacements, ladderTier],
  )

  // Cooldown — the single most important stat on a Bazaar weapon. Flat number or
  // per-tier; if this exact tier isn't listed, use the nearest defined tier (down
  // first, since cooldowns are defined from the item's base tier up, then up).
  // That nearest-tier guess is only sound when the tier is real; when it isn't,
  // `cooldownSteps` below carries the whole ladder instead and this returns null.
  const cooldownSteps = useMemo(
    () => cooldownLadder(card?.Cooldown, ladderTier),
    [card?.Cooldown, ladderTier],
  )

  const cooldown = useMemo(() => {
    const cd = card?.Cooldown
    if (cd == null) return null
    if (typeof cd === 'number') return cd
    if (cooldownSteps) return null
    if (cd[tier] != null) return cd[tier]
    const idx = TIER_SEQ.indexOf(tier)
    for (let i = idx - 1; i >= 0; i--) if (cd[TIER_SEQ[i]] != null) return cd[TIER_SEQ[i]]
    for (let i = idx + 1; i < TIER_SEQ.length; i++) if (cd[TIER_SEQ[i]] != null) return cd[TIER_SEQ[i]]
    return null
  }, [card?.Cooldown, tier, cooldownSteps])

  // What the applied enchantment actually does on this card (not just its name).
  const enchantParts = useMemo((): TooltipPart[] | null => {
    if (!enchantment) return null
    const e = card?.Enchantments?.[enchantment]
    if (!e?.tooltips?.length) return null
    return e.tooltips.flatMap((t, i) => [
      ...(i > 0 ? [{ t: 'text', s: ' ' } as TooltipPart] : []),
      ...resolveTooltipParts(t.text, e.tooltipReplacements ?? {}, ladderTier),
    ])
  }, [enchantment, card?.Enchantments, ladderTier])

  // One dense stat line instead of a row of chips — the chips were 9px and unreadable
  // over moving video, and the labels cost more pixels than the values they framed.
  // [slug, label, value]. The slug drives styling and stays fixed even when the
  // label changes, so the colour tracks the fact rather than the wording.
  const stats = useMemo(() => {
    // A sender that only knows the card's *starting* tier says so, and we label it
    // "base" rather than "tier" — the tier itself is still a fact worth stating,
    // it's the numbers keyed off it that are a guess, and those now carry their own
    // tier below rather than silently borrowing this one.
    const out: Array<[string, string, string | LadderStep[]]> = [
      ['tier', tierKnown === false ? 'base' : 'tier', tier.toLowerCase()],
    ]
    // Size and cooldown come from the dump, so without a card there is nothing
    // honest to put here — tier and enchantment came off the wire and still stand.
    if (card) out.push(['size', 'size', SIZE_LABEL[card.Size] ?? String(card.Size).toLowerCase()])
    if (cooldownSteps) out.push(['cd', 'cd', cooldownSteps])
    else if (cooldown != null) out.push(['cd', 'cd', `${cooldown}s`])
    // Named here too, not only as the effect block's label — an enchant whose text
    // we can't resolve would otherwise vanish from the card entirely.
    if (enchantment) out.push(['ench', 'ench', enchantment.toLowerCase()])
    return out
  }, [tier, card, cooldown, cooldownSteps, enchantment, tierKnown])

  const name = card?.Title ?? title ?? ''

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
              {!card ? '?' : card.Type === 'Skill' ? '*' : '#'}
            </div>
          )}
        </div>
        <div class="tt-head-text">
          <div class="tt-name">{name}</div>
          <div class="tt-stats">
            {stats.map(([slug, label, v], i) => (
              <span class="tt-stat" key={slug}>
                {/* Leading, never trailing. Four stats always wrap at this width, and
                    a trailing separator strands a lone dot at the end of the first
                    line; leading, the last stat can never end on punctuation and the
                    wrapped line opens on a continuation mark instead. */}
                {i > 0 && <span class="tt-sep">·</span>}
                <span class="tt-stat-k">{label}</span>
                <span class={`tt-stat-v tt-stat-v--${slug}`}>
                  {typeof v === 'string' ? v : <Ladder steps={v} suffix="s" />}
                </span>
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
              <div class="tt-text"><Parts parts={tip.parts} /></div>
            </div>
          ))}
        </div>
      )}

      {enchantParts && (
        <div class="tt-block tt-block--ench">
          <div class="tt-label">{enchantment}</div>
          <div class="tt-text"><Parts parts={enchantParts} /></div>
        </div>
      )}

      {missing && (
        <div class="tt-block tt-block--note">
          <div class="tt-text tt-note">{MISSING_TEXT[missing]}</div>
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
