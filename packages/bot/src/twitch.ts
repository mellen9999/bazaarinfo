const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws'
const IRC_URL = 'wss://irc-ws.chat.twitch.tv'
const HELIX_URL = 'https://api.twitch.tv/helix'

interface TwitchConfig {
  token: string
  clientId: string
  botUserId: string
  botUsername: string
  channelUserId: string
  channel: string
}

type MessageHandler = (userId: string, username: string, text: string) => void

export class TwitchClient {
  private eventsub: WebSocket | null = null
  private irc: WebSocket | null = null
  private sessionId = ''
  private config: TwitchConfig
  private onMessage: MessageHandler
  private keepaliveTimeout: Timer | null = null
  private keepaliveMs = 15_000
  private ircReady = false
  private ircQueue: string[] = []

  constructor(config: TwitchConfig, onMessage: MessageHandler) {
    this.config = config
    this.onMessage = onMessage
  }

  async connect() {
    this.connectEventSub()
    this.connectIrc()
  }

  // --- EventSub (receive) ---

  private connectEventSub() {
    this.eventsub = new WebSocket(EVENTSUB_URL)
    this.eventsub.onmessage = (ev) => this.handleEventSub(JSON.parse(ev.data))
    this.eventsub.onclose = (ev) => {
      console.log(`eventsub closed: ${ev.code} ${ev.reason}`)
      this.reconnectEventSub()
    }
    this.eventsub.onerror = (ev) => console.error('eventsub error:', ev)
  }

  private async handleEventSub(msg: any) {
    const type = msg.metadata?.message_type

    if (type === 'session_welcome') {
      this.sessionId = msg.payload.session.id
      this.keepaliveMs = (msg.payload.session.keepalive_timeout_seconds ?? 10) * 1000
      console.log(`eventsub connected, session: ${this.sessionId}`)
      await this.subscribe()
      this.resetKeepalive()
    } else if (type === 'session_keepalive') {
      this.resetKeepalive()
    } else if (type === 'notification') {
      this.resetKeepalive()
      if (msg.metadata.subscription_type === 'channel.chat.message') {
        const e = msg.payload.event
        this.onMessage(e.chatter_user_id, e.chatter_user_login, e.message.text)
      }
    } else if (type === 'session_reconnect') {
      const newUrl = msg.payload.session.reconnect_url
      console.log('eventsub reconnecting to', newUrl)
      const oldWs = this.eventsub
      this.eventsub = new WebSocket(newUrl)
      this.eventsub.onmessage = (ev) => this.handleEventSub(JSON.parse(ev.data))
      this.eventsub.onclose = (ev) => {
        console.log(`eventsub closed: ${ev.code}`)
        this.reconnectEventSub()
      }
      this.eventsub.onopen = () => oldWs?.close()
    }
  }

  private resetKeepalive() {
    if (this.keepaliveTimeout) clearTimeout(this.keepaliveTimeout)
    this.keepaliveTimeout = setTimeout(() => {
      console.log('keepalive timeout, reconnecting eventsub...')
      this.eventsub?.close()
    }, this.keepaliveMs + 5000)
  }

  private async reconnectEventSub() {
    if (this.keepaliveTimeout) clearTimeout(this.keepaliveTimeout)
    console.log('eventsub reconnecting in 3s...')
    await new Promise((r) => setTimeout(r, 3000))
    this.connectEventSub()
  }

  private async subscribe() {
    const body = {
      type: 'channel.chat.message',
      version: '1',
      condition: {
        broadcaster_user_id: this.config.channelUserId,
        user_id: this.config.botUserId,
      },
      transport: {
        method: 'websocket',
        session_id: this.sessionId,
      },
    }

    const res = await fetch(`${HELIX_URL}/eventsub/subscriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        'Client-Id': this.config.clientId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`subscribe failed: ${res.status} ${err}`)
    }
    console.log('subscribed to channel.chat.message')
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
        } else if (line.includes('001')) {
          // RPL_WELCOME — auth succeeded, join channel
          this.ircSend(`JOIN #${this.config.channel}`)
        } else if (line.includes('JOIN')) {
          console.log(`irc joined #${this.config.channel}`)
          this.ircReady = true
          this.flushQueue()
        } else if (line.startsWith(':tmi.twitch.tv NOTICE')) {
          console.log('irc notice:', line)
        }
      }
    }

    this.irc.onclose = (ev) => {
      console.log(`irc closed: ${ev.code} ${ev.reason}`)
      this.ircReady = false
      this.reconnectIrc()
    }

    this.irc.onerror = (ev) => console.error('irc error:', ev)
  }

  private ircSend(msg: string) {
    if (this.irc?.readyState === WebSocket.OPEN) {
      this.irc.send(msg + '\r\n')
    }
  }

  private async reconnectIrc() {
    console.log('irc reconnecting in 3s...')
    await new Promise((r) => setTimeout(r, 3000))
    this.connectIrc()
  }

  private flushQueue() {
    while (this.ircQueue.length > 0) {
      const msg = this.ircQueue.shift()!
      this.ircSend(`PRIVMSG #${this.config.channel} :${msg}`)
    }
  }

  async say(text: string) {
    if (this.ircReady) {
      this.ircSend(`PRIVMSG #${this.config.channel} :${text}`)
    } else {
      this.ircQueue.push(text)
    }
  }
}

export async function getUserId(token: string, clientId: string, login: string): Promise<string> {
  const res = await fetch(`${HELIX_URL}/users?login=${login}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Client-Id': clientId,
    },
  })
  if (!res.ok) throw new Error(`getUserId failed: ${res.status}`)
  const data = await res.json() as any
  return data.data[0]?.id
}
