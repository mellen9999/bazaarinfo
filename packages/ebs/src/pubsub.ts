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
  owner?: string
  type?: string
  enchantment?: string
}

interface ShopCard {
  title: string
  type: string
  tier: string
  size: string
}

interface BroadcastPayload {
  cards: DetectedCard[]
  shop?: ShopCard[]
}

export async function broadcastState(channelId: string, payload: BroadcastPayload): Promise<boolean> {
  if (!CLIENT_ID) {
    console.error('[pubsub] TWITCH_EXTENSION_CLIENT_ID not set')
    return false
  }

  const jwt = await createServerJwt(channelId)
  const message = JSON.stringify(payload)

  if (message.length > 5000) {
    console.warn(`[pubsub] message ${message.length} bytes, stripping attrs`)
    // Strip attrs to fit under 5KB Twitch limit
    const slim = {
      ...payload,
      cards: payload.cards.map(({ title, tier, x, y, w, h, owner, type, enchantment }) =>
        ({ title, tier, x, y, w, h, owner, type, enchantment }))
    }
    const slimMsg = JSON.stringify(slim)
    if (slimMsg.length > 5000) {
      console.error(`[pubsub] still ${slimMsg.length} bytes after stripping`)
    }
    return await sendPubSub(channelId, jwt, slimMsg)
  }

  return await sendPubSub(channelId, jwt, message)
}

async function sendPubSub(channelId: string, jwt: string, message: string): Promise<boolean> {
  const res = await fetch('https://api.twitch.tv/helix/extensions/pubsub', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'Client-Id': CLIENT_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      broadcaster_id: channelId,
      message,
      target: ['broadcast'],
    }),
  })

  if (!res.ok) {
    console.error(`[pubsub] broadcast failed: ${res.status} ${await res.text()}`)
    return false
  }

  return true
}
