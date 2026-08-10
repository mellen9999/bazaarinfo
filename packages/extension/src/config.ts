// Twitch extension config view — broadcaster fetches their companion secret
// and calibrates the game-area crop for windowed / cropped captures.
// Loaded as a static script via <script src>. CSP-clean: no inline handlers.

import { initCalibrator } from './calibrate'

const EBS_URL = 'https://ebs.bazaarinfo.com'

// The secret leaked once by simply being on screen during a stream. It now lives
// only in this closure: the DOM shows a fixed-width mask, copy writes from the
// closure, and reveal is hold-only — it cannot be left visible.
const SECRET_MASK = '•'.repeat(32)
let currentSecret = ''
let authToken = ''

function selectContents(el: HTMLElement) {
  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  range.selectNodeContents(el)
  sel.removeAllRanges()
  sel.addRange(range)
}

function flashCopied(el: HTMLElement) {
  el.classList.add('copied')
  setTimeout(() => el.classList.remove('copied'), 1500)
}

// Twitch serves this view inside a sandboxed cross-origin iframe that usually
// withholds the async Clipboard API (no clipboard-write permission). So: select
// the field first — that alone makes a manual ctrl/⌘+c work and gives the user
// visible feedback — then try the async API, falling back to execCommand('copy'),
// which acts on the live selection and is permitted in the sandbox where the
// async API is not. If every path is blocked, the text stays selected to copy by hand.
function copy(text: string, el: HTMLElement) {
  selectContents(el)
  const viaAsync = navigator.clipboard?.writeText?.(text)
  if (viaAsync) {
    viaAsync.then(() => flashCopied(el)).catch(() => { if (execCopy()) flashCopied(el) })
  } else if (execCopy()) {
    flashCopied(el)
  }
}

function execCopy(): boolean {
  try { return document.execCommand('copy') } catch { return false }
}

// execCommand fallback for the secret: select an offscreen textarea instead of
// the visible field, so the secret never paints even for a frame.
function execCopyText(text: string): boolean {
  const tmp = document.createElement('textarea')
  tmp.value = text
  tmp.setAttribute('readonly', '')
  tmp.style.position = 'fixed'
  tmp.style.left = '-9999px'
  document.body.appendChild(tmp)
  tmp.select()
  const ok = execCopy()
  tmp.remove()
  return ok
}

function copySecret(el: HTMLElement) {
  if (!currentSecret) return
  const viaAsync = navigator.clipboard?.writeText?.(currentSecret)
  if (viaAsync) {
    viaAsync.then(() => flashCopied(el)).catch(() => { if (execCopyText(currentSecret)) flashCopied(el) })
  } else if (execCopyText(currentSecret)) {
    flashCopied(el)
  }
}

function setupCopyHandlers() {
  document.querySelectorAll<HTMLElement>('[data-copy]').forEach((el) => {
    const fire = () => copy(el.textContent ?? '', el)
    el.addEventListener('click', fire)
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        fire()
      }
    })
  })
}

function setStatus(text: string, cls: 'loading' | 'error' | '') {
  const el = document.getElementById('status')
  if (!el) return
  el.textContent = text
  el.className = cls
}

function reveal(channelId: string, secret: string) {
  const status = document.getElementById('status')
  const fields = document.getElementById('fields')
  const channelEl = document.getElementById('channel-id')
  const secretEl = document.getElementById('secret')
  if (!status || !fields || !channelEl || !secretEl) return
  currentSecret = secret
  channelEl.textContent = channelId
  secretEl.textContent = SECRET_MASK
  status.hidden = true
  fields.hidden = false
}

function setSecretStatus(text: string, error = false) {
  const el = document.getElementById('secret-status')
  if (!el) return
  el.textContent = text
  el.className = error ? 'error' : 'muted'
}

function setupSecretHandlers() {
  const secretEl = document.getElementById('secret')
  const revealBtn = document.getElementById('secret-reveal') as HTMLButtonElement | null
  const rotateBtn = document.getElementById('secret-rotate') as HTMLButtonElement | null
  if (!secretEl || !revealBtn || !rotateBtn) return

  const fire = () => copySecret(secretEl)
  secretEl.addEventListener('click', fire)
  secretEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      fire()
    }
  })

  // Hold-only reveal: shown while the button is held (pointer or Enter/Space),
  // restored on ANY release path. While held the text is also selected, so a
  // manual ctrl/⌘+c works if the sandbox blocks every programmatic copy.
  const show = () => {
    if (!currentSecret) return
    secretEl.textContent = currentSecret
    selectContents(secretEl)
  }
  const hide = () => {
    secretEl.textContent = SECRET_MASK
    window.getSelection()?.removeAllRanges()
  }
  revealBtn.addEventListener('pointerdown', show)
  revealBtn.addEventListener('pointerup', hide)
  revealBtn.addEventListener('pointerleave', hide)
  revealBtn.addEventListener('pointercancel', hide)
  revealBtn.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
      e.preventDefault()
      show()
    }
  })
  revealBtn.addEventListener('keyup', hide)
  revealBtn.addEventListener('blur', hide)

  // Two-step confirm: first press arms for 4s, second press rotates.
  let armed: ReturnType<typeof setTimeout> | null = null
  const disarm = () => {
    if (armed) clearTimeout(armed)
    armed = null
    rotateBtn.textContent = 'rotate secret'
    rotateBtn.classList.remove('cal-btn--danger')
  }
  rotateBtn.addEventListener('click', async () => {
    if (!authToken) return
    if (!armed) {
      rotateBtn.textContent = 'really rotate? old secret stops working'
      rotateBtn.classList.add('cal-btn--danger')
      armed = setTimeout(disarm, 4000)
      return
    }
    disarm()
    rotateBtn.disabled = true
    try {
      const res = await fetch(`${EBS_URL}/api/companion-rotate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      })
      if (!res.ok) throw new Error(String(res.status))
      const data = await res.json() as { secret: string }
      currentSecret = data.secret
      setSecretStatus('rotated — copy the new secret into your companion config and restart it')
    } catch {
      setSecretStatus('rotation failed — old secret still works, try again', true)
    } finally {
      rotateBtn.disabled = false
    }
  })
}

function applyTheme(theme: string | undefined) {
  if (theme === 'light' || theme === 'dark') {
    document.body.dataset.theme = theme
  }
}

function init() {
  setupCopyHandlers()
  setupSecretHandlers()
  initCalibrator()
  const twitch = window.Twitch?.ext
  if (!twitch) {
    setStatus('twitch extension helper unavailable', 'error')
    return
  }

  twitch.onContext?.((ctx) => applyTheme(ctx?.theme))

  twitch.onAuthorized(async (auth) => {
    authToken = auth.token
    try {
      const res = await fetch(`${EBS_URL}/api/companion-setup`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      })
      if (!res.ok) {
        const reason = res.status === 403 ? 'only the broadcaster can view this' : `failed to load (${res.status})`
        setStatus(reason, 'error')
        return
      }
      const data = await res.json() as { channelId: string; secret: string }
      reveal(data.channelId, data.secret)
    } catch {
      setStatus('network error — try again', 'error')
    }
  })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true })
} else {
  init()
}
