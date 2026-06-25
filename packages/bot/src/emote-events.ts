import { log } from './log'
import {
  addChannelEmote,
  removeChannelEmote,
  renameChannelEmote,
  getGlobalEmoteSetId,
} from './emotes'

// 7TV EventAPI opcodes
const OP_DISPATCH = 0
const OP_HELLO = 1
const OP_HEARTBEAT = 2
const OP_RECONNECT = 4
const OP_SUBSCRIBE = 35
const OP_UNSUBSCRIBE = 36

// close codes that warrant reconnection
const RECONNECT_CODES = new Set([4000, 4005, 4006, 4007, 4008])

const WS_URL = 'wss://events.7tv.io/v3'
const BASE_BACKOFF = 3_000
const MAX_BACKOFF = 5 * 60_000

let ws: WebSocket | null = null
let sessionId = ''
let heartbeatInterval = 0
let lastHeartbeat = 0
let missedBeats = 0
let heartbeatTimer: Timer | null = null
let backoff = BASE_BACKOFF
let closed = false

// emote set ID → channel name (reverse map for routing dispatches)
const setIdToChannel = new Map<string, string>()
// channel → emote set ID (for resubscribe on reconnect)
const channelSubs = new Map<string, string>()

function send(op: number, d: any) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ op, d }))
  }
}

function subscribe(setId: string) {
  send(OP_SUBSCRIBE, {
    type: 'emote_set.update',
    condition: { object_id: setId },
  })
}

function unsubscribe(setId: string) {
  send(OP_UNSUBSCRIBE, {
    type: 'emote_set.update',
    condition: { object_id: setId },
  })
}

function startHeartbeatCheck() {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  if (!heartbeatInterval) return
  heartbeatTimer = setInterval(() => {
    if (Date.now() - lastHeartbeat > heartbeatInterval * 1.5) {
      missedBeats++
      if (missedBeats >= 3) {
        log('7TV EventAPI: 3 missed heartbeats, reconnecting')
        reconnect()
      }
    } else {
      missedBeats = 0
    }
  }, heartbeatInterval)
}

/** validate an emote name from the untrusted 7TV websocket — @internal exported for tests */
export function validEmoteName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  if (!name || name.length > 64) return null
  return name
}

/** @internal — exported for tests only */
export function handleDispatch(body: any) {
  const setId = body?.condition?.object_id
  if (!setId) return

  // route to channel — check channel subs first, then global
  let channel = setIdToChannel.get(setId)
  const isGlobal = !channel && setId === getGlobalEmoteSetId()
  if (!channel && !isGlobal) return

  const changes = body?.body
  if (!changes) return

  // pushed = emote added
  if (Array.isArray(changes.pushed)) {
    for (const entry of changes.pushed) {
      if (!entry) continue
      const name = validEmoteName(entry.value?.name)
      if (!name) continue
      if (isGlobal) {
        // global emotes affect all channels — just log, full reconciliation handles it
        log(`7TV global emote added: ${name}`)
      } else {
        addChannelEmote(channel!, name)
        log(`7TV emote added in #${channel}: ${name}`)
      }
    }
  }

  // pulled = emote removed
  if (Array.isArray(changes.pulled)) {
    for (const entry of changes.pulled) {
      if (!entry) continue
      const name = validEmoteName(entry.old_value?.name)
      if (!name) continue
      if (isGlobal) {
        log(`7TV global emote removed: ${name}`)
      } else {
        removeChannelEmote(channel!, name)
        log(`7TV emote removed in #${channel}: ${name}`)
      }
    }
  }

  // updated = emote renamed
  if (Array.isArray(changes.updated)) {
    for (const entry of changes.updated) {
      if (!entry) continue
      const oldName = validEmoteName(entry.old_value?.name)
      const newName = validEmoteName(entry.value?.name)
      if (!oldName || !newName || oldName === newName) continue
      if (isGlobal) {
        log(`7TV global emote renamed: ${oldName} → ${newName}`)
      } else {
        renameChannelEmote(channel!, oldName, newName)
        log(`7TV emote renamed in #${channel}: ${oldName} → ${newName}`)
      }
    }
  }
}

function onMessage(event: MessageEvent) {
  let msg: any
  try { msg = JSON.parse(String(event.data)) } catch { return }

  switch (msg.op) {
    case OP_HELLO:
      sessionId = msg.d?.session_id ?? ''
      const hb = Number(msg.d?.heartbeat_interval)
      heartbeatInterval = Number.isFinite(hb) && hb > 0
        ? Math.min(Math.max(hb, 5_000), 120_000)
        : 45_000
      lastHeartbeat = Date.now()
      missedBeats = 0
      startHeartbeatCheck()
      backoff = BASE_BACKOFF
      // rebuild reverse map and resubscribe all channels
      setIdToChannel.clear()
      for (const [ch, setId] of channelSubs) {
        setIdToChannel.set(setId, ch)
        subscribe(setId)
      }
      // subscribe global emote set
      const globalId = getGlobalEmoteSetId()
      if (globalId) subscribe(globalId)
      log(`7TV EventAPI connected (session: ${sessionId.slice(0, 8)}..., ${channelSubs.size} channels)`)
      break

    case OP_HEARTBEAT:
      lastHeartbeat = Date.now()
      missedBeats = 0
      break

    case OP_RECONNECT:
      log('7TV EventAPI: server requested reconnect')
      reconnect()
      break

    case OP_DISPATCH:
      try { handleDispatch(msg.d) } catch (e) { log(`7TV dispatch error: ${e}`) }
      break
  }
}

function reconnect() {
  cleanup()
  if (closed) return
  const delay = Math.min(backoff + Math.random() * 1000, MAX_BACKOFF)
  log(`7TV EventAPI: reconnecting in ${Math.round(delay / 1000)}s`)
  setTimeout(doConnect, delay)
  backoff = Math.min(backoff * 2, MAX_BACKOFF)
}

function cleanup() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  if (ws) {
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
    try { ws.close() } catch {}
    ws = null
  }
}

function doConnect() {
  if (closed) return
  cleanup()
  ws = new WebSocket(WS_URL)

  ws.onmessage = onMessage

  ws.onclose = (event) => {
    if (closed) return
    log(`7TV EventAPI closed: ${event.code} ${event.reason} — reconnecting`)
    reconnect()
  }

  ws.onerror = () => {
    // onclose will fire after this
  }
}

export function connect() {
  closed = false
  doConnect()
}

export function close() {
  closed = true
  cleanup()
  channelSubs.clear()
  setIdToChannel.clear()
}

export function subscribeChannel(channel: string, setId: string) {
  const prev = channelSubs.get(channel)
  if (prev === setId) return // already subscribed to this set — idempotent, safe to call often
  // channel swapped to a different 7TV emote set: release the stale subscription + routing
  // entry, else we keep getting the old set's events and never the new set's (real-time dies).
  if (prev) {
    unsubscribe(prev)
    setIdToChannel.delete(prev)
  }
  channelSubs.set(channel, setId)
  setIdToChannel.set(setId, channel)
  subscribe(setId)
}

export function unsubscribeChannel(channel: string) {
  const setId = channelSubs.get(channel)
  if (setId) {
    unsubscribe(setId)
    channelSubs.delete(channel)
    setIdToChannel.delete(setId)
  }
}
