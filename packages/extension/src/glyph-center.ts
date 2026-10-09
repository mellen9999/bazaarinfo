// Centres icon glyphs on their INK, not on their advance box.
//
// A monospace font's glyph sits wherever its designer drew it inside the cell:
// DejaVu's ✖ rides high, Consolas' ↗ hangs left, Menlo's ⌕ drops. CSS can only
// centre the em box, so the same markup looks centred in one viewer's font and
// crooked in the next. This measures the real ink once per glyph+font (canvas
// measureText) and nudges the element by the difference, in em, via --gx/--gy
// (style.css turns them into a translate). Nothing is guessed: when canvas or its
// metrics are missing the offset is 0, which is the plain CSS-centred result.

export interface InkMetrics {
  adv: number // advance width
  left: number // actualBoundingBoxLeft
  right: number // actualBoundingBoxRight
  asc: number // actualBoundingBoxAscent (above baseline)
  desc: number // actualBoundingBoxDescent (below baseline)
  fAsc: number // fontBoundingBoxAscent
  fDesc: number // fontBoundingBoxDescent
}

export interface Offset { x: number; y: number }

const ZERO: Offset = { x: 0, y: 0 }
const finite = (n: number) => (Number.isFinite(n) ? n : 0)

// Offset in em that moves the ink centre onto the centre of its box, for a glyph in
// a line-height:1 box. `size` is the px the metrics were taken at: the engine rounds
// ascent and descent to whole pixels and floors the half-leading before it places the
// baseline, so the maths does the same or it lands a pixel off at small sizes.
export function inkOffset(m: InkMetrics, size: number, xMidUp?: number): Offset {
  if (!(size > 0)) return ZERO
  const fA = Math.round(finite(m.fAsc))
  const fD = Math.round(finite(m.fDesc))
  // metrics the engine did not report: don't invent an offset from half a set
  if (fA + fD <= 0 || !(finite(m.asc) + finite(m.desc) > 0 || finite(m.right) + finite(m.left) > 0)) return ZERO
  // the engine floors the half-leading, so the baseline lands on a whole pixel
  const baseline = fA + Math.floor((size - (fA + fD)) / 2)
  const inkUp = (finite(m.asc) - finite(m.desc)) / 2 // ink centre, above the baseline
  // default target: the middle of the box. With xMidUp the box sits ON the baseline
  // (separators) and the target is that far above it — the middle of the x-height.
  const targetUp = xMidUp === undefined ? baseline - size / 2 : finite(xMidUp)
  const dy = inkUp - targetUp
  const dx = (finite(m.adv) - finite(m.right) + finite(m.left)) / 2
  return { x: finite(dx / size), y: finite(dy / size) }
}

const BASE = 200 // px the ink is measured at: big enough that sub-pixel ink is exact
const ink = new Map<string, InkMetrics | null>()
const lines = new Map<string, { fAsc: number; fDesc: number } | null>()
let ctx: CanvasRenderingContext2D | null | undefined

function context(): CanvasRenderingContext2D | null {
  if (ctx !== undefined) return ctx
  try { ctx = document.createElement('canvas').getContext('2d') } catch { ctx = null }
  return ctx
}

function measureAt(glyph: string, style: string, weight: string, family: string, px: number): TextMetrics | null {
  const c = context()
  if (!c) return null
  try {
    c.font = `${style} ${weight} ${px}px ${family}`
    c.textBaseline = 'alphabetic'
    c.textAlign = 'left'
    const t = c.measureText(glyph)
    return typeof t.fontBoundingBoxAscent === 'number' && typeof t.actualBoundingBoxAscent === 'number' ? t : null
  } catch { return null }
}

// The ink is measured once, big, and scaled: at 14px the engine reports it in whole
// pixels, which is the half-pixel error this exists to remove. Ascent and descent are
// the opposite — the engine rounds them at the REAL size when it places the baseline,
// so those are asked at the real size (cached per font + size, a handful ever).
function inkAt(glyph: string, style: string, weight: string, family: string): InkMetrics | null {
  const key = `${style}|${weight}|${family}|${glyph}`
  const hit = ink.get(key)
  if (hit !== undefined) return hit
  const t = measureAt(glyph, style, weight, family, BASE)
  const out = t && {
    adv: t.width, left: t.actualBoundingBoxLeft, right: t.actualBoundingBoxRight,
    asc: t.actualBoundingBoxAscent, desc: t.actualBoundingBoxDescent, fAsc: 0, fDesc: 0,
  }
  ink.set(key, out)
  return out
}

function lineAt(style: string, weight: string, family: string, px: number) {
  const key = `${style}|${weight}|${family}|${px}`
  const hit = lines.get(key)
  if (hit !== undefined) return hit
  const t = measureAt('x', style, weight, family, px)
  const out = t && { fAsc: t.fontBoundingBoxAscent, fDesc: t.fontBoundingBoxDescent }
  lines.set(key, out)
  return out
}

// fonts arriving invalidate what was measured
export function resetGlyphCache() { ink.clear(); lines.clear() }

// Offset (em) for the glyph at the element's real px size. `host` is the font of the
// text the glyph sits in, given only for x-height-centred glyphs (separators).
export interface HostFont { style: string; weight: string; family: string; px: number }
export function offsetFor(glyph: string, style: string, weight: string, family: string, px: number, host?: HostFont): Offset {
  const m = inkAt(glyph, style, weight, family)
  const l = lineAt(style, weight, family, px)
  if (!m || !l || !(px > 0)) return ZERO
  const k = px / BASE
  let xMidUp: number | undefined
  if (host) {
    const x = inkAt('x', host.style, host.weight, host.family)
    if (!x || !(host.px > 0)) return ZERO
    xMidUp = (x.asc * host.px) / BASE / 2
  }
  return inkOffset({
    adv: m.adv * k, left: m.left * k, right: m.right * k, asc: m.asc * k, desc: m.desc * k,
    fAsc: l.fAsc, fDesc: l.fDesc,
  }, px, xMidUp)
}

// Text in a box (chip, tag, result row) is centred on the middle of its x-height: the
// copy is lowercase, so that is where the eye puts the middle, and the em box (what
// CSS centres) sits a pixel lower. Returned in em as a padding shift — positive moves
// the text down. `lh` is the box's used line-height in px.
export function textShift(style: string, weight: string, family: string, px: number, lh: number): number {
  const x = inkAt('x', style, weight, family)
  const l = lineAt(style, weight, family, px)
  if (!x || !l || !(px > 0) || !(lh > 0)) return 0
  const fA = Math.round(l.fAsc)
  const fD = Math.round(l.fDesc)
  const baseline = fA + Math.floor((lh - (fA + fD)) / 2)
  const d = lh / 2 - (baseline - (x.asc * px) / BASE / 2)
  return Number.isFinite(d) ? d / px : 0
}

const applied = new WeakMap<Element, string>()

// One batched pass: read every glyph's font, then write every offset, so no write
// forces a layout between two reads.
export function centerGlyphs(root: ParentNode = document) {
  const jobs: Array<[HTMLElement, string, Offset]> = []
  for (const el of root.querySelectorAll<HTMLElement>('.glyph > .gi')) {
    const cs = getComputedStyle(el)
    const px = parseFloat(cs.fontSize)
    // separators are centred on the x-height middle of the text around them
    const box = el.parentElement
    const hc = box?.classList.contains('glyph--xmid') && box.parentElement ? getComputedStyle(box.parentElement) : null
    const host = hc ? { style: hc.fontStyle, weight: hc.fontWeight, family: hc.fontFamily, px: parseFloat(hc.fontSize) } : undefined
    const sig = `${cs.fontFamily}|${cs.fontWeight}|${cs.fontStyle}|${px}|${el.textContent}|${host ? `${host.family}|${host.weight}|${host.px}` : ''}`
    if (applied.get(el) === sig) continue
    jobs.push([el, sig, offsetFor(el.textContent ?? '', cs.fontStyle, cs.fontWeight, cs.fontFamily, px, host)])
  }
  const shifts: Array<[HTMLElement, string, number]> = []
  for (const el of root.querySelectorAll<HTMLElement>('.xc')) {
    const cs = getComputedStyle(el)
    const px = parseFloat(cs.fontSize)
    const lh = parseFloat(cs.lineHeight)
    const sig = `${cs.fontFamily}|${cs.fontWeight}|${cs.fontStyle}|${px}|${lh}`
    if (applied.get(el) === sig) continue
    shifts.push([el, sig, textShift(cs.fontStyle, cs.fontWeight, cs.fontFamily, px, lh)])
  }
  for (const [el, sig, o] of jobs) {
    el.style.setProperty('--gx', o.x.toFixed(4))
    el.style.setProperty('--gy', o.y.toFixed(4))
    applied.set(el, sig)
  }
  for (const [el, sig, d] of shifts) {
    el.style.setProperty('--xc', d.toFixed(4))
    applied.set(el, sig)
  }
}

// Keep every `.glyph` centred as the page changes: mount, text swaps, a --ui or --fit
// resize, fonts arriving. Style writes made on `.gi` / `.xc` nodes are ignored by the observer, so
// it cannot feed itself.
export function watchGlyphs(root: HTMLElement = document.body) {
  let queued = false
  const run = () => { queued = false; centerGlyphs(root) }
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(run) } }
  new MutationObserver((muts) => {
    // our own writes (style on .gi / .xc) must not wake us again
    const own = (m: MutationRecord) => m.type === 'attributes' && m.attributeName === 'style' && (m.target as Element).matches?.('.gi, .xc')
    if (muts.some((m) => !own(m))) schedule()
  }).observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style', 'class'] })
  window.addEventListener('resize', schedule)
  const fonts = document.fonts
  if (fonts) {
    fonts.ready.then(() => { resetGlyphCache(); schedule() }).catch(() => {})
    fonts.addEventListener?.('loadingdone', () => { resetGlyphCache(); schedule() })
  }
  schedule()
}
