import { log } from './log'
import { stripOutgoingCommands } from './text-safety'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws'
const IRC_URL = 'wss://irc-ws.chat.twitch.tv'
const HELIX_URL = 'https://api.twitch.tv/helix'
const FETCH_TIMEOUT = 10_000
const MAX_QUEUE = 50
const BACKOFF_BASE = 3_000
const BACKOFF_MAX = 60_000 // 1min cap
const BACKOFF_WAF_BLOCKED = 30 * 60_000 // 30min when CloudFront WAF blocks us
// after this many consecutive WAF blocks the edge is clearly rejecting our egress IP
// permanently (datacenter/VPN range CloudFront blocks by policy). retrying every 30min
// forever just churns + spams logs — drop to a quiet 6h self-healing retry instead.
const WAF_PERSISTENT_THRESHOLD = 4
const BACKOFF_WAF_PERSISTENT = 6 * 60 * 60_000 // 6h once the WAF block is clearly permanent
const MAX_CONSECUTIVE_FAILURES = 10
const STATE_FILE = 'cache/eventsub-state.json'
// if N+ failures in last 30min recorded across processes, sleep before first connect
const STARTUP_BACKOFF_THRESHOLD = 5
const STARTUP_BACKOFF_WINDOW = 30 * 60_000

interface EventSubState {
  consecutiveFailures: number
  lastFailureAt: number
  firstFailureAt: number
  lastWafBlockAt: number
}

function loadEventsubState(): EventSubState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as EventSubState
  } catch {
    return { consecutiveFailures: 0, lastFailureAt: 0, firstFailureAt: 0, lastWafBlockAt: 0 }
  }
}

function saveEventsubState(s: EventSubState) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(s))
  } catch {}
}

interface EventSubMessage {
  metadata: {
    message_type: string
    subscription_type?: string
    message_timestamp?: string
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
      message_id: string
      message: { text: string }
      badges?: { set_id: string; id: string }[]
      reply?: { parent_user_login: string; parent_message_body?: string; thread_message_id?: string }
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

export type MessageHandler = (channel: string, userId: string, username: string, text: string, badges: string[], messageId: string, threadId?: string, sentTs?: number) => void

export type AuthRefreshFn = () => Promise<string>

function fetchWithTimeout(url: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(FETCH_TIMEOUT) })
}

interface IrcPrivmsg {
  type: 'privmsg'
  channel: string
  login: string
  text: string
  userId: string
  messageId: string
  badges: string[]
  sentTs: number
  replyParentUserLogin?: string
  threadId?: string
}

type IrcMessage =
  | { type: 'ping'; payload: string }
  | { type: 'welcome' }
  | { type: 'join'; channel: string }
  | { type: 'auth_failure' }
  | { type: 'notice'; raw?: string }
  | { type: 'userstate'; channel: string; privileged: boolean }
  | IrcPrivmsg
  | { type: 'other' }

function parseIrcTags(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of raw.split(';')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const k = pair.slice(0, eq)
    const v = pair.slice(eq + 1).replace(/\\s/g, ' ').replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\:/g, ';').replace(/\\\\/g, '\\')
    out[k] = v
  }
  return out
}

export function parseIrcLine(line: string): IrcMessage {
  if (line.startsWith('PING')) return { type: 'ping', payload: line.slice(5) }
  if (/ 001 /.test(line)) return { type: 'welcome' }
  const joinMatch = line.match(/ JOIN #(\S+)/)
  if (joinMatch) return { type: 'join', channel: joinMatch[1] }
  if (/NOTICE.*(?:Login authentication failed|Login unsuccessful)/.test(line)) return { type: 'auth_failure' }
  if (line.startsWith(':tmi.twitch.tv NOTICE')) return { type: 'notice', raw: line }

  // PRIVMSG with tags: @key=val;... :nick!user@host PRIVMSG #channel :text
  if (line.startsWith('@')) {
    const space = line.indexOf(' ')
    if (space < 0) return { type: 'other' }
    const tags = parseIrcTags(line.slice(1, space))
    const rest = line.slice(space + 1)
    // tagged NOTICE (@msg-id=msg_duplicate/msg_ratelimit/automod… :tmi.twitch.tv NOTICE
    // #ch :reason) — this is Twitch EXPLAINING a server-side message drop. it used to fall
    // through to 'other' and vanish (the game-603 headless round: the question's rejection
    // reason was delivered here and discarded). surface it so drops are diagnosable.
    const ntMatch = rest.match(/^:tmi\.twitch\.tv NOTICE #?(\S+) :(.*)$/)
    if (ntMatch) return { type: 'notice', raw: `[${tags['msg-id'] ?? '?'}] #${ntMatch[1]}: ${ntMatch[2]}` }
    // USERSTATE: twitch's per-channel statement of OUR badges in that channel.
    // sent on join + after each privmsg we send. tells us if we're vip/mod/broadcaster
    // there, which decides whether sends draw from the 100/30s mod bucket or are also
    // capped by the 20/30s user bucket.
    const usMatch = rest.match(/^:tmi\.twitch\.tv USERSTATE #(\S+)/)
    if (usMatch) {
      const badges = (tags['badges'] || '').split(',').map((b) => b.split('/')[0])
      const privileged = tags['mod'] === '1' || badges.includes('vip') || badges.includes('moderator') || badges.includes('broadcaster')
      return { type: 'userstate', channel: usMatch[1], privileged }
    }
    const pmMatch = rest.match(/^:([^!]+)![^ ]+ PRIVMSG #(\S+) :(.*)$/)
    if (!pmMatch) return { type: 'other' }
    const [, login, channel, text] = pmMatch
    const badges = (tags['badges'] || '').split(',').filter(Boolean).map((b) => b.split('/')[0])
    return {
      type: 'privmsg',
      channel,
      login,
      text,
      userId: tags['user-id'] || '',
      messageId: tags['id'] || '',
      badges,
      // twitch's authoritative send time (epoch ms). used to drop replies that couldn't be
      // produced/sent while fresh (network stall backlog) instead of bursting them out late.
      sentTs: Number(tags['tmi-sent-ts']) || 0,
      replyParentUserLogin: tags['reply-parent-user-login'] || undefined,
      threadId: tags['reply-thread-parent-msg-id'] || tags['reply-parent-msg-id'] || undefined,
    }
  }
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
  private ircLastData = Date.now()
  private ircWatchdog: Timer | null = null
  private ircReconnecting = false
  private ircQueue: { channel: string; text: string; replyTo?: string; failCount?: number }[] = []
  // single paced drain — at most one outgoing message per SEND_GAP, so simultaneous
  // reply completions go out spaced like human typing instead of a burst (which reads
  // as spam and risks the 30min lockout). first message after idle still goes immediately.
  private pacerTimer: Timer | null = null
  // true while a send is in flight (the pacer callback nulls pacerTimer before its async
  // sendOne await). without this, a concurrent say()->kickPacer during that await sees
  // pacerTimer===null and schedules a SECOND drain → two helix POSTs race / reorder.
  private draining = false
  private lastSendAt = 0
  private readonly SEND_GAP = 400
  // twitch chat rate limiting uses TWO account-wide buckets, each refilling over 30s
  // (per https://dev.twitch.tv/docs/chat + pajbot/tmi-rate-limits):
  //   moderator-bucket: 100/30s — EVERY send debits this.
  //   user-bucket:       20/30s — only sends to channels where we're NOT
  //                               vip/mod/broadcaster also debit this.
  // a send to a channel where we're privileged (vip counts!) draws from the mod
  // bucket only, so it's effectively capped at 100/30s; everywhere else the 20/30s
  // user bucket binds. exceeding either = messages dropped + a 30min spam lockout,
  // so we keep a safety margin under both ceilings.
  private modSendTimes: number[] = []
  private userSendTimes: number[] = []
  private readonly MOD_LIMIT = 95
  private readonly USER_LIMIT = 18
  private readonly SEND_WINDOW = 30_000
  // channels where we're vip/mod/broadcaster — learned live from USERSTATE. default
  // (unknown) = non-privileged, so we never assume a firehose we weren't granted.
  private privilegedChannels = new Set<string>()
  private eventsubBackoff = BACKOFF_BASE
  private eventsubConsecutiveFailures = 0
  eventsubEverConnected = false
  private eventsubLastWafBlockReason = ''
  // one-shot guard so the persistent-WAF state logs once on entry, not every 6h retry
  private eventsubWafPersistentLogged = false
  private ircBackoff = BACKOFF_BASE
  private _channelIdMap: Record<string, string> = {}
  private ircOnlyChannels = new Set<string>()
  private eventsubPingInterval: Timer | null = null
  // warm-reconnect state: on keepalive timeout, open a new WS in parallel rather than
  // close-then-reconnect. old WS keeps delivering (onmessage attached) until new session
  // is fully subscribed, then we close it. dedup ring catches any momentary overlap.
  private pendingOldEventsub: WebSocket | null = null
  private warmReconnecting = false
  private ircPingInterval: Timer | null = null
  private ircConnectTimeout: Timer | null = null
  private ircJoinAckTimeout: Timer | null = null
  private ircJoinedChannels = new Set<string>()
  // Dedup ring for messages seen via either transport. EventSub + IRC PRIVMSG can
  // both deliver the same message; first wins, duplicates dropped by message id.
  private seenMessageIds: string[] = []
  private seenMessageIdSet = new Set<string>()
  private readonly SEEN_MSG_CAP = 512
  lastActivity = Date.now()

  constructor(config: TwitchConfig, onMessage: MessageHandler) {
    this.config = config
    this.onMessage = onMessage
    this.rebuildChannelMap()
  }

  private rebuildChannelMap() {
    const map: Record<string, string> = {}
    // belt-and-suspenders: lowercase keys so helix routing is case-insensitive regardless
    // of how channel names entered the config (e.g. mixed-case TWITCH_CHANNELS env var).
    for (const ch of this.config.channels) map[ch.name.toLowerCase()] = ch.userId
    this._channelIdMap = map
  }

  setAuthRefresh(fn: AuthRefreshFn) {
    this.onAuthFailure = fn
  }

  setIrcOnly(channels: string[]) {
    this.ircOnlyChannels = new Set(channels)
  }

  updateToken(token: string) {
    this.config.token = token
  }

  async connect() {
    // IRC connects immediately — chat reception/commands must not be blocked by
    // an unrelated EventSub WAF cooldown. EventSub gets its own backoff in parallel.
    this.connectIrc()
    this.applyStartupBackoff().then(() => this.connectEventSub())
  }

  // if prior process(es) just hammered eventsub into a WAF block, sit out before first attempt
  // so systemd-restart loops can't keep firing handshakes through the ban.
  // EventSub-only — IRC is decoupled (see connect()).
  private async applyStartupBackoff() {
    const s = loadEventsubState()
    const now = Date.now()
    if (s.lastWafBlockAt && now - s.lastWafBlockAt < BACKOFF_WAF_BLOCKED) {
      const wait = BACKOFF_WAF_BLOCKED - (now - s.lastWafBlockAt)
      log(`startup: WAF block detected ${Math.round((now - s.lastWafBlockAt) / 60_000)}min ago, sleeping ${Math.round(wait / 60_000)}min before connecting`)
      await new Promise((r) => setTimeout(r, wait))
      return
    }
    if (s.consecutiveFailures >= STARTUP_BACKOFF_THRESHOLD && now - s.lastFailureAt < STARTUP_BACKOFF_WINDOW) {
      const wait = Math.min(BACKOFF_MAX * 5, 60_000 * s.consecutiveFailures)
      log(`startup: ${s.consecutiveFailures} recent failures (oldest ${Math.round((now - s.firstFailureAt) / 60_000)}min ago), sleeping ${Math.round(wait / 1000)}s before connecting`)
      await new Promise((r) => setTimeout(r, wait))
    }
  }

  close() {
    this.closing = true
    this.ircReconnecting = false
    if (this.keepaliveTimeout) clearTimeout(this.keepaliveTimeout)
    if (this.ircWatchdog) clearInterval(this.ircWatchdog)
    if (this.eventsubPingInterval) clearInterval(this.eventsubPingInterval)
    if (this.ircPingInterval) clearInterval(this.ircPingInterval)
    if (this.ircConnectTimeout) clearTimeout(this.ircConnectTimeout)
    if (this.ircJoinAckTimeout) clearTimeout(this.ircJoinAckTimeout)
    this.eventsub?.close()
    this.pendingOldEventsub?.close()
    this.pendingOldEventsub = null
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
      const reason = ev.reason || ''
      log(`eventsub closed: ${ev.code}${reason ? ` (${reason})` : ''}`)
      // 1002 + "Expected 101" = HTTP upgrade rejected (CloudFront WAF / 403 / network gate)
      const isWafBlock = ev.code === 1002 && /101|forbidden|403/i.test(reason)
      if (isWafBlock) this.eventsubLastWafBlockReason = reason
      // only reconnect if this is still the active WS (prevents stray reconnect on session_reconnect)
      if (this.eventsub === ws) {
        // warm reconnect's NEW ws died before welcome — drop both, fall back to cold reconnect
        if (this.warmReconnecting) {
          if (this.pendingOldEventsub) {
            try { this.pendingOldEventsub.close() } catch {}
            this.pendingOldEventsub = null
          }
          this.warmReconnecting = false
        }
        this.reconnectEventSub(isWafBlock)
      }
    }
    ws.onerror = (ev) => {
      const msg = (ev as unknown as { message?: string }).message || ''
      if (/101|forbidden|403/i.test(msg)) this.eventsubLastWafBlockReason = msg
      log('eventsub error:', ev)
    }
    return ws
  }

  private async handleEventSub(msg: EventSubMessage) {
    const type = msg.metadata?.message_type

    if (type === 'session_welcome') {
      this.sessionId = msg.payload.session?.id ?? ''
      this.keepaliveMs = (msg.payload.session?.keepalive_timeout_seconds ?? 10) * 1000
      log(`eventsub connected, session: ${this.sessionId}`)
      this.eventsubBackoff = BACKOFF_BASE
      this.eventsubConsecutiveFailures = 0
      this.eventsubEverConnected = true
      this.eventsubLastWafBlockReason = ''
      this.eventsubWafPersistentLogged = false
      saveEventsubState({ consecutiveFailures: 0, lastFailureAt: 0, firstFailureAt: 0, lastWafBlockAt: 0 })
      // subscribe new session FIRST so messages can flow before we tear anything down.
      // cleanup of stale (old-session) subs runs in background — no race since each
      // session's subs are independent slots on twitch's side.
      await this.subscribeAll()
      this.resetKeepalive()
      this.startEventSubPing()
      // warm reconnect: now that new session is fully subscribed, close the old ws.
      if (this.pendingOldEventsub) {
        try { this.pendingOldEventsub.close() } catch {}
        this.pendingOldEventsub = null
        log('warm reconnect complete — old ws closed')
      }
      this.warmReconnecting = false
      this.cleanupStaleSubscriptions().catch((e) => log(`background cleanup failed: ${e}`))
    } else if (type === 'session_keepalive') {
      this.resetKeepalive()
    } else if (type === 'notification') {
      this.resetKeepalive()
      const subType = msg.metadata.subscription_type
      if (subType === 'channel.chat.message') {
        const e = msg.payload.event
        if (!e?.message?.text) return
        let text = e.message.text
        // strip Twitch's auto-prefix @mention on thread replies
        if (e.reply?.parent_user_login) {
          text = text.replace(new RegExp(`^@${e.reply.parent_user_login}\\s+`, 'i'), '')
        }
        const badges = (e.badges ?? []).map((b: { set_id: string }) => b.set_id)
        const sentTs = Date.parse(msg.metadata.message_timestamp ?? '') || 0
        this.dispatchMessage(e.broadcaster_user_login, e.chatter_user_id, e.chatter_user_login, text, badges, e.message_id ?? '', e.reply?.thread_message_id, sentTs)
      }
    } else if (type === 'session_reconnect') {
      const newUrl = msg.payload.session?.reconnect_url
      if (!newUrl) { log('session_reconnect missing url, ignoring'); return }
      log('eventsub reconnecting to', newUrl)
      const oldWs = this.eventsub
      if (oldWs) { oldWs.onmessage = null; oldWs.onclose = null; oldWs.onerror = null }
      this.eventsub = this.wireEventSub(new WebSocket(newUrl))
      this.eventsub.onopen = () => oldWs?.close()
    }
  }

  private startEventSubPing() {
    if (this.eventsubPingInterval) clearInterval(this.eventsubPingInterval)
    this.eventsubPingInterval = setInterval(() => {
      try { (this.eventsub as unknown as { ping?: () => void })?.ping?.() } catch {}
    }, 20_000)
  }

  // IRC-level PING — Twitch replies with PONG as a real onmessage event, which bumps
  // ircLastData. Frame-level ws.ping() does NOT fire onmessage in Bun, so it can't
  // serve as application-layer liveness. Every 2min keeps us well under the 6min watchdog.
  private startIrcPing() {
    if (this.ircPingInterval) clearInterval(this.ircPingInterval)
    this.ircPingInterval = setInterval(() => {
      this.ircSend('PING :keepalive')
    }, 120_000)
  }

  private async cleanupStaleSubscriptions() {
    try {
      let deleted = 0
      let cursor: string | undefined
      // paginate through all subscriptions
      do {
        const url = cursor
          ? `${HELIX_URL}/eventsub/subscriptions?after=${cursor}`
          : `${HELIX_URL}/eventsub/subscriptions`
        const res = await fetchWithTimeout(url, {
          headers: {
            Authorization: `Bearer ${this.config.token}`,
            'Client-Id': this.config.clientId,
          },
        })
        if (!res.ok) break
        const data = await res.json() as {
          data: { id: string; status: string; transport: { session_id?: string } }[]
          pagination?: { cursor?: string }
        }
        const stale = data.data.filter((s) =>
          s.transport.session_id && s.transport.session_id !== this.sessionId
        )
        for (const sub of stale) {
          try {
            await fetchWithTimeout(`${HELIX_URL}/eventsub/subscriptions?id=${sub.id}`, {
              method: 'DELETE',
              headers: {
                Authorization: `Bearer ${this.config.token}`,
                'Client-Id': this.config.clientId,
              },
            })
            deleted++
          } catch {}
        }
        cursor = data.pagination?.cursor
      } while (cursor)
      if (deleted > 0) {
        log(`eventsub: cleaned up ${deleted} stale subscriptions`)
      }
    } catch (e) {
      log(`eventsub: cleanup failed: ${e}`)
    }
  }

  private resetKeepalive() {
    this.lastActivity = Date.now()
    if (this.keepaliveTimeout) clearTimeout(this.keepaliveTimeout)
    this.keepaliveTimeout = setTimeout(() => {
      log('keepalive timeout — warm reconnecting')
      this.warmReconnectEventSub()
    }, this.keepaliveMs + 5000)
  }

  private warmReconnectEventSub() {
    if (this.warmReconnecting || this.closing) return
    this.warmReconnecting = true
    if (this.eventsubPingInterval) { clearInterval(this.eventsubPingInterval); this.eventsubPingInterval = null }
    if (this.keepaliveTimeout) { clearTimeout(this.keepaliveTimeout); this.keepaliveTimeout = null }
    const oldWs = this.eventsub
    if (oldWs) {
      // detach close/error so its eventual close doesn't trigger fresh reconnect.
      // KEEP onmessage so it continues delivering until the new session is ready.
      oldWs.onclose = null
      oldWs.onerror = null
    }
    this.pendingOldEventsub = oldWs ?? null
    this.eventsub = this.wireEventSub(new WebSocket(EVENTSUB_URL))
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

  private reconnectEventSub(isWafBlock = false) {
    if (this.keepaliveTimeout) clearTimeout(this.keepaliveTimeout)
    if (this.eventsubPingInterval) { clearInterval(this.eventsubPingInterval); this.eventsubPingInterval = null }
    this.eventsubConsecutiveFailures++

    // persist failure across processes so systemd restarts can't reset the counter
    const prior = loadEventsubState()
    const now = Date.now()
    const nextState: EventSubState = {
      consecutiveFailures: prior.consecutiveFailures + 1,
      firstFailureAt: prior.firstFailureAt || now,
      lastFailureAt: now,
      lastWafBlockAt: isWafBlock ? now : prior.lastWafBlockAt,
    }
    saveEventsubState(nextState)

    // WAF block = HTTP upgrade rejected at the edge. exponential won't help. once it's
    // clearly permanent (egress IP on a datacenter/VPN range CloudFront blocks), stop the
    // 30min churn and drop to a quiet 6h self-healing retry — auto-recovers if the IP ever
    // becomes residential, without spamming logs or burning reconnects in the meantime.
    if (isWafBlock) {
      const persistent = nextState.consecutiveFailures >= WAF_PERSISTENT_THRESHOLD
      this.eventsubBackoff = persistent ? BACKOFF_WAF_PERSISTENT : BACKOFF_WAF_BLOCKED
      if (persistent) {
        if (!this.eventsubWafPersistentLogged) {
          log(`eventsub edge WAF-blocked ${nextState.consecutiveFailures}x — egress IP is a datacenter/VPN range CloudFront rejects. IRC is primary transport; quiet retry every ${BACKOFF_WAF_PERSISTENT / 3_600_000}h (auto-recovers on a residential IP)`)
          this.eventsubWafPersistentLogged = true
        }
      } else {
        log(`eventsub WAF/403 blocked — sleeping ${BACKOFF_WAF_BLOCKED / 60_000}min before retry (in-process)`)
      }
    } else if (this.eventsubConsecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      // non-WAF failures: don't exit — exit + systemd restart resets in-memory state and
      // defeats backoff. sleep within process so we keep ratcheting backoff up not spamming.
      const sleep = Math.min(BACKOFF_MAX * 5, 5 * 60_000)
      log(`eventsub failed ${this.eventsubConsecutiveFailures}x — long sleep ${Math.round(sleep / 60_000)}min instead of process.exit`)
      this.eventsubBackoff = sleep
    }
    this.reconnectWithBackoff('eventsub', () => this.eventsubBackoff, (n) => { this.eventsubBackoff = n }, () => this.connectEventSub())
  }

  private async subscribeAll() {
    const results = await Promise.allSettled(
      this.config.channels.map((ch) =>
        this.subscribe(ch.userId).catch((e) => {
          log(`subscribe error for ${ch.name}: ${e}`)
          throw e
        }),
      ),
    )
    const ok = results.filter((r) => r.status === 'fulfilled').length
    if (ok === 0 && this.config.channels.length > 0) {
      log('all eventsub subscriptions failed — exiting for systemd restart')
      process.exit(1)
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
    this.ircJoinedChannels.clear()
    // close old socket if still lingering — clear all handlers to prevent stray events
    if (this.irc) {
      try { this.irc.onmessage = null; this.irc.onclose = null; this.irc.onerror = null; this.irc.close() } catch {}
    }
    if (this.ircConnectTimeout) clearTimeout(this.ircConnectTimeout)
    this.irc = new WebSocket(IRC_URL)
    const ws = this.irc

    // Handshake watchdog: if WebSocket never reaches OPEN within 20s (DNS hang, TCP black hole,
    // proxy gate), force-close so onclose fires reconnect. Bun's WebSocket doesn't reliably
    // surface stuck-in-CONNECTING failures via onerror.
    this.ircConnectTimeout = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        log('irc handshake stuck >20s — force closing')
        try { ws.close() } catch {}
      }
    }, 20_000)

    this.irc.onopen = () => {
      if (this.ircConnectTimeout) { clearTimeout(this.ircConnectTimeout); this.ircConnectTimeout = null }
      this.ircSend('CAP REQ :twitch.tv/tags twitch.tv/commands')
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
            this.startIrcWatchdog()
            this.scheduleJoinAckCheck()
            break
          case 'join':
            log(`irc joined #${msg.channel}`)
            this.ircJoinedChannels.add(msg.channel)
            if (!this.ircReady) { this.ircReady = true; this.startIrcPing(); this.kickPacer() }
            break
          case 'auth_failure':
            log('irc auth failed — refreshing token and reconnecting')
            this.handleIrcAuthFailure()
            break
          case 'notice':
            log('irc notice:', msg.raw ?? line)
            break
          case 'userstate': {
            const was = this.privilegedChannels.has(msg.channel)
            if (msg.privileged) this.privilegedChannels.add(msg.channel)
            else this.privilegedChannels.delete(msg.channel)
            if (was !== msg.privileged) {
              log(`irc #${msg.channel}: ${msg.privileged ? 'privileged (vip/mod) — 100/30s send bucket' : 'non-privileged — 20/30s send bucket'}`)
            }
            break
          }
          case 'privmsg':
            this.dispatchPrivmsg(msg)
            break
        }
      }
      this.ircLastData = Date.now()
    }

    this.irc.onclose = (ev) => {
      log(`irc closed: ${ev.code} ${ev.reason}`)
      this.ircReady = false
      if (this.ircWatchdog) clearInterval(this.ircWatchdog)
      this.ircWatchdog = null
      if (this.ircPingInterval) { clearInterval(this.ircPingInterval); this.ircPingInterval = null }
      this.reconnectIrc()
    }

    this.irc.onerror = (ev) => log('irc error:', ev)
  }

  // IRC PRIVMSG receive path — fallback for when EventSub is WAF-blocked. The bot
  // would otherwise be deaf during cooldown. Dedup by message id so dual-delivery
  // (EventSub + IRC both alive) only fires once per message.
  private dispatchPrivmsg(m: IrcPrivmsg) {
    let text = m.text
    if (m.replyParentUserLogin) {
      text = text.replace(new RegExp(`^@${m.replyParentUserLogin}\\s+`, 'i'), '')
    }
    this.dispatchMessage(m.channel, m.userId, m.login, text, m.badges, m.messageId, m.threadId, m.sentTs)
  }

  private dispatchMessage(channel: string, userId: string, username: string, text: string, badges: string[], messageId: string, threadId?: string, sentTs?: number) {
    if (messageId) {
      if (this.seenMessageIdSet.has(messageId)) return
      this.seenMessageIdSet.add(messageId)
      this.seenMessageIds.push(messageId)
      if (this.seenMessageIds.length > this.SEEN_MSG_CAP) {
        const evicted = this.seenMessageIds.shift()
        if (evicted) this.seenMessageIdSet.delete(evicted)
      }
    }
    this.onMessage(channel, userId, username, text, badges, messageId, threadId, sentTs)
  }

  // After welcome, JOIN ack should arrive within seconds. If a channel hasn't acked
  // by 15s, re-issue the JOIN once. Catches silent JOIN drops (rare but observed).
  private scheduleJoinAckCheck() {
    if (this.ircJoinAckTimeout) clearTimeout(this.ircJoinAckTimeout)
    this.ircJoinAckTimeout = setTimeout(() => {
      const missing = this.config.channels.filter((c) => !this.ircJoinedChannels.has(c.name))
      if (missing.length > 0) {
        log(`irc re-issuing JOIN for ${missing.length} un-acked channel(s): ${missing.map((c) => c.name).join(', ')}`)
        for (const ch of missing) this.ircSend(`JOIN #${ch.name}`)
      }
    }, 15_000)
  }

  // Twitch sends PING every ~5min — that's the real liveness signal. Frame-level pongs
  // from our client ping don't fire onmessage, so ircLastData only bumps on chat or PING.
  // Watchdog window must exceed Twitch's PING cycle, else quiet channels false-positive.
  private startIrcWatchdog() {
    if (this.ircWatchdog) clearInterval(this.ircWatchdog)
    this.ircLastData = Date.now()
    this.ircWatchdog = setInterval(() => {
      if (Date.now() - this.ircLastData > 360_000) {
        log('irc timeout (6min no data) — reconnecting')
        this.irc?.close()
      }
    }, 60_000)
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

  // dispatch one message now (helix with IRC fallback), debiting the rate buckets.
  // returns false ONLY when an irc-only send hit a closed socket (so the caller can requeue
  // instead of dropping the line — the trivia-round "went dead" bug). debits the bucket only
  // on a real send so a dropped+requeued message isn't double-counted.
  private async sendOne(channel: string, text: string, replyTo?: string): Promise<boolean> {
    const prefix = replyTo ? `@reply-parent-msg-id=${replyTo} ` : ''
    if (this.ircOnlyChannels.has(channel)) {
      const ok = this.ircSend(`${prefix}PRIVMSG #${channel} :${text}`)
      if (ok) { this.recordSend(channel); this.lastSendAt = Date.now() }
      return ok
    }
    const sent = await this.helixSend(channel, text, false, replyTo)
    if (sent) {
      this.recordSend(channel)
      this.lastSendAt = Date.now()
      return true
    }
    // helix failed — fall back to IRC, but PROPAGATE the result. if the IRC socket is also
    // closed (a reconnect coinciding with a helix failure), report false so the pacer
    // requeues instead of dropping the line, and don't debit the bucket for a send that
    // never went out.
    log(`helix failed for #${channel}, falling back to IRC PRIVMSG${replyTo ? ' (threaded)' : ''}`)
    const fbOk = this.ircSend(`${prefix}PRIVMSG #${channel} :${text}`)
    if (fbOk) { this.recordSend(channel); this.lastSendAt = Date.now() }
    return fbOk
  }

  // drain the queue one message at a time, paced by SEND_GAP and the rate buckets.
  // re-arms itself while messages remain; only one timer is ever in flight.
  private kickPacer() {
    if (this.pacerTimer || this.draining || !this.ircReady || this.ircQueue.length === 0) return
    const head = this.ircQueue[0]
    // wait for whichever binds: the rate bucket (poll in 1s) or the inter-message gap.
    const wait = this.canSend(head.channel) ? Math.max(0, this.SEND_GAP - (Date.now() - this.lastSendAt)) : 1000
    this.pacerTimer = setTimeout(async () => {
      this.pacerTimer = null
      const next = this.ircQueue[0]
      if (!next) return
      // transport down (reconnect blip)? NEVER shift+drop the head — leave it queued. if the
      // socket is briefly closed but we're still marked ready, re-poll in 1s; if hard-unready,
      // the reconnect path re-kicks the pacer on rejoin and the drain resumes.
      if (!this.ircReady || (this.ircOnlyChannels.has(next.channel) && this.irc?.readyState !== WebSocket.OPEN)) {
        if (this.ircReady) this.pacerTimer = setTimeout(() => { this.pacerTimer = null; this.kickPacer() }, 1000)
        return
      }
      if (!this.canSend(next.channel)) { this.kickPacer(); return }
      this.ircQueue.shift()
      // hold the single-drain invariant across the async send: kickPacer() is guarded on
      // `draining`, so a concurrent say() queues its line but can't open a parallel drain.
      this.draining = true
      let ok: boolean
      try {
        ok = await this.sendOne(next.channel, next.text, next.replyTo)
      } finally {
        this.draining = false
      }
      if (!ok) {
        // both helix and IRC failed (e.g. token refresh window + socket mid-reconnect).
        // bump lastSendAt so SEND_GAP applies on the retry path, then re-arm with a fixed
        // 1s delay instead of looping back immediately — prevents ~930 POSTs/sec when
        // both transports are persistently down.
        const fails = (next.failCount ?? 0) + 1
        const MAX_SEND_FAILS = 8 // ~8s total at 1s cadence, then give up so a poison line drops
        if (fails >= MAX_SEND_FAILS) {
          log(`dropping undeliverable line after ${fails} failures (#${next.channel}): ${next.text.slice(0, 60)}`)
        } else {
          this.ircQueue.unshift({ ...next, failCount: fails })
          this.lastSendAt = Date.now()
          this.pacerTimer = setTimeout(() => { this.pacerTimer = null; this.kickPacer() }, 1000)
        }
        return
      }
      this.kickPacer()
    }, wait)
  }

  // privileged = we're vip/mod/broadcaster in this channel (our own channel = broadcaster).
  private isPrivileged(channel: string): boolean {
    return channel === this.config.botUsername.toLowerCase() || this.privilegedChannels.has(channel)
  }

  private trimBuckets() {
    const cutoff = Date.now() - this.SEND_WINDOW
    while (this.modSendTimes.length > 0 && this.modSendTimes[0] < cutoff) this.modSendTimes.shift()
    while (this.userSendTimes.length > 0 && this.userSendTimes[0] < cutoff) this.userSendTimes.shift()
  }

  private canSend(channel: string): boolean {
    this.trimBuckets()
    if (this.modSendTimes.length >= this.MOD_LIMIT) return false
    // non-privileged channels are additionally bound by the smaller user bucket
    if (!this.isPrivileged(channel) && this.userSendTimes.length >= this.USER_LIMIT) return false
    return true
  }

  // record a send against the buckets it consumes from.
  private recordSend(channel: string) {
    const now = Date.now()
    this.modSendTimes.push(now)
    if (!this.isPrivileged(channel)) this.userSendTimes.push(now)
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

  private async helixSend(channel: string, text: string, retried = false, replyTo?: string): Promise<boolean> {
    const broadcasterId = this._channelIdMap[channel]
    if (!broadcasterId) return false
    try {
      const body: Record<string, string> = {
        broadcaster_id: broadcasterId,
        sender_id: this.config.botUserId,
        message: text,
      }
      if (replyTo) body.reply_parent_message_id = replyTo
      const res = await fetchWithTimeout(`${HELIX_URL}/chat/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          'Client-Id': this.config.clientId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      if (res.status === 401 && !retried && this.onAuthFailure) {
        log('helix send 401 — refreshing token and retrying')
        const newToken = await this.onAuthFailure()
        this.config.token = newToken
        return this.helixSend(channel, text, true, replyTo)
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

  async say(channel: string, text: string, replyTo?: string) {
    // strip leading command prefixes (/ . ! \) to prevent the bot timing itself out
    text = stripOutgoingCommands(text)
    // count by code points, not utf-16 units: twitch's ~500-char limit counts each
    // supplementary-plane glyph (fancy font, emoji) as one char. slicing the codepoint
    // array can never split a surrogate pair, so this is orphan-safe by construction.
    const cps = [...text]
    if (cps.length > 490) text = cps.slice(0, 487).join('') + '...'
    // every send goes through the single FIFO pacer — preserves order and guarantees
    // spacing, so no two replies can ever land in the same instant.
    if (this.ircQueue.length >= MAX_QUEUE) {
      // NEVER evict the head the pacer is holding through a reconnect — it can't be sent yet
      // but will once the socket recovers, and it's often a trivia reveal/win line; dropping
      // it silently kills the round (the wave-2 "round went dead" vanish, via this 2nd path).
      // when the head is held, shed the next-oldest instead so the held message survives.
      const head = this.ircQueue[0]
      const headHeld = head && (!this.ircReady ||
        (this.ircOnlyChannels.has(head.channel) && this.irc?.readyState !== WebSocket.OPEN))
      if (headHeld && this.ircQueue.length > 1) {
        log('queue full, dropping second-oldest (head held by pacer)')
        this.ircQueue.splice(1, 1)
      } else {
        log('queue full, dropping oldest')
        this.ircQueue.shift()
      }
    }
    this.ircQueue.push({ channel, text, replyTo })
    this.kickPacer()
  }
}

// --- Helix user data ---

export interface HelixUserData {
  id: string
  login: string
  display_name: string
  created_at: string
}

export async function getUserInfo(
  token: string,
  clientId: string,
  login: string,
): Promise<HelixUserData | null> {
  try {
    const res = await fetchWithTimeout(`${HELIX_URL}/users?login=${encodeURIComponent(login)}`, {
      headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId },
    })
    if (!res.ok) return null
    const data = await res.json() as { data: HelixUserData[] }
    return data.data[0] ?? null
  } catch {
    return null
  }
}

export async function getFollowage(
  token: string,
  clientId: string,
  userId: string,
  broadcasterId: string,
): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(
      `${HELIX_URL}/channels/followers?broadcaster_id=${broadcasterId}&user_id=${userId}`,
      { headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId } },
    )
    if (!res.ok) return null // 403 = missing scope, degrade gracefully
    const data = await res.json() as { data: { followed_at: string }[] }
    return data.data[0]?.followed_at ?? null
  } catch {
    return null
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
    return getUserId(newToken, clientId, login, onAuthFailure)
  }
  if (!res.ok) throw new Error(`getUserId failed: ${res.status}`)
  const data = (await res.json()) as HelixUsersResponse
  const id = data.data[0]?.id
  if (!id) throw new Error(`user not found: ${login}`)
  return id
}
