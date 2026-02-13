import { log } from './log'

const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws'
const IRC_URL = 'wss://irc-ws.chat.twitch.tv'
const HELIX_URL = 'https://api.twitch.tv/helix'
const FETCH_TIMEOUT = 10_000
const MAX_QUEUE = 50
const BACKOFF_BASE = 3_000
const BACKOFF_MAX = 300_000 // 5min cap

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

export type MessageHandler = (channel: string, userId: string, username: string, text: string) => void

export type AuthRefreshFn = () => Promise<string>

function fetchWithTimeout(url: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(FETCH_TIMEOUT) })
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
  private ircQueue: { channel: string; text: string }[] = []
  private sendTimes: number[] = []
  private readonly SEND_LIMIT = 18
  private readonly SEND_WINDOW = 30_000
  private eventsubBackoff = BACKOFF_BASE
  private ircBackoff = BACKOFF_BASE
  lastActivity = Date.now()

  constructor(config: TwitchConfig, onMessage: MessageHandler) {
    this.config = config
    this.onMessage = onMessage
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
      try { this.handleEventSub(JSON.parse(ev.data)) } catch (e) { log('eventsub message error:', e) }
    }
    ws.onclose = (ev) => { log(`eventsub closed: ${ev.code}`); this.reconnectEventSub() }
    ws.onerror = (ev) => log('eventsub error:', ev)
    return ws
  }

  private async handleEventSub(msg: any) {
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
        this.onMessage(e.broadcaster_user_login, e.chatter_user_id, e.chatter_user_login, e.message.text)
      }
    } else if (type === 'session_reconnect') {
      const newUrl = msg.payload.session.reconnect_url
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
    this.irc = new WebSocket(IRC_URL)

    this.irc.onopen = () => {
      this.ircSend(`PASS oauth:${this.config.token}`)
      this.ircSend(`NICK ${this.config.botUsername}`)
    }

    this.irc.onmessage = (ev) => {
      const lines = String(ev.data).split('\r\n').filter(Boolean)
      for (const line of lines) {
        if (line.startsWith('PING')) {
          this.ircSend(`PONG ${line.slice(5)}`)
        } else if (/ 001 /.test(line)) {
          this.ircBackoff = BACKOFF_BASE // reset on success
          for (const ch of this.config.channels) {
            this.ircSend(`JOIN #${ch.name}`)
          }
        } else if (/ JOIN #/.test(line)) {
          const match = line.match(/JOIN #(\S+)/)
          if (match) log(`irc joined #${match[1]}`)
          if (!this.ircReady) {
            this.ircReady = true
            this.flushQueue()
          }
        } else if (/NOTICE.*(?:Login authentication failed|Login unsuccessful)/.test(line)) {
          log('irc auth failed — refreshing token and reconnecting')
          this.handleIrcAuthFailure()
        } else if (line.startsWith(':tmi.twitch.tv NOTICE')) {
          log('irc notice:', line)
        }
      }
    }

    this.irc.onclose = (ev) => {
      log(`irc closed: ${ev.code} ${ev.reason}`)
      this.ircReady = false
      this.reconnectIrc()
    }

    this.irc.onerror = (ev) => log('irc error:', ev)
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

  private ircSend(msg: string) {
    if (this.irc?.readyState === WebSocket.OPEN) {
      this.irc.send(msg + '\r\n')
    }
  }

  private reconnectIrc() {
    this.reconnectWithBackoff('irc', () => this.ircBackoff, (n) => { this.ircBackoff = n }, () => this.connectIrc())
  }

  private flushQueue() {
    while (this.ircQueue.length > 0 && this.canSend()) {
      const { channel, text } = this.ircQueue.shift()!
      this.sendTimes.push(Date.now())
      this.ircSend(`PRIVMSG #${channel} :${text}`)
    }
    if (this.ircQueue.length > 0) {
      log(`${this.ircQueue.length} queued messages waiting for rate limit`)
      setTimeout(() => this.flushQueue(), 1000)
    }
  }

  private canSend(): boolean {
    const now = Date.now()
    this.sendTimes = this.sendTimes.filter((t) => now - t < this.SEND_WINDOW)
    return this.sendTimes.length < this.SEND_LIMIT
  }

  hasChannel(name: string): boolean {
    return this.config.channels.some((c) => c.name === name)
  }

  async joinChannel(channel: ChannelInfo) {
    if (this.config.channels.some((c) => c.name === channel.name)) return
    this.config.channels.push(channel)
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
    this.ircSend(`PART #${name}`)
    log(`left channel: ${name}`)
  }

  async say(channel: string, text: string) {
    if (text.length > 490) text = text.slice(0, 487) + '...'
    if (this.ircReady && this.canSend()) {
      this.sendTimes.push(Date.now())
      this.ircSend(`PRIVMSG #${channel} :${text}`)
    } else {
      if (this.ircQueue.length >= MAX_QUEUE) {
        log('irc queue full, dropping oldest')
        this.ircQueue.shift()
      }
      this.ircQueue.push({ channel, text })
      if (this.ircReady) {
        setTimeout(() => this.flushQueue(), 1000)
      }
    }
  }
}

export async function getUserId(token: string, clientId: string, login: string): Promise<string> {
  const res = await fetchWithTimeout(`${HELIX_URL}/users?login=${login}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Client-Id': clientId,
    },
  })
  if (!res.ok) throw new Error(`getUserId failed: ${res.status}`)
  const data = (await res.json()) as any
  const id = data.data[0]?.id
  if (!id) throw new Error(`user not found: ${login}`)
  return id
}
