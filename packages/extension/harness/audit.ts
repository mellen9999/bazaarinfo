// In-page alignment audit. Served by the harness at /audit.js and loaded by
// /?audit=1, /panel?audit=1 and /config?audit=1. Walks a declared list of states
// (a card hovered, a search open, ...) and, in each, a declared list of geometry
// checks. Results go to window.__audit and, as JSON + a table, into <pre id="audit">.
//
// ?audit=1     run every state on load
// ?audit=step  wait: scripts/ui-audit.ts drives __audit.run(id) state by state so it
//              can take pixel-level readings of the same state before moving on.

type Row = { id: string; ok: boolean; v: number | string; lim: number | string }
type State = { id: string; surface: string; run: () => Promise<Row[]> }

const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector<T>(s)
const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => [...r.querySelectorAll<T>(s)]
const rc = (e: Element) => e.getBoundingClientRect()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const frames = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(() => r(0))) }
const num = (n: number) => Math.round(n * 100) / 100
const W: any = window

// ── measuring ──
const cv = document.createElement('canvas').getContext('2d')!
function fontOf(e: Element) {
  const cs = getComputedStyle(e)
  return { px: parseFloat(cs.fontSize), font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}` }
}
function metrics(e: Element, text: string) {
  const f = fontOf(e)
  cv.font = f.font
  cv.textBaseline = 'alphabetic'
  cv.textAlign = 'left'
  return { m: cv.measureText(text), px: f.px }
}
// ink centre of a .gi: ink measured big and scaled, line metrics at the real size
function inkCentre(gi: Element) {
  const text = gi.textContent ?? ''
  const f = fontOf(gi)
  cv.font = f.font.replace(/(\d+(\.\d+)?)px/, '200px')
  cv.textBaseline = 'alphabetic'
  cv.textAlign = 'left'
  const m = cv.measureText(text)
  const k = f.px / 200
  cv.font = f.font
  const l = cv.measureText('x')
  const r = rc(gi)
  const lh = parseFloat(getComputedStyle(gi).lineHeight) || r.height
  const fa = Math.round(l.fontBoundingBoxAscent), fd = Math.round(l.fontBoundingBoxDescent)
  const baseline = r.top + fa + Math.floor((lh - (fa + fd)) / 2)
  return { x: r.left + ((m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2) * k, y: baseline - ((m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2) * k }
}
function textRange(e: Element, firstOnly = false): DOMRect | null {
  const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT)
  let n: Node | null
  let u: DOMRect | null = null
  while ((n = w.nextNode())) {
    if (!n.textContent?.trim()) continue
    const g = document.createRange()
    g.selectNodeContents(n)
    const r = g.getBoundingClientRect()
    if (!r.width) continue
    if (firstOnly) return r
    u = u ? new DOMRect(Math.min(u.left, r.left), Math.min(u.top, r.top), Math.max(u.right, r.right) - Math.min(u.left, r.left), Math.max(u.bottom, r.bottom) - Math.min(u.top, r.top)) : r
  }
  return u
}
// baseline of the first text in e, from its content-area top + the font's rounded ascent
function baselineOf(e: Element): number | null {
  const r = textRange(e, true)
  if (!r) return null
  const f = fontOf(e)
  cv.font = f.font
  return r.top + Math.round(cv.measureText('x').fontBoundingBoxAscent)
}
function xMid(e: Element): number | null {
  const b = baselineOf(e)
  if (b == null) return null
  const f = fontOf(e)
  cv.font = f.font.replace(/(\d+(\.\d+)?)px/, '200px')
  return b - (cv.measureText('x').actualBoundingBoxAscent * f.px) / 200 / 2
}

// ── check plumbing ──
let rows: Row[] = []
const T = 0.5
function check(id: string, v: number, lim = T) { rows.push({ id, ok: Math.abs(v) <= lim, v: num(v), lim }) }
function flag(id: string, ok: boolean, v: string | number = ok ? 'ok' : 'FAIL') { rows.push({ id, ok, v, lim: '' }) }
function spread(id: string, vals: Array<number | null>, lim = T) {
  const v = vals.filter((x): x is number => x != null && Number.isFinite(x))
  if (v.length < 2) return
  check(id, Math.max(...v) - Math.min(...v), lim)
}
// elements on the same visual line share a value; lines are told apart by a gap bigger than a few px
function perLine(id: string, els: Element[], val: (e: Element) => number | null, lim = T) {
  const items = els.map((e) => ({ y: rc(e).top + rc(e).height / 2, v: val(e) })).filter((i) => i.v != null) as Array<{ y: number; v: number }>
  items.sort((a, b) => a.y - b.y)
  let group: number[] = []
  let last = -1e9
  const flush = () => { spread(id, group, lim); group = [] }
  for (const i of items) {
    if (i.y - last > 4 && group.length) flush()
    group.push(i.v)
    last = i.y
  }
  flush()
}
function glyphs(root: ParentNode, tag: string) {
  for (const g of $$('.glyph', root)) {
    const gi = g.firstElementChild
    if (!gi || !rc(g).width) continue
    const ink = inkCentre(gi)
    const b = rc(g)
    const sep = g.classList.contains('glyph--sep')
    const name = `${tag}:glyph:${[...g.classList].find((c) => c !== 'glyph' && c !== 'glyph--wide') ?? 'key'}`
    check(`${name}:x`, ink.x - (b.left + b.width / 2))
    if (sep) {
      const host = g.parentElement!
      const mid = xMid(host.querySelector('.tt-stat-k, .tt-step') ?? host)
      if (mid != null) check(`${name}:y-xmid`, ink.y - mid)
    } else {
      check(`${name}:y`, ink.y - (b.top + b.height / 2))
      if (g.classList.contains('kw-glyph')) {
        const w = g.nextElementSibling
        const mid = w ? xMid(w) : null
        if (mid != null) check(`${name}:y-xmid`, ink.y - mid)
      }
    }
  }
}
function within(id: string, el: Element, box: { left: number; top: number; right: number; bottom: number }, slack = T) {
  const r = rc(el)
  const over = Math.max(box.left - r.left, box.top - r.top, r.right - box.right, r.bottom - box.bottom)
  check(id, Math.max(0, over), slack)
}
function noOverflow(id: string, el: Element) {
  const e = el as HTMLElement
  const scrolls = getComputedStyle(e).overflowY === 'auto' && e.scrollHeight > e.clientHeight + 1
  flag(`${id}:no-clip`, e.scrollWidth <= e.clientWidth + 1 && !scrolls, `${e.scrollWidth}x${e.scrollHeight}/${e.clientWidth}x${e.clientHeight}`)
  const r = rc(e)
  const cs = getComputedStyle(e)
  const box = { left: r.left + parseFloat(cs.borderLeftWidth), top: r.top + parseFloat(cs.borderTopWidth), right: r.right - parseFloat(cs.borderRightWidth), bottom: r.bottom - parseFloat(cs.borderBottomWidth) }
  let worst = 0
  let who = ''
  for (const c of $$('*', e)) {
    const cr = rc(c)
    if (!cr.width || !cr.height || getComputedStyle(c).position === 'fixed') continue
    const o = Math.max(box.left - cr.left, cr.right - box.right, scrolls ? 0 : cr.bottom - box.bottom)
    if (o > worst) { worst = o; who = `${c.className || c.tagName}:${(c.textContent ?? '').slice(0, 30)}` }
  }
  check(`${id}:children-inside`, Math.max(0, worst), T)
  if (worst > T) rows.push({ id: `${id}:children-inside:who`, ok: false, v: who, lim: '' })
  within(`${id}:in-frame`, e, { left: 0, top: 0, right: innerWidth, bottom: innerHeight })
}
function seams(id: string, parent: Element) {
  const kids = [...parent.children].filter((c) => rc(c).height > 0)
  let bad = 0
  for (let i = 1; i < kids.length; i++) {
    const a = kids[i - 1], b = kids[i]
    const ab = parseFloat(getComputedStyle(a).borderBottomWidth)
    const bt = parseFloat(getComputedStyle(b).borderTopWidth)
    if (ab > 0 && bt > 0 && rc(b).top - rc(a).bottom < 1) bad++
  }
  flag(`${id}:no-doubled-rule`, bad === 0, bad)
}
// the x-height middle of a box's text sits on the middle of the box (inside its border)
function textCentred(id: string, el: Element) {
  const mid = xMid(el)
  if (mid == null) return
  const r = rc(el)
  const cs = getComputedStyle(el)
  // the box, not its content: padding is what moves the text, so it is not a reference
  const top = r.top + parseFloat(cs.borderTopWidth)
  const bot = r.bottom - parseFloat(cs.borderBottomWidth)
  check(id, mid - (top + bot) / 2)
}
function gaps(id: string, els: Element[]) {
  const g: number[] = []
  for (let i = 1; i < els.length; i++) {
    const a = rc(els[i - 1]), b = rc(els[i])
    if (Math.abs(a.top - b.top) < 2) g.push(b.left - a.right)
  }
  spread(id, g)
}

// ── per-surface check lists ──
function tooltipChecks(t: HTMLElement, tag: string, framed: boolean) {
  glyphs(t, tag)
  const art = $('.tt-art', t)!
  const txt = $('.tt-head-text', t)!
  check(`${tag}:head:art-vs-text-centre-y`, rc(art).top + rc(art).height / 2 - (rc(txt).top + rc(txt).height / 2), 1)
  check(`${tag}:head:art-square`, rc(art).width - rc(art).height)
  perLine(`${tag}:stats:baseline`, $$('.tt-stat-k, .tt-stat-v', t).filter((e) => !e.querySelector('.tt-stat-k, .tt-ladder')), (e) => baselineOf(e))
  perLine(`${tag}:stats:sep-centre`, $$('.tt-sep > .gi', t), (g) => inkCentre(g).y - (xMid($('.tt-stat-k', g.closest('.tt-stat')!) as Element) ?? 0))
  for (const lad of $$('.tt-ladder', t)) {
    perLine(`${tag}:ladder:baseline`, $$('.tt-step', lad), (e) => baselineOf(e))
  }
  const tags = $$('.tt-tag', t)
  if (tags.length) {
    perLine(`${tag}:tags:top`, tags, (e) => rc(e).top)
    spread(`${tag}:tags:height`, tags.map((e) => rc(e).height))
    perLine(`${tag}:tags:baseline`, tags, (e) => baselineOf(e))
    for (const g of tags) textCentred(`${tag}:tag:text-centre-y`, g)
    gaps(`${tag}:tags:gap`, tags)
  }
  // left edges: art, labels, text, tags share the tooltip's inner gutter
  const lefts = [art, ...$$('.tt-label', t), ...$$('.tt-block .tt-text', t), ...tags.slice(0, 1)].filter((e) => !e.closest('.tt-block--ench'))
  spread(`${tag}:gutter-left`, lefts.map((e) => rc(e).left))
  spread(`${tag}:head:name-stats-left`, [$('.tt-name', t), $('.tt-stats', t)].map((e) => rc(e!).left))
  const kws = $$('.kw', t)
  spread(`${tag}:kw:word-offset`, kws.map((k) => rc(k.querySelector('.kw-word')!).left - rc(k.querySelector('.kw-glyph')!).left))
  spread(`${tag}:kw:glyph-box`, kws.map((k) => rc(k.querySelector('.kw-glyph')!).width - rc(k.querySelector('.kw-glyph')!).height))
  seams(`${tag}`, t)
  const name = $('.tt-name', t)!
  flag(`${tag}:name-fits`, name.scrollWidth <= name.clientWidth + 1, `${name.scrollWidth}/${name.clientWidth}`)
  if (framed) noOverflow(`${tag}`, t)
}
function searchChecks(root: HTMLElement, tag: string) {
  glyphs(root, tag)
  const input = $('.panel-search', root)!
  const col = [input, $('.panel-filters', root), $('.panel-results', root), $('.panel-note', root), $('.panel-selected', root), $('.panel-tiers', root), $('.panel-link--card', root), $('.card-tooltip', root)].filter(Boolean) as Element[]
  spread(`${tag}:column-left`, col.map((e) => rc(e).left))
  for (const e of col.filter((e) => e.matches('.panel-search, .panel-results, .card-tooltip, .panel-selected'))) check(`${tag}:column-width:${e.className.split(' ')[0]}`, rc(e).width - rc(root).width)
  for (const [grp, sel] of [['chip', '.panel-chip'], ['tier', '.panel-tier']] as const) {
    const els = $$(sel, root)
    if (!els.length) continue
    spread(`${tag}:${grp}:height`, els.map((e) => rc(e).height))
    perLine(`${tag}:${grp}:top`, els, (e) => rc(e).top)
    perLine(`${tag}:${grp}:baseline`, els, (e) => baselineOf(e))
    for (const e of els) textCentred(`${tag}:${grp}:text-centre-y`, e)
    gaps(`${tag}:${grp}:gap`, els)
  }
  const rows_ = $$('.panel-result', root)
  if (rows_.length) {
    spread(`${tag}:result:height`, rows_.map((e) => rc(e).height))
    spread(`${tag}:result:text-left`, rows_.map((e) => textRange(e)?.left ?? null))
    for (const e of rows_) textCentred(`${tag}:result:text-centre-y`, e)
  }
  const link = $('.panel-link--card', root)
  if (link) { const g = $('.panel-glyph', link); if (g) check(`${tag}:link:glyph-vs-text-xmid`, inkCentre(g.firstElementChild!).y - (xMid(link) ?? 0)) }
  noOverflow(`${tag}`, root)
  const t = $<HTMLElement>('.card-tooltip', root)
  if (t) tooltipChecks(t, `${tag}:tt`, false)
}
function keysChecks(tag: string) {
  const keys = $$('.panel-keys kbd')
  if (!keys.length) return
  glyphs(document, tag)
  const sq = keys.filter((k) => !k.classList.contains('glyph--wide'))
  spread(`${tag}:keys:width`, sq.map((k) => rc(k).width))
  spread(`${tag}:keys:height`, keys.map((k) => rc(k).height))
  for (const k of sq) check(`${tag}:key:square`, rc(k).width - rc(k).height)
  perLine(`${tag}:keys:centre-y`, keys, (k) => rc(k).top + rc(k).height / 2)
  for (const k of keys) { const gi = k.firstElementChild!; const r = rc(k); check(`${tag}:key:ink-x`, inkCentre(gi).x - (r.left + r.width / 2)); check(`${tag}:key:ink-y`, inkCentre(gi).y - (r.top + r.height / 2)) }
  gaps(`${tag}:keys:gap`, keys.slice(0, 2))
  noOverflow(`${tag}:keys`, $('.panel-keys')!)
}

// ── driving the page ──
let cards: any[] = []
async function loadCards() {
  const r = await fetch(location.origin + '/api/cards')
  const j = await r.json()
  cards = [...j.items, ...j.skills]
}
const KW = /burn|poison|heal|shield|crit|freeze|haste|slow|charge|damage|lifesteal|regen|reload|ammo|flying|multicast/gi
const textOf = (c: any) => (c.Tooltips ?? []).map((t: any) => t.text).join(' ')
function pick() {
  const items = cards.filter((c) => c.Type !== 'Skill')
  const by = (list: any[], f: (c: any) => number) => [...list].sort((a, b) => f(b) - f(a))[0]
  const out: Array<{ key: string; card: any; ench?: string }> = []
  const add = (key: string, card: any, ench?: string) => { if (card && !out.some((o) => o.card.Title === card.Title)) out.push({ key, card, ench }) }
  const withEnch = items.filter((c) => c.Enchantments && Object.keys(c.Enchantments).length && c.Cooldown && typeof c.Cooldown === 'object')
  const e = by(withEnch.length ? withEnch : items, (c) => textOf(c).length)
  add('ench', e, e && Object.keys(e.Enchantments ?? {})[0])
  add('long-name', by(items, (c) => c.Title.length))
  add('tags', by(items, (c) => (c.DisplayTags ?? c.Tags ?? []).length))
  add('keywords', by(items, (c) => (textOf(c).match(KW) ?? []).length))
  add('tall', by(items, (c) => textOf(c).length))
  add('skill', by(cards.filter((c) => c.Type === 'Skill'), (c) => textOf(c).length))
  add('ladder', by(items.filter((c) => c.Cooldown && typeof c.Cooldown === 'object'), (c) => Object.keys(c.Cooldown).length))
  return out
}

async function sendBoard(list: ReturnType<typeof pick>) {
  const n = list.length
  const slots = list.map((p, i) => ({
    title: p.card.Title, tier: p.card.BaseTier ?? p.card.Tiers?.[0] ?? 'Gold', tierKnown: false, type: p.card.Type, owner: 'player',
    enchantment: p.ench, x: 0.02 + (0.9 / n) * i, y: i % 2 ? 0.2 : 0.55, w: 0.07, h: 0.2,
  }))
  W.__bcast('broadcast', 'application/json', JSON.stringify({ v: 1, cards: slots }))
  await sleep(250)
}
// let fallback art, the fit pass and glyph centring all land before anything is measured
const settle = async () => {
  await sleep(200); await frames(3)
  // translations and art land late: wait until the page's text stops changing
  let last = ''
  for (let i = 0; i < 30; i++) {
    const now = document.body.innerText + $$('.gi').map((g) => g.getAttribute('style')).join()
    if (now === last) break
    last = now
    await sleep(150)
  }
}
async function hover(i: number) {
  const z = $$('.hover-zone')
  z.forEach((e) => e.dispatchEvent(new MouseEvent('mouseleave')))
  await frames(2)
  for (let tries = 0; tries < 6; tries++) {
    z[i].dispatchEvent(new MouseEvent('mouseenter'))
    await settle()
    if ($('.card-tooltip.visible')) break
    z[i].dispatchEvent(new MouseEvent('mouseleave'))
    await sleep(100)
  }
}
async function lang(l: string, controls = true) {
  W.__ctx({ language: l, arePlayerControlsVisible: controls })
  await sleep(l === 'en' ? 100 : 900)
}
async function type(q: string) {
  const i = $<HTMLInputElement>('.card-search input')!
  i.value = q
  i.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(300)
  await settle()
}
const key = (k: string) => $('.card-search input')!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
async function closeSearch() { if ($('.search-surface')) { $('.search-btn')!.click(); await sleep(80) } }

const states: State[] = []
const add = (id: string, surface: string, f: () => Promise<void>) => states.push({ id, surface, run: async () => { rows = []; await f(); await frames(2); return rows } })

function buildCards() {
  const picked = pick()
  const idx = (k: string) => picked.findIndex((p) => p.key === k)
  const shortlist = ['ench', 'keywords', 'long-name']
  // overlay: tooltips
  add('overlay:setup', 'overlay', async () => {
    await sendBoard(picked)
    flag('overlay:zones', $$('.hover-zone').length === picked.length, $$('.hover-zone').length)
    for (const z of $$('.hover-zone')) within('overlay:zone-in-frame', z, { left: 0, top: 0, right: innerWidth, bottom: innerHeight })
  })
  for (const p of picked) add(`overlay:tt:en:${p.key}`, 'overlay', async () => {
    await lang('en', false); await hover(idx(p.key))
    const t = $<HTMLElement>('.card-tooltip.visible')
    flag(`overlay:tt:visible`, !!t)
    if (t) tooltipChecks(t, `tt`, true)
  })
  for (const l of ['fr', 'zh', 'th']) for (const k of shortlist) add(`overlay:tt:${l}:${k}`, 'overlay', async () => {
    await lang(l, false); await hover(idx(k))
    const t = $<HTMLElement>('.card-tooltip.visible')
    flag(`overlay:tt:visible`, !!t)
    if (t) tooltipChecks(t, `tt`, true)
  })
  // overlay: search
  const longTitle = picked[idx('long-name')].card.Title as string
  const overlaySearch = (id: string, f: () => Promise<void>) => add(id, 'overlay', async () => { await lang('en'); await f() })
  overlaySearch('overlay:search:button', async () => {
    await closeSearch()
    const b = $('.search-btn')!
    check('search-btn:square', rc(b).width - rc(b).height)
    glyphs(b, 'search-btn')
    const gi = b.querySelector('.gi')!
    check('search-btn:ink-x', inkCentre(gi).x - (rc(b).left + rc(b).width / 2))
    check('search-btn:ink-y', inkCentre(gi).y - (rc(b).top + rc(b).height / 2))
    within('search-btn:in-frame', b, { left: 0, top: 0, right: innerWidth, bottom: innerHeight })
  })
  overlaySearch('overlay:search:idle', async () => {
    if (!$('.search-surface')) { $('.search-btn')!.click(); await sleep(150) }
    const s = $<HTMLElement>('.search-surface')!
    searchChecks(s.querySelector('.card-search') as HTMLElement, 'os')
    noOverflow('os:surface', s)
    check('os:surface-above-btn', Math.max(0, rc(s).bottom - rc($('.search-btn')!).top), T)
  })
  overlaySearch('overlay:search:results', async () => {
    if (!$('.search-surface')) { $('.search-btn')!.click(); await sleep(150) }
    await type(longTitle.split(' ')[0].slice(0, 4))
    const s = $<HTMLElement>('.search-surface')!
    searchChecks(s.querySelector('.card-search') as HTMLElement, 'os')
    noOverflow('os:surface', s)
  })
  overlaySearch('overlay:search:chips+more', async () => {
    if (!$('.search-surface')) { $('.search-btn')!.click(); await sleep(150) }
    await type('')
    const chip = $$('.panel-chip')[0]
    chip.click(); await sleep(150)
    const s = $<HTMLElement>('.search-surface')!
    searchChecks(s.querySelector('.card-search') as HTMLElement, 'os')
    noOverflow('os:surface', s)
  })
  for (const l of ['en', 'fr', 'th']) overlaySearch(`overlay:search:card:${l}`, async () => {
    await lang(l)
    if (!$('.search-surface')) { $('.search-btn')!.click(); await sleep(150) }
    await type(picked[idx('ench')].card.Title.slice(0, 5))
    key('Enter'); await sleep(250); await settle()
    const s = $<HTMLElement>('.search-surface')!
    searchChecks(s.querySelector('.card-search') as HTMLElement, 'os')
    noOverflow('os:surface', s)
  })
  // panel
  const panel = (id: string, f: () => Promise<void>) => add(id, 'panel', async () => { document.body.style.width = '318px'; await f() })
  panel('panel:idle', async () => {
    await type(''); key('Escape'); await sleep(100)
    searchChecks($('.card-search') as HTMLElement, 'p')
    keysChecks('p')
    const foot = $('.panel-foot')!
    noOverflow('p:foot', foot)
    check('p:foot:left', rc($('.panel-foot a')!).left - rc($('.card-search')!).left)
  })
  panel('panel:results', async () => {
    key('Escape'); await type(longTitle.split(' ')[0].slice(0, 4))
    searchChecks($('.card-search') as HTMLElement, 'p')
  })
  for (const l of ['en', 'fr', 'zh', 'th']) panel(`panel:card:${l}`, async () => {
    if (l !== 'en' || W.__lang) { W.__ctx({ language: l }); await sleep(l === 'en' ? 100 : 700) }
    W.__lang = l
    key('Escape'); await type(picked[idx('ench')].card.Title.slice(0, 5))
    key('Enter'); await sleep(250); await settle()
    searchChecks($('.card-search') as HTMLElement, 'p')
  })
}

function buildConfig() {
  add('config:main', 'config', async () => {
    for (let i = 0; i < 40 && $('#fields')?.hasAttribute('hidden'); i++) await sleep(100)
    const stage = $('#cal-stage')!, box = $('#cal-box')!
    within('cfg:box-in-stage', box, rc(stage))
    const btns = $$('.cal-btn')
    spread('cfg:btn:height', btns.map((b) => rc(b).height))
    perLine('cfg:btn:top', btns, (b) => rc(b).top)
    perLine('cfg:btn:baseline', btns, (b) => baselineOf(b))
    for (const b of btns) textCentred('cfg:btn:text-centre-y', b)
    for (const b of btns) { const t = textRange(b); if (t) check('cfg:btn:text-centre-x', t.left + t.width / 2 - (rc(b).left + rc(b).width / 2)) }
    const bar = $('.cal-bar')!
    const ro = $('#cal-readout')!, group = $('.cal-btns')!
    check('cfg:bar:readout-vs-buttons-centre-y', rc(ro).top + rc(ro).height / 2 - (rc(group).top + rc(group).height / 2))
    const inp = $<HTMLInputElement>('#cal-delay')!
    check('cfg:delay:label-input-left', rc($('label[for=cal-delay]')!).left - rc(inp).left)
    const fields = [$('#channel-id'), $('#secret'), $('.secret-btns')].filter(Boolean) as Element[]
    spread('cfg:secret:left', fields.map((e) => rc(e).left))
    spread('cfg:secret:btn-height', $$('.secret-btns .cal-btn').map((b) => rc(b).height))
    perLine('cfg:secret:btn-top', $$('.secret-btns .cal-btn'), (b) => rc(b).top)
    // the page scrolls vertically; sideways it must fit
    for (const e of [stage, bar, ...fields, inp]) within('cfg:in-frame-x', e, { left: 0, top: -1e9, right: innerWidth, bottom: 1e9 })
    flag('cfg:no-hscroll', document.documentElement.scrollWidth <= innerWidth + 1, document.documentElement.scrollWidth)
    spread('cfg:right-edge:stage-bar', [rc(stage).right, rc(bar).right].map((x) => Math.min(x, 480 + rc(stage).left)), 1)
  })
}

// glyph boxes for the pixel pass: where each ink SHOULD be centred, in page coords
function glyphTargets() {
  return $$('.glyph').filter((g) => rc(g).width > 0 && rc(g).bottom > 0 && rc(g).top < innerHeight && rc(g).right > 0 && rc(g).left < innerWidth).map((g, i) => {
    const b = rc(g)
    let ty = b.top + b.height / 2
    if (g.classList.contains('glyph--sep')) ty = xMid(g.parentElement!.querySelector('.tt-stat-k, .tt-step') ?? g.parentElement!) ?? ty
    const name = [...g.classList].find((c) => c !== 'glyph' && c !== 'glyph--wide') ?? 'key'
    return { i, name: `${name}:${g.textContent}`, x: b.left, y: b.top, w: b.width, h: b.height, tx: b.left + b.width / 2, ty }
  })
}

function table(res: Array<{ id: string; rows: Row[] }>) {
  const lines: string[] = []
  let fails = 0, total = 0
  for (const s of res) {
    const f = s.rows.filter((r) => !r.ok)
    fails += f.length; total += s.rows.length
    lines.push(`${f.length ? 'FAIL' : ' ok '} ${s.id}  ${s.rows.length - f.length}/${s.rows.length}`)
    for (const r of f) lines.push(`       - ${r.id} = ${r.v} (limit ${r.lim})`)
  }
  lines.push(`\n${total - fails}/${total} checks pass`)
  return lines.join('\n')
}

W.__audit = {
  ready: false,
  states: () => states.map((s) => ({ id: s.id, surface: s.surface })),
  run: async (id: string) => states.find((s) => s.id === id)!.run(),
  glyphTargets,
}
async function main() {
  const mode = new URLSearchParams(location.search).get('audit')
  if (!mode) return
  const surface = location.pathname.startsWith('/panel') ? 'panel' : location.pathname.startsWith('/config') ? 'config' : 'overlay'
  if (surface !== 'config') {
    await loadCards()
    for (let i = 0; i < 50 && !$('.hover-zone') && surface === 'overlay'; i++) await sleep(100)
    for (let i = 0; i < 50 && !$('.card-search input') && surface === 'panel'; i++) await sleep(100)
  }
  if (surface === 'config') buildConfig()
  else buildCards()
  const mine = states.filter((s) => s.surface === surface)
  W.__audit.mine = mine.map((s) => s.id)
  W.__audit.ready = true
  if (mode === 'step') return
  const res: Array<{ id: string; rows: Row[] }> = []
  for (const s of mine) res.push({ id: s.id, rows: await s.run() })
  const pre = document.createElement('pre')
  pre.id = 'audit'
  pre.style.cssText = 'position:fixed;left:0;top:0;z-index:9999;background:#000;color:#0f0;font:12px monospace;margin:0;padding:6px;max-height:100%;overflow:auto;white-space:pre-wrap'
  pre.textContent = table(res) + '\n\n' + JSON.stringify(res)
  document.body.appendChild(pre)
  W.__audit.done = true
}
main().catch((e) => { W.__audit.error = String(e?.stack ?? e) })
