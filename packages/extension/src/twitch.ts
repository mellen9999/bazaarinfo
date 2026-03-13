import type { BazaarCard } from '@bazaarinfo/shared/src/types'

declare global {
  interface Window {
    Twitch?: {
      ext: {
        onAuthorized: (cb: (auth: { token: string; channelId: string; clientId: string }) => void) => void
        listen: (target: string, cb: (target: string, contentType: string, message: string) => void) => void
        unlisten: (target: string, cb: (target: string, contentType: string, message: string) => void) => void
        onContext?: (cb: (context: { theme: string; language: string; mode: string }) => void) => void
        onVisibilityChanged?: (cb: (isVisible: boolean, context: unknown) => void) => void
      }
    }
  }
}

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
