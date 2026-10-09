// The one path card data takes into the panel and the overlay: authorize, fetch from
// the EBS with backoff, refresh on demand. Both used to carry their own copy of this
// loop, which is how they drifted before.
import { useState, useEffect, useCallback, useRef } from 'preact/hooks'
import type { BazaarCard } from '@bazaarinfo/shared/src/types'
import { fetchCards, CARD_FETCH_BACKOFF } from './twitch'

// An empty list is a failed load wearing a success's clothes: it would leave every
// card "unknown" (and every search empty) with no sign anything went wrong.
async function fetchNonEmpty(token: string): Promise<BazaarCard[]> {
  const all = await fetchCards(token)
  if (all.length === 0) throw new Error('empty')
  return all
}

export function useCards() {
  const [cards, setCards] = useState<BazaarCard[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Twitch re-fires onAuthorized (~hourly) with a fresh token: keep the latest for
  // refresh(), and use `loaded` to stop the re-fire from re-running the first fetch.
  const tokenRef = useRef<string | null>(null)
  const loadedRef = useRef(false)
  const refreshingRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    const twitch = window.Twitch?.ext
    if (!twitch) {
      // visible in the console only: the overlay stays silent over someone's stream
      console.error('bazaarinfo: twitch extension helper unavailable')
      setError('twitch extension helper unavailable')
      return
    }
    twitch.onAuthorized(async (auth) => {
      tokenRef.current = auth.token
      if (loadedRef.current) return
      for (let i = 0; i < CARD_FETCH_BACKOFF.length; i++) {
        if (CARD_FETCH_BACKOFF[i] > 0) {
          await new Promise((r) => setTimeout(r, CARD_FETCH_BACKOFF[i]))
          if (!mountedRef.current || loadedRef.current) return
        }
        try {
          const all = await fetchNonEmpty(tokenRef.current ?? auth.token)
          if (!mountedRef.current) return
          setCards(all)
          loadedRef.current = true
          return
        } catch {
          if (i === CARD_FETCH_BACKOFF.length - 1 && mountedRef.current) setError('card data unavailable')
        }
      }
    })
    return () => { mountedRef.current = false }
  }, [])

  // One quiet re-fetch for a viewer whose list predates a data refresh. Never
  // concurrent, and a failure leaves the cards in hand untouched — a failed refresh
  // must not break a working view. Pacing is the caller's call (card-refresh.ts).
  const refresh = useCallback(async () => {
    if (!loadedRef.current || refreshingRef.current || !tokenRef.current) return
    refreshingRef.current = true
    try {
      const all = await fetchNonEmpty(tokenRef.current)
      if (mountedRef.current) setCards(all)
    } catch {} finally {
      refreshingRef.current = false
    }
  }, [])

  return { cards, error, refresh }
}
