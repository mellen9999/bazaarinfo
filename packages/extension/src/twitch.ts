import type { BazaarCard } from '@bazaarinfo/shared/src/types'

export const EBS_BASE = 'https://ebs.bazaarinfo.com'

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
