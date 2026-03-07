import type { BazaarCard } from '@bazaarinfo/shared/src/types'

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

export const EBS_BASE = 'https://ebs.bazaarinfo.com'

export async function fetchCards(token: string): Promise<BazaarCard[]> {
  const res = await fetch(`${EBS_BASE}/api/cards`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return []
  const data = await res.json() as { items: BazaarCard[]; skills: BazaarCard[] }
  return [...(data.items ?? []), ...(data.skills ?? [])]
}
