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
const MAX_SHOT_BYTES = 25 * 1024 * 1024 // a stream screenshot is ~1-5MB; anything bigger is a mistake

// Text pasted or dropped onto the stage may be an image link. Only https survives:
// data:/javascript:/file: pasted as text are rejected outright, and the URL parser
// throwing on garbage is the validation. Exported for tests.
export function pastedImageUrl(text: string | undefined | null): string | null {
  const t = (text ?? '').trim()
  if (!t || t.length > 2048 || /\s/.test(t)) return null
  let u: URL
  try { u = new URL(t) } catch { return null }
  return u.protocol === 'https:' ? u.href : null
}

// A link dragged from another tab arrives as text/uri-list (line-based, # comments),
// with text/plain as the fallback. Exported for tests.
export function droppedImageUrl(uriList: string, plain: string): string | null {
  const first = uriList.split('\n').map((s) => s.trim()).find((s) => s && !s.startsWith('#'))
  return pastedImageUrl(first ?? plain)
}

interface Els {
  stage: HTMLElement
  box: HTMLElement
  handle: HTMLElement
  readout: HTMLElement
  save: HTMLButtonElement
  reset: HTMLButtonElement
  status: HTMLElement
  shot: HTMLButtonElement
  file: HTMLInputElement
  drophint: HTMLElement
}

function getEls(): Els | null {
  const stage = document.getElementById('cal-stage')
  const box = document.getElementById('cal-box')
  const handle = document.getElementById('cal-handle')
  const readout = document.getElementById('cal-readout')
  const save = document.getElementById('cal-save') as HTMLButtonElement | null
  const reset = document.getElementById('cal-reset') as HTMLButtonElement | null
  const status = document.getElementById('cal-status')
  const shot = document.getElementById('cal-shot') as HTMLButtonElement | null
  const file = document.getElementById('cal-file') as HTMLInputElement | null
  const drophint = document.getElementById('cal-drophint')
  if (!stage || !box || !handle || !readout || !save || !reset || !status || !shot || !file || !drophint) return null
  return { stage, box, handle, readout, save, reset, status, shot, file, drophint }
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

  // Twitch refuses to activate an extension that "requires configuration" until a
  // broadcaster segment exists. A fullscreen streamer never edits the crop (identity
  // already fits) and so never triggers a save — leaving the extension permanently
  // unactivatable. So the first time we see an empty config, register the identity
  // default. It only runs inside onChanged, which carries the *loaded* config, so an
  // existing crop is never clobbered by a not-yet-loaded read. Harmless (identity is a
  // no-op crop) and idempotent: serializeCrop(IDENTITY) is a truthy string, so the
  // next onChanged sees content and skips this.
  const ensureConfigured = () => {
    const setFn = twitch?.configuration?.set
    if (!setFn || twitch?.configuration?.broadcaster?.content) return
    try { setFn('broadcaster', CONFIG_VERSION, serializeCrop(IDENTITY_CROP)) } catch { /* config service unavailable — non-fatal */ }
  }

  readStored()
  twitch?.configuration?.onChanged?.(() => {
    readStored()
    ensureConfigured()
    setStatus('', '')
  })
  // onChanged is not guaranteed to fire for a never-configured extension, which
  // would leave ensureConfigured above unreached and the extension unactivatable.
  // onAuthorized always fires, so use it as a backstop: wait long enough for any
  // real config to have arrived via onChanged (which would set content and make
  // ensureConfigured a no-op), then register the default if still empty.
  twitch?.onAuthorized?.(() => {
    setTimeout(ensureConfigured, 3000)
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

  // ── keyboard (keyboard-first fine-tuning; vim keys mirror the arrows) ──
  els.box.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? NUDGE_BIG : NUDGE
    switch (e.key) {
      case 'ArrowLeft': case 'h': case 'H': set({ x: crop.x - step }); break
      case 'ArrowRight': case 'l': case 'L': set({ x: crop.x + step }); break
      case 'ArrowUp': case 'k': case 'K': set({ y: crop.y - step }); break
      case 'ArrowDown': case 'j': case 'J': set({ y: crop.y + step }); break
      case '+': case '=': set({ scale: crop.scale + step }); break
      case '-': case '_': set({ scale: crop.scale - step }); break
      case 'Enter': if (!els.save.disabled) els.save.click(); break
      case 'r': case 'R': els.reset.click(); break
      case 'x': case 'X': case 'Escape': if (!hasShot) return; clearShot(); break
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
      setStatus('saved — live for viewers now', 'ok')
    } catch {
      setStatus('save failed — try again', '')
    }
  })

  els.reset.addEventListener('click', () => {
    set(IDENTITY_CROP)
    els.box.focus()
    setStatus('reset to fullscreen — save to apply', 'muted')
  })

  // ── screenshot backdrop ──
  // The broadcaster pastes or drops a frame of their own stream so they align the
  // box to the real game, not a guess. A file is read locally into a data: URL and
  // painted as the stage background — never uploaded, never leaves the browser.
  // An https link paints directly (the browser fetches only to render it).
  let hasShot = false

  const paintShot = (url: string) => {
    // 100% 100% because a stream screenshot IS the full 16:9 frame the stage
    // represents; stretch-fit maps it 1:1 so the box lines up with the video.
    els.stage.style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`
    els.stage.classList.add('cal-stage--shot')
    hasShot = true
    els.box.focus()
    setStatus('aligned to your screenshot — box the game, then save · x clears it', 'muted')
  }

  const clearShot = () => {
    els.stage.style.backgroundImage = ''
    els.stage.classList.remove('cal-stage--shot')
    hasShot = false
    setStatus('screenshot cleared', 'muted')
  }

  // Decode before painting: a corrupt file or dead link fails loud here instead of
  // silently leaving the stage blank.
  const verifyAndPaint = (url: string, failMsg: string) => {
    const probe = new Image()
    probe.onload = () => paintShot(url)
    probe.onerror = () => setStatus(failMsg, '')
    probe.src = url
  }

  const loadImage = (file: File | undefined | null) => {
    if (!file || !file.type.startsWith('image/')) { setStatus('not an image file', ''); return }
    if (file.size > MAX_SHOT_BYTES) { setStatus('image too large (25mb max)', ''); return }
    const reader = new FileReader()
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : ''
      if (url) verifyAndPaint(url, 'could not read that image')
    }
    reader.onerror = () => setStatus('could not read that image', '')
    reader.readAsDataURL(file)
  }

  const loadImageUrl = (url: string) => {
    setStatus('loading image…', 'muted')
    verifyAndPaint(url, 'could not load that link')
  }

  els.shot.addEventListener('click', () => els.file.click())
  els.file.addEventListener('change', () => loadImage(els.file.files?.[0]))

  const stopDrag = (e: DragEvent) => { e.preventDefault(); e.stopPropagation() }
  els.stage.addEventListener('dragenter', (e) => { stopDrag(e); els.stage.classList.add('cal-stage--drop') })
  els.stage.addEventListener('dragover', stopDrag)
  els.stage.addEventListener('dragleave', (e) => { stopDrag(e); els.stage.classList.remove('cal-stage--drop') })
  els.stage.addEventListener('drop', (e) => {
    stopDrag(e)
    els.stage.classList.remove('cal-stage--drop')
    const dt = e.dataTransfer
    const file = dt?.files?.[0]
    if (file) { loadImage(file); return }
    const url = dt ? droppedImageUrl(dt.getData('text/uri-list'), dt.getData('text/plain')) : null
    if (url) loadImageUrl(url)
    else setStatus('drop an image file or an https image link', '')
  })

  // Paste-anywhere: ctrl/⌘+v with a screenshot (or an image link) on the clipboard
  // just works — no save-to-file detour. Real text fields keep their pastes.
  const isEditable = (t: EventTarget | null) =>
    t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement ||
    (t instanceof HTMLElement && t.isContentEditable)

  document.addEventListener('paste', (e) => {
    if (isEditable(e.target)) return
    const dt = e.clipboardData
    if (!dt) return
    const img = Array.from(dt.files).find((f) => f.type.startsWith('image/'))
    if (img) { e.preventDefault(); loadImage(img); return }
    const url = pastedImageUrl(dt.getData('text/plain'))
    if (url) { e.preventDefault(); loadImageUrl(url); return }
    setStatus('clipboard had no image — screenshot your stream, then paste again', '')
  })

  // Clicking anywhere on the stage arms the keyboard — no hunting for the box.
  els.stage.addEventListener('pointerdown', () => els.box.focus())

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
