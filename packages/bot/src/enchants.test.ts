import { describe, it, expect } from 'bun:test'
import { enchantAnswer, ENCHANTS } from './enchants'

describe('enchantAnswer — generic enchant definitions', () => {
  it('answers a definitional ask', () => {
    expect(enchantAnswer('what does fiery do')).toStartWith('Fiery:')
    expect(enchantAnswer('what does obsidian do')).toStartWith('Obsidian:')
    expect(enchantAnswer('what is the radiant enchant')).toStartWith('Radiant:')
  })
  it('answers a bare enchant name', () => {
    expect(enchantAnswer('golden')).toStartWith('Golden:')
    expect(enchantAnswer('mossy')).toStartWith('Mossy:')
  })
  it('answers an explicit "<name> enchant" ask', () => {
    expect(enchantAnswer('deadly enchantment')).toStartWith('Deadly:')
    expect(enchantAnswer('turbo enchant')).toStartWith('Turbo:')
  })
  it('handles a comparison', () => {
    const a = enchantAnswer('fiery vs toxic')
    expect(a).toContain('Fiery:')
    expect(a).toContain('Toxic:')
  })

  // anti-hijack: an enchant word + an item word is an item lookup, not a definition
  it('does NOT steal item+enchant lookups', () => {
    expect(enchantAnswer('fiery boomerang')).toBeNull()
    expect(enchantAnswer('golden dagger')).toBeNull()
    expect(enchantAnswer('i love fiery pans')).toBeNull()
  })
  it('does NOT fire on build/list asks', () => {
    expect(enchantAnswer('best fiery item')).toBeNull()
    expect(enchantAnswer('fiery build')).toBeNull()
    expect(enchantAnswer('good toxic items')).toBeNull()
  })
  // overlap guard: "shielded" is also a mechanic keyword -> glossary unless explicit
  it('yields "shielded" to the glossary unless "enchant" is stated', () => {
    expect(enchantAnswer('shielded')).toBeNull()
    expect(enchantAnswer('what does shielded do')).toBeNull()
    expect(enchantAnswer('shielded enchant')).toStartWith('Shielded:')
  })
  it('returns null for non-enchant queries', () => {
    expect(enchantAnswer('vanessa')).toBeNull()
    expect(enchantAnswer('what does burn do')).toBeNull()
    expect(enchantAnswer('')).toBeNull()
  })
  it('every enchant answer stays under the twitch limit', () => {
    // explicit "<name> enchant" form so the "shielded" overlap guard doesn't null out
    for (const name of Object.keys(ENCHANTS)) {
      const a = enchantAnswer(`${name} enchant`)
      expect(a).not.toBeNull()
      expect(a!.length).toBeLessThanOrEqual(480)
    }
  })
})
