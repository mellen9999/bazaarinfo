// plain-english odds asks find the item inside the sentence; everything else stays untouched.
import { describe, it, expect, beforeAll } from 'bun:test'
import type { BazaarCard, CardCache } from '@bazaarinfo/shared'
import { initDb } from './db'
import { loadCache } from './store'
import { itemInSentence, naturalOddsReply } from './commands-lookup'

const card = (title: string): BazaarCard => ({
  Type: 'Item', Title: title, Size: 'Medium', BaseTier: 'Bronze', Tiers: ['Bronze'], Heroes: ['Vanessa'],
  Tags: [], HiddenTags: [], DisplayTags: [], Tooltips: [{ text: 'Deal 5 damage', type: 'Active' }],
  TooltipReplacements: {}, Enchantments: {}, Shortlink: '',
})

beforeAll(() => {
  initDb(':memory:')
  loadCache({ items: [card('Airplane Glue'), card('Glue'), card('Cutlass')], skills: [], events: [], monsters: [], fetchedAt: '' } as CardCache)
})

describe('itemInSentence', () => {
  it('finds the longest exact title inside a sentence', () => {
    expect(itemInSentence('whats the chance i see airplane glue in a shop')?.Title).toBe('Airplane Glue')
    expect(itemInSentence('how likely is cutlass to show up?')?.Title).toBe('Cutlass')
  })
  it('no item, no match', () => {
    expect(itemInSentence('what tier are shops on day 5')).toBeUndefined()
    expect(itemInSentence('is it a good day')).toBeUndefined()
  })
})

describe('naturalOddsReply', () => {
  it('stays out of the way without the key or an odds word', async () => {
    delete process.env.BAZAARDB_KEY
    expect(await naturalOddsReply('whats the chance i see airplane glue in a shop', '')).toBeNull()
    expect(await naturalOddsReply('airplane glue is great', '')).toBeNull()
  })
})
