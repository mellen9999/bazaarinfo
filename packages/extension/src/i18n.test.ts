import { describe, it, expect } from 'bun:test'
import type { BazaarCard } from '@bazaarinfo/shared/src/types'
import { resolveTooltipParts } from '@bazaarinfo/shared/src/format'
import { buildIndex, searchCards, type SearchCard } from '@bazaarinfo/shared/src/search'
import { ENGLISH, makeI18n, resolveLang } from './i18n'
import { filterLabel, filterName } from './card-filters'

const AVAILABLE = ['de', 'es', 'fr', 'it', 'ko', 'pt', 'th', 'tr', 'zh']

describe('resolveLang', () => {
  it('takes the two-letter base of region variants', () => {
    expect(resolveLang('fr', AVAILABLE)).toBe('fr')
    expect(resolveLang('pt-br', AVAILABLE)).toBe('pt')
    expect(resolveLang('zh-cn', AVAILABLE)).toBe('zh')
    expect(resolveLang('DE_AT', AVAILABLE)).toBe('de')
  })
  it('is English (null) for English, unknown, missing or not-offered', () => {
    expect(resolveLang('en', AVAILABLE)).toBeNull()
    expect(resolveLang('en-gb', AVAILABLE)).toBeNull()
    expect(resolveLang('xx', AVAILABLE)).toBeNull()
    expect(resolveLang(undefined, AVAILABLE)).toBeNull()
    expect(resolveLang('', AVAILABLE)).toBeNull()
    expect(resolveLang('fr', [])).toBeNull()
  })
})

describe('t()', () => {
  const fr = makeI18n('fr', { Burn: 'Brûlure', Small: 'Petit', Gold: 'Or' })
  it('translates what the map has and returns English for a miss', () => {
    expect(fr.t('Burn')).toBe('Brûlure')
    expect(fr.t('Unmapped thing')).toBe('Unmapped thing')
  })
  it('does not trip on inherited object keys', () => {
    expect(fr.t('constructor')).toBe('constructor')
    expect(fr.has('toString')).toBe(false)
  })
  it('English is the identity', () => {
    expect(ENGLISH.t('Burn')).toBe('Burn')
    expect(ENGLISH.word('Gold')).toBe('gold')
  })
  it('lowercases in the language, and leaves caseless scripts alone', () => {
    expect(fr.word('Gold')).toBe('or')
    expect(makeI18n('tr', { Gold: 'ALTIN' }).word('Gold')).toBe('altın')
    expect(makeI18n('zh', { Gold: '黄金' }).word('Gold')).toBe('黄金')
  })
})

describe('translate before template', () => {
  it('keeps placeholders so ladders still substitute into the translated sentence', () => {
    const zh = makeI18n('zh', { 'Deal {ability.0} Damage': '造成{ability.0}伤害' })
    const parts = resolveTooltipParts(zh.t('Deal {ability.0} Damage'), { '{ability.0}': { Bronze: 5, Silver: 10 } })
    expect(parts.map((p) => p.t)).toEqual(['text', 'ladder', 'text'])
    expect(parts[0]).toEqual({ t: 'text', s: '造成' })
    expect(parts[2]).toEqual({ t: 'text', s: '伤害' })
  })
})

describe('keyword aliasing per script', () => {
  const kws = (i18n: ReturnType<typeof makeI18n>, s: string) =>
    i18n.tokenize(s).filter((x) => typeof x !== 'string').map((x) => (x as { kw: string; text: string }))

  it('fr: whole-word, case-insensitive, accent-safe', () => {
    const fr = makeI18n('fr', { Burn: 'Brûlure', Freeze: 'Gelé', Damage: 'Dégâts' })
    expect(kws(fr, 'Inflige 5 Brûlure et brûlure')).toEqual([
      { kw: 'burn', text: 'Brûlure' }, { kw: 'burn', text: 'brûlure' },
    ])
    expect(kws(fr, 'Gelé')).toEqual([{ kw: 'freeze', text: 'Gelé' }])
    // not inside a longer word
    expect(kws(fr, 'Brûlures')).toEqual([])
    expect(kws(fr, 'Surgelé')).toEqual([])
  })
  it('keeps English forms styled when the tooltip itself was a miss', () => {
    const fr = makeI18n('fr', { Burn: 'Brûlure' })
    expect(kws(fr, 'Deal Damage and Burn')).toEqual([{ kw: 'damage', text: 'Damage' }, { kw: 'burn', text: 'Burn' }])
  })
  it('zh: substring match, longest term first', () => {
    const zh = makeI18n('zh', { Burn: '灼烧', Poison: '剧毒', Heal: '治疗', Regen: '持续治疗' })
    expect(kws(zh, '造成5灼烧，获得持续治疗和剧毒')).toEqual([
      { kw: 'burn', text: '灼烧' }, { kw: 'regen', text: '持续治疗' }, { kw: 'poison', text: '剧毒' },
    ])
  })
  it('th: substring match inside unspaced text', () => {
    const th = makeI18n('th', { Poison: 'พิษ', Damage: 'ดาเมจ' })
    expect(kws(th, 'ไอเทมพิษชิ้นซ้ายสุดได้รับดาเมจ')).toEqual([
      { kw: 'poison', text: 'พิษ' }, { kw: 'damage', text: 'ดาเมจ' },
    ])
  })
  it('a keyword the game has no word for is just not styled in that language', () => {
    const ko = makeI18n('ko', { Burn: '연소' })
    expect(kws(ko, '연소 and 독')).toEqual([{ kw: 'burn', text: '연소' }])
  })
  it('English tokenising is unchanged', () => {
    expect(kws(ENGLISH, 'Frozen Heal Healthy')).toEqual([{ kw: 'freeze', text: 'Frozen' }, { kw: 'heal', text: 'Heal' }])
  })
})

describe('search matches both languages', () => {
  const base = { Type: 'Item', Size: 'Small', BaseTier: 'Bronze', Tiers: ['Bronze'], Heroes: [], Tags: [], HiddenTags: [], DisplayTags: [], Tooltips: [], TooltipReplacements: {}, Enchantments: {}, Shortlink: '' } as const
  const cards: BazaarCard[] = [{ ...base, Title: 'Bar of Gold' }, { ...base, Title: 'Cutlass' }]
  const fr = makeI18n('fr', { 'Bar of Gold': "Barre d'or", Cutlass: 'Sabre' })
  const local = buildIndex(cards.map((c): SearchCard => ({ ...c, TitleLocal: fr.t(c.Title) })), true)

  it('finds by the translated title', () => {
    expect(searchCards(local, 'sabre')[0].item.Title).toBe('Cutlass')
  })
  it('still finds by the English title', () => {
    expect(searchCards(local, 'cutlass')[0].item.Title).toBe('Cutlass')
  })
})

describe('filter words', () => {
  const fr = makeI18n('fr', { Small: 'Petit', Size: 'Taille' })
  it('shows the game word when it has one, ours when not', () => {
    expect(filterLabel('size', 'Small', fr)).toBe('petit')
    expect(filterName('size', fr)).toBe('taille')
    expect(filterName('hero', fr)).toBe('hero')
    expect(filterLabel('hero', 'Common', fr)).toBe('neutral')
  })
})
