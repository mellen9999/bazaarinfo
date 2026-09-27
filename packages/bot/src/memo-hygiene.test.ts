import { describe, expect, it } from 'bun:test'
import { stripMetaTraits } from './memo-hygiene'

describe('stripMetaTraits — a memo never records how they treat the bot', () => {
  it('drops the clause that became the "take it up with past you" dunk', () => {
    expect(stripMetaTraits('favorite item: Proboscis; plays TBOI Repentance; disputes memo accuracy; debates PHP/JS syntax.'))
      .toBe('favorite item: Proboscis; plays TBOI Repentance; debates PHP/JS syntax.')
  })

  it('drops boundary-testing and repeat-to-catch-me clauses, restoring the full stop', () => {
    expect(stripMetaTraits('loves music videos (late 90s dreamy to current), AI love stories, repeats song requests to see if I\'ll catch it, checks me on legal jurisdiction nuances.'))
      .toBe('loves music videos (late 90s dreamy to current), AI love stories.')
  })

  it('returns an untouched memo byte-identical, commas in quotes included', () => {
    const m = 'calls things "unf," compares non-game things to Kripp\'s takes, runs Kripp casting bits.'
    expect(stripMetaTraits(m)).toBe(m)
  })

  it('keeps game talk that merely shares a word', () => {
    const m = 'associates "thumping" with repeated blows on a surface, plays Dooley.'
    expect(stripMetaTraits(m)).toBe(m)
  })

  it('returns empty when nothing but meta is left', () => {
    expect(stripMetaTraits('tests boundaries with absurdist humor and minimal prompts.')).toBe('')
  })
})
