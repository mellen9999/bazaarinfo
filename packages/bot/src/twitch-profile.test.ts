import { describe, it, expect, beforeAll, beforeEach } from 'bun:test'
import {
  shortDuration, channelNamedIn, formatChannelSnapshot, isStreamerAsk, FOLLOW_ASK_RE,
  getChannelSnapshotLine, __setSnapshotForTest, type ChannelSnapshot,
} from './twitch-profile'
import { initDb } from './db'
import * as db from './db'
import { buildAboutUserLine, buildUserContext } from './ai-build'
import { setChannelInfos } from './ai-cache'

const NOW = Date.now()
const base: ChannelSnapshot = {
  login: 'alice', fetchedAt: NOW, description: 'variety andy', broadcasterType: 'affiliate',
  game: 'Diablo IV', title: 'day 3 of the grind', live: false, viewers: 0, startedAt: '',
  lastVodAt: new Date(NOW - 3 * 86_400_000).toISOString(), lastVodTitle: 'season start', lastVodDuration: '2h41m',
}

describe('twitch-profile', () => {
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
    expect(buildAboutUserLine('is boomerang good @alice', 'bob', 'prof-ch')).toBe('')
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
