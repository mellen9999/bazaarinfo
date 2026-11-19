import { describe, expect, it } from 'bun:test'
import { getGrNewsLine, __setGrNewsForTest } from './guildrun-news'

describe('getGrNewsLine', () => {
  it('renders newest-first with an explicit source label', () => {
    __setGrNewsForTest([{ title: 'Patch 0.5.5', date: 'Aug 19', iso: '', summary: 'stun resistance' }])
    const line = getGrNewsLine()
    expect(line).toContain('official news (steam')
    expect(line).toContain('Patch 0.5.5 (Aug 19): stun resistance')
  })
})
