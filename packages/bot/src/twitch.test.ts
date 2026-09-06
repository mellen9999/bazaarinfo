import { test, expect, describe } from 'bun:test'
import { parseIrcLine, TwitchClient } from './twitch'

// USERSTATE drives per-channel send-rate privilege (vip/mod/broadcaster -> 100/30s
// mod bucket; everyone else -> 20/30s user bucket). getting this parse wrong either
// throttles a vip channel or risks a 30min spam lockout on a regular channel.
describe('parseIrcLine USERSTATE privilege detection', () => {
  test('vip badge -> privileged', () => {
    const m = parseIrcLine('@badge-info=;badges=vip/1;mod=0;display-name=Bot :tmi.twitch.tv USERSTATE #nl_kripp')
    expect(m).toEqual({ type: 'userstate', channel: 'nl_kripp', privileged: true, mod: false })
  })

  test('moderator badge -> privileged AND mod (vip alone is not mod: no moderator-scoped reads)', () => {
    const m = parseIrcLine('@badges=moderator/1;mod=1 :tmi.twitch.tv USERSTATE #somechan')
    expect(m).toMatchObject({ type: 'userstate', channel: 'somechan', privileged: true, mod: true })
    expect(parseIrcLine('@badges=broadcaster/1;mod=0 :tmi.twitch.tv USERSTATE #bot')).toMatchObject({ mod: true })
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
    expect(m).toEqual({ type: 'userstate', channel: 'randomchan', privileged: false, mod: false })
  })

  test('subscriber-only badge is not a send-rate privilege', () => {
    const m = parseIrcLine('@badges=subscriber/12;mod=0 :tmi.twitch.tv USERSTATE #chan')
    expect(m).toMatchObject({ type: 'userstate', privileged: false })
  })

  test('still parses a normal PRIVMSG', () => {
    const m = parseIrcLine('@badges=vip/1;id=abc;user-id=42 :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #nl_kripp :hello world')
    expect(m).toMatchObject({ type: 'privmsg', channel: 'nl_kripp', login: 'viewer', text: 'hello world' })
  })

  // sentTs powers the stale-reply drop (freshness gate) — must parse tmi-sent-ts, and fail
  // open to 0 when absent so a missing tag can never make every reply look infinitely old.
  test('extracts tmi-sent-ts as sentTs', () => {
    const m = parseIrcLine('@id=abc;user-id=42;tmi-sent-ts=1700000000123 :v!v@v.tmi.twitch.tv PRIVMSG #chan :hi')
    expect(m).toMatchObject({ type: 'privmsg', sentTs: 1700000000123 })
  })
  test('sentTs is 0 when tmi-sent-ts is absent', () => {
    const m = parseIrcLine('@id=abc;user-id=42 :v!v@v.tmi.twitch.tv PRIVMSG #chan :hi')
    expect(m).toMatchObject({ type: 'privmsg', sentTs: 0 })
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

// twitch tells us when it threw a line away. the viewer who asked got silence, so the
// notice has to survive parsing intact or the drop is unfalsifiable after the fact.
describe('drop notices', () => {
  test('a tagged automod notice keeps its msg-id and channel', () => {
    const line = '@msg-id=msg_automod_held :tmi.twitch.tv NOTICE #nl_kripp :Your message has been held for review by Automod.'
    const msg = parseIrcLine(line)
    expect(msg.type).toBe('notice')
    expect(msg.raw).toContain('[msg_automod_held]')
    expect(msg.raw).toContain('#nl_kripp')
  })

  test('the drop-class matcher recognises the ones that eat a reply', () => {
    const DROP = /^\[(msg_automod_held|msg_rejected\w*|msg_duplicate|msg_ratelimit|msg_banned|msg_channel_suspended)\] #(\S+):/
    for (const id of ['msg_automod_held', 'msg_duplicate', 'msg_ratelimit', 'msg_rejected_mandatory']) {
      expect(DROP.test(`[${id}] #chan: reason`)).toBe(true)
    }
    // a routine informational notice is not a drop and must not be reported as one
    expect(DROP.test('[msg_followersonly] #chan: this room is in followers-only mode')).toBe(false)
  })
})

// P1: "is this a reply to the bot?" = parent login === botname. twitch delivers the direct
// parent's login + body on every reply tag, so no message-id capture / pacer surgery needed.
describe('reply-parent parsing (P1 addressed-without-!b)', () => {
  test('parseIrcLine extracts reply-parent-user-login and unescapes reply-parent-msg-body', () => {
    const line = '@reply-parent-user-login=BotName;reply-parent-msg-body=hi\\sthere;id=1;user-id=2 :viewer!v@v.tmi.twitch.tv PRIVMSG #chan :@BotName hi there'
    const m = parseIrcLine(line)
    expect(m).toMatchObject({ type: 'privmsg', replyParentUserLogin: 'BotName', replyParentBody: 'hi there' })
  })

  test('a privmsg with no reply tags carries no replyParent fields', () => {
    const m = parseIrcLine('@id=1;user-id=2 :viewer!v@v.tmi.twitch.tv PRIVMSG #chan :just chatting')
    expect(m).toMatchObject({ type: 'privmsg' })
    if (m.type === 'privmsg') {
      expect(m.replyParentUserLogin).toBeUndefined()
      expect(m.replyParentBody).toBeUndefined()
    }
  })

  test('dispatchPrivmsg forwards {login, body} as replyParent (login lowercased) and strips the auto @-prefix', () => {
    const received: unknown[][] = []
    const client = new TwitchClient(
      { token: 't', clientId: 'c', botUserId: '1', botUsername: 'bot', channels: [] },
      (...args: unknown[]) => { received.push(args) },
    )
    const c = client as unknown as { dispatchPrivmsg: (m: unknown) => void }
    c.dispatchPrivmsg({
      type: 'privmsg', channel: 'chan', login: 'viewer', text: '@Bot hi there', userId: '2', messageId: 'm1',
      badges: [], sentTs: 0, replyParentUserLogin: 'Bot', replyParentBody: 'question text',
    })
    expect(received.length).toBe(1)
    const [, , , text, , , , , replyParent] = received[0] as unknown[]
    expect(text).toBe('hi there')
    expect(replyParent).toEqual({ login: 'bot', body: 'question text' })
  })

  test('dispatchPrivmsg carries no replyParent when the message is not a reply', () => {
    const received: unknown[][] = []
    const client = new TwitchClient(
      { token: 't', clientId: 'c', botUserId: '1', botUsername: 'bot', channels: [] },
      (...args: unknown[]) => { received.push(args) },
    )
    const c = client as unknown as { dispatchPrivmsg: (m: unknown) => void }
    c.dispatchPrivmsg({
      type: 'privmsg', channel: 'chan', login: 'viewer', text: 'just chatting', userId: '2', messageId: 'm2',
      badges: [], sentTs: 0,
    })
    const replyParent = (received[0] as unknown[])[8]
    expect(replyParent).toBeUndefined()
  })

  test('EventSub notification lowercases the reply parent login and carries the body', async () => {
    const received: unknown[][] = []
    const client = new TwitchClient(
      { token: 't', clientId: 'c', botUserId: '1', botUsername: 'bot', channels: [] },
      (...args: unknown[]) => { received.push(args) },
    )
    const c = client as unknown as { handleEventSub: (msg: unknown) => Promise<void> }
    await c.handleEventSub({
      metadata: { message_type: 'notification', subscription_type: 'channel.chat.message', message_timestamp: new Date().toISOString() },
      payload: {
        event: {
          broadcaster_user_login: 'chan', chatter_user_id: '9', chatter_user_login: 'viewer',
          message_id: 'evt1', message: { text: '@Bot hi there' },
          reply: { parent_user_login: 'Bot', parent_message_body: 'q' },
        },
      },
    })
    expect(received.length).toBe(1)
    const replyParent = (received[0] as unknown[])[8]
    expect(replyParent).toEqual({ login: 'bot', body: 'q' })
  })
})

// USERNOTICE (sub/resub/raid/gift/announce) — context only, rendered by stream-events.ts.
// this file only proves the parse + dispatch plumbing: tag shapes, escaping, dedupe, and
// the first-msg/returning-chatter privmsg flags threaded to the 10th dispatch arg.
describe('parseIrcLine USERNOTICE', () => {
  test('raid — camelCase msg-param tags', () => {
    const line = '@badges=;display-name=Kripp;id=abc123;login=kripp;msg-id=raid;msg-param-displayName=Kripp;msg-param-login=kripp;msg-param-viewerCount=1204;room-id=1;system-msg=1\\sraiders\\sfrom\\sKripp\\shave\\sjoined!;tmi-sent-ts=1700000000000;user-id=2 :tmi.twitch.tv USERNOTICE #nl_kripp'
    const m = parseIrcLine(line)
    expect(m).toMatchObject({
      type: 'usernotice', channel: 'nl_kripp', msgId: 'raid', login: 'kripp', displayName: 'Kripp',
      params: { 'msg-param-displayName': 'Kripp', 'msg-param-login': 'kripp', 'msg-param-viewerCount': '1204' },
    })
  })

  test('resub with a user-typed message', () => {
    const line = '@badges=subscriber/12;display-name=Alice;id=r1;login=alice;msg-id=resub;msg-param-cumulative-months=14;msg-param-sub-plan=1000;room-id=1;system-msg=Alice\\ssubscribed;tmi-sent-ts=123;user-id=5 :tmi.twitch.tv USERNOTICE #chan :loving the stream'
    const m = parseIrcLine(line)
    expect(m).toMatchObject({ type: 'usernotice', msgId: 'resub', login: 'alice', text: 'loving the stream' })
  })

  test('resub with no message — text is undefined, not empty string', () => {
    const line = '@badges=subscriber/1;display-name=Bob;id=r2;login=bob;msg-id=resub;msg-param-cumulative-months=2;msg-param-sub-plan=1000;room-id=1;tmi-sent-ts=123;user-id=6 :tmi.twitch.tv USERNOTICE #chan'
    const m = parseIrcLine(line)
    expect(m).toMatchObject({ type: 'usernotice', msgId: 'resub' })
    if (m.type === 'usernotice') expect(m.text).toBeUndefined()
  })

  test('submysterygift — mass-gift-count + sender-count params', () => {
    const line = '@badges=subscriber/1;display-name=Ben;id=m1;login=ben;msg-id=submysterygift;msg-param-mass-gift-count=20;msg-param-sender-count=20;room-id=1;tmi-sent-ts=123;user-id=7 :tmi.twitch.tv USERNOTICE #chan'
    const m = parseIrcLine(line)
    expect(m).toMatchObject({ type: 'usernotice', msgId: 'submysterygift', params: { 'msg-param-mass-gift-count': '20' } })
  })

  test('subgift — recipient login/display-name params', () => {
    const line = '@badges=;display-name=Carl;id=g1;login=carl;msg-id=subgift;msg-param-recipient-display-name=Bob;msg-param-recipient-user-name=bob;room-id=1;tmi-sent-ts=123;user-id=8 :tmi.twitch.tv USERNOTICE #chan'
    const m = parseIrcLine(line)
    expect(m).toMatchObject({
      type: 'usernotice', msgId: 'subgift',
      params: { 'msg-param-recipient-user-name': 'bob', 'msg-param-recipient-display-name': 'Bob' },
    })
  })

  test('announcement — trailing text is the announce body', () => {
    const line = '@msg-id=announcement;login=moduser;display-name=ModUser;id=a1;room-id=1;tmi-sent-ts=123;user-id=9 :tmi.twitch.tv USERNOTICE #chan :big news everyone'
    const m = parseIrcLine(line)
    expect(m).toMatchObject({ type: 'usernotice', msgId: 'announcement', login: 'moduser', text: 'big news everyone' })
  })

  test('system-msg unescapes \\s to a real space', () => {
    const line = '@id=s1;login=x;msg-id=sub;room-id=1;system-msg=X\\ssubscribed\\swith\\sPrime;tmi-sent-ts=1;user-id=1 :tmi.twitch.tv USERNOTICE #chan'
    const m = parseIrcLine(line)
    expect(m).toMatchObject({ type: 'usernotice', systemMsg: 'X subscribed with Prime' })
  })

  test('an unrecognized msg-id still parses to type usernotice, msgId preserved', () => {
    const line = '@id=u1;login=x;msg-id=someNewTwitchThing;room-id=1;tmi-sent-ts=1;user-id=1 :tmi.twitch.tv USERNOTICE #chan'
    const m = parseIrcLine(line)
    expect(m).toMatchObject({ type: 'usernotice', msgId: 'someNewTwitchThing' })
  })
})

describe('parseIrcLine first-msg / returning-chatter flags', () => {
  test('first-msg=1 sets firstMsg true', () => {
    const m = parseIrcLine('@badges=;first-msg=1;id=1;user-id=2 :viewer!v@v.tmi.twitch.tv PRIVMSG #chan :hello')
    expect(m).toMatchObject({ type: 'privmsg', firstMsg: true })
  })

  test('returning-chatter=1 sets returningChatter true', () => {
    const m = parseIrcLine('@badges=;returning-chatter=1;id=1;user-id=2 :viewer!v@v.tmi.twitch.tv PRIVMSG #chan :hello')
    expect(m).toMatchObject({ type: 'privmsg', returningChatter: true })
  })

  test('absent tags leave both flags undefined', () => {
    const m = parseIrcLine('@badges=;id=1;user-id=2 :viewer!v@v.tmi.twitch.tv PRIVMSG #chan :hello')
    expect(m).toMatchObject({ type: 'privmsg' })
    if (m.type === 'privmsg') {
      expect(m.firstMsg).toBeUndefined()
      expect(m.returningChatter).toBeUndefined()
    }
  })
})

describe('dispatch forwards flags as the 10th arg', () => {
  test('dispatchPrivmsg carries firstMsg/returningChatter through to onMessage', () => {
    const received: unknown[][] = []
    const client = new TwitchClient(
      { token: 't', clientId: 'c', botUserId: '1', botUsername: 'bot', channels: [] },
      (...args: unknown[]) => { received.push(args) },
    )
    const c = client as unknown as { dispatchPrivmsg: (m: unknown) => void }
    c.dispatchPrivmsg({
      type: 'privmsg', channel: 'chan', login: 'viewer', text: 'hi', userId: '2', messageId: 'm3',
      badges: [], sentTs: 0, firstMsg: true,
    })
    const flags = (received[0] as unknown[])[9]
    expect(flags).toMatchObject({ firstMsg: true })
  })

  test('a privmsg with neither flag forwards undefined flags (not an object)', () => {
    const received: unknown[][] = []
    const client = new TwitchClient(
      { token: 't', clientId: 'c', botUserId: '1', botUsername: 'bot', channels: [] },
      (...args: unknown[]) => { received.push(args) },
    )
    const c = client as unknown as { dispatchPrivmsg: (m: unknown) => void }
    c.dispatchPrivmsg({
      type: 'privmsg', channel: 'chan', login: 'viewer', text: 'hi', userId: '2', messageId: 'm4',
      badges: [], sentTs: 0,
    })
    const flags = (received[0] as unknown[])[9]
    expect(flags).toBeUndefined()
  })
})

// CLEARCHAT (timeout/ban/whole-clear) and CLEARMSG (single deletion) — rendered by
// moderation.ts, this file only proves the parse.
describe('parseIrcLine CLEARCHAT / CLEARMSG', () => {
  test('timeout — durationSec + lowercased login', () => {
    const line = '@ban-duration=600;room-id=1;target-user-id=2;tmi-sent-ts=1700000000000 :tmi.twitch.tv CLEARCHAT #chan :Alice'
    const m = parseIrcLine(line)
    expect(m).toMatchObject({ type: 'clearchat', channel: 'chan', login: 'alice', durationSec: 600, userId: '2' })
  })

  test('permanent ban — no ban-duration tag, durationSec undefined', () => {
    const line = '@room-id=1;target-user-id=2;tmi-sent-ts=1700000000000 :tmi.twitch.tv CLEARCHAT #chan :alice'
    const m = parseIrcLine(line)
    expect(m).toMatchObject({ type: 'clearchat', login: 'alice' })
    if (m.type === 'clearchat') expect(m.durationSec).toBeUndefined()
  })

  test('whole chat cleared — no trailing login', () => {
    const line = '@room-id=1;tmi-sent-ts=1700000000000 :tmi.twitch.tv CLEARCHAT #chan'
    const m = parseIrcLine(line)
    expect(m).toMatchObject({ type: 'clearchat', channel: 'chan' })
    if (m.type === 'clearchat') expect(m.login).toBeUndefined()
  })

  test('CLEARMSG carries the deleted text verbatim, including empty', () => {
    const line = '@login=alice;room-id=1;target-msg-id=uuid-1;tmi-sent-ts=123 :tmi.twitch.tv CLEARMSG #chan :the deleted text'
    const m = parseIrcLine(line)
    expect(m).toMatchObject({ type: 'clearmsg', channel: 'chan', login: 'alice', targetMsgId: 'uuid-1', text: 'the deleted text' })

    const emptyLine = '@login=alice;room-id=1;target-msg-id=uuid-2;tmi-sent-ts=123 :tmi.twitch.tv CLEARMSG #chan :'
    const m2 = parseIrcLine(emptyLine)
    expect(m2).toMatchObject({ type: 'clearmsg', text: '' })
  })
})

describe('parseIrcLine RECONNECT', () => {
  test('untagged RECONNECT parses to {type: reconnect}', () => {
    expect(parseIrcLine(':tmi.twitch.tv RECONNECT')).toEqual({ type: 'reconnect' })
  })

  test('the word RECONNECT inside a tagged PRIVMSG body does not parse as reconnect', () => {
    const line = '@id=1;user-id=2 :viewer!v@v.tmi.twitch.tv PRIVMSG #chan :please RECONNECT now'
    const m = parseIrcLine(line)
    expect(m.type).toBe('privmsg')
  })
})

describe('parseIrcLine bits/highlighted/redeem flags', () => {
  test('bits= tag sets bits as a number', () => {
    const m = parseIrcLine('@bits=100;id=1;user-id=2 :v!v@v.tmi.twitch.tv PRIVMSG #chan :cheer100 nice')
    expect(m).toMatchObject({ type: 'privmsg', bits: 100 })
  })

  test('bits absent or non-positive leaves bits undefined', () => {
    const noBits = parseIrcLine('@id=1;user-id=2 :v!v@v.tmi.twitch.tv PRIVMSG #chan :hi')
    expect(noBits).toMatchObject({ type: 'privmsg' })
    if (noBits.type === 'privmsg') expect(noBits.bits).toBeUndefined()
    const zeroBits = parseIrcLine('@bits=0;id=1;user-id=2 :v!v@v.tmi.twitch.tv PRIVMSG #chan :hi')
    if (zeroBits.type === 'privmsg') expect(zeroBits.bits).toBeUndefined()
  })

  test('msg-id=highlighted-message sets highlighted', () => {
    const m = parseIrcLine('@msg-id=highlighted-message;id=1;user-id=2 :v!v@v.tmi.twitch.tv PRIVMSG #chan :hi')
    expect(m).toMatchObject({ type: 'privmsg', highlighted: true })
  })

  test('custom-reward-id present and non-empty sets redeem', () => {
    const m = parseIrcLine('@custom-reward-id=abc-123;id=1;user-id=2 :v!v@v.tmi.twitch.tv PRIVMSG #chan :hi')
    expect(m).toMatchObject({ type: 'privmsg', redeem: true })
  })

  test('absent tags leave highlighted/redeem undefined', () => {
    const m = parseIrcLine('@id=1;user-id=2 :v!v@v.tmi.twitch.tv PRIVMSG #chan :hi')
    expect(m).toMatchObject({ type: 'privmsg' })
    if (m.type === 'privmsg') {
      expect(m.highlighted).toBeUndefined()
      expect(m.redeem).toBeUndefined()
    }
  })

  test('dispatchPrivmsg forwards bits/highlighted/redeem in flags', () => {
    const received: unknown[][] = []
    const client = new TwitchClient(
      { token: 't', clientId: 'c', botUserId: '1', botUsername: 'bot', channels: [] },
      (...args: unknown[]) => { received.push(args) },
    )
    const c = client as unknown as { dispatchPrivmsg: (m: unknown) => void }
    c.dispatchPrivmsg({
      type: 'privmsg', channel: 'chan', login: 'viewer', text: 'cheer100 nice', userId: '2', messageId: 'm5',
      badges: [], sentTs: 0, bits: 100, highlighted: true, redeem: true,
    })
    const flags = (received[0] as unknown[])[9]
    expect(flags).toMatchObject({ bits: 100, highlighted: true, redeem: true })
  })
})

describe('say() returns the transmitted text', () => {
  test('truncates past 490 codepoints and strips a leading command prefix', async () => {
    const client = new TwitchClient(
      { token: 't', clientId: 'c', botUserId: '1', botUsername: 'bot', channels: [] },
      () => {},
    )
    const c = client as unknown as { ircSend: (l: string) => boolean; ircReady: boolean; ircOnlyChannels: Set<string>; irc: { readyState: number } }
    c.ircReady = true
    c.irc = { readyState: 1 }
    c.ircOnlyChannels = new Set(['chan'])
    c.ircSend = () => true

    const long = '/' + 'a'.repeat(600)
    const result = await client.say('chan', long)
    expect(result.startsWith('/')).toBe(false) // leading command prefix stripped
    expect([...result].length).toBe(490) // 487 kept chars + '...'
    expect(result.endsWith('...')).toBe(true)
  })
})

describe('usernotice dedupe + routing', () => {
  test('dispatchUserNotice fires the handler once per messageId, dedupes a redelivery', () => {
    const received: unknown[] = []
    const client = new TwitchClient(
      { token: 't', clientId: 'c', botUserId: '1', botUsername: 'bot', channels: [] },
      () => {},
    )
    client.setUserNoticeHandler((n) => received.push(n))
    const c = client as unknown as { dispatchUserNotice: (m: unknown) => void }
    const notice = {
      type: 'usernotice', channel: 'chan', msgId: 'raid', login: 'kripp', displayName: 'Kripp',
      userId: '2', messageId: 'evt-dup', badges: [], sentTs: 0, systemMsg: '', params: {},
    }
    c.dispatchUserNotice(notice)
    c.dispatchUserNotice(notice)
    expect(received.length).toBe(1)
  })
})
