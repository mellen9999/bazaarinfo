import type { BazaarCard } from '@bazaarinfo/shared/src/types'

export const EBS_BASE = 'https://ebs.bazaarinfo.com'

// Card data is fetched once per viewer and the panel/overlay are dead without it, so
// a blip on a viewer's connection must not cost them the whole session. Backoff in
// ms per attempt; the first is immediate.
export const CARD_FETCH_BACKOFF = [0, 1_000, 5_000]

export async function fetchCards(token: string): Promise<BazaarCard[]> {
  const ac = new AbortController()
  const tid = setTimeout(() => ac.abort(), 8000)
  try {
    const res = await fetch(`${EBS_BASE}/api/cards`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ac.signal,
    })
    if (!res.ok) throw new Error(`${res.status}`)
    const data = await res.json() as { items: BazaarCard[]; skills: BazaarCard[] }
    return [...(data.items ?? []), ...(data.skills ?? [])]
  } finally {
    clearTimeout(tid)
  }
}
