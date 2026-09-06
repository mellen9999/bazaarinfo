import { describe, it, expect, beforeAll, beforeEach } from 'bun:test'
import {
  shortDuration, channelNamedIn, formatChannelSnapshot, isStreamerAsk, FOLLOW_ASK_RE,
  getChannelSnapshotLine, __setSnapshotForTest, maybeFetchChannelSnapshot, canReadFollowage, type ChannelSnapshot,
} from './twitch-profile'
import { initDb } from './db'
import { __setTokensForTest } from './auth'
import * as db from './db'
import { buildAboutUserLine, buildUserContext, userStandingLine } from './ai-build'
import { setChannelInfos } from './ai-cache'

const NOW = Date.now()
const base: ChannelSnapshot = {
  login: 'alice', fetchedAt: NOW, description: 'variety andy', broadcasterType: 'affiliate',
  game: 'Diablo IV', title: 'day 3 of the grind', live: false, viewers: 0, startedAt: '',
  lastVodAt: new Date(NOW - 3 * 86_400_000).toISOString(), lastVodTitle: 'season start', lastVodDuration: '2h41m',
}

describe('twitch-profile', () => {
  it('followage is unreadable without the scope — no fetch, no cached "not following"', () => {
    expect(canReadFollowage('anychan')).toBe(false)
  })

  it('shortens helix durations', () => {
    expect(shortDuration('2h41m3s')).toBe('2h41m')
    expect(shortDuration('47m12s')).toBe('47m')
    expect(shortDuration('3h')).toBe('3h')
    expect(shortDuration('')).toBe('')
  })

  it('finds a joined channel named in the ask, never the current one, never a substring', () => {
    const joined = ['nl_kripp', 'rogue', 'mellen']
    expect(channelNamedIn('how long has alice followed rogue', 'nl_kripp', joined)).toBe('rogue')
    expect(channelNamedIn('how long has alice followed Rogue?', 'nl_kripp', joined)).toBe('rogue')
    expect(channelNamedIn('my followage on kripp', 'nl_kripp', joined)).toBeNull()
    expect(channelNamedIn('rogue', 'rogue', joined)).toBeNull()
    expect(channelNamedIn('roguelike followage', 'nl_kripp', joined)).toBeNull()
  })

  it('classifies streamer and follow asks', () => {
    expect(isStreamerAsk('does alice stream')).toBe(true)
    expect(isStreamerAsk('what does alice play on her channel')).toBe(true)
    expect(isStreamerAsk('is alice live')).toBe(true)
    expect(isStreamerAsk('is boomerang good')).toBe(false)
    expect(FOLLOW_ASK_RE.test('whats my followage')).toBe(true)
    expect(FOLLOW_ASK_RE.test('how long has bob followed')).toBe(true)
    expect(FOLLOW_ASK_RE.test('follow up question')).toBe(true)
  })

  it('formats an offline streamer from the last vod', () => {
    const line = formatChannelSnapshot(base, NOW)
    expect(line).toBe('twitch affiliate; streams Diablo IV, last live 3d ago (2h41m) "season start"; bio: "variety andy"')
  })

  it('formats a live streamer, a channel with no vods, and a never-streamed account', () => {
    expect(formatChannelSnapshot({ ...base, live: true, viewers: 120 }, NOW)).toContain('LIVE right now playing Diablo IV to 120 viewers ("day 3 of the grind")')
    expect(formatChannelSnapshot({ ...base, lastVodAt: '', lastVodTitle: '', lastVodDuration: '' }, NOW)).toContain('channel set to Diablo IV "day 3 of the grind", no vods')
    expect(formatChannelSnapshot({ ...base, broadcasterType: '', game: '', title: '', description: '', lastVodAt: '' }, NOW)).toBe('has never streamed')
  })

  it('a snapshot older than the ttl reads as unknown', () => {
    __setSnapshotForTest('alice', { ...base, fetchedAt: NOW - 2 * 3_600_000 })
    expect(getChannelSnapshotLine('alice')).toBe('')
    __setSnapshotForTest('alice', base)
    expect(getChannelSnapshotLine('ALICE')).toContain('streams Diablo IV')
    __setSnapshotForTest('alice', null)
  })
})

describe('about-user context', () => {
  beforeAll(() => { initDb(':memory:') })
  beforeEach(() => { __setSnapshotForTest('alice', null) })

  it('a streamer ask about a real chatter carries their twitch facts, and nothing for the asker', () => {
    db.logChat('prof-ch', 'alice', 'hello there')
    db.flushWrites()
    db.setCachedTwitchUser('alice', '1', 'Alice', '2015-03-01T00:00:00Z')
    db.setCachedFollowage('alice', 'prof-ch', '2020-01-01T00:00:00Z')
    __setSnapshotForTest('alice', base)
    const line = buildAboutUserLine('does @alice stream', 'bob', 'prof-ch')
    expect(line).toContain('About alice (twitch, real): account')
    expect(line).toContain('following #prof-ch since')
    expect(line).toContain('streams Diablo IV')
    expect(line).not.toContain('followage is only readable')
    expect(buildAboutUserLine('does @alice stream', 'alice', 'prof-ch')).toBe('')
    expect(buildAboutUserLine('is boomerang good', 'bob', 'prof-ch')).toBe('')
    // any @mention of a real chatter carries their record — banter about someone gets the who
    expect(buildAboutUserLine('@alice is a chad', 'bob', 'prof-ch')).toContain('About alice')
  })

  it('badges and the event log land in the standing line, for the asker and for @someone', () => {
    db.upsertUserBadges('alice', 'prof-ch', JSON.stringify({ subMonths: 14, subTier: 2, gifter: 50 }))
    db.flushWrites()
    db.logUserEvent({ channel: 'prof-ch', login: 'alice', kind: 'resub', detail: 'resubbed (14 months): "gg"', months: 14 })
    db.logUserEvent({ channel: 'rogue', login: 'alice', kind: 'gift', detail: 'gifted 20 subs', count: 20 })
    db.logUserEvent({ channel: 'prof-ch', login: 'alice', kind: 'announce', detail: 'english only' })
    const standing = userStandingLine('alice', 'prof-ch')
    expect(standing).toContain('sub 14 months (tier 2), gifted 50+ subs')
    expect(standing).toContain('recently: ')
    expect(standing).toContain('resubbed (14 months): "gg"')
    expect(standing).toContain('gifted 20 subs')
    expect(standing).toContain('(#rogue)')
    expect(standing).not.toContain('english only')
    expect(buildUserContext('alice', 'prof-ch', true, true, 'hi')).toContain('sub 14 months (tier 2)')
    expect(buildAboutUserLine('@alice is a chad', 'bob', 'prof-ch')).toContain('gifted 50+ subs')
    expect(userStandingLine('nobody', 'prof-ch')).toBe('')
  })

  it('the chat profile counts what is logged here', () => {
    db.logChat('prof-ch', 'alice', 'second line')
    db.flushWrites()
    const p = db.getUserChatProfile('alice', 'prof-ch')
    expect(p?.messages).toBe(2)
    expect(typeof p?.peakHourUtc).toBe('number')
    expect(db.getUserChatProfile('nobody', 'prof-ch')).toBeNull()
  })

  it('a failed helix read is a miss, never "has never streamed"', async () => {
    const realFetch = globalThis.fetch
    process.env.TWITCH_CLIENT_ID = 'cid'
    __setTokensForTest({ accessToken: 'tok', refreshToken: 'r' })
    let calls = 0
    globalThis.fetch = (async (url: string) => {
      calls++
      if (String(url).includes('/users?')) return new Response(JSON.stringify({ data: [{ id: '9', login: 'dave', created_at: '2020-01-01T00:00:00Z' }] }))
      return new Response('rate limited', { status: 429 })
    }) as typeof fetch
    try {
      maybeFetchChannelSnapshot('dave')
      await new Promise((r) => setTimeout(r, 20))
      expect(getChannelSnapshotLine('dave')).toBe('')
      const before = calls
      maybeFetchChannelSnapshot('dave') // inside the miss window: no refetch storm
      await new Promise((r) => setTimeout(r, 20))
      expect(calls).toBe(before)
      expect(before).toBe(4)
    } finally {
      globalThis.fetch = realFetch
      __setTokensForTest(null)
    }
  })

  it('a follow ask about another joined channel reads its cached followage and states the limit', () => {
    setChannelInfos([{ name: 'prof-ch', userId: '10' }, { name: 'rogue', userId: '11' }] as any)
    db.setCachedFollowage('alice', 'rogue', null)
    const line = buildAboutUserLine('how long has @alice followed rogue', 'bob', 'prof-ch')
    expect(line).toContain('not following #rogue')
    expect(line).toContain('followage is only readable on channels i moderate')
    db.setCachedFollowage('alice', 'rogue', '2021-06-01T00:00:00Z')
    expect(buildAboutUserLine('how long has @alice followed rogue', 'bob', 'prof-ch')).toContain('following #rogue since')
    setChannelInfos([])
  })

  it('the asker gets their own channel line only on a streamer ask', () => {
    __setSnapshotForTest('bob', { ...base, login: 'bob' })
    expect(buildUserContext('bob', 'prof-ch', true, true, 'do i stream')).toContain('streams Diablo IV')
    expect(buildUserContext('bob', 'prof-ch', true, true, 'is boomerang good')).not.toContain('streams Diablo IV')
    __setSnapshotForTest('bob', null)
  })
})
