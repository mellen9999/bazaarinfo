// Game-area calibrator for the extension config view.
//
// The broadcaster draws a box around where their game video sits inside the
// stream frame. That box IS the crop the overlay applies to every card position,
// so windowed / letterboxed / OBS-cropped captures line up instead of drifting.
// Fullscreen streamers never need to touch this — identity (the full frame) is
// the default and what an unset config resolves to.
//
// CSP-clean: no inline handlers, no eval. Pure DOM + the Twitch config service.

import { parseCrop, clampCrop, serializeCrop, isIdentityCrop, IDENTITY_CROP } from './viewport'
import type { Crop } from './viewport'

const NUDGE = 0.005 // arrow-key step; Shift multiplies
const NUDGE_BIG = 0.05
const MIN_SCALE = 0.05
const CONFIG_VERSION = '1'

interface Els {
  stage: HTMLElement
  box: HTMLElement
  handle: HTMLElement
  readout: HTMLElement
  save: HTMLButtonElement
  reset: HTMLButtonElement
  status: HTMLElement
}

function getEls(): Els | null {
  const stage = document.getElementById('cal-stage')
  const box = document.getElementById('cal-box')
  const handle = document.getElementById('cal-handle')
  const readout = document.getElementById('cal-readout')
  const save = document.getElementById('cal-save') as HTMLButtonElement | null
  const reset = document.getElementById('cal-reset') as HTMLButtonElement | null
  const status = document.getElementById('cal-status')
  if (!stage || !box || !handle || !readout || !save || !reset || !status) return null
  return { stage, box, handle, readout, save, reset, status }
}

export function initCalibrator() {
  const els = getEls()
  if (!els) return
  const twitch = window.Twitch?.ext

  let crop: Crop = IDENTITY_CROP
  let stored: Crop = IDENTITY_CROP

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`

  const render = () => {
    els.box.style.left = pct(crop.x)
    els.box.style.top = pct(crop.y)
    els.box.style.width = pct(crop.scale)
    els.box.style.height = pct(crop.scale)
    els.readout.textContent = `x ${pct(crop.x)}   y ${pct(crop.y)}   size ${pct(crop.scale)}`
    const dirty = crop.x !== stored.x || crop.y !== stored.y || crop.scale !== stored.scale
    els.save.disabled = !dirty
    els.reset.disabled = isIdentityCrop(crop) && !dirty
    els.box.classList.toggle('cal-box--full', isIdentityCrop(crop))
  }

  const set = (next: Partial<Crop>) => {
    crop = clampCrop({ ...crop, ...next })
    render()
  }

  const setStatus = (text: string, cls: '' | 'ok' | 'muted') => {
    els.status.textContent = text
    els.status.className = cls
  }

  // ── load stored crop ──
  const readStored = () => {
    stored = parseCrop(twitch?.configuration?.broadcaster?.content)
    crop = stored
    render()
  }
  readStored()
  twitch?.configuration?.onChanged?.(() => {
    readStored()
    setStatus('', '')
  })

  // ── drag to move ──
  const norm = (clientX: number, clientY: number) => {
    const r = els.stage.getBoundingClientRect()
    return {
      x: r.width ? (clientX - r.left) / r.width : 0,
      y: r.height ? (clientY - r.top) / r.height : 0,
    }
  }

  let mode: 'none' | 'move' | 'resize' = 'none'
  let grabDX = 0
  let grabDY = 0

  const onMove = (e: PointerEvent) => {
    if (mode === 'none') return
    e.preventDefault()
    const p = norm(e.clientX, e.clientY)
    if (mode === 'move') {
      set({ x: p.x - grabDX, y: p.y - grabDY })
    } else {
      // bottom-right resize, top-left anchored; aspect-locked via single scale
      const s = Math.max(p.x - crop.x, p.y - crop.y)
      const maxS = Math.min(1 - crop.x, 1 - crop.y)
      set({ scale: Math.min(maxS, Math.max(MIN_SCALE, s)) })
    }
  }

  const endDrag = (e: PointerEvent) => {
    if (mode === 'none') return
    mode = 'none'
    try { els.stage.releasePointerCapture(e.pointerId) } catch {}
  }

  els.box.addEventListener('pointerdown', (e) => {
    if (e.target === els.handle) return // handle starts a resize instead
    e.preventDefault()
    els.box.focus()
    const p = norm(e.clientX, e.clientY)
    grabDX = p.x - crop.x
    grabDY = p.y - crop.y
    mode = 'move'
    try { els.stage.setPointerCapture(e.pointerId) } catch {}
  })

  els.handle.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    els.box.focus()
    mode = 'resize'
    try { els.stage.setPointerCapture(e.pointerId) } catch {}
  })

  els.stage.addEventListener('pointermove', onMove)
  els.stage.addEventListener('pointerup', endDrag)
  els.stage.addEventListener('pointercancel', endDrag)

  // ── keyboard (keyboard-first fine-tuning) ──
  els.box.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? NUDGE_BIG : NUDGE
    switch (e.key) {
      case 'ArrowLeft': set({ x: crop.x - step }); break
      case 'ArrowRight': set({ x: crop.x + step }); break
      case 'ArrowUp': set({ y: crop.y - step }); break
      case 'ArrowDown': set({ y: crop.y + step }); break
      case '+': case '=': set({ scale: crop.scale + step }); break
      case '-': case '_': set({ scale: crop.scale - step }); break
      case 'Enter': if (!els.save.disabled) els.save.click(); break
      case 'r': case 'R': els.reset.click(); break
      default: return
    }
    e.preventDefault()
  })

  // ── save / reset ──
  els.save.addEventListener('click', () => {
    const setFn = twitch?.configuration?.set
    if (!setFn) { setStatus('config service unavailable', ''); return }
    try {
      setFn('broadcaster', CONFIG_VERSION, serializeCrop(crop))
      stored = crop
      render()
      setStatus('saved — viewers pick it up on their next load', 'ok')
    } catch {
      setStatus('save failed — try again', '')
    }
  })

  els.reset.addEventListener('click', () => {
    set(IDENTITY_CROP)
    els.box.focus()
    setStatus('reset to fullscreen — save to apply', 'muted')
  })

  // faint item-row hint so the broadcaster can orient the box to their board
  buildBoardHint(els.box)
  render()
}

// A ghost of the shop/board row inside the box — purely to signal orientation
// ("your game goes here, board near the bottom"). Not pixel-accurate; the box
// EDGES are what must match the game video, not these marks.
function buildBoardHint(box: HTMLElement) {
  const hint = document.createElement('div')
  hint.className = 'cal-hint'
  const row = document.createElement('div')
  row.className = 'cal-hint-row'
  for (let i = 0; i < 10; i++) {
    const cell = document.createElement('span')
    row.appendChild(cell)
  }
  const label = document.createElement('div')
  label.className = 'cal-hint-label'
  label.textContent = 'your game video'
  hint.appendChild(label)
  hint.appendChild(row)
  box.appendChild(hint)
}
