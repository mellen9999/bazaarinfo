// bazaardb page facts reach the answers: where-from, quest, price, merchant pool,
// monster drops. cards without the facts must render exactly as before.
import { describe, it, expect, beforeAll } from 'bun:test'
import type { BazaarCard, CardCache, Monster } from '@bazaarinfo/shared'
import { initDb } from './db'
import { loadCache } from './store'
import { extractEntities, serializeCard, serializeMonster } from './ai-query'
import { buildGameContext } from './ai-build-game'
import { itemLookup } from './commands-lookup'

const card = (over: Partial<BazaarCard>): BazaarCard => ({
  Type: 'Item', Title: 'x', Size: 'Medium', BaseTier: 'Bronze', Tiers: ['Bronze'], Heroes: ['Vanessa'],
  Tags: [], HiddenTags: [], DisplayTags: [], Tooltips: [{ text: 'Deal 5 damage', type: 'Active' }],
  TooltipReplacements: {}, Enchantments: {}, Shortlink: '', ...over,
})
const PLAIN = card({ Title: 'Plainblade' })
const SOUL = card({ Title: 'Soultest Relic', Where: ['Awakened District'], Buy: 64, Sell: 32 })
const ATLAS = card({
  Title: 'Atlastest', Buy: { Silver: 8, Gold: 16 },
  Quests: [{ goal: 'Visit a Gold-tier Encounter', reward: 'When you sell this, get 2 Loot items' }],
})
const COLT = card({
  Type: 'EventEncounter', Title: 'Colt', Tags: ['EventEncounter', 'Merchant', 'Vanessa'], Tooltips: [],
  Pool: { heroes: ['Vanessa'], counts: { Vanessa: { Bronze: 13, Silver: 14, Gold: 5 } } },
})
const POL = card({ Type: 'EventEncounter', Title: 'Polmerchant', Tags: ['EventEncounter', 'Merchant'], Tooltips: [] })
const MOB = (title: string, meta: object): Monster => ({
  Type: 'CombatEncounter', Title: title, Size: 'Medium', Tags: [], DisplayTags: [], HiddenTags: [], Heroes: [], Shortlink: '',
  MonsterMetadata: { available: 'Day 1', day: 1, health: 100, board: [], skills: [], ...meta },
})

beforeAll(() => {
  initDb(':memory:')
  loadCache({
    items: [PLAIN, SOUL, ATLAS], skills: [], events: [COLT, POL],
    monsters: [MOB('Haunted Kimono', { skillDropChance: 0.25, avgDropGold: 1.25 }), MOB('Dropless Bandit', {})],
    fetchedAt: '',
  } as CardCache)
})

describe('ai context', () => {
  it('a card without facts serializes exactly as before (no trailing segments)', () => {
    expect(serializeCard(PLAIN)).toBe('Plainblade | Medium Item | Heroes: Vanessa | Tiers: B | Deal 5 damage')
  })
  it('where-from is labelled inferred; prices ride along; no odds %', () => {
    const line = serializeCard(SOUL)
    expect(line).toContain('also found: Awakened District (bazaardb inferred, not a full list)')
    expect(line).toContain('buy 64g, sell 32g')
    expect(line).not.toContain('%')
  })
  it('quest surfaces', () => {
    expect(serializeCard(ATLAS)).toContain('quest: Visit a Gold-tier Encounter -> When you sell this, get 2 Loot items')
  })
  it('monster drop stats appear only when the monster has them', () => {
    expect(serializeMonster(MOB('Haunted Kimono', { skillDropChance: 0.25, avgDropGold: 1.25 }))).toContain('25% skill drop, ~1.3g avg gold')
    expect(serializeMonster(MOB('Dropless Bandit', {}))).toBe('Dropless Bandit · Day 1 · 100HP')
  })
  it('"what does colt sell" resolves the merchant and injects its pool sizes', () => {
    const e = extractEntities('what does colt sell')
    expect(e.events?.map((x) => x.Title)).toEqual(['Colt'])
    expect(e.isGame).toBe(true)
    expect(buildGameContext(e)).toContain('Colt (merchant) pool size by hero and tier: Vanessa 13B/14S/5G')
  })
  it('a merchant with no pool is not injected', () => {
    expect(extractEntities('what does polmerchant sell').events).toBeUndefined()
  })
  it('"chances to get soultest relic" grounds the card', () => {
    expect(buildGameContext(extractEntities('chances to get soultest relic'))).toContain('found: Awakened District')
  })
})

describe('chat lookup', () => {
  const ctx = { user: 'tester', channel: 'test', privileged: false, isMod: false } as any
  it('a plain lookup is unchanged; a quest ask adds the quest', async () => {
    const plain = await itemLookup('atlastest', ctx, '')
    const asked = await itemLookup('atlastest quest', ctx, '')
    expect(plain).not.toContain('quest:')
    expect(asked).toContain('quest: Visit a Gold-tier Encounter')
  })
  it('a bare monster lookup carries no drop stats (a drop ask goes to the AI path, tested above)', async () => {
    expect(await itemLookup('haunted kimono', ctx, '')).not.toContain('skill drop')
  })
  it('the merchant name returns its pool', async () => {
    expect(await itemLookup('colt', ctx, '')).toContain('pool size by hero and tier')
  })
})
