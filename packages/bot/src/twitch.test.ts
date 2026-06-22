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
