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
