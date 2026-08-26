import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { unlinkSync } from 'fs'
import { resolve } from 'path'
import { tmpdir } from 'os'

const db = await import('./db')
const { buildLoreDossier, contentTokens, isKnownChatter } = await import('./lore')

let dbPath: string

function cleanPath(p: string) {
  try { unlinkSync(p) } catch {}
  try { unlinkSync(p + '-wal') } catch {}
  try { unlinkSync(p + '-shm') } catch {}
}

// the real bit, trimmed: chat has posted this ~30 times since March.
const PASTA = 'trumpBirdge MANY PEOPLE ARE SAYING THAT mellen (NAMED AFTER A FRUIT?) IS WORKING WITH THE TRICKY-TIDOLAR CRIME FAMILY! SAD!! THEY SHOULD BOTH BE LOCKED UP IF YOU ASK ME'

function seedTidolarLore() {
  db.logChat('nl_kripp', 'tidolar', 'anyone else running boomerang')
  db.logChat('nl_kripp', 'alice', PASTA)
  db.logChat('nl_kripp', 'bob', PASTA.toUpperCase())
  db.logChat('nl_kripp', 'carol', PASTA.replace('mellen', 'M E L L E N'))
  db.logChat('nl_kripp', 'dave', "don't upset the tidolar crime family monkaS")
  db.logChat('nl_kripp', 'erin', 'how goes the investigation of the tidolar crime family')
  db.flushWrites()
}

describe('lore', () => {
  beforeEach(() => {
    dbPath = resolve(tmpdir(), `.bazaarinfo-lore-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    db.initDb(dbPath)
  })

  afterEach(() => {
    try { db.closeDb() } catch {}
    cleanPath(dbPath)
  })

  describe('contentTokens', () => {
    it('drops stopwords, short words, punctuation and duplicates', () => {
      expect(contentTokens('The tidolar crime family')).toEqual(['tidolar', 'crime', 'family'])
      expect(contentTokens('the, the! a of')).toEqual([])
      expect(contentTokens('tidolar TIDOLAR tidolar!')).toEqual(['tidolar'])
    })

    it('caps at six terms so the AND-chain stays sane', () => {
      expect(contentTokens('one two three four five six seven eight').length).toBe(6)
    })
  })

  describe('isKnownChatter', () => {
    it('accepts someone who just chatted here', () => {
      db.logChat('nl_kripp', 'tidolar', 'hello')
      db.flushWrites()
      expect(isKnownChatter('tidolar', 'nl_kripp')).toBe(true)
      expect(isKnownChatter('tidolar', 'other')).toBe(false)
    })

    it('rejects a name nobody here has used', () => {
      expect(isKnownChatter('nobody', 'nl_kripp')).toBe(false)
    })
  })

  describe('buildLoreDossier', () => {
    it('builds a dossier from what chat actually posted', () => {
      seedTidolarLore()
      const d = buildLoreDossier('The tidolar crime family', 'nl_kripp')
      expect(d).not.toBeNull()
      expect(d!.anchor).toBe('tidolar')
      expect(d!.text).toContain('MANY PEOPLE ARE SAYING')
      expect(d!.text).toContain("don't upset the tidolar crime family")
      // the footprint line is the evidence this is channel-native, not a coincidence
      expect(d!.text).toMatch(/footprint: chat has posted "tidolar" in \d+ messages from \d+ different chatters/)
    })

    it('merges caps/spacing variants of the same pasta into one repeat count', () => {
      seedTidolarLore()
      const d = buildLoreDossier('The tidolar crime family', 'nl_kripp')!
      // three surface forms of one pasta => one line, counted three times
      const pastaLines = d.text.split('\n').filter((l) => l.includes('MANY PEOPLE ARE SAYING') || l.includes('many people are saying'))
      expect(pastaLines.length).toBe(1)
      expect(pastaLines[0]).toContain('x3')
    })

    it('anchors on an emote as well as a chatter', () => {
      for (const u of ['alice', 'bob', 'carol']) {
        db.logChat('nl_kripp', u, 'the monkaS crime family strikes again in chat today')
      }
      db.logChat('nl_kripp', 'dave', 'nobody survives the monkaS crime family raid on chat')
      db.flushWrites()
      const d = buildLoreDossier('the monkaS crime family', 'nl_kripp')
      expect(d?.anchor).toBe('monkas')
    })

    it('returns null for a single-token topic (person/world paths own those)', () => {
      seedTidolarLore()
      expect(buildLoreDossier('tidolar', 'nl_kripp')).toBeNull()
    })

    it('returns null when no token is a chatter or emote', () => {
      for (const u of ['alice', 'bob', 'carol', 'dave']) {
        db.logChat('nl_kripp', u, 'the sopranos crime family is a great show honestly')
      }
      db.flushWrites()
      expect(buildLoreDossier('the sopranos crime family', 'nl_kripp')).toBeNull()
    })

    it('returns null when the anchor is known but the phrase has no footprint', () => {
      db.logChat('nl_kripp', 'tidolar', 'hello chat')
      db.flushWrites()
      expect(buildLoreDossier('the tidolar crime family', 'nl_kripp')).toBeNull()
    })

    it('ignores lore from a different channel', () => {
      seedTidolarLore()
      expect(buildLoreDossier('The tidolar crime family', 'rogue')).toBeNull()
    })

    it('skips command lines so an unanswered "!trivia X" is never the evidence', () => {
      db.logChat('nl_kripp', 'tidolar', 'hi')
      for (const u of ['alice', 'bob', 'carol', 'dave']) {
        db.logChat('nl_kripp', u, '!trivia the tidolar crime family please')
      }
      db.flushWrites()
      expect(buildLoreDossier('the tidolar crime family', 'nl_kripp')).toBeNull()
    })

    it('treats FTS operators in a topic as literal text', () => {
      seedTidolarLore()
      expect(() => buildLoreDossier('tidolar NOT crime OR family*', 'nl_kripp')).not.toThrow()
    })
  })
})
