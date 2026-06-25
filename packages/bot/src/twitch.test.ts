import { test, expect, describe } from 'bun:test'
import { parseIrcLine, TwitchClient } from './twitch'

// USERSTATE drives per-channel send-rate privilege (vip/mod/broadcaster -> 100/30s
// mod bucket; everyone else -> 20/30s user bucket). getting this parse wrong either
// throttles a vip channel or risks a 30min spam lockout on a regular channel.
describe('parseIrcLine USERSTATE privilege detection', () => {
  test('vip badge -> privileged', () => {
    const m = parseIrcLine('@badge-info=;badges=vip/1;mod=0;display-name=Bot :tmi.twitch.tv USERSTATE #nl_kripp')
    expect(m).toEqual({ type: 'userstate', channel: 'nl_kripp', privileged: true })
  })

  test('moderator badge -> privileged', () => {
    const m = parseIrcLine('@badges=moderator/1;mod=1 :tmi.twitch.tv USERSTATE #somechan')
    expect(m).toMatchObject({ type: 'userstate', channel: 'somechan', privileged: true })
  })

  test('mod=1 tag without badge -> privileged', () => {
    const m = parseIrcLine('@badges=;mod=1 :tmi.twitch.tv USERSTATE #chan')
    expect(m).toMatchObject({ type: 'userstate', privileged: true })
  })

  test('broadcaster badge -> privileged', () => {
    const m = parseIrcLine('@badges=broadcaster/1;mod=0 :tmi.twitch.tv USERSTATE #bot')
    expect(m).toMatchObject({ type: 'userstate', channel: 'bot', privileged: true })
  })

  test('no privileged badges -> NOT privileged', () => {
    const m = parseIrcLine('@badges=;mod=0 :tmi.twitch.tv USERSTATE #randomchan')
    expect(m).toEqual({ type: 'userstate', channel: 'randomchan', privileged: false })
  })

  test('subscriber-only badge is not a send-rate privilege', () => {
    const m = parseIrcLine('@badges=subscriber/12;mod=0 :tmi.twitch.tv USERSTATE #chan')
    expect(m).toMatchObject({ type: 'userstate', privileged: false })
  })

  test('still parses a normal PRIVMSG', () => {
    const m = parseIrcLine('@badges=vip/1;id=abc;user-id=42 :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #nl_kripp :hello world')
    expect(m).toMatchObject({ type: 'privmsg', channel: 'nl_kripp', login: 'viewer', text: 'hello world' })
  })
})

// regression for the slow-then-spammy burst: several replies finishing at once must
// trickle out one-per-gap, never fire in the same tick (which reads as spam + risks lockout).
describe('outgoing send pacer', () => {
  test('spaces simultaneous replies instead of bursting', async () => {
    const client = new TwitchClient(
      { token: 't', clientId: 'c', botUserId: '1', botUsername: 'bot', channels: [] },
      () => {},
    )
    const c = client as unknown as {
      ircReady: boolean; SEND_GAP: number; ircOnlyChannels: Set<string>; ircSend: (l: string) => boolean
      irc: { readyState: number }
    }
    c.ircReady = true
    c.irc = { readyState: 1 }              // WebSocket.OPEN — pacer's transport-ready check passes
    c.SEND_GAP = 30                        // shrink for a fast test
    c.ircOnlyChannels = new Set(['chan'])  // force the IRC path — no network
    const sent: number[] = []
    const t0 = performance.now()
    c.ircSend = () => { sent.push(performance.now() - t0); return true } // true = sent (else pacer requeues)

    // four replies land in the same instant
    client.say('chan', 'a'); client.say('chan', 'b')
    client.say('chan', 'c'); client.say('chan', 'd')

    // pacer defers even the first send — nothing fires synchronously
    expect(sent.length).toBe(0)

    await new Promise((r) => setTimeout(r, 30 * 7))
    expect(sent.length).toBe(4)
    // consecutive sends are spaced ~SEND_GAP apart (allow scheduler jitter)
    for (let i = 1; i < sent.length; i++) {
      expect(sent[i] - sent[i - 1]).toBeGreaterThanOrEqual(20)
    }
  })

  test('queue overflow never evicts the pacer-held head (trivia reveal survives a reconnect)', () => {
    const client = new TwitchClient(
      { token: 't', clientId: 'c', botUserId: '1', botUsername: 'bot', channels: [] },
      () => {},
    )
    const c = client as unknown as {
      ircReady: boolean; ircOnlyChannels: Set<string>; ircQueue: { channel: string; text: string }[]
    }
    c.ircOnlyChannels = new Set(['nl_kripp'])
    c.ircReady = false // transport down mid-reconnect: the pacer holds the head, can't send it

    // the trivia reveal is queued first (it becomes the held head)
    client.say('nl_kripp', "Time's up! The answer was: FTL")
    // then chat floods the queue well past MAX_QUEUE (50) during the reconnect window
    for (let i = 0; i < 70; i++) client.say('nl_kripp', `reply ${i}`)

    expect(c.ircQueue.length).toBeLessThanOrEqual(50)       // bounded
    expect(c.ircQueue[0].text).toContain("Time's up")       // ...but the held reveal survived
  })
})

// regression #3: pacer failure backoff
// when both helix and IRC are down, the pacer must NOT busy-loop (~930/sec).
// it must back off 1s on each failure and drop a poison line after MAX_SEND_FAILS retries.
describe('pacer failure backoff (#3)', () => {
  test('failed send arms a 1s timer, not an immediate re-kick', async () => {
    const client = new TwitchClient(
      { token: 't', clientId: 'c', botUserId: '1', botUsername: 'bot', channels: [{ name: 'chan', userId: '99' }] },
      () => {},
    )
    const c = client as unknown as {
      ircReady: boolean; ircOnlyChannels: Set<string>; irc: { readyState: number }
      sendOne: (ch: string, text: string, replyTo?: string) => Promise<boolean>
      pacerTimer: unknown; lastSendAt: number; kickPacer: () => void
      ircQueue: { channel: string; text: string; failCount?: number }[]
    }
    c.ircReady = true
    c.irc = { readyState: 1 }
    c.ircOnlyChannels = new Set()
    // stub sendOne to always fail (simulates helix 5xx + dead IRC)
    let callCount = 0
    c.sendOne = async () => { callCount++; return false }

    client.say('chan', 'hello')
    await new Promise((r) => setTimeout(r, 50)) // let first attempt fire

    // exactly one attempt in 50ms — the backoff timer fires at 1s, not immediately
    expect(callCount).toBe(1)
    // line is requeued with incremented failCount
    expect(c.ircQueue.length).toBe(1)
    expect(c.ircQueue[0].failCount).toBe(1)
    // lastSendAt was bumped (forces SEND_GAP on next attempt)
    expect(Date.now() - c.lastSendAt).toBeLessThan(200)
    // pacerTimer is set (the 1s re-arm, not null)
    expect(c.pacerTimer).not.toBeNull()
  })

  test('poison line drops after MAX_SEND_FAILS (8) retries', async () => {
    const client = new TwitchClient(
      { token: 't', clientId: 'c', botUserId: '1', botUsername: 'bot', channels: [{ name: 'chan', userId: '99' }] },
      () => {},
    )
    const c = client as unknown as {
      ircReady: boolean; ircOnlyChannels: Set<string>; irc: { readyState: number }
      sendOne: (ch: string, text: string, replyTo?: string) => Promise<boolean>
      pacerTimer: unknown; kickPacer: () => void
      ircQueue: { channel: string; text: string; failCount?: number }[]
    }
    c.ircReady = true
    c.irc = { readyState: 1 }
    c.ircOnlyChannels = new Set()
    c.sendOne = async () => false

    // inject a pre-failed item at the drop threshold (failCount = 7, one more push drops it)
    c.ircQueue.unshift({ channel: 'chan', text: 'poison', failCount: 7 })
    // manually trigger the pacer cycle (bypass kickPacer guard by calling after unshift)
    c.kickPacer()
    await new Promise((r) => setTimeout(r, 50))

    // the item was dropped (failCount 7 + 1 = 8 >= MAX_SEND_FAILS)
    expect(c.ircQueue.length).toBe(0)
  })
})

// regression #28: mixed-case channel names in config must not break helix routing
describe('channel name normalisation (#28)', () => {
  test('rebuildChannelMap lowercases keys so helix lookup matches IRC wire', () => {
    const client = new TwitchClient(
      {
        token: 't', clientId: 'c', botUserId: '1', botUsername: 'bot',
        channels: [{ name: 'Kripp', userId: '999' }],
      },
      () => {},
    )
    const c = client as unknown as { _channelIdMap: Record<string, string>; hasChannel: (n: string) => boolean }
    // map key must be lowercase so helix lookup for 'kripp' (IRC wire form) succeeds
    expect(c._channelIdMap['kripp']).toBe('999')
    expect(c._channelIdMap['Kripp']).toBeUndefined()
  })

  test('isPrivileged matches botUsername case-insensitively via lowercase compare', () => {
    const client = new TwitchClient(
      { token: 't', clientId: 'c', botUserId: '1', botUsername: 'MyBot', channels: [] },
      () => {},
    )
    const c = client as unknown as { isPrivileged: (ch: string) => boolean }
    // own channel is always privileged regardless of how the name is cased
    expect(c.isPrivileged('mybot')).toBe(true)
  })
})
