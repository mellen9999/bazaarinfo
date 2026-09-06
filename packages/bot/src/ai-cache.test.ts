import { describe, expect, it, afterEach } from 'bun:test'
import { cacheExchange, getHotExchanges } from './ai-cache'

describe('hot exchange cache', () => {
  const realNow = Date.now

  afterEach(() => {
    Date.now = realNow
  })

  it('hits regardless of user casing, keyed within the same channel', () => {
    cacheExchange('MixedCase', 'what does it do', 'sells for a lot', 'kripp')
    expect(getHotExchanges('mixedcase', 'kripp').map((e) => e.query)).toEqual(['what does it do'])
    expect(getHotExchanges('MIXEDCASE', 'kripp').map((e) => e.query)).toEqual(['what does it do'])
  })

  it('never crosses channels — same user, different channel misses', () => {
    cacheExchange('crossuser', 'q', 'r', 'channelone')
    expect(getHotExchanges('crossuser', 'channeltwo')).toEqual([])
    expect(getHotExchanges('crossuser', 'channelone').length).toBe(1)
  })

  it('drops entries older than the ttl', () => {
    let now = 1_700_000_000_000
    Date.now = () => now
    cacheExchange('ttluser', 'q1', 'r1', 'ttlchan')
    now += 3_600_001 // just past the 1h ttl
    Date.now = () => now
    expect(getHotExchanges('ttluser', 'ttlchan')).toEqual([])
  })

  it('caps at 8 entries, dropping the oldest first', () => {
    for (let i = 0; i < 10; i++) cacheExchange('capuser', `q${i}`, `r${i}`, 'capchan')
    const hot = getHotExchanges('capuser', 'capchan')
    expect(hot.length).toBe(8)
    expect(hot.map((e) => e.query)).toEqual(['q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9'])
  })
})
