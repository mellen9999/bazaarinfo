import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const css = readFileSync(join(import.meta.dir, 'style.css'), 'utf8')

// The overlay and the panel share one stylesheet and one #root, but they want
// opposite things from the pointer: the overlay must let every click through to
// the video, the panel is the click target. Getting this backwards is silent —
// nothing errors, the panel just stops responding to the mouse — so it is pinned
// here rather than left to be noticed by a viewer.
describe('pointer-events split between overlay and panel', () => {
  it('the shared root stays click-through for the video overlay', () => {
    expect(/#root\s*\{[^}]*pointer-events:\s*none/.test(css)).toBe(true)
  })

  it('the panel takes the pointer back, or its search box is dead', () => {
    const rule = /body\[data-twitch-mode="panel"\]\s*#root\s*\{[^}]*pointer-events:\s*auto/
    expect(rule.test(css)).toBe(true)
  })

  it('the panel root is not position:fixed, or long cards cannot scroll', () => {
    const rule = /body\[data-twitch-mode="panel"\]\s*#root\s*\{[^}]*position:\s*static/
    expect(rule.test(css)).toBe(true)
  })
})

// The overlay search is the one place the click-through overlay takes the pointer
// back. If it ever leaks — a wrapper, a full-size layer, a zone-sized hit area — the
// stream's video stops receiving clicks, silently. So: exactly these two selectors
// may opt in, and the button must stay a small square.
describe('overlay search pointer-events', () => {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = [...bare.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ sel: m[1].trim().replace(/\s+/g, ' '), body: m[2] }))
  const rule = (sel: string) => rules.find((r) => r.sel === sel)?.body ?? ''

  it('only the button and the open surface take the pointer back', () => {
    const optIn = rules
      .filter((r) => /pointer-events:\s*auto/.test(r.body) && !r.sel.includes('data-twitch-mode'))
      .map((r) => r.sel.replace(/\s+/g, ' '))
    expect(optIn).toEqual(['.search-btn, .search-surface'])
  })

  it('the shared root is still click-through while the search exists', () => {
    expect(/#root\s*\{[^}]*pointer-events:\s*none/.test(css)).toBe(true)
  })

  it('the button is a square sized by one variable', () => {
    const body = rule('.search-btn')
    expect(/width:\s*var\(--btn\)/.test(body)).toBe(true)
    expect(/height:\s*var\(--btn\)/.test(body)).toBe(true)
    expect(/align-items:\s*center/.test(body) && /justify-content:\s*center/.test(body)).toBe(true)
  })

  it('inverts on hover and while open, like every other control', () => {
    const body = rule(".search-btn:hover, .search-btn:focus-visible, .search-btn[aria-expanded='true']")
    expect(/background:\s*#fff/.test(body) && /color:\s*#000/.test(body)).toBe(true)
  })

  it('has no fixed px max-height, which would clip a tall card off a short frame', () => {
    expect(/max-height:\s*calc\(100% - /.test(rule('.search-surface'))).toBe(true)
    expect(/max-height:\s*\d+px/.test(rule('.search-surface'))).toBe(false)
  })

  it('is square and still: no rounding, shadow or motion in the search styles', () => {
    const block = css.slice(css.indexOf('/* ── Overlay search'), css.indexOf('/* ── Accessibility'))
    expect(/border-radius|box-shadow|transition|animation|gradient/.test(block)).toBe(false)
  })
})

describe('tooltip sizing', () => {
  it('scales with the video instead of hardcoding one size', () => {
    expect(/font-size:\s*calc\(14px \* var\(--s\)\)/.test(css)).toBe(true)
    expect(/width:\s*min\(calc\(310px \* var\(--ui, 1\)\)/.test(css)).toBe(true)
  })

  it('has no fixed max-height, which used to clip 40 cards with no way to scroll', () => {
    const rule = css.slice(css.indexOf('.card-tooltip {'))
    const maxH = /max-height:\s*([^;]+);/.exec(rule)
    expect(maxH?.[1]).toBe('calc(100vh - 8px)')
  })
})
