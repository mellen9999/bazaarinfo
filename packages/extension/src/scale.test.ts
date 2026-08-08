import { describe, it, expect } from 'bun:test'
import { uiScale, fitScale, UI_REFERENCE_HEIGHT } from './scale'

describe('uiScale', () => {
  it('is exactly 1 at the reference height', () => {
    expect(uiScale(UI_REFERENCE_HEIGHT)).toBe(1)
  })

  it('never shrinks below 1, however short the player', () => {
    // the standard 1920-desktop channel player is ~672 tall — it must render
    // exactly as it always has, not 7% smaller
    expect(uiScale(672)).toBe(1)
    expect(uiScale(200)).toBe(1)
    expect(uiScale(1)).toBe(1)
  })

  it('grows with the video', () => {
    expect(uiScale(1080)).toBeCloseTo(1.5, 5)
    expect(uiScale(900)).toBeCloseTo(1.25, 5)
  })

  it('caps so a huge screen never turns the tooltip into a wall', () => {
    expect(uiScale(1440)).toBe(1.75)
    expect(uiScale(2160)).toBe(1.75)
    expect(uiScale(10_000)).toBe(1.75)
  })

  it('falls back to 1 on a nonsense height rather than collapsing the ui', () => {
    expect(uiScale(0)).toBe(1)
    expect(uiScale(-500)).toBe(1)
    expect(uiScale(NaN)).toBe(1)
    expect(uiScale(Infinity)).toBe(1)
    expect(uiScale(undefined as unknown as number)).toBe(1)
  })
})

describe('fitScale', () => {
  it('leaves content that already fits untouched', () => {
    expect(fitScale(1, 300, 600)).toBe(1)
    expect(fitScale(1.5, 600, 600)).toBe(1.5)
  })

  it('shrinks just enough to fit, never further', () => {
    expect(fitScale(1, 400, 360)).toBeCloseTo(0.9, 5)
    expect(fitScale(1, 500, 400)).toBeCloseTo(0.8, 5)
    // a 400px-tall frame with the tallest real card in it
    expect(fitScale(1, 407, 380)).toBeCloseTo(0.9337, 3)
  })

  it('scales the base, so a big video still shows bigger text when it shrinks', () => {
    expect(fitScale(1.5, 800, 600)).toBeCloseTo(1.125, 5)
  })

  it('floors so an absurd frame cannot shrink text to nothing', () => {
    expect(fitScale(1, 10_000, 100)).toBe(0.7)
  })

  it('keeps the base on nonsense measurements instead of guessing', () => {
    expect(fitScale(1.25, 0, 600)).toBe(1.25)
    expect(fitScale(1.25, NaN, 600)).toBe(1.25)
    expect(fitScale(1.25, 800, 0)).toBe(1.25)
    expect(fitScale(1.25, 800, NaN)).toBe(1.25)
    expect(fitScale(NaN, 800, 600)).toBe(1)
  })

  it('the tallest real card fits every realistic desktop player at scale 1', () => {
    // measured in the harness across all 1796 cards: 407px is the worst case
    const TALLEST_CARD = 407
    // 1366-wide laptop → ~478 tall player; 1280-wide → ~450
    expect(fitScale(1, TALLEST_CARD, 470)).toBe(1)
    expect(fitScale(1, TALLEST_CARD, 442)).toBe(1)
  })
})
