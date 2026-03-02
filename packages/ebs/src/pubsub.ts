// Twitch PubSub Extension broadcast
// See: https://dev.twitch.tv/docs/extensions/reference/#send-extension-pubsub-message

import { createServerJwt } from './auth'

const CLIENT_ID = process.env.TWITCH_EXTENSION_CLIENT_ID ?? ''

interface DetectedCard {
  title: string
  tier: string
  x: number
  y: number
  w: number
  h: number
}

export async function broadcastCards(channelId: string, cards: DetectedCard[]): Promise<boolean> {
  if (!CLIENT_ID) {
    console.error('[pubsub] TWITCH_EXTENSION_CLIENT_ID not set')
    return false
  }

  const jwt = await createServerJwt(channelId)
  const message = JSON.stringify({ cards })

  const res = await fetch(`https://api.twitch.tv/extensions/message/${channelId}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'Client-Id': CLIENT_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content_type: 'application/json',
      message,
      targets: ['broadcast'],
    }),
  })

  if (!res.ok) {
    console.error(`[pubsub] broadcast failed: ${res.status} ${await res.text()}`)
    return false
  }

  return true
}
