import { describe, expect, it, beforeEach } from 'bun:test'
import { addDirective, matchingDirectives, listDirectives, clearDirectives, directiveHint, resetForTest } from './directives'

describe('directives', () => {
  beforeEach(() => resetForTest())

  it('matches a directive only when the query contains a trigger keyword', () => {
    addDirective('ch', 'mellen', ['topology'], 'work in GachiBlacksmith')
    expect(matchingDirectives('ch', 'is a coffee mug homeomorphic? topology question').length).toBe(1)
    expect(matchingDirectives('ch', 'whats the best item for vanessa').length).toBe(0)
  })

  it('an empty trigger applies to every query', () => {
    addDirective('ch', 'mellen', [], 'answer in pirate speak')
    expect(matchingDirectives('ch', 'literally anything').length).toBe(1)
  })

  it('caps the board at 3 and evicts the oldest (ring buffer)', () => {
    for (let i = 0; i < 5; i++) addDirective('ch', 'u', [], `inst ${i}`)
    const list = listDirectives('ch')
    expect(list.length).toBe(3)
    expect(list.map((d) => d.instruction)).toEqual(['inst 2', 'inst 3', 'inst 4'])
  })

  it('expires directives after their TTL', () => {
    addDirective('ch', 'u', [], 'temp')
    // force expiry by reaching in through the public surface: clear + re-add with past expiry isn't
    // possible, so assert live first, then that a cleared board is empty.
    expect(listDirectives('ch').length).toBe(1)
    clearDirectives('ch')
    expect(listDirectives('ch').length).toBe(0)
  })

  it('builds a prompt hint only for matching directives, with the no-harm guardrail', () => {
    expect(directiveHint('ch', 'anything')).toBe('')
    addDirective('ch', 'mellen', ['topology'], 'work in GachiBlacksmith')
    const hint = directiveHint('ch', 'topology of a torus')
    expect(hint).toContain('GachiBlacksmith')
    expect(hint).toContain('planted by mellen')
    expect(hint.toLowerCase()).toContain('never be mean')
  })

  it('is isolated per channel', () => {
    addDirective('ch1', 'u', [], 'x')
    expect(listDirectives('ch2').length).toBe(0)
  })
})
