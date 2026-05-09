// Twitch extension config view — broadcaster fetches their companion secret.
// Loaded as a static script via <script src>. CSP-clean: no inline handlers.

const EBS_URL = 'https://ebs.bazaarinfo.com'

function copy(text: string, el: HTMLElement) {
  navigator.clipboard.writeText(text).then(() => {
    el.classList.add('copied')
    setTimeout(() => el.classList.remove('copied'), 1500)
  }).catch(() => {})
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
  const twitch = window.Twitch?.ext
  if (!twitch) {
    setStatus('Twitch extension helper unavailable', 'error')
    return
  }

  twitch.onContext?.((ctx) => applyTheme(ctx?.theme))

  twitch.onAuthorized(async (auth) => {
    try {
      const res = await fetch(`${EBS_URL}/api/companion-setup`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      })
      if (!res.ok) {
        const reason = res.status === 403 ? 'Only the broadcaster can view this' : `Failed to load (${res.status})`
        setStatus(reason, 'error')
        return
      }
      const data = await res.json() as { channelId: string; secret: string }
      reveal(data.channelId, data.secret)
    } catch {
      setStatus('Network error — try again', 'error')
    }
  })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true })
} else {
  init()
}
