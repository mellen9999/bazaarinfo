import { describe, expect, it } from 'bun:test'
import { parsePatchHtml } from './patch'

// representative fixture trimmed from actual bazaardb.gg/patchnotes HTML
// (fetched with BazaarInfo/1.0 UA — Cloudflare only challenges browser path)
// structure: <a href="/patchnotes/SLUG"><div><div>
//   <span font-weight:bold>TITLE</span>
//   <span secondary>SIZE<!-- --> <!-- -->- <!-- -->DATE</span>
// </div></div></a>
const FIXTURE_NORMAL = `<div style="display:flex;flex-direction:column;gap:var(--gap-section-grid);padding:var(--gap-section-grid);flex-wrap:wrap;background:var(--background)"><a href="/patchnotes/15.2"><div class="Button-module__7bauUa__button"><div style="display:flex;width:100%;justify-content:space-between;align-items:center"><span style="font-size:16px;font-weight:bold">15.2</span><span style="font-size:12px;color:var(--secondary)">L<!-- --> <!-- -->- <!-- -->Jun 17</span></div></div></a><a href="/patchnotes/15.1-jun8"><div class="Button-module__7bauUa__button"><div style="display:flex;width:100%;justify-content:space-between;align-items:center"><span style="font-size:16px;font-weight:bold">15.1 Hotfix June 8</span><span style="font-size:12px;color:var(--secondary)">XS<!-- --> <!-- -->- <!-- -->Jun 8</span></div></div></a><a href="/patchnotes/13.3-apr29"><div class="Button-module__7bauUa__button"><div style="display:flex;width:100%;justify-content:space-between;align-items:center"><span style="font-size:16px;font-weight:bold">13.3 Event Apr 29</span><span style="font-size:12px;color:var(--secondary)">XS<!-- --> <!-- -->- <!-- -->Apr 29</span></div></div></a></div>`

// event entry is the FIRST in the list — simulates an event being the latest patch
const FIXTURE_EVENT_FIRST = `<div><a href="/patchnotes/13.3-apr29"><div class="Button-module__7bauUa__button"><div style="display:flex;width:100%;justify-content:space-between;align-items:center"><span style="font-size:16px;font-weight:bold">13.3 Event Apr 29</span><span style="font-size:12px;color:var(--secondary)">XS<!-- --> <!-- -->- <!-- -->Apr 29</span></div></div></a></div>`

describe('parsePatchHtml', () => {
  it('parses the latest patch from normal HTML', () => {
    const info = parsePatchHtml(FIXTURE_NORMAL)
    expect(info).not.toBeNull()
    expect(info!.latestPatch).toBe('15.2')
    expect(info!.patchDate).toBe('Jun 17')
    expect(info!.sizeBadge).toBe('L')
    expect(info!.activeEvent).toBeNull()
    expect(info!.fetchedAt).toBeTruthy()
    // fetchedAt must be a valid ISO timestamp
    expect(() => new Date(info!.fetchedAt).toISOString()).not.toThrow()
  })

  it('returns null for malformed / empty HTML', () => {
    expect(parsePatchHtml('')).toBeNull()
    expect(parsePatchHtml('<html><body></body></html>')).toBeNull()
    expect(parsePatchHtml('<!-- no patch links here -->')).toBeNull()
  })

  it('returns null when badge date is missing or implausible', () => {
    // badge with no month abbreviation
    const bad = FIXTURE_NORMAL.replace('Jun 17', '2025-06-17')
    expect(parsePatchHtml(bad)).toBeNull()
  })

  it('sets activeEvent when latest entry title contains "Event"', () => {
    const info = parsePatchHtml(FIXTURE_EVENT_FIRST)
    expect(info).not.toBeNull()
    expect(info!.latestPatch).toBe('13.3')
    expect(info!.patchDate).toBe('Apr 29')
    expect(info!.sizeBadge).toBe('XS')
    expect(info!.activeEvent).toBe('13.3 Event Apr 29')
  })

  it('does not set activeEvent when event is not the latest entry', () => {
    // FIXTURE_NORMAL has 15.2 first, event entry is further down — should not be detected
    const info = parsePatchHtml(FIXTURE_NORMAL)
    expect(info!.activeEvent).toBeNull()
  })

  it('latestPatch always passes /^\\d+(\\.\\d+)+$/ validation', () => {
    const info = parsePatchHtml(FIXTURE_NORMAL)
    expect(/^\d+(\.\d+)+$/.test(info!.latestPatch)).toBe(true)
  })
})
