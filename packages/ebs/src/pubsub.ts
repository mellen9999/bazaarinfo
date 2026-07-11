// Twitch PubSub Extension broadcast — bounded queue, 1/sec token bucket, dedupe.
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

interface BroadcastPayload {
  cards: DetectedCard[]
}

const PROTOCOL_VERSION = 1
const HELIX_RATE_MS = 1_100
const MAX_QUEUE_PER_CHANNEL = 4
const MAX_BACKOFF_MS = 30_000

interface QueueItem {
  message: string
  hash: string
  enqueuedAt: number
  attempts: number
}

interface ChannelState {
  queue: QueueItem[]
  lastSendAt: number
  lastHash: string
  pumping: boolean
  backoffMs: number
}

const channels = new Map<string, ChannelState>()

function djb2(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

function getState(channelId: string): ChannelState {
  let s = channels.get(channelId)
  if (!s) {
    s = { queue: [], lastSendAt: 0, lastHash: '', pumping: false, backoffMs: 0 }
    channels.set(channelId, s)
  }
  return s
}

function fitForLimit(payload: BroadcastPayload): string | null {
  const wrapped = { v: PROTOCOL_VERSION, ...payload }
  const full = JSON.stringify(wrapped)
  if (full.length <= 5000) return full
  const slim = {
    v: PROTOCOL_VERSION,
    cards: payload.cards.map(({ title, tier, x, y, w, h, owner, type, enchantment }) =>
      ({ title, tier, x, y, w, h, owner, type, enchantment })),
  }
  const slimMsg = JSON.stringify(slim)
  if (slimMsg.length <= 5000) return slimMsg
  console.error(`[pubsub] payload ${slimMsg.length} bytes after slim, dropping`)
  return null
}

export function broadcastState(channelId: string, payload: BroadcastPayload): boolean {
  if (!CLIENT_ID) {
    console.error('[pubsub] TWITCH_EXTENSION_CLIENT_ID not set')
    return false
  }

  const message = fitForLimit(payload)
  if (!message) return false

  const hash = djb2(message)
  const state = getState(channelId)

  // dedupe: identical message currently last in queue or last sent → drop
  const last = state.queue[state.queue.length - 1]
  if (last?.hash === hash) return true
  if (state.queue.length === 0 && state.lastHash === hash && Date.now() - state.lastSendAt < 5_000) {
    return true
  }

  state.queue.push({ message, hash, enqueuedAt: Date.now(), attempts: 0 })

  // bound queue: keep newest, drop oldest
  while (state.queue.length > MAX_QUEUE_PER_CHANNEL) state.queue.shift()

  pump(channelId).catch((e) => console.error(`[pubsub] pump error: ${e}`))
  return true
}

async function pump(channelId: string): Promise<void> {
  const state = getState(channelId)
  if (state.pumping) return
  state.pumping = true
  try {
    while (state.queue.length > 0) {
      const wait = Math.max(0, state.lastSendAt + HELIX_RATE_MS + state.backoffMs - Date.now())
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))

      const item = state.queue.shift()!
      const ok = await sendOnce(channelId, item.message)
      state.lastSendAt = Date.now()

      if (ok) {
        state.lastHash = item.hash
        state.backoffMs = 0
      } else {
        item.attempts++
        state.backoffMs = Math.min(MAX_BACKOFF_MS, state.backoffMs === 0 ? 1_000 : state.backoffMs * 2)
        // requeue at front if queue is empty and item hasn't hit the give-up cap.
        // cap prevents a permanently-misconfigured channel (bad creds, wrong client_id)
        // from pinning a poison message forever; transient outages self-heal well within 8 tries.
        const MAX_ATTEMPTS = 8
        if (state.queue.length === 0 && item.attempts < MAX_ATTEMPTS) {
          state.queue.unshift(item)
        } else if (item.attempts >= MAX_ATTEMPTS) {
          console.error(`[pubsub] giving up on message after ${item.attempts} attempts (channel ${channelId})`)
        }
      }
    }
  } finally {
    state.pumping = false
  }
}

async function sendOnce(channelId: string, message: string): Promise<boolean> {
  let jwt: string
  try {
    jwt = await createServerJwt(channelId)
  } catch (e) {
    console.error(`[pubsub] jwt error: ${e}`)
    return false
  }

  try {
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
      // a TCP-level stall here would otherwise hold state.pumping forever and
      // silently freeze this channel's broadcasts until an EBS restart
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      console.error(`[pubsub] broadcast failed: ${res.status}`)
      return false
    }
    return true
  } catch (e) {
    console.error(`[pubsub] network error: ${e}`)
    return false
  }
}

export function pubsubStats(): { channels: number; queued: number; backedOff: number } {
  let queued = 0
  let backedOff = 0
  for (const s of channels.values()) {
    queued += s.queue.length
    if (s.backoffMs > 0) backedOff++
  }
  return { channels: channels.size, queued, backedOff }
}
