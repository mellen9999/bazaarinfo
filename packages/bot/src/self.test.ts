import { describe, expect, it } from 'bun:test'
import { isSelfQuery, selfContext, assertGroupsCoverSubs, RESERVED_SUBS } from './self'

describe('self-knowledge — the bot describes itself from the command table, not from memory', () => {
  it('every command named in the description is a real command', () => {
    // the whole point of deriving it: a renamed or deleted subcommand fails here rather
    // than shipping chat a feature that no longer exists
    expect(assertGroupsCoverSubs()).toEqual([])
  })

  it('recognises the ways chat asks about the bot', () => {
    for (const q of [
      'what can you do', 'what do you do', 'what are you', 'how do you work',
      'how does this bot work', 'who made you', 'who built this', 'your features',
      'what commands', 'whats new with you', 'what changed with you', 'did you get an update',
      'can you play trivia', 'are you an ai', 'are you a bot', 'your changelog',
    ]) expect(isSelfQuery(q)).toBe(true)
  })

  it('leaves the game\'s own "what\'s new" to the patch line', () => {
    // "what's new" without a self-referent is a question about The Bazaar, and hijacking
    // it would answer a patch question with a feature list
    for (const q of [
      "what's new", 'whats new in the game', 'is there a new event', 'any updates',
      'what changed this patch', 'pumpkin', 'who is vanessa', 'what can vanessa do',
    ]) expect(isSelfQuery(q)).toBe(false)
  })

  it('grounds a self question and stays silent on everything else', () => {
    expect(selfContext('pumpkin')).toBe('')
    const ctx = selfContext('what can you do')
    expect(ctx).toContain('never invent a feature')
    expect(ctx).toContain('trivia')
    expect(ctx).toContain('bazaardb.gg')
    // it must read as material to answer from, not a script to recite
    expect(ctx).toContain('Never recite this as a list')
  })

  it('answers "what\'s new with you" from real commit history', () => {
    const ctx = selfContext('whats new with you')
    // running from a git checkout, so there is history; and it must not be raw
    // conventional-commit noise by the time chat could see it
    expect(ctx).toContain('Shipped recently')
    const shipped = ctx.split('Shipped recently')[1] ?? ''
    expect(shipped).not.toMatch(/^- (?:feat|fix|chore|docs|refactor)(?:\([^)]*\))?:/m)
  })

  it('still owns the reserved-name list commands.ts checks against', () => {
    expect(RESERVED_SUBS.has('trivia')).toBe(true)
    expect(RESERVED_SUBS.has('overlay')).toBe(true)
    expect(RESERVED_SUBS.has('pumpkin')).toBe(false)
  })
})
