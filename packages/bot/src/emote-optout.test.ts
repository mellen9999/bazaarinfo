import { describe, it, expect, beforeAll } from 'bun:test'
import { initDb, isEmoteOptedOut, emoteOptedOutAmong } from './db'
import { handleEmoteOptOut, OPTED_OUT_LINE, OPTED_IN_LINE } from './emote-optout'

beforeAll(() => initDb(':memory:'))

describe('handleEmoteOptOut', () => {
  it.each([
    'I wish to opt out from non-consensual lick. Thank you for respecting my autonomy. :)',
    'opt me out of the lick bit',
    'please stop licking me',
    "don't tag me",
    'can i opt-out of emote walls',
  ])('opts out: %s', (q) => {
    expect(handleEmoteOptOut(q, 'galeru')).toBe(OPTED_OUT_LINE)
    expect(isEmoteOptedOut('galeru')).toBe(true)
    expect(isEmoteOptedOut('@Galeru')).toBe(true)
  })

  it('opts back in', () => {
    handleEmoteOptOut('opt me out of the lick bit', 'galeru')
    expect(handleEmoteOptOut('opt me back in', 'galeru')).toBe(OPTED_IN_LINE)
    expect(isEmoteOptedOut('galeru')).toBe(false)
  })

  it.each([
    'why are you constantly licking wollip without their consent?',
    'how do i opt out of data collection',
    'LICK wollip',
    'stop spamming the chat',
    'what does opt in mean',
  ])('not an opt-out: %s', (q) => expect(handleEmoteOptOut(q, 'someone')).toBeNull())

  it('finds opted-out names among an ask\'s words', () => {
    handleEmoteOptOut('opt me out of licks', 'wollip')
    expect(emoteOptedOutAmong(['LICK', 'Wollip', 'please'])).toEqual(['wollip'])
  })
})
