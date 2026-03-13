import { useState, useEffect, useCallback } from 'preact/hooks'
import type { BazaarCard } from '@bazaarinfo/shared/src/types'
import { HoverZone } from './HoverZone'
import type { DetectedSlot } from './HoverZone'
import { CardTooltip } from './CardTooltip'
import { fetchCards } from '../twitch'

function isValidSlot(s: unknown): s is DetectedSlot {
  if (!s || typeof s !== 'object') return false
  const o = s as Record<string, unknown>
  return typeof o.title === 'string' && typeof o.tier === 'string'
    && typeof o.x === 'number' && typeof o.y === 'number'
    && typeof o.w === 'number' && typeof o.h === 'number'
    && o.x >= 0 && o.x <= 1 && o.y >= 0 && o.y <= 1
    && o.w > 0 && o.w <= 1 && o.h > 0 && o.h <= 1
}

export function App() {
  const [cards, setCards] = useState<Map<string, BazaarCard>>(new Map())
  const [detected, setDetected] = useState<DetectedSlot[]>([])
  const [hovered, setHovered] = useState<DetectedSlot | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ left: string; top: string }>({ left: '0', top: '0' })

  useEffect(() => {
    const twitch = window.Twitch?.ext
    if (!twitch) return

    twitch.onAuthorized(async (auth) => {
      for (let i = 0; i < 2; i++) {
        try {
          const all = await fetchCards(auth.token)
          const map = new Map<string, BazaarCard>()
          for (const c of all) map.set(c.Title.toLowerCase(), c)
          setCards(map)
          return
        } catch {
          if (i === 1) break
        }
      }
    })

    const onBroadcast = (_target: string, _contentType: string, message: string) => {
      try {
        const data = JSON.parse(message)
        const raw = data?.cards
        if (Array.isArray(raw)) setDetected(raw.filter(isValidSlot))
      } catch {}
    }
    twitch.listen('broadcast', onBroadcast)

    twitch.onVisibilityChanged?.((isVisible) => {
      if (!isVisible) setDetected([])
    })

    return () => twitch.unlisten('broadcast', onBroadcast)
  }, [])

  const handleHover = useCallback((slot: DetectedSlot) => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const cx = slot.x * vw + (slot.w * vw) / 2
    const cy = slot.y * vh
    const left = `${Math.max(4, Math.min(vw - 264, cx + 140 > vw ? cx - 280 : cx))}px`
    const top = `${Math.max(4, Math.min(vh - 244, cy + 240 > vh ? cy - 240 : cy))}px`
    setTooltipPos({ left, top })
    setHovered(slot)
  }, [])

  const handleLeave = useCallback(() => setHovered(null), [])

  const hoveredCard = hovered ? cards.get(hovered.title.toLowerCase()) ?? null : null

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
          card={hoveredCard}
          tier={hovered.tier}
          visible={true}
          style={{ position: 'absolute', left: tooltipPos.left, top: tooltipPos.top }}
        />
      )}
    </div>
  )
}
