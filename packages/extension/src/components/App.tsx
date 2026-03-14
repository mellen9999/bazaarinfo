import { useState, useEffect, useCallback, useMemo } from 'preact/hooks'
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
  const [dbg, setDbg] = useState('init')

  useEffect(() => {
    const twitch = window.Twitch?.ext
    if (!twitch) { setDbg('no twitch helper'); return }
    setDbg('waiting for auth...')

    twitch.onAuthorized(async (auth) => {
      setDbg('authed, fetching cards...')
      for (let i = 0; i < 2; i++) {
        try {
          const all = await fetchCards(auth.token)
          const map = new Map<string, BazaarCard>()
          for (const c of all) map.set(c.Title.toLowerCase(), c)
          setCards(map)
          setDbg(`${map.size} cards, listening`)
          return
        } catch (e) {
          setDbg(`fetch err ${i}: ${(e as Error).message}`)
          if (i === 1) break
        }
      }
    })

    const onBroadcast = (_target: string, _contentType: string, message: string) => {
      try {
        const data = JSON.parse(message)
        const raw = data?.cards
        if (Array.isArray(raw)) {
          const valid = raw.filter(isValidSlot)
          setDetected(valid)
          setDbg(prev => prev.replace(/listening.*/, `listening | ${valid.length} slots`))
        }
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

  const hoveredCard = useMemo(
    () => hovered ? cards.get(hovered.title.toLowerCase()) ?? null : null,
    [hovered, cards],
  )

  return (
    <div class="overlay">
      <div style={{
        position: 'absolute', bottom: '4px', left: '4px', padding: '2px 6px',
        background: 'rgba(0,0,0,0.7)', color: '#0f0', fontSize: '10px',
        fontFamily: 'monospace', borderRadius: '3px', zIndex: 999,
        pointerEvents: 'none',
      }}>{dbg}</div>
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
