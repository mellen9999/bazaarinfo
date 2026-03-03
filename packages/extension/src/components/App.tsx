import { useState, useEffect, useCallback } from 'preact/hooks'
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

interface ShopCard {
  title: string
  type: string
  tier: string
  size: string
}

const EBS_BASE = 'https://ebs.bazaarinfo.com'

export function App() {
  const [cards, setCards] = useState<Map<string, BazaarCard>>(new Map())
  const [detected, setDetected] = useState<DetectedSlot[]>([])
  const [shop, setShop] = useState<ShopCard[]>([])
  const [hovered, setHovered] = useState<DetectedSlot | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ left: string; top: string }>({ left: '0', top: '0' })
  const [debug, setDebug] = useState('loading...')

  useEffect(() => {
    const twitch = window.Twitch?.ext
    if (!twitch) return

    twitch.onAuthorized(async (auth) => {
      setDebug('auth ok, fetching cards...')
      try {
        const res = await fetch(`${EBS_BASE}/api/cards`, {
          headers: { Authorization: `Bearer ${auth.token}` },
        })
        if (!res.ok) {
          setDebug(`fetch failed: ${res.status}`)
          return
        }
        const data = await res.json() as { items: BazaarCard[]; skills: BazaarCard[] }
        const map = new Map<string, BazaarCard>()
        for (const c of [...(data.items ?? []), ...(data.skills ?? [])]) {
          map.set(c.Title.toLowerCase(), c)
        }
        setCards(map)
        setDebug(`${map.size} cards, waiting for pubsub...`)
      } catch (e) {
        setDebug(`error: ${e}`)
      }
    })

    twitch.listen('broadcast', (_target, _contentType, message) => {
      try {
        const data = JSON.parse(message)
        const slots = data?.cards as DetectedSlot[] | undefined
        if (Array.isArray(slots)) {
          setDetected(slots)
        }
        const shopData = data?.shop as ShopCard[] | undefined
        if (Array.isArray(shopData)) {
          setShop(shopData)
        } else {
          setShop([])
        }
        const boardCount = slots?.length ?? 0
        const shopCount = shopData?.length ?? 0
        setDebug(`${boardCount} board${shopCount > 0 ? ` · ${shopCount} shop` : ''}`)
      } catch (e) {
        setDebug(`pubsub err: ${e}`)
      }
    })
  }, [])

  const handleHover = useCallback((slot: DetectedSlot) => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const cx = slot.x * vw + (slot.w * vw) / 2
    const cy = slot.y * vh

    const left = cx + 280 > vw ? `${cx - 290}px` : `${cx}px`
    const top = cy - 250 < 0 ? `${cy + slot.h * vh + 8}px` : `${cy - 250}px`

    setTooltipPos({ left, top })
    setHovered(slot)
  }, [])

  const handleLeave = useCallback(() => setHovered(null), [])

  const hoveredCard = hovered ? cards.get(hovered.title.toLowerCase()) ?? null : null

  return (
    <div class="overlay">
      <div style={{ position: 'absolute', top: '4px', left: '4px', background: 'rgba(0,0,0,0.8)', color: '#0f0', fontSize: '11px', padding: '4px 8px', borderRadius: '4px', pointerEvents: 'none', zIndex: 999 }}>
        {debug}
      </div>
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
          enchantment={hovered.enchantment}
          visible={true}
          style={{ position: 'absolute', left: tooltipPos.left, top: tooltipPos.top }}
        />
      )}
    </div>
  )
}
