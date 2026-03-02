import { render } from 'preact'
import { useState, useEffect, useCallback } from 'preact/hooks'
import type { BazaarCard, TierName } from '@bazaarinfo/shared/src/types'
import { buildIndex, searchCards, type ScoredCard } from '@bazaarinfo/shared/src/search'
import { CardTooltip } from './components/CardTooltip'
import './style.css'

declare global {
  interface Window {
    Twitch: {
      ext: {
        onAuthorized: (cb: (auth: { token: string; channelId: string; clientId: string }) => void) => void
        listen: (target: string, cb: (target: string, contentType: string, message: string) => void) => void
      }
    }
  }
}

const EBS_BASE = 'https://ebs.bazaarinfo.com'

function Panel() {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState<ReturnType<typeof buildIndex> | null>(null)
  const [results, setResults] = useState<ScoredCard[]>([])
  const [selected, setSelected] = useState<{ card: BazaarCard; tier: TierName } | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const twitch = window.Twitch?.ext
    if (!twitch) return
    twitch.onAuthorized(async (auth) => {
      try {
        const res = await fetch(`${EBS_BASE}/api/cards`, {
          headers: { Authorization: `Bearer ${auth.token}` },
        })
        if (!res.ok) return
        const data = await res.json() as { items: BazaarCard[]; skills: BazaarCard[] }
        const all = [...(data.items ?? []), ...(data.skills ?? [])]
        setIndex(buildIndex(all))
        setLoaded(true)
      } catch {}
    })
  }, [])

  const search = useCallback((q: string) => {
    setQuery(q)
    setSelected(null)
    if (!index || q.trim().length < 2) { setResults([]); return }
    const hits = searchCards(index, q).slice(0, 8)
    setResults(hits)
  }, [index])

  const pick = (card: BazaarCard) => {
    setSelected({ card, tier: card.BaseTier })
    setResults([])
    setQuery(card.Title)
  }

  return (
    <div style={{ padding: '12px', background: '#111', minHeight: '100vh', color: '#e8e8e8', fontFamily: 'sans-serif' }}>
      <input
        type="text"
        value={query}
        onInput={(e) => search((e.target as HTMLInputElement).value)}
        placeholder={loaded ? 'Search cards…' : 'Loading…'}
        disabled={!loaded}
        style={{
          width: '100%', padding: '8px', borderRadius: '6px',
          border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.07)',
          color: '#fff', fontSize: '13px', outline: 'none',
        }}
      />
      {results.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '4px 0 0', padding: 0, background: 'rgba(0,0,0,0.8)', borderRadius: 6, border: '1px solid rgba(255,255,255,0.1)' }}>
          {results.map((c) => (
            <li
              key={c.item.Title}
              onClick={() => pick(c.item)}
              style={{ padding: '8px 12px', cursor: 'pointer', fontSize: '12px' }}
            >
              {c.item.Title}
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <div style={{ marginTop: '12px' }}>
          <CardTooltip
            card={selected.card}
            tier={selected.tier}
            visible={true}
            style={{ position: 'relative', width: '100%' }}
          />
          <div style={{ marginTop: '8px', display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
            {selected.card.Tiers.map((t) => (
              <button
                key={t}
                onClick={() => setSelected({ ...selected, tier: t })}
                style={{
                  padding: '2px 8px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 11,
                  background: selected.tier === t ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.07)',
                  color: '#ddd',
                }}
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
