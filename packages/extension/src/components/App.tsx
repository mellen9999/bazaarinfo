import { useState, useEffect, useCallback, useRef } from 'preact/hooks'
import type { BazaarCard, TierName } from '@bazaarinfo/shared/src/types'
import { HoverZone } from './HoverZone'
import type { DetectedSlot } from './HoverZone'
import { CardTooltip } from './CardTooltip'

declare global {
  interface Window {
    Twitch: {
      ext: {
        onAuthorized: (cb: (auth: { token: string; channelId: string; clientId: string }) => void) => void
        listen: (target: string, cb: (target: string, contentType: string, message: string) => void) => void
      }
    }
  }
}

const EBS_BASE = 'https://ebs.bazaarinfo.com'

export function App() {
  const cardsRef = useRef<Map<string, BazaarCard>>(new Map())
  const [detected, setDetected] = useState<DetectedSlot[]>([])
  const [hovered, setHovered] = useState<DetectedSlot | null>(null)
  const [tooltipPos, setTooltipPos] = useState({ left: '0', top: '0' })

  useEffect(() => {
    const twitch = window.Twitch?.ext
    if (!twitch) return

    twitch.onAuthorized(async (auth) => {
      try {
        const res = await fetch(`${EBS_BASE}/api/cards`, {
          headers: { Authorization: `Bearer ${auth.token}` },
        })
        if (!res.ok) return
        const data = await res.json() as { items: BazaarCard[]; skills: BazaarCard[] }
        const map = new Map<string, BazaarCard>()
        for (const c of data.items ?? []) map.set(c.Title.toLowerCase(), c)
        for (const c of data.skills ?? []) map.set(c.Title.toLowerCase(), c)
        cardsRef.current = map
      } catch {}
    })

    twitch.listen('broadcast', (_target, _contentType, message) => {
      try {
        const data = JSON.parse(message)
        if (Array.isArray(data?.cards)) setDetected(data.cards)
      } catch {}
    })
  }, [])

  const handleHover = useCallback((slot: DetectedSlot) => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const cx = slot.x * vw + (slot.w * vw) / 2
    const cy = slot.y * vh

    setTooltipPos({
      left: cx + 280 > vw ? `${cx - 290}px` : `${cx}px`,
      top: cy - 250 < 0 ? `${cy + slot.h * vh + 8}px` : `${cy - 250}px`,
    })
    setHovered(slot)
  }, [])

  const handleLeave = useCallback(() => setHovered(null), [])

  const hoveredCard = hovered ? cardsRef.current.get(hovered.title.toLowerCase()) ?? null : null

  return (
    <div class="overlay">
      {detected.filter((slot) => slot.type !== 'Skill' && slot.owner !== 'opponent').map((slot) => (
        <HoverZone
          key={`${slot.title}-${slot.x}-${slot.y}`}
          {...slot}
          onHover={handleHover}
          onLeave={handleLeave}
        />
      ))}
      {hovered && hoveredCard && (
        <CardTooltip
          card={hoveredCard}
          tier={hovered.tier}
          enchantment={hovered.enchantment}
          visible={true}
          style={{ position: 'absolute', left: tooltipPos.left, top: tooltipPos.top }}
        />
      )}
    </div>
  )
}
