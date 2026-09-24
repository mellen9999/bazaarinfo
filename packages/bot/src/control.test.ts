import { describe, expect, it } from 'bun:test'

import * as db from './db'

// the panel and chat share one action layer — a pause from the web must be the same
// pause chat sees, and nothing untrusted gets past parseAction.
db.initDb(':memory:')
;(await import('./raid/state')).setDb(db.getDb())
;(await import('./dungeon')).initDungeonDb()
const { act, parseAction, describe: say, snapshot, fmtMins, onControlChange } = await import('./control')
const { isSuppressed } = await import('./suppress')
const { isMuted, addDirective, listDirectives } = await import('./directives')

describe('control actions', () => {
  it('pause/resume land in the same suppress state chat reads', async () => {
    expect((await act('ctl', 'mod1', { kind: 'pause', feature: 'trivia', minutes: 30 }, false)).ok).toBe(true)
    expect(isSuppressed('ctl', 'trivia')).toBe(true)
    expect((await act('ctl', 'mod1', { kind: 'resume', feature: 'trivia' }, false)).ok).toBe(true)
    expect(isSuppressed('ctl', 'trivia')).toBe(false)
    expect((await act('ctl', 'mod1', { kind: 'resume', feature: 'trivia' }, false)).ok).toBe(false)
  })

  it('ignore bites through the chat mute gate', async () => {
    await act('ctl', 'mod1', { kind: 'ignore', user: 'baiter' }, false)
    expect(isMuted('ctl', 'baiter', true)).toBe(true)
    await act('ctl', 'mod1', { kind: 'unignore', user: 'baiter' }, false)
    expect(isMuted('ctl', 'baiter', true)).toBe(false)
  })

  it('drops a vibe by its listed number', async () => {
    addDirective('ctl', 'v', { instruction: 'talk like a pirate' })
    expect((await act('ctl', 'mod1', { kind: 'vibe-drop', index: 1 }, false)).ok).toBe(true)
    expect(listDirectives('ctl')).toHaveLength(0)
  })

  it('notifies listeners only on a real change', async () => {
    const seen: string[] = []
    const off = onControlChange((ch) => seen.push(ch))
    await act('ctl', 'mod1', { kind: 'vibe-clear' }, false) // nothing to clear → not ok
    await act('ctl', 'mod1', { kind: 'raid-pace', pace: 'slow' }, false)
    off()
    expect(seen).toEqual(['ctl'])
  })
})

describe('parseAction (untrusted input)', () => {
  it('accepts well-formed actions', () => {
    expect(parseAction({ kind: 'pause', feature: 'ai', minutes: 60 })).toEqual({ kind: 'pause', feature: 'ai', minutes: 60 })
    expect(parseAction({ kind: 'ignore', user: '@Troll' })).toEqual({ kind: 'ignore', user: 'troll' })
    expect(parseAction({ kind: 'join', target: '#SomeChan' })).toEqual({ kind: 'join', target: 'somechan' })
  })

  it('rejects junk, out-of-range and smuggled lines', () => {
    for (const bad of [
      null, 'pause', {}, { kind: 'nope' },
      { kind: 'pause', feature: 'everything' },
      { kind: 'pause', feature: 'ai', minutes: 0 },
      { kind: 'pause', feature: 'ai', minutes: 1.5 },
      { kind: 'pause', feature: 'ai', minutes: 99999 },
      { kind: 'vibe-drop', index: '1' },
      { kind: 'say', text: 'hi\r\nPRIVMSG #x :pwned' },
      { kind: 'say', text: 'x'.repeat(451) },
      { kind: 'ignore', user: 'two words' },
      { kind: 'join', target: '../etc' },
      { kind: 'raid', on: 'yes' },
    ]) expect(parseAction(bad)).toBeNull()
  })

  it('previews read like a person wrote them', () => {
    expect(say({ kind: 'ignore', user: 'x', minutes: 1440 })).toBe('ignore @x for 1d')
    expect(say({ kind: 'ignore', user: 'x' })).toBe('ignore @x until lifted')
    expect([fmtMins(90), fmtMins(120), fmtMins(10080)]).toEqual(['90m', '2h', '7d'])
  })
})

describe('snapshot', () => {
  it('is json-safe and carries no trivia answer field', () => {
    const snap = snapshot('ctl')
    const json = JSON.stringify(snap)
    expect(json).not.toMatch(/"answer"|"accepted"/)
    expect(snap.raid.pace).toBe('slow')
  })
})
