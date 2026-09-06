import { describe, expect, it } from 'bun:test'
import { isNullFact, stripNoBotCommitments, isSlopMemo, trimMemoPrefix } from './ai-background'

describe('isNullFact', () => {
  it('drops the extractor\'s "nothing to extract" answer in every observed shape', () => {
    expect(isNullFact('No facts to extract.')).toBe(true)
    expect(isNullFact('No facts about X found in the provided text.')).toBe(true)
    expect(isNullFact('There are no facts to extract.')).toBe(true)
    expect(isNullFact('No facts extracted.')).toBe(true)
    expect(isNullFact('Output: (nothing to extract)')).toBe(true)
    expect(isNullFact('Output: *(nothing to extract)*')).toBe(true)
  })

  // the second family, seen in prod after the first prune: haiku narrating the task
  it('drops the extractor talking about the task instead of the person', () => {
    for (const s of [
      '1. The user never identifies themselves as "mellen"',
      '2. The bot response does not mention askittlez',
      '# Facts about iloveice987',
      "To extract facts about a person, I'd need",
      'To complete this task, I would need:',
      'Since no facts about the user were stated',
      '0 facts extracted.',
      'An explicit request from nevekk87 to remember some',
    ]) expect(isNullFact(s)).toBe(true)
  })

  it('keeps real facts, first-person ones included', () => {
    expect(isNullFact('favorite item is tour bus')).toBe(false)
    expect(isNullFact("doesn't play bazaar")).toBe(false)
    expect(isNullFact('i got 30k gems')).toBe(false)
    expect(isNullFact('i feel very canadian today')).toBe(false)
    expect(isNullFact('has 2 cats')).toBe(false)
  })
})

describe('stripNoBotCommitments', () => {
  it('strips the echoed instruction sentence', () => {
    expect(stripNoBotCommitments('chat argued about tier 4 boards. No bot commitments made.'))
      .toBe('chat argued about tier 4 boards.')
    expect(stripNoBotCommitments('quiet stream, some banter about vanessa. No bot commitments.'))
      .toBe('quiet stream, some banter about vanessa.')
    expect(stripNoBotCommitments('kripp died to day 8 boss. bot made no commitments.'))
      .toBe('kripp died to day 8 boss.')
  })

  it('leaves an unrelated summary untouched', () => {
    const s = 'chat is hyped about the new season, bot agreed to track the winrate thread.'
    expect(stripNoBotCommitments(s)).toBe(s)
  })
})

describe('isSlopMemo', () => {
  it('flags HR-blurb personality adjectives', () => {
    expect(isSlopMemo('Playful chaos agent who loves gaming deep-dives and Kripp lore, speaks in delightful code-switches')).toBe(true)
    expect(isSlopMemo('Witty conversationalist who loves dissecting game lore')).toBe(true)
  })

  it('flags an em-dash', () => {
    expect(isSlopMemo('mains pyg — asks for tour bus stats a lot')).toBe(true)
  })

  it('keeps a concrete, observable memo', () => {
    expect(isSlopMemo('mains pyg, asks for tour bus stats a lot, runs the buh zar bit, sometimes writes in german')).toBe(false)
  })
})

describe('trimMemoPrefix', () => {
  it('drops the "User" subject line the prompt bans, keeps the note', () => {
    expect(trimMemoPrefix('User asks about game seasons and new classes; plays with coaoaba')).toBe('asks about game seasons and new classes; plays with coaoaba')
    expect(trimMemoPrefix('User zanderwill: Makes jokes about eating cars when hungry')).toBe('makes jokes about eating cars when hungry')
    expect(trimMemoPrefix('The user eats whatever is available')).toBe('eats whatever is available')
  })
  it('leaves a memo that already reads like a note alone', () => {
    expect(trimMemoPrefix('mains pyg, asks for tour bus stats a lot')).toBe('mains pyg, asks for tour bus stats a lot')
    expect(trimMemoPrefix('uses the LICK emote for efficiency')).toBe('uses the LICK emote for efficiency')
    expect(trimMemoPrefix('')).toBe('')
  })
})
