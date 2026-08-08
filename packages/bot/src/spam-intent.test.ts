import { describe, it, expect, beforeAll } from 'bun:test'
import { addChannelEmote } from './emotes'
import { detectSpamIntent } from './spam-intent'

// register the 7TV emotes this suite aims — KEKW/Sadge are already known globals.
// findEmote is channel-agnostic, so registering anywhere is enough.
beforeAll(() => {
  for (const e of ['LICK', 'Crowge', 'ffzW', '67']) addChannelEmote('spamtest', e)
})

const CHATTERS = new Set(['mellen', 'wollip', 'tsukinami_'])
const isChatter = (n: string) => CHATTERS.has(n.toLowerCase())
const detect = (s: string) => detectSpamIntent(s, isChatter)

describe('detectSpamIntent', () => {
  it('walls a bare emote', () => {
    expect(detect('LICK')).toBe('LICK LICK LICK LICK LICK')
  })

  it('walls the leading-verb form', () => {
    expect(detect('spam KEKW')).toBe('KEKW KEKW KEKW KEKW KEKW')
    expect(detect('spam this KEKW')).toBe('KEKW KEKW KEKW KEKW KEKW')
  })

  it('walls the trailing-verb form', () => {
    expect(detect('67 spam')).toBe('67 67 67 67 67')
    expect(detect('the 67 spam')).toBe('67 67 67 67 67')
  })

  // the regression: an emote aimed at chat used to reach the AI, which refused the bit
  it('walls an emote aimed at an audience', () => {
    expect(detect('LICK anyone')).toBe('LICK LICK LICK LICK LICK')
    expect(detect('LICK everyone')).toBe('LICK LICK LICK LICK LICK')
    expect(detect('LICK random chatter')).toBe('LICK LICK LICK LICK LICK')
    expect(detect('LICK me')).toBe('LICK LICK LICK LICK LICK')
  })

  it('walls an emote aimed at a named chatter', () => {
    expect(detect('LICK mellen')).toBe('LICK LICK LICK LICK LICK')
    expect(detect('LICK @wollip')).toBe('LICK LICK LICK LICK LICK')
  })

  it('never echoes the target back', () => {
    expect(detect('LICK mellen')).not.toContain('mellen')
  })

  it('sees through request scaffolding', () => {
    expect(detect('can u LICK mellen')).toBe('LICK LICK LICK LICK LICK')
    expect(detect('just LICK wollip')).toBe('LICK LICK LICK LICK LICK')
    expect(detect('pls LICK wollip')).toBe('LICK LICK LICK LICK LICK')
    expect(detect('now LICK wollip')).toBe('LICK LICK LICK LICK LICK')
  })

  it('ignores trailing punctuation', () => {
    expect(detect('LICK ?')).toBe('LICK LICK LICK LICK LICK')
    expect(detect('LICK!')).toBe('LICK LICK LICK LICK LICK')
  })

  it('cycles multiple emotes up to the 5 cap', () => {
    expect(detect('LICK ffzW')).toBe('LICK ffzW LICK ffzW LICK')
    expect(detect('spam KEKW Sadge')).toBe('KEKW Sadge KEKW Sadge KEKW')
  })

  it('dedupes repeats before cycling', () => {
    expect(detect('spam LICK LICK LICK')).toBe('LICK LICK LICK LICK LICK')
  })

  // --- must NOT fire ---

  it('leaves questions about an emote to the AI', () => {
    expect(detect('what does LICK mean')).toBeNull()
    expect(detect('is LICK a 7tv emote')).toBeNull()
    expect(detect('who added LICK')).toBeNull()
  })

  it('leaves complaints alone', () => {
    expect(detect('stop the 67 spam')).toBeNull()
    expect(detect("so u don't want LICK anyone")).toBeNull()
  })

  it('leaves creative/modified asks to the AI', () => {
    expect(detect('LICK tsukinami_ respectfully back')).toBeNull()
    expect(detect('lick a random chatter. Wildly')).toBeNull()
    expect(detect('Crowge lets cleanse the chat with LICK 5 times KEKW')).toBeNull()
  })

  it('requires a target to be an audience word or a real chatter', () => {
    expect(detect('LICK respectfully')).toBeNull()
    expect(detect('LICK nosuchperson')).toBeNull()
  })

  it('requires the payload to lead', () => {
    expect(detect('roast someone with LICK')).toBeNull()
  })

  it('answers nothing for prose with no emote', () => {
    expect(detect('hello there')).toBeNull()
    expect(detect('')).toBeNull()
    expect(detect('spam something')).toBeNull()
  })

  it('does not wall a question hidden in the leading form', () => {
    expect(detect('spam KEKW and tell me whats the meta')).toBeNull()
  })
})
