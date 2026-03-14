import { render } from 'preact'
import { useState, useEffect, useCallback, useRef } from 'preact/hooks'
import type { BazaarCard, TierName } from '@bazaarinfo/shared/src/types'
import { buildIndex, searchCards, type ScoredCard } from '@bazaarinfo/shared/src/search'
import { CardTooltip } from './components/CardTooltip'
import { fetchCards } from './twitch'
import './style.css'

function Panel() {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState<ReturnType<typeof buildIndex> | null>(null)
  const [results, setResults] = useState<ScoredCard[]>([])
  const [selected, setSelected] = useState<{ card: BazaarCard; tier: TierName } | null>(null)
  const [error, setError] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const twitch = window.Twitch?.ext
    if (!twitch) return
    twitch.onAuthorized(async (auth) => {
      for (let i = 0; i < 2; i++) {
        try {
          const all = await fetchCards(auth.token)
          if (all.length > 0) {
            setIndex(buildIndex(all))
            setError(false)
          }
          return
        } catch {
          if (i === 1) setError(true)
        }
      }
    })
  }, [])

  const runSearch = useCallback((q: string) => {
    setSelected(null)
    if (!index || q.trim().length < 2) { setResults([]); return }
    const hits = searchCards(index, q).slice(0, 8)
    setResults(hits)
  }, [index])

  const handleInput = useCallback((e: Event) => {
    const q = (e.target as HTMLInputElement).value
    setQuery(q)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runSearch(q), 120)
  }, [runSearch])

  const pick = useCallback((card: BazaarCard) => {
    setSelected({ card, tier: card.BaseTier })
    setResults([])
    setQuery(card.Title)
    if (debounceRef.current) clearTimeout(debounceRef.current)
  }, [])

  const pickTier = useCallback((tier: TierName) => {
    setSelected((s) => s ? { ...s, tier } : s)
  }, [])

  return (
    <div class="panel">
      <input
        type="text"
        class="panel-search"
        value={query}
        onInput={handleInput}
        placeholder={index ? 'Search cards\u2026' : error ? 'Failed to load' : 'Loading\u2026'}
        disabled={!index}
        aria-label="Search cards"
      />
      {results.length > 0 && (
        <ul class="panel-results">
          {results.map((c) => (
            <li
              key={c.item.Title}
              class="panel-result"
              onClick={() => pick(c.item)}
            >
              {c.item.Title}
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <div class="panel-selected">
          <CardTooltip
            card={selected.card}
            tier={selected.tier}
            visible={true}
            style={{ position: 'relative', width: '100%' }}
          />
          <div class="panel-tiers">
            {selected.card.Tiers.map((t) => (
              <button
                key={t}
                class={`panel-tier-btn${selected.tier === t ? ' active' : ''}`}
                onClick={() => pickTier(t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const root = document.getElementById('root')
if (root) render(<Panel />, root)
