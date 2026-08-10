// Twitch extension config view — broadcaster fetches their companion secret
// and calibrates the game-area crop for windowed / cropped captures.
// Loaded as a static script via <script src>. CSP-clean: no inline handlers.

import { initCalibrator } from './calibrate'

const EBS_URL = 'https://ebs.bazaarinfo.com'

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
  channelEl.textContent = channelId
  secretEl.textContent = secret
  status.hidden = true
  fields.hidden = false
}

function applyTheme(theme: string | undefined) {
  if (theme === 'light' || theme === 'dark') {
    document.body.dataset.theme = theme
  }
}

function init() {
  setupCopyHandlers()
  initCalibrator()
  const twitch = window.Twitch?.ext
  if (!twitch) {
    setStatus('twitch extension helper unavailable', 'error')
    return
  }

  twitch.onContext?.((ctx) => applyTheme(ctx?.theme))

  twitch.onAuthorized(async (auth) => {
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
