import { describe, expect, it } from 'bun:test'

// the new scraper is a single fetch — no pure-logic helpers to unit test
// integration tests would require mocking fetch against dump.json
// keep this file as a placeholder for future tests

describe('scrapeDump', () => {
  it('exports scrapeDump function', async () => {
    const { scrapeDump } = await import('./scraper')
    expect(typeof scrapeDump).toBe('function')
  })
})
