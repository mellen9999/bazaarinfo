import { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect } from 'preact/hooks'
import type { BazaarCard } from '@bazaarinfo/shared/src/types'
import { HoverZone } from './HoverZone'
import type { DetectedSlot } from './HoverZone'
import { CardTooltip } from './CardTooltip'
import type { MissingReason } from './CardTooltip'
import { TooltipBoundary } from './TooltipBoundary'
import { fetchCards, CARD_FETCH_BACKOFF } from '../twitch'
import { deriveValidTiers, isPlausibleTierString } from '../tiers'
import { parseCrop, applyCrop, IDENTITY_CROP } from '../viewport'
import type { Crop } from '../viewport'
import { tessellate, separateRows, padVertical } from '../tessellate'
import { uiScale, fitScale } from '../scale'

const VIEWPORT_MARGIN = 4
const MAX_SLOTS = 50
// The tooltip's own 1px frame, top and bottom. scrollHeight measures content, so
// the border has to be added back before comparing against the room available.
const TOOLTIP_BORDER = 2
// Clear the overlay if no frame arrives for this long. The companion heartbeats
// every 30s while a board is shown, so a live stream refreshes well within this
// window; only a dead companion (crash, closed app, network drop) goes silent
// longer — without this its last frame would haunt the overlay forever, leaving
// viewers hovering phantom cards over a board that has since changed.
const STALE_TTL_MS = 75_000

const DEFAULT_ASPECT = 16 / 9 // Twitch/The Bazaar broadcast; onContext refines it

interface Rect { left: number; top: number; width: number; height: number }

// The video's rectangle inside the overlay iframe. Twitch gives no guarantee the
// iframe equals the video area — in theater/fullscreen/mobile or a non-16:9
// broadcast it can span a padded container with letterbox bars, which would
// shift every % -positioned zone. We size the overlay to the centered video rect
// so all normalized coords resolve against the video, not the bars. When the
// iframe already matches the video aspect (the standard desktop case) this
// returns the full iframe — a pure no-op. Measured from the real iframe
// (innerWidth/innerHeight), since Twitch's displayResolution is unreliable.
export function computeOverlayRect(aspect: number): Rect {
  const iw = window.innerWidth
  const ih = window.innerHeight
  if (!iw || !ih || !Number.isFinite(aspect) || aspect <= 0) return { left: 0, top: 0, width: iw, height: ih }
  const framed = iw / ih
  if (framed > aspect) {
    const width = ih * aspect
    return { left: (iw - width) / 2, top: 0, width, height: ih }
  }
  const height = iw / aspect
  return { left: 0, top: (ih - height) / 2, width: iw, height }
}

export function parseAspect(res: string | undefined): number | null {
  if (!res) return null
  const m = /^(\d+)\s*x\s*(\d+)$/.exec(res.trim())
  if (!m) return null
  const w = Number(m[1]), h = Number(m[2])
  return w > 0 && h > 0 ? w / h : null
}

export function makeSlotValidator(validTiers: Set<string>) {
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
    // reject a zone big enough to blanket the video and swallow all clicks — no real
    // card covers a fifth of the frame; a buggy/hostile whole-board bbox would.
    if (o.w * o.h > 0.2) return false
    // optional fields: if present they must be well-formed strings (a non-string
    // slips through the `typeof === 'string'` guards below and violates the contract)
    if (o.owner !== undefined && (typeof o.owner !== 'string' || o.owner.length > 50)) return false
    if (o.type !== undefined && (typeof o.type !== 'string' || o.type.length > 50)) return false
    if (o.enchantment !== undefined && (typeof o.enchantment !== 'string' || o.enchantment.length > 50)) return false
    if (o.tierKnown !== undefined && typeof o.tierKnown !== 'boolean') return false
    return true
  }
}

// Identity of a detected slot across frames. Includes w/h and type so a resized or
// retyped slot is a distinct identity (used for the render key AND for tracking the
// hovered slot as the board updates). NUL-separated so values can't run together.
function slotKey(s: DetectedSlot): string {
  return [s.title, s.tier, s.owner ?? '', s.type ?? '', s.enchantment ?? '', s.x, s.y, s.w, s.h].join('\u0000')
}

export function slotsEqual(a: DetectedSlot[], b: DetectedSlot[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].title !== b[i].title || a[i].x !== b[i].x || a[i].y !== b[i].y || a[i].w !== b[i].w || a[i].h !== b[i].h || a[i].tier !== b[i].tier || a[i].enchantment !== b[i].enchantment || a[i].owner !== b[i].owner || a[i].type !== b[i].type || a[i].tierKnown !== b[i].tierKnown) return false
  }
  return true
}

export function App() {
  const [cards, setCards] = useState<Map<string, BazaarCard>>(new Map())
  const [detected, setDetected] = useState<DetectedSlot[]>([])
  // Broadcaster's game-area crop (identity = fullscreen; the default). Applied to
  // every slot before it is painted so windowed/letterboxed captures line up.
  const [crop, setCrop] = useState<Crop>(IDENTITY_CROP)
  // Video rect within the iframe (see computeOverlayRect). Sizes the overlay so
  // % -positioned zones track the video through letterbox/pillarbox; no-op at 16:9.
  const [overlayRect, setOverlayRect] = useState<Rect>(() => computeOverlayRect(DEFAULT_ASPECT))
  const aspectRef = useRef(DEFAULT_ASPECT)
  // Distinguishes "no tooltip yet because we're still fetching" from "we fetched
  // and this card genuinely isn't in the data" — the viewer sees a different line
  // for each, instead of the old silent nothing for both.
  const [cardsState, setCardsState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [hovered, setHovered] = useState<DetectedSlot | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ left: string; top: string }>({ left: '0', top: '0' })
  const cardsLoaded = useRef(false)
  const tooltipRef = useRef<HTMLDivElement | null>(null)
  const lastSlotRef = useRef<DetectedSlot | null>(null)
  const validatorRef = useRef<(s: unknown) => s is DetectedSlot>(makeSlotValidator(new Set<string>()))
  const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Real wall-clock time of the last accepted frame, so visibility-on can re-judge
  // staleness against how much time actually passed — not just re-arm a fresh window.
  const lastFrameAtRef = useRef(0)

  useEffect(() => {
    let mounted = true
    const twitch = window.Twitch?.ext
    // An overlay sits on top of gameplay, so it stays visually silent even when
    // broken — no banner belongs on someone's stream — but a console line means
    // this isn't a silent, undiagnosable dead end.
    if (!twitch) { console.error('bazaarinfo overlay: twitch extension helper unavailable'); return }

    // Read the broadcaster's calibrated game-area crop from the Twitch config
    // service, and re-read whenever they change it. parseCrop fails safe to
    // identity, so a missing/corrupt value simply leaves the overlay fullscreen.
    const readCrop = () => setCrop(parseCrop(twitch.configuration?.broadcaster?.content))
    readCrop()
    twitch.configuration?.onChanged?.(readCrop)

    // Fit the overlay to the video rect; refine the aspect from the broadcast
    // resolution when Twitch reports it, and refit on every layout change.
    const refit = () => setOverlayRect(computeOverlayRect(aspectRef.current))
    twitch.onContext?.((ctx) => {
      const a = parseAspect(ctx?.videoResolution)
      if (a) aspectRef.current = a
      refit()
    })
    refit()

    twitch.onAuthorized(async (auth) => {
      if (cardsLoaded.current) return
      for (let i = 0; i < CARD_FETCH_BACKOFF.length; i++) {
        if (CARD_FETCH_BACKOFF[i] > 0) {
          await new Promise((r) => setTimeout(r, CARD_FETCH_BACKOFF[i]))
          if (!mounted || cardsLoaded.current) return
        }
        try {
          const all = await fetchCards(auth.token)
          if (!mounted) return
          // An empty list is a failure wearing a success's clothes: it would leave
          // every card "unknown" forever with no sign anything went wrong.
          if (all.length === 0) throw new Error('empty')
          const map = new Map<string, BazaarCard>()
          for (const c of all) map.set(c.Title.toLowerCase(), c)
          setCards(map)
          validatorRef.current = makeSlotValidator(deriveValidTiers(all))
          cardsLoaded.current = true
          setCardsState('ready')
          return
        } catch {
          if (i === CARD_FETCH_BACKOFF.length - 1 && mounted) setCardsState('failed')
        }
      }
    })

    // Every valid frame (including the companion's heartbeat and empty clear
    // frames) proves the sender is alive, so arm a fresh expiry each time. If
    // the timer ever fires, the companion has gone silent past the heartbeat —
    // wipe the board so viewers never hover a stale detection.
    const armStaleTimer = (delay = STALE_TTL_MS) => {
      if (staleTimerRef.current) clearTimeout(staleTimerRef.current)
      staleTimerRef.current = setTimeout(() => {
        setDetected([])
        setHovered(null)
      }, delay)
    }

    const onBroadcast = (_target: string, _contentType: string, message: string) => {
      if (!message.includes('"cards"')) return
      try {
        const data = JSON.parse(message)
        // Forward-compatible on purpose: render whatever `cards` we can validate,
        // regardless of the protocol version field. The per-slot validator below IS
        // the compatibility contract — a future additive field is ignored, and an
        // incompatible one (e.g. out-of-range coords) is filtered out, failing safe
        // to an empty overlay rather than a wrong one. This is what lets the backend
        // evolve the protocol forever without ever forcing an extension re-review;
        // never reintroduce a version gate that hard-drops whole messages.
        const raw = data?.cards
        if (Array.isArray(raw)) {
          const next = raw.slice(0, MAX_SLOTS).filter(validatorRef.current)
          setDetected(prev => slotsEqual(prev, next) ? prev : next)
          lastFrameAtRef.current = Date.now()
          armStaleTimer()
        }
      } catch {}
    }
    twitch.listen('broadcast', onBroadcast)

    twitch.onVisibilityChanged?.((isVisible) => {
      if (!isVisible) {
        // Stop counting down while hidden — a viewer toggling the overlay off
        // doesn't mean the companion went dark — but keep `detected` so the
        // board is still there the instant they toggle back on.
        if (staleTimerRef.current) clearTimeout(staleTimerRef.current)
        setHovered(null)
        return
      }
      // Re-prime against the frame's real age, not a fresh STALE_TTL_MS: a
      // companion that had already gone quiet before we hid must still hide the
      // board on return, not linger up to another full TTL past reappearing.
      const age = Date.now() - lastFrameAtRef.current
      if (lastFrameAtRef.current === 0 || age >= STALE_TTL_MS) {
        setDetected([])
      } else {
        armStaleTimer(STALE_TTL_MS - age)
      }
    })

    return () => {
      mounted = false
      twitch.unlisten('broadcast', onBroadcast)
      if (staleTimerRef.current) clearTimeout(staleTimerRef.current)
    }
  }, [])

  // One number for how big the overlay's UI should be, from how big the video is.
  const uiBase = useMemo(() => uiScale(overlayRect.height), [overlayRect.height])

  const positionTooltip = useCallback((slot: DetectedSlot) => {
    lastSlotRef.current = slot
    const tip = tooltipRef.current
    // Coordinates are relative to `.overlay`, which is sized to the video rect —
    // so px math runs against the video dimensions, not the raw viewport.
    const vw = overlayRect.width
    const vh = overlayRect.height
    // The frame the tooltip must stay inside is the iframe, not the video: in
    // letterbox/pillarbox the bars are ours to use, and putting the tooltip on a
    // black bar covers no game at all. In the standard 16:9 case they're equal.
    const frameW = window.innerWidth
    const frameH = window.innerHeight

    // Fit to frame before measuring. The tooltip can't scroll (pointer-events is
    // none, so a scrollbar would be unreachable), so anything taller than the frame
    // shrinks its type until every line shows rather than losing the tail silently.
    // Reset first: the previous card's shrink says nothing about this one.
    if (tip) {
      tip.style.removeProperty('--fit')
      const natural = tip.scrollHeight + TOOLTIP_BORDER
      const room = frameH - VIEWPORT_MARGIN * 2
      const fit = fitScale(uiBase, natural, room)
      if (fit !== uiBase) tip.style.setProperty('--fit', String(fit / uiBase))
    }

    const tipW = tip?.offsetWidth ?? Math.min(280, vw - VIEWPORT_MARGIN * 2)
    const tipH = tip?.offsetHeight ?? Math.min(320, vh - VIEWPORT_MARGIN * 2)

    const slotCx = slot.x * vw + (slot.w * vw) / 2
    const slotTop = slot.y * vh
    const slotBottom = (slot.y + slot.h) * vh

    // Frame bounds, expressed in `.overlay` coordinates (it sits at overlayRect
    // inside the iframe), so a tooltip may sit over a letterbox bar.
    const frameRight = frameW - overlayRect.left - VIEWPORT_MARGIN
    const minLeft = VIEWPORT_MARGIN - overlayRect.left
    const maxLeft = frameRight - tipW
    const minTop = VIEWPORT_MARGIN - overlayRect.top
    const maxTop = frameH - overlayRect.top - tipH - VIEWPORT_MARGIN

    // Prefer placing tooltip right of slot center, but flip if it overflows
    const wantLeft = slotCx + tipW / 2 > frameRight ? slotCx - tipW : slotCx
    const left = Math.max(minLeft, Math.min(maxLeft, wantLeft))

    // Prefer above slot, fall back to below if no room
    const wantTop = slotTop - tipH - 8 < minTop ? slotBottom + 8 : slotTop - tipH - 8
    const top = Math.max(minTop, Math.min(maxTop, wantTop))

    setTooltipPos({ left: `${left}px`, top: `${top}px` })
  }, [overlayRect, uiBase])

  const handleHover = useCallback((slot: DetectedSlot) => {
    setHovered(slot)
    positionTooltip(slot)
  }, [positionTooltip])

  const handleLeave = useCallback(() => {
    setHovered(null)
    lastSlotRef.current = null
  }, [])

  // Slots as painted: raw detections remapped into the broadcaster's game area,
  // then tessellated so hovers landing in the gap between adjacent cards still
  // resolve, rows pulled apart so no zone can answer for a card in another row, and
  // finally padded within whatever room is left. Identity crop is a pure
  // pass-through, so fullscreen streamers are unaffected by the remap; none of the
  // three steps ever shifts a card off its center. Everything downstream (zones,
  // tooltip, hover tracking) consumes these display coords; `detected` stays raw for
  // the wire contract.
  const displayed = useMemo(
    () => padVertical(separateRows(tessellate(detected.map(s => applyCrop(s, crop)))), 0.12, 0.03),
    [detected, crop],
  )

  // re-clamp tooltip when its rendered size is known and on resize
  useLayoutEffect(() => {
    if (hovered) positionTooltip(hovered)
  }, [hovered, positionTooltip])

  useEffect(() => {
    const onResize = () => setOverlayRect(computeOverlayRect(aspectRef.current))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

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

  // Reconcile the hovered slot whenever the board changes. A HoverZone that unmounts
  // (card sold/reordered/swapped in combat) does not reliably fire onMouseLeave, so
  // without this the tooltip would linger over a card that has left the board. If the
  // hovered card is gone, clear; if it moved/resized, re-point so the tooltip tracks it.
  useEffect(() => {
    if (!hovered) return
    const key = slotKey(hovered)
    const match = displayed.find(s => slotKey(s) === key)
      ?? displayed.find(s => s.title === hovered.title && s.owner === hovered.owner)
    if (!match) {
      setHovered(null)
      lastSlotRef.current = null
    } else if (match !== hovered) {
      setHovered(match)
    }
  }, [displayed]) // eslint-disable-line react-hooks/exhaustive-deps

  const hoveredCard = useMemo(
    () => hovered ? cards.get(hovered.title.toLowerCase()) ?? null : null,
    [hovered, cards],
  )

  const tooltipStyle = useMemo(
    () => ({ position: 'absolute' as const, left: tooltipPos.left, top: tooltipPos.top }),
    [tooltipPos.left, tooltipPos.top],
  )

  const overlayStyle = useMemo(
    () => ({
      position: 'absolute' as const,
      left: `${overlayRect.left}px`,
      top: `${overlayRect.top}px`,
      width: `${overlayRect.width}px`,
      height: `${overlayRect.height}px`,
      '--ui': String(uiBase),
    }),
    [overlayRect.left, overlayRect.top, overlayRect.width, overlayRect.height, uiBase],
  )

  // A hovered card with no entry in the dump still gets a tooltip: the wire told us
  // its name and tier, which is more than the viewer could read off the stream, and
  // rendering nothing at all is indistinguishable from the extension being broken.
  const missing: MissingReason | undefined = hoveredCard
    ? undefined
    : cardsState === 'ready' ? 'unknown' : cardsState === 'failed' ? 'failed' : 'loading'

  return (
    <div class="overlay" style={overlayStyle}>
      {displayed.map((slot, i) => (
        <HoverZone
          key={`${slotKey(slot)} ${i}`}
          {...slot}
          onHover={handleHover}
          onLeave={handleLeave}
        />
      ))}
      {hovered && (
        <TooltipBoundary key={hovered.title}>
          <CardTooltip
            ref={tooltipRef}
            card={hoveredCard}
            title={hovered.title}
            tier={hovered.tier}
            enchantment={hovered.enchantment}
            tierKnown={hovered.tierKnown}
            missing={missing}
            visible={true}
            style={tooltipStyle}
          />
        </TooltipBoundary>
      )}
    </div>
  )
}
