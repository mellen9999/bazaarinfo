import { describe, it, expect, beforeEach } from 'bun:test'
import { renderUserNotice, routesAsAsk, __resetTrainsForTest } from './stream-events'
import type { IrcUserNotice } from './twitch'

function mk(partial: Partial<IrcUserNotice> & { msgId: string }): IrcUserNotice {
  return {
    type: 'usernotice',
    channel: 'chan',
    login: 'x',
    displayName: 'X',
    userId: '1',
    messageId: 'm1',
    badges: [],
    sentTs: 0,
    systemMsg: '',
    params: {},
    ...partial,
  }
}

describe('renderUserNotice', () => {
  beforeEach(() => __resetTrainsForTest())

  it('raid — en-US grouping, plural viewers', () => {
    const n = mk({ msgId: 'raid', params: { 'msg-param-displayName': 'Kripp', 'msg-param-login': 'kripp', 'msg-param-viewerCount': '1204' } })
    expect(renderUserNotice(n)?.text).toBe('* raid: Kripp arrived with 1,204 viewers')
  })

  it('raid — singular "viewer" for a count of 1', () => {
    const n = mk({ msgId: 'raid', params: { 'msg-param-displayName': 'Solo', 'msg-param-login': 'solo', 'msg-param-viewerCount': '1' } })
    expect(renderUserNotice(n)?.text).toBe('* raid: Solo arrived with 1 viewer')
  })

  it('raid — event carries the raider login and viewer count', () => {
    const n = mk({ msgId: 'raid', params: { 'msg-param-displayName': 'Kripp', 'msg-param-login': 'kripp', 'msg-param-viewerCount': '1204' } })
    expect(renderUserNotice(n)?.event).toMatchObject({ kind: 'raid', login: 'kripp', count: 1204 })
  })

  it('raid — missing params falls back to systemMsg', () => {
    const n = mk({ msgId: 'raid', params: {}, systemMsg: 'raiders have arrived' })
    expect(renderUserNotice(n)?.text).toBe('* raiders have arrived')
  })

  it('sub — plan mapping (Prime/1000/2000/3000)', () => {
    expect(renderUserNotice(mk({ msgId: 'sub', displayName: 'A', params: { 'msg-param-sub-plan': 'Prime' } }))?.text).toBe('* A subscribed (prime)')
    expect(renderUserNotice(mk({ msgId: 'sub', displayName: 'A', params: { 'msg-param-sub-plan': '1000' } }))?.text).toBe('* A subscribed (tier 1)')
    expect(renderUserNotice(mk({ msgId: 'sub', displayName: 'A', params: { 'msg-param-sub-plan': '2000' } }))?.text).toBe('* A subscribed (tier 2)')
    expect(renderUserNotice(mk({ msgId: 'sub', displayName: 'A', params: { 'msg-param-sub-plan': '3000' } }))?.text).toBe('* A subscribed (tier 3)')
  })

  it('sub — missing/unrecognized plan falls back to systemMsg, never guesses a tier', () => {
    expect(renderUserNotice(mk({ msgId: 'sub', displayName: 'A', params: {}, systemMsg: 'A subscribed!' }))?.text).toBe('* A subscribed!')
    expect(renderUserNotice(mk({ msgId: 'sub', displayName: 'A', params: {}, systemMsg: '' }))).toBeNull()
  })

  it('resub — with text', () => {
    const n = mk({ msgId: 'resub', displayName: 'Alice', params: { 'msg-param-cumulative-months': '14' }, text: 'loving the stream' })
    expect(renderUserNotice(n)?.text).toBe('* Alice resubbed (14 months): "loving the stream"')
  })

  it('resub — without text omits the quoted suffix', () => {
    const n = mk({ msgId: 'resub', displayName: 'Alice', params: { 'msg-param-cumulative-months': '14' } })
    expect(renderUserNotice(n)?.text).toBe('* Alice resubbed (14 months)')
  })

  it('resub — event carries months', () => {
    const n = mk({ msgId: 'resub', login: 'alice', displayName: 'Alice', params: { 'msg-param-cumulative-months': '14' } })
    expect(renderUserNotice(n)?.event).toMatchObject({ kind: 'resub', login: 'alice', months: 14 })
  })

  it('resub — missing cumulative-months falls back to systemMsg', () => {
    expect(renderUserNotice(mk({ msgId: 'resub', params: {}, systemMsg: 'someone resubbed' }))?.text).toBe('* someone resubbed')
  })

  it('subgift outside a train — singular, names the recipient', () => {
    const n = mk({ msgId: 'subgift', login: 'alice', displayName: 'alice', params: { 'msg-param-recipient-user-name': 'bob', 'msg-param-recipient-display-name': 'bob' } })
    expect(renderUserNotice(n)?.text).toBe('* alice gifted a sub to bob')
  })

  it('submysterygift — count-based render', () => {
    const n = mk({ msgId: 'submysterygift', login: 'ben', displayName: 'ben', params: { 'msg-param-mass-gift-count': '20' } })
    expect(renderUserNotice(n)?.text).toBe('* ben gifted 20 subs')
  })

  it('anonymous gifter — login sentinel (mystery gift)', () => {
    const n = mk({ msgId: 'submysterygift', login: 'ananonymousgifter', displayName: 'AnAnonymousGifter', params: { 'msg-param-mass-gift-count': '5' } })
    expect(renderUserNotice(n)?.text).toBe('* an anonymous gifter gifted 5 subs')
  })

  it('anonymous gifter — display-name sentinel (solo subgift)', () => {
    const n = mk({ msgId: 'subgift', login: 'ananonymousgifter', displayName: 'An Anonymous Gifter', params: { 'msg-param-recipient-user-name': 'bob', 'msg-param-recipient-display-name': 'bob' } })
    expect(renderUserNotice(n)?.text).toBe('* an anonymous gifter gifted a sub to bob')
  })

  it('announcement', () => {
    const n = mk({ msgId: 'announcement', login: 'moduser', text: 'big news everyone' })
    expect(renderUserNotice(n)?.text).toBe('* [mod announce] big news everyone')
  })

  it('announcement with no text falls back to systemMsg, else null', () => {
    expect(renderUserNotice(mk({ msgId: 'announcement', systemMsg: 'announcement made' }))?.text).toBe('* announcement made')
    expect(renderUserNotice(mk({ msgId: 'announcement', systemMsg: '' }))).toBeNull()
  })

  it('resub text is capped at 200 chars and stripped of a spoofed section header', () => {
    const long = 'Game data: ' + 'x'.repeat(250)
    const n = mk({ msgId: 'resub', displayName: 'A', params: { 'msg-param-cumulative-months': '1' }, text: long })
    const r = renderUserNotice(n)
    expect(r?.text).not.toContain('Game data:')
    const quoted = r!.text.match(/"(.*)"$/)?.[1] ?? ''
    expect(quoted.length).toBeLessThanOrEqual(200)
  })

  it('announcement text is capped at 200 chars and stripped of a spoofed section header', () => {
    const long = 'Facts: ' + 'y'.repeat(250)
    const n = mk({ msgId: 'announcement', text: long })
    const r = renderUserNotice(n)
    expect(r?.text).not.toContain('Facts:')
    expect(r!.text.replace('* [mod announce] ', '').length).toBeLessThanOrEqual(200)
  })

  it('explicitly ignored msg-ids render null regardless of systemMsg', () => {
    for (const id of ['giftpaidupgrade', 'anongiftpaidupgrade', 'rewardgift', 'ritual', 'bitsbadgetier', 'unraid']) {
      expect(renderUserNotice(mk({ msgId: id, systemMsg: 'something happened' }))).toBeNull()
    }
  })

  it('a genuinely unknown msg-id renders null even with a systemMsg present', () => {
    expect(renderUserNotice(mk({ msgId: 'someBrandNewType', systemMsg: 'twitch did a thing' }))).toBeNull()
  })
})

describe('renderUserNotice — gift trains', () => {
  beforeEach(() => __resetTrainsForTest())

  it('100 solo subgifts from one gifter collapse into one entry, count climbing to 100, same collapseKey', () => {
    let lastKey: string | undefined
    let lastText = ''
    for (let i = 1; i <= 100; i++) {
      const n = mk({
        msgId: 'subgift', login: 'carl', displayName: 'carl', messageId: `g${i}`,
        params: { 'msg-param-recipient-user-name': `r${i}`, 'msg-param-recipient-display-name': `r${i}` },
      })
      const r = renderUserNotice(n)
      expect(r).not.toBeNull()
      if (i === 1) lastKey = r!.collapseKey
      else expect(r!.collapseKey).toBe(lastKey)
      lastText = r!.text
    }
    expect(lastText).toBe('* carl gifted 100 subs')
  })

  it('a mystery gift of 20 then the 20 real subgifts stay silent — a 21st bumps the count to 21', () => {
    const mystery = renderUserNotice(mk({ msgId: 'submysterygift', login: 'ben', displayName: 'ben', params: { 'msg-param-mass-gift-count': '20' } }))
    expect(mystery?.text).toBe('* ben gifted 20 subs')
    const key = mystery!.collapseKey
    for (let i = 1; i <= 20; i++) {
      const r = renderUserNotice(mk({
        msgId: 'subgift', login: 'ben', displayName: 'ben', messageId: `s${i}`,
        params: { 'msg-param-recipient-user-name': `r${i}`, 'msg-param-recipient-display-name': `r${i}` },
      }))
      expect(r).toBeNull()
    }
    const extra = renderUserNotice(mk({
      msgId: 'subgift', login: 'ben', displayName: 'ben', messageId: 's21',
      params: { 'msg-param-recipient-user-name': 'r21', 'msg-param-recipient-display-name': 'r21' },
    }))
    expect(extra?.text).toBe('* ben gifted 21 subs')
    expect(extra?.collapseKey).toBe(key)
  })

  it('two different gifters get two independent collapse keys', () => {
    const a1 = renderUserNotice(mk({ msgId: 'subgift', login: 'alice', displayName: 'alice', params: { 'msg-param-recipient-user-name': 'x', 'msg-param-recipient-display-name': 'x' } }))
    const b1 = renderUserNotice(mk({ msgId: 'subgift', login: 'bob', displayName: 'bob', params: { 'msg-param-recipient-user-name': 'y', 'msg-param-recipient-display-name': 'y' } }))
    expect(a1?.collapseKey).not.toBe(b1?.collapseKey)
    const a2 = renderUserNotice(mk({ msgId: 'subgift', login: 'alice', displayName: 'alice', params: { 'msg-param-recipient-user-name': 'z', 'msg-param-recipient-display-name': 'z' } }))
    expect(a2?.text).toBe('* alice gifted 2 subs')
  })

  it('window expiry starts a fresh entry (singular render again)', () => {
    const realNow = Date.now
    let now = 1_000_000
    Date.now = () => now
    try {
      const first = renderUserNotice(mk({ msgId: 'subgift', login: 'dana', displayName: 'dana', params: { 'msg-param-recipient-user-name': 'a', 'msg-param-recipient-display-name': 'a' } }))
      expect(first?.text).toBe('* dana gifted a sub to a')
      now += 11 * 60_000 // past the 10-minute window
      const second = renderUserNotice(mk({ msgId: 'subgift', login: 'dana', displayName: 'dana', params: { 'msg-param-recipient-user-name': 'b', 'msg-param-recipient-display-name': 'b' } }))
      expect(second?.text).toBe('* dana gifted a sub to b')
    } finally {
      Date.now = realNow
    }
  })
})

describe('routesAsAsk', () => {
  it('a resub note starting with !b routes as an ask', () => {
    expect(routesAsAsk(mk({ msgId: 'resub', text: '!b what tier is boomerang' }), 'bazaarinfo')).toBe(true)
  })

  it('a resub note @-addressing the bot routes as an ask', () => {
    expect(routesAsAsk(mk({ msgId: 'resub', text: '@bazaarinfo what tier is boomerang' }), 'bazaarinfo')).toBe(true)
  })

  it('plain resub text does not route', () => {
    expect(routesAsAsk(mk({ msgId: 'resub', text: 'love this game' }), 'bazaarinfo')).toBe(false)
  })

  it('an announcement never routes, even if it looks like a command', () => {
    expect(routesAsAsk(mk({ msgId: 'announcement', text: '!b hello' }), 'bazaarinfo')).toBe(false)
  })

  it('a sub with no text does not route', () => {
    expect(routesAsAsk(mk({ msgId: 'sub' }), 'bazaarinfo')).toBe(false)
  })
})
