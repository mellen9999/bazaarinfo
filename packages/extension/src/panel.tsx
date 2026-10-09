import { render } from 'preact'
import { CardSearch } from './components/CardSearch'
import { useCards } from './use-cards'
import './style.css'

// two deliberate lines — a Twitch panel is 318px wide, and one long hint wraps into
// an orphan word
const KEYS = (
  <div class="panel-keys">
    {/* the only place we can say the overlay exists without putting anything on the
        broadcaster's video */}
    <div class="panel-lede">hover any card on the stream for its tooltip</div>
    <div><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>⏎</kbd> pick</div>
    <div><kbd>←</kbd><kbd>→</kbd> tier · <kbd>esc</kbd> clear</div>
  </div>
)

function Panel() {
  const { cards, error } = useCards()
  // only where there is a mouse: on a phone an autofocused field throws up the soft
  // keyboard over the panel before the viewer has asked for anything
  const fine = Boolean(window.matchMedia?.('(pointer: fine)').matches)

  return (
    <div class="panel">
      <CardSearch cards={cards} error={error} autoFocus={fine} idle={KEYS} />
      <div class="panel-foot">
        <a class="panel-link" href="https://bazaardb.gg" target="_blank" rel="noopener noreferrer">
          data from bazaardb.gg
        </a>
      </div>
    </div>
  )
}

const root = document.getElementById('root')
if (root) render(<Panel />, root)
