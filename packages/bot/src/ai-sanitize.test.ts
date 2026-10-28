import { describe, test, expect } from "bun:test"

describe('stripLeadingAskEcho', () => {
  const { stripLeadingAskEcho } = require('./ai-sanitize')
  test('drops the copied ask, keeps the add-on', () => {
    expect(stripLeadingAskEcho('@ennortix LICK wollip Madge LICK wollip', 'LICK wollip Madge')).toBe('@ennortix LICK wollip')
  })
  test('leaves normal replies and pure repeats alone', () => {
    expect(stripLeadingAskEcho('@a nice one', 'LICK wollip Madge')).toBe('@a nice one')
    expect(stripLeadingAskEcho('@a LICK wollip Madge', 'LICK wollip Madge')).toBe('@a LICK wollip Madge')
  })
})
