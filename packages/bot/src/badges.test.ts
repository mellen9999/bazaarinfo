import { describe, it, expect } from 'bun:test'
import { parseBadges, formatBadges, badgeKey } from './badges'

describe('badges', () => {
  it('reads exact sub months from badge-info and the tier from the badge version', () => {
    const s = parseBadges('subscriber/2012,sub-gifter/50,bits/1000,vip/1', 'subscriber/14')
    expect(s).toEqual({ subMonths: 14, subTier: 2, gifter: 50, bits: 1000, vip: true })
    expect(formatBadges(s)).toBe('vip, sub 14 months (tier 2), gifted 50+ subs, 1k+ bits')
  })

  it('falls back to the badge version for months when badge-info is missing', () => {
    expect(parseBadges('subscriber/3006', undefined)).toEqual({ subMonths: 6, subTier: 3 })
    expect(parseBadges('subscriber/0', undefined)).toEqual({ subMonths: 1, subTier: 1 })
  })

  it('founder carries months in badge-info under its own set', () => {
    const s = parseBadges('founder/0,premium/1', 'founder/22')
    expect(s.subMonths).toBe(22)
    expect(s.founder).toBe(true)
    expect(formatBadges(s)).toBe('sub 22 months (prime), founder')
  })

  it('mod, broadcaster, partner, artist, game dev, turbo all read; junk badges are ignored', () => {
    const s = parseBadges('broadcaster/1,moderator/1,partner/1,artist-badge/1,game-developer/1,turbo/1,twitch-recap-2023/1,predictions/blue-1,glhf-pledge/1', '')
    expect(formatBadges(s)).toBe('broadcaster, mod, twitch partner, channel artist, game dev, turbo')
  })

  it('a plain chatter formats to nothing', () => {
    expect(parseBadges('', '')).toEqual({})
    expect(parseBadges(undefined, undefined)).toEqual({})
    expect(formatBadges({})).toBe('')
  })

  it('the key is stable across property order and skips unset flags', () => {
    expect(badgeKey({ vip: true, subMonths: 3 })).toBe(badgeKey({ subMonths: 3, vip: true, mod: false }))
    expect(badgeKey({ vip: true })).not.toBe(badgeKey({ mod: true }))
  })
})

// the raw tags ride the privmsg flags untouched; parsing is badges.ts's job
import { parseIrcLine } from './twitch'
describe('badge tags on a privmsg', () => {
  it('carry through as raw strings, absent when the chatter has none', () => {
    const line = '@badge-info=subscriber/14;badges=subscriber/2012,vip/1;display-name=Alice;id=abc;user-id=1 :alice!alice@alice.tmi.twitch.tv PRIVMSG #ch :hi'
    const m = parseIrcLine(line) as any
    expect(m.badgeTags).toBe('subscriber/2012,vip/1')
    expect(m.badgeInfoTags).toBe('subscriber/14')
    expect(m.badges).toEqual(['subscriber', 'vip'])
    const plain = parseIrcLine('@id=x;user-id=2 :bob!bob@bob.tmi.twitch.tv PRIVMSG #ch :yo') as any
    expect(plain.badgeTags).toBeUndefined()
    expect(plain.badgeInfoTags).toBeUndefined()
  })
})
