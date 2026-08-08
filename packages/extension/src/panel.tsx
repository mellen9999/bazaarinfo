import { render } from 'preact'
import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks'
import type { BazaarCard, TierName } from '@bazaarinfo/shared/src/types'
import { buildIndex, searchCards, type ScoredCard } from '@bazaarinfo/shared/src/search'
import { CardTooltip } from './components/CardTooltip'
import { fetchCards } from './twitch'
import { tierColor } from './tiers'
import './style.css'

const MAX_RESULTS = 8
const MIN_QUERY = 2

function Panel() {
  const [query, setQuery] = useState('')
  const [cards, setCards] = useState<BazaarCard[] | null>(null)
  const [results, setResults] = useState<ScoredCard[]>([])
  const [cursor, setCursor] = useState(0)
  const [selected, setSelected] = useState<{ card: BazaarCard; tier: TierName } | null>(null)
  const [error, setError] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Built on the first keystroke, not on load. Indexing ~1800 cards is work the
  // viewer has not asked for yet, and doing it during startup is the difference
  // between a panel that opens instantly and one that hitches on a phone.
  const indexRef = useRef<ReturnType<typeof buildIndex> | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Focus on open so the panel is usable without touching the mouse — but only
  // where there is a mouse. On a phone an autofocused field throws up the soft
  // keyboard over the panel before the viewer has asked for anything.
  useEffect(() => {
    if (window.matchMedia?.('(pointer: fine)').matches) inputRef.current?.focus()
  }, [])

  useEffect(() => {
    let mounted = true
    const twitch = window.Twitch?.ext
    if (!twitch) return
    twitch.onAuthorized(async (auth) => {
      if (indexRef.current || cards) return
      for (let i = 0; i < 2; i++) {
        try {
          const all = await fetchCards(auth.token)
          if (!mounted) return
          // An empty list is a failed load wearing a success's clothes — say so
          // rather than sitting on "loading…" forever.
          if (all.length === 0) throw new Error('empty')
          setCards(all)
          return
        } catch {
          if (i === 1 && mounted) setError(true)
        }
      }
    })
    return () => { mounted = false }
  }, [])

  const runSearch = useCallback((q: string) => {
    setSelected(null)
    setCursor(0)
    if (!cards || q.trim().length < MIN_QUERY) { setResults([]); return }
    if (!indexRef.current) indexRef.current = buildIndex(cards)
    setResults(searchCards(indexRef.current, q, MAX_RESULTS))
  }, [cards])

  // Typed while the dump was still downloading — run it the moment it lands
  // instead of making the viewer type the whole thing a second time.
  useEffect(() => {
    if (cards && query.trim().length >= MIN_QUERY && results.length === 0 && !selected) runSearch(query)
  }, [cards]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const stepTier = useCallback((d: number) => {
    setSelected((s) => {
      if (!s) return s
      const i = s.card.Tiers.indexOf(s.tier)
      const next = s.card.Tiers[Math.min(s.card.Tiers.length - 1, Math.max(0, i + d))]
      return next ? { ...s, tier: next } : s
    })
  }, [])

  const clear = useCallback(() => {
    setQuery('')
    setResults([])
    setSelected(null)
    setCursor(0)
    if (debounceRef.current) clearTimeout(debounceRef.current)
  }, [])

  // Everything reachable without the mouse. The list is driven from the input so
  // focus never has to leave it: arrows or ctrl-n/p to move, enter to take the
  // highlighted card, arrows again to walk its tiers once the list is closed.
  const handleKey = useCallback((e: KeyboardEvent) => {
    const open = results.length > 0
    const key = e.key
    if (key === 'Escape') { clear(); return }
    if (open && (key === 'ArrowDown' || (e.ctrlKey && key === 'n'))) {
      e.preventDefault()
      setCursor((c) => (c + 1) % results.length)
      return
    }
    if (open && (key === 'ArrowUp' || (e.ctrlKey && key === 'p'))) {
      e.preventDefault()
      setCursor((c) => (c - 1 + results.length) % results.length)
      return
    }
    if (open && key === 'Enter') {
      e.preventDefault()
      const hit = results[cursor] ?? results[0]
      if (hit) pick(hit.item)
      return
    }
    // With the list closed the caret has nowhere useful to go — the query is just
    // the name of the card already on screen — so the arrows walk its tiers.
    if (!open && selected && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      e.preventDefault()
      stepTier(key === 'ArrowRight' ? 1 : -1)
    }
  }, [results, cursor, selected, pick, clear, stepTier])

  const placeholder = cards ? 'search cards…' : error ? 'card data unavailable' : 'loading card data…'
  const trimmed = query.trim()
  const noMatch = Boolean(cards) && !selected && results.length === 0 && trimmed.length >= MIN_QUERY

  const tierStyles = useMemo(
    () => selected?.card.Tiers.map((t) => ({ '--tier': tierColor(t) } as Record<string, string>)) ?? [],
    [selected?.card.Tiers],
  )

  return (
    <div class="panel">
      {/* stays usable while the dump is still downloading — a query typed early
          runs itself the moment the data lands. Only a hard failure, where nothing
          typed could ever resolve, takes the field away. */}
      <input
        type="text"
        class="panel-search"
        value={query}
        onInput={handleInput}
        onKeyDown={handleKey}
        placeholder={placeholder}
        disabled={!cards && error}
        ref={inputRef}
        autocomplete="off"
        spellcheck={false}
        role="combobox"
        aria-expanded={results.length > 0}
        aria-controls="panel-results"
        aria-activedescendant={results.length > 0 ? `panel-opt-${cursor}` : undefined}
        aria-label="search cards"
      />

      {results.length > 0 && (
        <ul class="panel-results" id="panel-results" role="listbox" aria-label="results">
          {results.map((c, i) => (
            <li
              key={c.item.Title}
              id={`panel-opt-${i}`}
              class="panel-result"
              role="option"
              aria-selected={i === cursor}
              onMouseEnter={() => setCursor(i)}
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
          <div class="panel-tiers" role="group" aria-label="tier">
            {selected.card.Tiers.map((t, i) => (
              <button
                key={t}
                type="button"
                class={`panel-tier${selected.tier === t ? ' active' : ''}`}
                style={tierStyles[i]}
                aria-pressed={selected.tier === t}
                onClick={() => pickTier(t)}
              >
                {t.toLowerCase()}
              </button>
            ))}
          </div>
        </div>
      )}

      {noMatch && <div class="panel-note">no card matches "{trimmed}"</div>}

      {/* two deliberate lines — a Twitch panel is 318px wide, and one long hint
          wraps into an orphan word */}
      {!selected && results.length === 0 && !noMatch && (
        <div class="panel-keys">
          {/* the only place we can say the overlay exists without putting anything
              on the broadcaster's video */}
          <div class="panel-lede">hover any card on the stream for its tooltip</div>
          <div><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>⏎</kbd> pick</div>
          <div><kbd>←</kbd><kbd>→</kbd> tier · <kbd>esc</kbd> clear</div>
        </div>
      )}

      <div class="panel-foot">
        {selected?.card.Shortlink && (
          <a
            class="panel-link panel-link--card"
            href={selected.card.Shortlink}
            target="_blank"
            rel="noopener noreferrer"
          >
            full card ↗
          </a>
        )}
        <a class="panel-link" href="https://bazaardb.gg" target="_blank" rel="noopener noreferrer">
          data from bazaardb.gg
        </a>
      </div>
    </div>
  )
}

const root = document.getElementById('root')
if (root) render(<Panel />, root)
