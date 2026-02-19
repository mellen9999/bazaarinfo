import { log } from './log'

const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws'
const IRC_URL = 'wss://irc-ws.chat.twitch.tv'
const HELIX_URL = 'https://api.twitch.tv/helix'
const FETCH_TIMEOUT = 10_000
const MAX_QUEUE = 50
const BACKOFF_BASE = 3_000
const BACKOFF_MAX = 300_000 // 5min cap

interface EventSubMessage {
  metadata: {
    message_type: string
    subscription_type?: string
  }
  payload: {
    session?: {
      id: string
      keepalive_timeout_seconds?: number
      reconnect_url?: string
    }
    event?: {
      broadcaster_user_login: string
      chatter_user_id: string
      chatter_user_login: string
      message: { text: string }
      badges?: { set_id: string; id: string }[]
    }
  }
}

interface HelixSendResponse {
  data: { is_sent: boolean; drop_reason?: { message: string } }[]
}

interface HelixUsersResponse {
  data: { id: string }[]
}

export interface ChannelInfo {
  name: string
  userId: string
}

export interface TwitchConfig {
  token: string
  clientId: string
  botUserId: string
  botUsername: string
  channels: ChannelInfo[]
}

export type MessageHandler = (channel: string, userId: string, username: string, text: string, badges: string[]) => void

export type AuthRefreshFn = () => Promise<string>

function fetchWithTimeout(url: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(FETCH_TIMEOUT) })
}

type IrcMessage =
  | { type: 'ping'; payload: string }
  | { type: 'welcome' }
  | { type: 'join'; channel: string }
  | { type: 'auth_failure' }
  | { type: 'notice' }
  | { type: 'other' }

function parseIrcLine(line: string): IrcMessage {
  if (line.startsWith('PING')) return { type: 'ping', payload: line.slice(5) }
  if (/ 001 /.test(line)) return { type: 'welcome' }
  const joinMatch = line.match(/ JOIN #(\S+)/)
  if (joinMatch) return { type: 'join', channel: joinMatch[1] }
  if (/NOTICE.*(?:Login authentication failed|Login unsuccessful)/.test(line)) return { type: 'auth_failure' }
  if (line.startsWith(':tmi.twitch.tv NOTICE')) return { type: 'notice' }
  return { type: 'other' }
}

export class TwitchClient {
  private eventsub: WebSocket | null = null
  private irc: WebSocket | null = null
  private sessionId = ''
  private config: TwitchConfig
  private onMessage: MessageHandler
  private onAuthFailure: AuthRefreshFn | null = null
  private keepaliveTimeout: Timer | null = null
  private keepaliveMs = 15_000
  private closing = false
  private ircReady = false
  private ircPingTimeout: Timer | null = null
  private ircReconnecting = false
  private ircQueue: { channel: string; text: string }[] = []
  private sendTimes: number[] = []
  private readonly SEND_LIMIT = 90
  private readonly SEND_WINDOW = 30_000
  private eventsubBackoff = BACKOFF_BASE
  private ircBackoff = BACKOFF_BASE
  private _channelIdMap: Record<string, string> = {}
  lastActivity = Date.now()

  constructor(config: TwitchConfig, onMessage: MessageHandler) {
    this.config = config
    this.onMessage = onMessage
    this.rebuildChannelMap()
  }

  private rebuildChannelMap() {
    const map: Record<string, string> = {}
    for (const ch of this.config.channels) map[ch.name] = ch.userId
    this._channelIdMap = map
  }

  setAuthRefresh(fn: AuthRefreshFn) {
    this.onAuthFailure = fn
  }

  updateToken(token: string) {
    this.config.token = token
  }

  async connect() {
    this.connectEventSub()
    this.connectIrc()
  }

  close() {
    this.closing = true
    if (this.keepaliveTimeout) clearTimeout(this.keepaliveTimeout)
    if (this.ircPingTimeout) clearTimeout(this.ircPingTimeout)
    this.eventsub?.close()
    this.irc?.close()
    log('connections closed')
  }

  // --- EventSub (receive) ---

  private connectEventSub() {
    this.eventsub = this.wireEventSub(new WebSocket(EVENTSUB_URL))
  }

  private wireEventSub(ws: WebSocket): WebSocket {
    ws.onmessage = (ev) => {
      try { this.handleEventSub(JSON.parse(ev.data) as EventSubMessage) } catch (e) { log('eventsub message error:', e) }
    }
    ws.onclose = (ev) => {
      log(`eventsub closed: ${ev.code}`)
      // only reconnect if this is still the active WS (prevents stray reconnect on session_reconnect)
      if (this.eventsub === ws) this.reconnectEventSub()
    }
    ws.onerror = (ev) => log('eventsub error:', ev)
    return ws
  }

  private async handleEventSub(msg: EventSubMessage) {
    const type = msg.metadata?.message_type

    if (type === 'session_welcome') {
      this.sessionId = msg.payload.session.id
      this.keepaliveMs = (msg.payload.session.keepalive_timeout_seconds ?? 10) * 1000
      log(`eventsub connected, session: ${this.sessionId}`)
      this.eventsubBackoff = BACKOFF_BASE // reset on success
      await this.subscribeAll()
      this.resetKeepalive()
    } else if (type === 'session_keepalive') {
      this.resetKeepalive()
    } else if (type === 'notification') {
      this.resetKeepalive()
      if (msg.metadata.subscription_type === 'channel.chat.message') {
        const e = msg.payload.event
        const badges = (e.badges ?? []).map((b: { set_id: string }) => b.set_id)
        this.onMessage(e.broadcaster_user_login, e.chatter_user_id, e.chatter_user_login, e.message.text, badges)
      }
    } else if (type === 'session_reconnect') {
      const newUrl = msg.payload.session?.reconnect_url
      if (!newUrl) { log('session_reconnect missing url, ignoring'); return }
      log('eventsub reconnecting to', newUrl)
      const oldWs = this.eventsub
      this.eventsub = this.wireEventSub(new WebSocket(newUrl))
      this.eventsub.onopen = () => oldWs?.close()
    }
  }

  private resetKeepalive() {
    this.lastActivity = Date.now()
    if (this.keepaliveTimeout) clearTimeout(this.keepaliveTimeout)
    this.keepaliveTimeout = setTimeout(() => {
      log('keepalive timeout, reconnecting eventsub...')
      this.eventsub?.close()
    }, this.keepaliveMs + 5000)
  }

  private async reconnectWithBackoff(
    label: string,
    getBackoff: () => number,
    setBackoff: (n: number) => void,
    connectFn: () => void,
  ) {
    if (this.closing) return
    const ms = getBackoff()
    log(`${label} reconnecting in ${Math.round(ms / 1000)}s...`)
    await new Promise((r) => setTimeout(r, ms))
    setBackoff(Math.min(ms * 2, BACKOFF_MAX))
    if (!this.closing) connectFn()
  }

  private reconnectEventSub() {
    if (this.keepaliveTimeout) clearTimeout(this.keepaliveTimeout)
    this.reconnectWithBackoff('eventsub', () => this.eventsubBackoff, (n) => { this.eventsubBackoff = n }, () => this.connectEventSub())
  }

  private async subscribeAll() {
    for (const ch of this.config.channels) {
      try {
        await this.subscribe(ch.userId)
      } catch (e) {
        log(`subscribe error for ${ch.name}: ${e}`)
      }
    }
  }

  private async subscribe(broadcasterUserId: string, retries = 2): Promise<void> {
    const body = {
      type: 'channel.chat.message',
      version: '1',
      condition: {
        broadcaster_user_id: broadcasterUserId,
        user_id: this.config.botUserId,
      },
      transport: {
        method: 'websocket',
        session_id: this.sessionId,
      },
    }

    const res = await fetchWithTimeout(`${HELIX_URL}/eventsub/subscriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        'Client-Id': this.config.clientId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (res.status === 401 && this.onAuthFailure && retries > 0) {
      log('helix 401 — refreshing token and retrying subscribe')
      const newToken = await this.onAuthFailure()
      this.config.token = newToken
      return this.subscribe(broadcasterUserId, retries - 1)
    }

    if (res.status === 409) {
      log(`already subscribed for ${broadcasterUserId}, skipping`)
      return
    }

    if (!res.ok) {
      const err = await res.text()
      if (retries > 0) {
        log(`subscribe failed (${broadcasterUserId}): ${res.status}, retrying in 5s...`)
        await new Promise((r) => setTimeout(r, 5000))
        return this.subscribe(broadcasterUserId, retries - 1)
      }
      throw new Error(`subscribe failed (${broadcasterUserId}): ${res.status} ${err}`)
    }
    log(`subscribed to channel.chat.message for ${broadcasterUserId}`)
  }

  // --- IRC (send) ---

  private connectIrc() {
    this.ircReady = false
    this.ircReconnecting = false
    // close old socket if still lingering
    if (this.irc) {
      try { this.irc.onclose = null; this.irc.close() } catch {}
    }
    this.irc = new WebSocket(IRC_URL)

    this.irc.onopen = () => {
      this.ircSend('CAP REQ :twitch.tv/membership twitch.tv/tags twitch.tv/commands')
      this.ircSend(`PASS oauth:${this.config.token}`)
      this.ircSend(`NICK ${this.config.botUsername}`)
    }

    this.irc.onmessage = (ev) => {
      const lines = String(ev.data).split('\r\n').filter(Boolean)
      for (const line of lines) {
        const msg = parseIrcLine(line)
        switch (msg.type) {
          case 'ping':
            if (!this.ircSend(`PONG ${msg.payload}`)) {
              log('irc PONG failed, socket dead — reconnecting')
              this.irc?.close()
            }
            break
          case 'welcome':
            this.ircBackoff = BACKOFF_BASE
            for (const ch of this.config.channels) this.ircSend(`JOIN #${ch.name}`)
            break
          case 'join':
            log(`irc joined #${msg.channel}`)
            if (!this.ircReady) { this.ircReady = true; this.flushQueue() }
            break
          case 'auth_failure':
            log('irc auth failed — refreshing token and reconnecting')
            this.handleIrcAuthFailure()
            break
          case 'notice':
            log('irc notice:', line)
            break
        }
        this.resetIrcPingTimeout()
      }
    }

    this.irc.onclose = (ev) => {
      log(`irc closed: ${ev.code} ${ev.reason}`)
      this.ircReady = false
      if (this.ircPingTimeout) clearTimeout(this.ircPingTimeout)
      this.reconnectIrc()
    }

    this.irc.onerror = (ev) => log('irc error:', ev)
  }

  // Twitch sends PING every ~5min. If we hear nothing for 6min, connection is dead.
  private resetIrcPingTimeout() {
    if (this.ircPingTimeout) clearTimeout(this.ircPingTimeout)
    this.ircPingTimeout = setTimeout(() => {
      log('irc ping timeout (6min no data) — reconnecting')
      this.irc?.close()
    }, 360_000)
  }

  private async handleIrcAuthFailure() {
    if (!this.onAuthFailure) return
    try {
      const newToken = await this.onAuthFailure()
      this.config.token = newToken
      this.irc?.close()
    } catch (e) {
      log('auth refresh failed during irc reconnect:', e)
    }
  }

  private ircSend(msg: string): boolean {
    if (this.irc?.readyState === WebSocket.OPEN) {
      this.irc.send(msg + '\r\n')
      return true
    }
    return false
  }

  private reconnectIrc() {
    if (this.ircReconnecting) return
    this.ircReconnecting = true
    this.reconnectWithBackoff('irc', () => this.ircBackoff, (n) => { this.ircBackoff = n }, () => this.connectIrc())
  }

  private async flushQueue() {
    while (this.ircQueue.length > 0 && this.canSend()) {
      const { channel, text } = this.ircQueue.shift()!
      this.sendTimes.push(Date.now())
      if (this.ircReady && this.ircSend(`PRIVMSG #${channel} :${text}`)) {
        // sent via IRC
      } else {
        await this.helixSend(channel, text)
      }
    }
    if (this.ircQueue.length > 0) {
      log(`${this.ircQueue.length} queued messages waiting for rate limit`)
      setTimeout(() => this.flushQueue(), 1000)
    }
  }

  private canSend(): boolean {
    const now = Date.now()
    const cutoff = now - this.SEND_WINDOW
    // trim expired entries from the front (oldest first)
    while (this.sendTimes.length > 0 && this.sendTimes[0] < cutoff) {
      this.sendTimes.shift()
    }
    return this.sendTimes.length < this.SEND_LIMIT
  }

  hasChannel(name: string): boolean {
    return this.config.channels.some((c) => c.name === name)
  }

  getChannels(): ChannelInfo[] {
    return this.config.channels
  }

  async joinChannel(channel: ChannelInfo) {
    if (this.config.channels.some((c) => c.name === channel.name)) return
    this.config.channels.push(channel)
    this.rebuildChannelMap()
    this.ircSend(`JOIN #${channel.name}`)
    if (this.sessionId) {
      try {
        await this.subscribe(channel.userId)
      } catch (e) {
        log(`subscribe error for ${channel.name}: ${e}`)
      }
    }
    log(`joined channel: ${channel.name}`)
  }

  leaveChannel(name: string) {
    this.config.channels = this.config.channels.filter((c) => c.name !== name)
    this.rebuildChannelMap()
    this.ircSend(`PART #${name}`)
    log(`left channel: ${name}`)
  }

  private async helixSend(channel: string, text: string, retried = false): Promise<boolean> {
    const broadcasterId = this._channelIdMap[channel]
    if (!broadcasterId) return false
    try {
      const res = await fetchWithTimeout(`${HELIX_URL}/chat/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          'Client-Id': this.config.clientId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          broadcaster_id: broadcasterId,
          sender_id: this.config.botUserId,
          message: text,
        }),
      })
      if (res.status === 401 && !retried && this.onAuthFailure) {
        log('helix send 401 — refreshing token and retrying')
        const newToken = await this.onAuthFailure()
        this.config.token = newToken
        return this.helixSend(channel, text, true)
      }
      if (!res.ok) {
        const err = await res.text()
        log(`helix send failed (${channel}): ${res.status} ${err}`)
        return false
      }
      const data = (await res.json()) as HelixSendResponse
      if (!data.data?.[0]?.is_sent) {
        log(`helix send dropped (${channel}): ${data.data?.[0]?.drop_reason?.message ?? 'unknown'}`)
        return false
      }
      return true
    } catch (e) {
      log(`helix send error (${channel}): ${e}`)
      return false
    }
  }

  async say(channel: string, text: string) {
    // strip twitch command prefixes — bot is a mod, NEVER execute / or . commands
    text = text.replace(/^[/.]/, '')
    if (text.length > 490) text = text.slice(0, 487) + '...'
    if (!this.canSend()) {
      if (this.ircQueue.length >= MAX_QUEUE) {
        log('queue full, dropping oldest')
        this.ircQueue.shift()
      }
      this.ircQueue.push({ channel, text })
      if (this.ircReady) setTimeout(() => this.flushQueue(), 1000)
      return
    }
    this.sendTimes.push(Date.now())
    // prefer IRC (instant WebSocket) over Helix (HTTP round-trip)
    if (this.ircReady && this.ircSend(`PRIVMSG #${channel} :${text}`)) {
      // sent via IRC
    } else {
      const sent = await this.helixSend(channel, text)
      if (!sent) log(`helix send failed for #${channel}, irc not ready`)
    }
  }
}

export async function getUserId(
  token: string,
  clientId: string,
  login: string,
  onAuthFailure?: AuthRefreshFn,
): Promise<string> {
  const res = await fetchWithTimeout(`${HELIX_URL}/users?login=${encodeURIComponent(login)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Client-Id': clientId,
    },
  })
  if (res.status === 401 && onAuthFailure) {
    log(`getUserId 401 for ${login}, refreshing token and retrying`)
    const newToken = await onAuthFailure()
    return getUserId(newToken, clientId, login)
  }
  if (!res.ok) throw new Error(`getUserId failed: ${res.status}`)
  const data = (await res.json()) as HelixUsersResponse
  const id = data.data[0]?.id
  if (!id) throw new Error(`user not found: ${login}`)
  return id
}
