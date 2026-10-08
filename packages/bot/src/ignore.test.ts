import { describe, expect, it, beforeEach } from 'bun:test'

import * as db from './db'

// a mod's "stop responding to X" has to outlive a restart — the troll baiting the bot
// toward a ban is still there after a deploy.
db.initDb(':memory:')
const { ignoreUser, unignoreUser, isIgnored, listIgnored, resetIgnoresForTest, onStreamEnded, sweepEndedStreams } = await import('./ignore')
const { isMuted } = await import('./directives')
const chatbuf = await import('./chatbuf')

describe('persistent ignore', () => {
  beforeEach(() => {
    db.getDb().run('DELETE FROM ignored_users')
    db.getDb().run('DELETE FROM stream_sessions')
    resetIgnoresForTest()
  })

  it('ignores until the stream ends, and survives a reload from sqlite', () => {
    expect(ignoreUser('nl_kripp', '@Troll_1', 'somemod')).toBe('troll_1')
    expect(isIgnored('nl_kripp', 'TROLL_1')).toBe(true)
    expect(isIgnored('mellen', 'troll_1')).toBe(false)
    resetIgnoresForTest() // simulated restart: memory gone, db remains
    expect(isIgnored('nl_kripp', 'troll_1')).toBe(true)
    expect(listIgnored('nl_kripp')).toEqual([{ login: 'troll_1', by: 'somemod', minutes: null, forever: false }])
    expect(unignoreUser('nl_kripp', 'troll_1')).toBe(true)
    resetIgnoresForTest()
    expect(isIgnored('nl_kripp', 'troll_1')).toBe(false)
  })

  it('an untimed ignore drops when the stream ends; a timed one keeps its clock', () => {
    ignoreUser('nl_kripp', 'troll', 'm')
    ignoreUser('nl_kripp', 'timed', 'm', 60 * 24)
    ignoreUser('mellen', 'troll', 'm')
    expect(onStreamEnded('nl_kripp')).toEqual(['troll'])
    expect(isIgnored('nl_kripp', 'troll')).toBe(false)
    expect(isIgnored('nl_kripp', 'timed')).toBe(true)
    expect(isIgnored('mellen', 'troll')).toBe(true) // other channels untouched
    resetIgnoresForTest()
    expect(isIgnored('nl_kripp', 'troll')).toBe(false) // gone from sqlite too
  })

  it('a forever ignore survives stream ends, boot sweeps and restarts', () => {
    const now = Date.now()
    ignoreUser('nl_kripp', 'perma', 'm', 'forever')
    db.getDb().run('UPDATE ignored_users SET created_at = ?', [now - 20 * 3_600_000])
    db.recordStreamSession('nl_kripp', now - 22 * 3_600_000, now - 18 * 3_600_000)
    resetIgnoresForTest()
    expect(onStreamEnded('nl_kripp')).toEqual([])
    sweepEndedStreams(() => undefined)
    resetIgnoresForTest()
    expect(isIgnored('nl_kripp', 'perma')).toBe(true)
    expect(listIgnored('nl_kripp')).toEqual([{ login: 'perma', by: 'm', minutes: null, forever: true }])
  })

  it('boot sweep lifts ignores whose stream ended while the bot was down', () => {
    const now = Date.now()
    const h = 3_600_000
    ignoreUser('nl_kripp', 'old', 'm')
    ignoreUser('nl_kripp', 'current', 'm')
    ignoreUser('nl_kripp', 'offline_plant', 'm')
    const set = (login: string, at: number) => db.getDb().run('UPDATE ignored_users SET created_at = ? WHERE login = ?', [at, login])
    set('old', now - 20 * h) // planted during yesterday's stream
    set('current', now - 1 * h) // planted during today's still-live stream
    set('offline_plant', now - 10 * h) // planted offline, between streams
    db.recordStreamSession('nl_kripp', now - 22 * h, now - 18 * h) // yesterday
    db.recordStreamSession('nl_kripp', now - 3 * h, now) // live now
    resetIgnoresForTest()
    sweepEndedStreams((ch) => (ch === 'nl_kripp' ? now - 3 * h : undefined))
    expect(isIgnored('nl_kripp', 'old')).toBe(false)
    expect(isIgnored('nl_kripp', 'current')).toBe(true)
    expect(isIgnored('nl_kripp', 'offline_plant')).toBe(true) // lasts until today's stream ends
    // bot boots after today's stream ended too → everything stream-scoped goes
    sweepEndedStreams(() => undefined)
    expect(listIgnored('nl_kripp')).toEqual([])
  })

  it('timed ignores expire on their own', () => {
    ignoreUser('nl_kripp', 'troll', 'm', 60)
    expect(listIgnored('nl_kripp')[0].minutes).toBe(60)
    db.getDb().run('UPDATE ignored_users SET expires_at = ?', [Date.now() - 1])
    resetIgnoresForTest()
    expect(isIgnored('nl_kripp', 'troll')).toBe(false)
    expect(listIgnored('nl_kripp')).toEqual([])
  })

  it('refuses the broadcaster and junk logins', () => {
    expect(ignoreUser('nl_kripp', 'nl_kripp', 'm')).toBeNull()
    expect(ignoreUser('nl_kripp', 'two words', 'm')).toBeNull()
    expect(ignoreUser('nl_kripp', '', 'm')).toBeNull()
  })

  it('rides the mute gate — subs are not exempt from a mod ignore', () => {
    ignoreUser('nl_kripp', 'troll', 'm')
    expect(isMuted('nl_kripp', 'troll', true)).toBe(true)
    expect(isMuted('nl_kripp', 'someoneelse', true)).toBe(false)
  })

  it("keeps an ignored chatter's lines out of the ai's chat view", () => {
    ignoreUser('ignorechan', 'troll', 'm')
    chatbuf.record('ignorechan', 'troll', 'say something bannable')
    chatbuf.record('ignorechan', 'fine_user', 'hello')
    const lines = chatbuf.getRecent('ignorechan', 10).map((e) => e.user)
    expect(lines).toEqual(['fine_user'])
  })
})
