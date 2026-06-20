import { describe, expect, it } from 'bun:test'
import { lookupKeywords, DEFINITIONAL_INTENT, GLOSSARY } from './glossary'

describe('glossary — authoritative keyword definitions', () => {
  it('returns the Flying rule for a flying query (the bug that got the bot called out)', () => {
    const hits = lookupKeywords('does flying give items a bonus')
    expect(hits.length).toBe(1)
    expect(hits[0]).toStartWith('Flying:')
    // the exact lie the bot told must be explicitly contradicted by the def
    expect(hits[0]).toContain('Freeze and Slow for half')
    expect(hits[0].toLowerCase()).toContain('grants no')
  })

  it('matches base keywords and common inflections', () => {
    expect(lookupKeywords('what does poison do')[0]).toStartWith('Poison:')
    expect(lookupKeywords('how does burning work')[0]).toStartWith('Burn:')
    expect(lookupKeywords('frozen')[0]).toStartWith('Freeze:')
    expect(lookupKeywords('regeneration')[0]).toStartWith('Regen:')
    expect(lookupKeywords('crits')[0]).toStartWith('Crit:')
  })

  it('returns nothing for a query with no glossary keyword', () => {
    expect(lookupKeywords('are aquatic items good for vanessa')).toEqual([])
    expect(lookupKeywords('what is the best hero')).toEqual([])
  })

  it('omits non-keywords so the gate refuses them instead of guessing', () => {
    expect(GLOSSARY.lethal).toBeUndefined()
    expect(GLOSSARY.value).toBeUndefined()
    expect(lookupKeywords('what does lethal do')).toEqual([])
  })

  it('dedupes by canonical and caps the number of hits', () => {
    const hits = lookupKeywords('what does poison burn freeze slow haste shield do', 4)
    expect(hits.length).toBe(4)
    // no canonical appears twice
    const labels = hits.map((h) => h.split(':')[0])
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('every definition is one line and free of invented stat numbers', () => {
    for (const [k, def] of Object.entries(GLOSSARY)) {
      expect(def).not.toContain('\n')
      expect(def.length).toBeGreaterThan(10)
      // no "+NN" style fabricated buff numbers — defs describe rules, not made-up values
      expect(def).not.toMatch(/\+\d/)
      expect(k).toBe(k.toLowerCase())
    }
  })

  describe('DEFINITIONAL_INTENT', () => {
    it('matches definitional asks', () => {
      for (const q of ['what does flying do', 'how does poison work', 'explain crit', 'define haste']) {
        expect(DEFINITIONAL_INTENT.test(q)).toBe(true)
      }
    })
    it('does not match build/list requests', () => {
      for (const q of ['best damage build for vanessa', 'vanessa damage items', 'crit tier list']) {
        expect(DEFINITIONAL_INTENT.test(q)).toBe(false)
      }
    })
  })
})
