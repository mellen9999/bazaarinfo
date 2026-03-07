import { useState, useEffect, useCallback } from 'preact/hooks'
import type { BazaarCard } from '@bazaarinfo/shared/src/types'
import { HoverZone } from './HoverZone'
import type { DetectedSlot } from './HoverZone'
import { CardTooltip } from './CardTooltip'
import { fetchCards } from '../twitch'

export function App() {
  const [cards, setCards] = useState<Map<string, BazaarCard>>(new Map())
  const [detected, setDetected] = useState<DetectedSlot[]>([])
  const [hovered, setHovered] = useState<DetectedSlot | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ left: string; top: string }>({ left: '0', top: '0' })

  useEffect(() => {
    const twitch = window.Twitch?.ext
    if (!twitch) return

    twitch.onAuthorized(async (auth) => {
      try {
        const all = await fetchCards(auth.token)
        const map = new Map<string, BazaarCard>()
        for (const c of all) map.set(c.Title.toLowerCase(), c)
        setCards(map)
      } catch {}
    })

    twitch.listen('broadcast', (_target, _contentType, message) => {
      try {
        const data = JSON.parse(message)
        const slots = data?.cards as DetectedSlot[] | undefined
        if (Array.isArray(slots)) setDetected(slots)
      } catch {}
    })
  }, [])

  const handleHover = useCallback((slot: DetectedSlot) => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const cx = slot.x * vw + (slot.w * vw) / 2
    const cy = slot.y * vh
    const left = cx + 140 > vw ? `${cx - 280}px` : `${cx}px`
    const top = cy + 240 > vh ? `${cy - 240}px` : `${cy}px`
    setTooltipPos({ left, top })
    setHovered(slot)
  }, [])

  const handleLeave = useCallback(() => setHovered(null), [])

  const hoveredCard = hovered ? cards.get(hovered.title.toLowerCase()) ?? null : null

  return (
    <div class=overlay>
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
