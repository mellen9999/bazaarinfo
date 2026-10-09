import { useState, useLayoutEffect, useCallback, useRef, useMemo } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import type { BazaarCard, TierName } from '@bazaarinfo/shared/src/types'
import { buildIndex, searchCards } from '@bazaarinfo/shared/src/search'
import { CardTooltip } from './CardTooltip'
import { tierColor } from '../tiers'
import {
  NO_FILTERS, FILTER_KEYS, hasFilter, filterLabel, filterOptions, cycleValue, applyFilters,
  type FilterKey, type Filters,
} from '../card-filters'

const MAX_RESULTS = 8
const MIN_QUERY = 2

interface Props {
  cards: BazaarCard[] | null
  // why there are no cards, if there never will be
  error: string | null
  autoFocus?: boolean
  // shown while there is nothing typed, picked or filtered
  idle?: ComponentChildren
}

type Index = ReturnType<typeof buildIndex>
const NONE = { list: [] as BazaarCard[], more: 0 }
const byTitle = (a: BazaarCard, b: BazaarCard) => a.Title.localeCompare(b.Title)

// The search box, filter chips, result list and picked card — everything between
// "viewer wants a card" and "viewer is reading it". Shared by the Twitch panel and
// the video overlay, which differ only in where it sits and how big it draws
// (their CSS), so a fix to either is a fix to both.
export function CardSearch({ cards, error, autoFocus = false, idle }: Props) {
  const [query, setQuery] = useState('')
  // `query` follows the keys; `term` is what the results are computed from, a beat
  // behind so typing never waits on a search.
  const [term, setTerm] = useState('')
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [cursor, setCursor] = useState(0)
  const [selected, setSelected] = useState<{ card: BazaarCard; tier: TierName } | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // Built on first use, not on load. Indexing ~1800 cards is work the viewer has not
  // asked for yet, and doing it during startup is the difference between a panel
  // that opens instantly and one that hitches on a phone. Dropped when the card list
  // is replaced (a refresh), so it can never answer from stale data.
  const cache = useRef<{ cards: BazaarCard[] | null; index?: Index; sorted?: BazaarCard[] }>({ cards: null })
  if (cache.current.cards !== cards) cache.current = { cards }

  // Focus on open so it is usable without touching the mouse. The panel passes
  // autoFocus only where there is a mouse: on a phone an autofocused field throws up
  // the soft keyboard before the viewer has asked for anything.
  useLayoutEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])

  const options = useMemo(() => filterOptions(cards ?? []), [cards])
  const filtering = hasFilter(filters)
  const picked = selected !== null
  const searching = term.trim().length >= MIN_QUERY

  // Derived, not stored: a query typed while the dump was still downloading, a
  // filter flipped, and a refreshed card list all just recompute.
  const { list, more } = useMemo(() => {
    if (!cards || picked || (!searching && !filtering)) return NONE
    const c = cache.current
    let pool: BazaarCard[]
    if (searching) {
      c.index ??= buildIndex(cards)
      // with a filter on, the best 8 matches may all be the wrong hero: rank them
      // all, then filter, then cut
      pool = searchCards(c.index, term, filtering ? cards.length : MAX_RESULTS).map((r) => r.item)
    } else {
      c.sorted ??= [...cards].sort(byTitle)
      pool = c.sorted
    }
    const r = applyFilters(pool, filters, MAX_RESULTS)
    return { list: r.shown, more: r.more }
  }, [cards, picked, searching, filtering, term, filters])

  const settle = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setSelected(null)
    setCursor(0)
  }, [])

  const handleInput = useCallback((e: Event) => {
    const q = (e.target as HTMLInputElement).value
    setQuery(q)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setTerm(q)
      setSelected(null)
      setCursor(0)
    }, 120)
  }, [])

  const pick = useCallback((card: BazaarCard) => {
    setSelected({ card, tier: card.BaseTier })
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
    settle()
    setQuery('')
    setTerm('')
    setFilters(NO_FILTERS)
  }, [settle])

  const cycleFilter = useCallback((key: FilterKey, dir: 1 | -1) => {
    // a picked card is the answer to the old filters, so changing them starts over;
    // what is in the box becomes the search again
    settle()
    setTerm(query)
    setFilters((f) => ({ ...f, [key]: cycleValue(options[key], f[key], dir) }))
  }, [settle, query, options])

  // Everything reachable without the mouse. The list is driven from the input so
  // focus never has to leave it: arrows or ctrl-n/p to move, enter to take the
  // highlighted card, arrows again to walk its tiers once the list is closed.
  const handleKey = useCallback((e: KeyboardEvent) => {
    const open = list.length > 0
    const key = e.key
    if (key === 'Escape') { clear(); return }
    if (open && (key === 'ArrowDown' || (e.ctrlKey && key === 'n'))) {
      e.preventDefault()
      setCursor((c) => (c + 1) % list.length)
      return
    }
    if (open && (key === 'ArrowUp' || (e.ctrlKey && key === 'p'))) {
      e.preventDefault()
      setCursor((c) => (c - 1 + list.length) % list.length)
      return
    }
    if (open && key === 'Enter') {
      e.preventDefault()
      const hit = list[cursor] ?? list[0]
      if (hit) pick(hit)
      return
    }
    // With the list closed the caret has nowhere useful to go — the query is just
    // the name of the card already on screen — so the arrows walk its tiers.
    if (!open && selected && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      e.preventDefault()
      stepTier(key === 'ArrowRight' ? 1 : -1)
    }
  }, [list, cursor, selected, pick, clear, stepTier])

  // A chip is a button, so enter and space already cycle it forward; the arrows
  // walk it both ways, the same keys that move everything else here.
  const handleChipKey = useCallback((e: KeyboardEvent, key: FilterKey) => {
    if (e.key === 'Escape') { clear(); return }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    cycleFilter(key, e.key === 'ArrowRight' ? 1 : -1)
  }, [clear, cycleFilter])

  const placeholder = cards ? 'search cards…' : error ?? 'loading card data…'
  const noMatch = Boolean(cards) && !picked && list.length === 0 && (searching || filtering)
  // typing, but the beat before the results land: say nothing rather than flicker
  const pending = query.trim().length >= MIN_QUERY && !searching && !filtering

  const tierStyles = useMemo(
    () => selected?.card.Tiers.map((t) => ({ '--tier': tierColor(t) } as Record<string, string>)) ?? [],
    [selected?.card.Tiers],
  )

  return (
    <div class="card-search">
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
        disabled={!cards && Boolean(error)}
        ref={inputRef}
        autocomplete="off"
        spellcheck={false}
        role="combobox"
        aria-expanded={list.length > 0}
        aria-controls="panel-results"
        aria-activedescendant={list.length > 0 ? `panel-opt-${cursor}` : undefined}
        aria-label="search cards"
      />

      <div class="panel-filters" role="group" aria-label="filters">
        {FILTER_KEYS.map((k) => {
          const v = filters[k]
          return (
            <button
              key={k}
              type="button"
              class={`panel-chip${v !== null ? ' active' : ''}`}
              aria-pressed={v !== null}
              aria-label={`${k} filter: ${v === null ? 'any' : filterLabel(k, v)}`}
              disabled={options[k].length === 0}
              onClick={() => cycleFilter(k, 1)}
              onKeyDown={(e) => handleChipKey(e, k)}
            >
              {v === null ? k : `${k}: ${filterLabel(k, v)}`}
            </button>
          )
        })}
      </div>

      {list.length > 0 && (
        <ul class="panel-results" id="panel-results" role="listbox" aria-label="results">
          {list.map((c, i) => (
            <li
              key={`${i} ${c.Title}`}
              id={`panel-opt-${i}`}
              class="panel-result"
              role="option"
              aria-selected={i === cursor}
              onMouseEnter={() => setCursor(i)}
              onClick={() => pick(c)}
            >
              {c.Title}
            </li>
          ))}
        </ul>
      )}

      {/* a long list is cut, not scrolled — the overlay has no scrollbars to offer */}
      {more > 0 && <div class="panel-note">+{more} more</div>}

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
          {selected.card.Shortlink && (
            <a
              class="panel-link panel-link--card"
              href={selected.card.Shortlink}
              target="_blank"
              rel="noopener noreferrer"
            >
              full card <span class="panel-glyph" aria-hidden="true">↗</span>
            </a>
          )}
        </div>
      )}

      {noMatch && (
        <div class="panel-note">
          {searching ? `no card matches "${term.trim()}"${filtering ? ' with these filters' : ''}` : 'no card matches these filters'}
        </div>
      )}

      {!picked && !noMatch && !pending && list.length === 0 && idle}
    </div>
  )
}
