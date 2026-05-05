import { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect } from 'preact/hooks'
import type { BazaarCard } from '@bazaarinfo/shared/src/types'
import { HoverZone } from './HoverZone'
import type { DetectedSlot } from './HoverZone'
import { CardTooltip } from './CardTooltip'
import { fetchCards } from '../twitch'
import { deriveValidTiers, isPlausibleTierString } from '../tiers'

const VIEWPORT_MARGIN = 4
const MAX_SLOTS = 50

function makeSlotValidator(validTiers: Set<string>) {
  return function isValidSlot(s: unknown): s is DetectedSlot {
    if (!s || typeof s !== 'object') return false
    const o = s as Record<string, unknown>
    if (typeof o.title !== 'string' || o.title.length === 0 || o.title.length > 80) return false
    if (!isPlausibleTierString(o.tier, validTiers)) return false
    if (typeof o.x !== 'number' || typeof o.y !== 'number') return false
    if (typeof o.w !== 'number' || typeof o.h !== 'number') return false
    if (!Number.isFinite(o.x) || !Number.isFinite(o.y) || !Number.isFinite(o.w) || !Number.isFinite(o.h)) return false
    if (o.x < 0 || o.x > 1 || o.y < 0 || o.y > 1) return false
    if (o.w <= 0 || o.w > 1 || o.h <= 0 || o.h > 1) return false
    if (typeof o.owner === 'string' && o.owner.length > 50) return false
    if (typeof o.type === 'string' && o.type.length > 50) return false
    if (typeof o.enchantment === 'string' && o.enchantment.length > 50) return false
    return true
  }
}

function slotsEqual(a: DetectedSlot[], b: DetectedSlot[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].title !== b[i].title || a[i].x !== b[i].x || a[i].y !== b[i].y || a[i].tier !== b[i].tier) return false
  }
  return true
}

export function App() {
  const [cards, setCards] = useState<Map<string, BazaarCard>>(new Map())
  const [detected, setDetected] = useState<DetectedSlot[]>([])
  const [hovered, setHovered] = useState<DetectedSlot | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ left: string; top: string }>({ left: '0', top: '0' })
  const cardsLoaded = useRef(false)
  const tooltipRef = useRef<HTMLDivElement | null>(null)
  const lastSlotRef = useRef<DetectedSlot | null>(null)
  const validatorRef = useRef<(s: unknown) => s is DetectedSlot>(makeSlotValidator(new Set<string>()))

  useEffect(() => {
    let mounted = true
    const twitch = window.Twitch?.ext
    if (!twitch) return

    twitch.onAuthorized(async (auth) => {
      if (cardsLoaded.current) return
      for (let i = 0; i < 2; i++) {
        try {
          const all = await fetchCards(auth.token)
          if (!mounted) return
          const map = new Map<string, BazaarCard>()
          for (const c of all) map.set(c.Title.toLowerCase(), c)
          setCards(map)
          validatorRef.current = makeSlotValidator(deriveValidTiers(all))
          cardsLoaded.current = true
          return
        } catch {
          if (i === 1) break
        }
      }
    })

    const onBroadcast = (_target: string, _contentType: string, message: string) => {
      if (!message.includes('"cards"')) return
      try {
        const data = JSON.parse(message)
        const raw = data?.cards
        if (Array.isArray(raw)) {
          const next = raw.slice(0, MAX_SLOTS).filter(validatorRef.current)
          setDetected(prev => slotsEqual(prev, next) ? prev : next)
        }
      } catch {}
    }
    twitch.listen('broadcast', onBroadcast)

    twitch.onVisibilityChanged?.((isVisible) => {
      if (!isVisible) {
        setDetected([])
        setHovered(null)
      }
    })

    return () => { mounted = false; twitch.unlisten('broadcast', onBroadcast) }
  }, [])

  const positionTooltip = useCallback((slot: DetectedSlot) => {
    lastSlotRef.current = slot
    const tip = tooltipRef.current
    const vw = window.innerWidth
    const vh = window.innerHeight
    const tipW = tip?.offsetWidth ?? Math.min(280, vw - VIEWPORT_MARGIN * 2)
    const tipH = tip?.offsetHeight ?? Math.min(320, vh - VIEWPORT_MARGIN * 2)

    const slotCx = slot.x * vw + (slot.w * vw) / 2
    const slotTop = slot.y * vh
    const slotBottom = (slot.y + slot.h) * vh

    // Prefer placing tooltip right of slot center, but flip if it overflows
    const wantLeft = slotCx + tipW / 2 > vw - VIEWPORT_MARGIN ? slotCx - tipW : slotCx
    const left = Math.max(VIEWPORT_MARGIN, Math.min(vw - tipW - VIEWPORT_MARGIN, wantLeft))

    // Prefer above slot, fall back to below if no room
    const wantTop = slotTop - tipH - 8 < VIEWPORT_MARGIN ? slotBottom + 8 : slotTop - tipH - 8
    const top = Math.max(VIEWPORT_MARGIN, Math.min(vh - tipH - VIEWPORT_MARGIN, wantTop))

    setTooltipPos({ left: `${left}px`, top: `${top}px` })
  }, [])

  const handleHover = useCallback((slot: DetectedSlot) => {
    setHovered(slot)
    positionTooltip(slot)
  }, [positionTooltip])

  const handleLeave = useCallback(() => {
    setHovered(null)
    lastSlotRef.current = null
  }, [])

  // re-clamp tooltip when its rendered size is known and on resize
  useLayoutEffect(() => {
    if (hovered) positionTooltip(hovered)
  }, [hovered, positionTooltip])

  useEffect(() => {
    const onResize = () => {
      if (lastSlotRef.current) positionTooltip(lastSlotRef.current)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [positionTooltip])

  // outside-tap dismissal for touch users
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return
      const target = e.target as Element | null
      if (!target?.closest('.hover-zone') && !target?.closest('.card-tooltip')) {
        setHovered(null)
      }
    }
    document.addEventListener('pointerdown', onPointerDown, { passive: true })
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  const hoveredCard = useMemo(
    () => hovered ? cards.get(hovered.title.toLowerCase()) ?? null : null,
    [hovered, cards],
  )

  const tooltipStyle = useMemo(
    () => ({ position: 'absolute' as const, left: tooltipPos.left, top: tooltipPos.top }),
    [tooltipPos.left, tooltipPos.top],
  )

  return (
    <div class="overlay">
      {detected.map((slot) => (
        <HoverZone
          key={`${slot.title}-${slot.x}-${slot.y}`}
          {...slot}
          onHover={handleHover}
          onLeave={handleLeave}
        />
      ))}
      {hoveredCard && hovered && (
        <CardTooltip
          ref={tooltipRef}
          card={hoveredCard}
          tier={hovered.tier}
          enchantment={hovered.enchantment}
          visible={true}
          style={tooltipStyle}
        />
      )}
    </div>
  )
}
