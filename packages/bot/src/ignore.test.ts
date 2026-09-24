import { describe, expect, it, beforeEach } from 'bun:test'

import * as db from './db'

// a mod's "stop responding to X" has to outlive a restart — the troll baiting the bot
// toward a ban is still there after a deploy.
db.initDb(':memory:')
const { ignoreUser, unignoreUser, isIgnored, listIgnored, resetIgnoresForTest } = await import('./ignore')
const { isMuted } = await import('./directives')
const chatbuf = await import('./chatbuf')

describe('persistent ignore', () => {
  beforeEach(() => {
    db.getDb().run('DELETE FROM ignored_users')
    resetIgnoresForTest()
  })

  it('ignores until lifted, and survives a reload from sqlite', () => {
    expect(ignoreUser('nl_kripp', '@Troll_1', 'somemod')).toBe('troll_1')
    expect(isIgnored('nl_kripp', 'TROLL_1')).toBe(true)
    expect(isIgnored('mellen', 'troll_1')).toBe(false)
    resetIgnoresForTest() // simulated restart: memory gone, db remains
    expect(isIgnored('nl_kripp', 'troll_1')).toBe(true)
    expect(listIgnored('nl_kripp')).toEqual([{ login: 'troll_1', by: 'somemod', minutes: null }])
    expect(unignoreUser('nl_kripp', 'troll_1')).toBe(true)
    resetIgnoresForTest()
    expect(isIgnored('nl_kripp', 'troll_1')).toBe(false)
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
