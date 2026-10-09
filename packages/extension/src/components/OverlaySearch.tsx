import { useState, useEffect } from 'preact/hooks'
import type { BazaarCard } from '@bazaarinfo/shared/src/types'
import { CardSearch } from './CardSearch'

interface Props {
  cards: BazaarCard[] | null
  error: string | null
  // Twitch's own player bar is showing. The button rides with it: a fullscreen
  // viewer who has not touched the mouse is watching, not looking for a button.
  controlsVisible: boolean
}

// Card search for the viewer who is fullscreen and so cannot reach the panel. A
// square button appears with the player controls; it (or `/`) opens the same search
// the panel has, over the video. Closed, the only thing on the overlay that takes a
// click is that button, so the hover zones underneath behave exactly as before.
export function OverlaySearch({ cards, error, controlsVisible }: Props) {
  const [open, setOpen] = useState(false)
  // nothing to search and never will be: no button, no hotkey, no empty box
  const failed = !cards && Boolean(error)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (open && e.key === 'Escape') { setOpen(false); return }
      if (open || failed || e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target
      // a slash typed into a field is a slash
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable)) return
      e.preventDefault()
      setOpen(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, failed])

  if (failed) return null

  return (
    <>
      {open && (
        <div class="search-surface" role="dialog" aria-label="card search">
          <CardSearch cards={cards} error={error} autoFocus={true} />
        </div>
      )}
      {/* stays while open even if the player bar fades, or the way to close it by
          mouse would vanish under the viewer's hand */}
      {(controlsVisible || open) && (
        <button
          type="button"
          class="search-btn"
          aria-label="search cards"
          aria-expanded={open}
          title="search cards ( / )"
          onClick={() => setOpen((o) => !o)}
        >
          <span class="search-glyph" aria-hidden="true">⌕</span>
        </button>
      )}
    </>
  )
}
