import { describe, expect, test } from 'bun:test'
import { pastedImageUrl, droppedImageUrl } from './calibrate'

describe('pastedImageUrl', () => {
  test('accepts a plain https link', () => {
    expect(pastedImageUrl('https://i.imgur.com/abc.png')).toBe('https://i.imgur.com/abc.png')
  })

  test('trims surrounding whitespace', () => {
    expect(pastedImageUrl('  https://cdn.example.com/shot.jpg\n')).toBe('https://cdn.example.com/shot.jpg')
  })

  test('rejects http', () => {
    expect(pastedImageUrl('http://example.com/a.png')).toBeNull()
  })

  test('rejects data: and javascript: schemes', () => {
    expect(pastedImageUrl('data:image/png;base64,AAAA')).toBeNull()
    expect(pastedImageUrl('javascript:alert(1)')).toBeNull()
  })

  test('rejects file: and blob: schemes', () => {
    expect(pastedImageUrl('file:///etc/passwd')).toBeNull()
    expect(pastedImageUrl('blob:https://twitch.tv/uuid')).toBeNull()
  })

  test('rejects non-URL text, empty, and interior whitespace', () => {
    expect(pastedImageUrl('just some words')).toBeNull()
    expect(pastedImageUrl('')).toBeNull()
    expect(pastedImageUrl(null)).toBeNull()
    expect(pastedImageUrl(undefined)).toBeNull()
  })

  test('rejects urls over 2048 chars', () => {
    expect(pastedImageUrl(`https://example.com/${'a'.repeat(2048)}`)).toBeNull()
  })

  test('rejects embedded quotes that could break the css url()', () => {
    // URL() escapes quotes to %22, so a survivor is inert in url("...")
    const out = pastedImageUrl('https://example.com/a"onload="x.png')
    expect(out === null || !out.includes('"')).toBe(true)
  })
})

describe('droppedImageUrl', () => {
  test('takes the first uri from a uri-list, skipping comments', () => {
    expect(droppedImageUrl('# dragged link\r\nhttps://example.com/a.png\nhttps://example.com/b.png', ''))
      .toBe('https://example.com/a.png')
  })

  test('falls back to text/plain when uri-list is empty', () => {
    expect(droppedImageUrl('', 'https://example.com/c.png')).toBe('https://example.com/c.png')
  })

  test('null when neither yields a safe https url', () => {
    expect(droppedImageUrl('', 'not a url')).toBeNull()
    expect(droppedImageUrl('# only comments', '')).toBeNull()
  })
})
