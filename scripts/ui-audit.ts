// Pixel-perfect alignment audit for the extension (overlay, panel, config).
//
//   bun run ui-audit                       full matrix: 3 fonts x 3 scales x 3 surfaces
//   bun run ui-audit -- --font=DejaVu --scale=1 --surface=overlay --verbose
//
// Starts the harness, drives headless chromium through every audit state in
// harness/audit.ts (geometry checks inside the page), then reads the real pixels of
// every icon glyph — render with and without the ink, diff, measure the bounding
// box — so "centred" is proven on what was drawn, not on what the maths predicted.
// Screenshots land in $UI_AUDIT_OUT (default /tmp/ui-audit). Exits 1 on any failure.
//
// Needs playwright-core (PLAYWRIGHT_CORE) and a chromium (CHROMIUM).
import { join } from 'path'
import { mkdirSync } from 'fs'

const ROOT = join(import.meta.dir, '..')
const EXT = join(ROOT, 'packages', 'extension')
const OUT = process.env.UI_AUDIT_OUT ?? '/tmp/ui-audit'
const PW = process.env.PLAYWRIGHT_CORE ?? '/home/mellen/projects/heatsync/node_modules/playwright-core/index.mjs'
const CHROMIUM = process.env.CHROMIUM ?? '/home/mellen/.local/bin/chromium'

const FONTS = ['DejaVu Sans Mono', 'Liberation Mono', 'Noto Sans Mono']
const SCALES = [
  { ui: 1, w: 1280, h: 720 },
  { ui: 1.25, w: 1600, h: 900 },
  { ui: 1.75, w: 2240, h: 1260 },
]
const SURFACES = [
  { name: 'overlay', path: '/?audit=step' },
  { name: 'panel', path: '/panel?audit=step' },
  { name: 'config', path: '/config?audit=step' },
]
// the state whose screenshot is saved for each surface
const SHOTS: Record<string, string[]> = {
  overlay: ['overlay:tt:en:ench', 'overlay:tt:th:keywords', 'overlay:search:card:en'],
  panel: ['panel:idle', 'panel:card:en'],
  config: ['config:main'],
}
const DPR = Number(process.env.UI_AUDIT_DPR ?? 2)
// Raster reading: 0.5px of text snapping to whole pixels + up to ~1 when the glyph
// comes from a fallback font (hinting differs from the 200px canvas measure). The
// in-page checks stay at 0.5.
const PIXEL_LIMIT = 1.5

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]
const verbose = process.argv.includes('--verbose')
const onlyFont = arg('font'), onlyScale = arg('scale'), onlySurface = arg('surface')

type Row = { id: string; ok: boolean; v: number | string; lim: number | string }

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response('') })
  const p = s.port
  await s.stop(true)
  return p as number
}

const build = Bun.spawnSync(['bun', 'run', 'build'], { cwd: EXT, stdout: 'pipe', stderr: 'pipe' })
if (build.exitCode !== 0) { console.error(build.stderr.toString() || 'build failed'); process.exit(1) }

const port = await freePort()
const harness = Bun.spawn(['bun', 'harness/serve.ts'], { cwd: EXT, env: { ...process.env, HARNESS_PORT: String(port) }, stdout: 'ignore', stderr: 'inherit' })
const base = `http://127.0.0.1:${port}`
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${base}/api/i18n`)).ok) break } catch { /* not up yet */ }
  await Bun.sleep(100)
}

const { chromium } = await import(PW)
const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ['--no-sandbox'] })
mkdirSync(OUT, { recursive: true })

// ink bounding box of a glyph from two renders of the same box: with and without ink
const INK_JS = `async ([a, b, dpr]) => {
  const load = async (s) => { const bm = await createImageBitmap(await (await fetch('data:image/png;base64,' + s)).blob()); const c = new OffscreenCanvas(bm.width, bm.height); const g = c.getContext('2d'); g.drawImage(bm, 0, 0); return g.getImageData(0, 0, bm.width, bm.height) }
  const A = await load(a), B = await load(b)
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1
  for (let y = 0; y < A.height; y++) for (let x = 0; x < A.width; x++) {
    const i = (y * A.width + x) * 4
    const d = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]))
    if (d > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  }
  if (x1 < 0) return null
  return { cx: (x0 + x1 + 1) / 2 / dpr, cy: (y0 + y1 + 1) / 2 / dpr, touches: x0 === 0 || y0 === 0 || x1 === A.width - 1 || y1 === A.height - 1 }
}`

async function pixelRows(page: any): Promise<Row[]> {
  const targets: any[] = await page.evaluate(() => (window as any).__audit.glyphTargets())
  const rows: Row[] = []
  const hide = await page.addStyleTag({ content: '.gi{visibility:hidden!important}' })
  await page.evaluate(() => { document.querySelectorAll('style').forEach((s) => { if (s.textContent?.includes('.gi{visibility:hidden')) s.disabled = true }) })
  const pairs: Array<{ t: any; a: Buffer; b: Buffer; x0: number; y0: number }> = []
  for (const t of targets) {
    const x0 = Math.max(0, Math.floor(t.x) - 1), y0 = Math.max(0, Math.floor(t.y) - 1)
    const clip = { x: x0, y: y0, width: Math.ceil(t.x + t.w) + 1 - x0, height: Math.ceil(t.y + t.h) + 1 - y0 }
    await page.evaluate(() => document.querySelectorAll('style').forEach((s) => { if (s.textContent?.includes('.gi{visibility:hidden')) s.disabled = true }))
    const a = await page.screenshot({ clip })
    await page.evaluate(() => document.querySelectorAll('style').forEach((s) => { if (s.textContent?.includes('.gi{visibility:hidden')) s.disabled = false }))
    const b = await page.screenshot({ clip })
    pairs.push({ t, a, b, x0, y0 })
  }
  await page.evaluate(() => document.querySelectorAll('style').forEach((s) => { if (s.textContent?.includes('.gi{visibility:hidden')) s.disabled = true }))
  void hide
  for (const p of pairs) {
    const read = (x: Buffer, y: Buffer) => page.evaluate(`(${INK_JS})(${JSON.stringify([x.toString('base64'), y.toString('base64'), DPR])})`)
    let r = await read(p.a, p.b)
    if (!r) {
      // the page moved under the two shots (a re-render between them): shoot the pair again
      const clip = { x: p.x0, y: p.y0, width: Math.ceil(p.t.x + p.t.w) + 1 - p.x0, height: Math.ceil(p.t.y + p.t.h) + 1 - p.y0 }
      const show = (on: boolean) => page.evaluate((v: boolean) => document.querySelectorAll('style').forEach((st) => { if (st.textContent?.includes('.gi{visibility:hidden')) st.disabled = !v }), on)
      await show(false); const a2 = await page.screenshot({ clip }); await show(true); const b2 = await page.screenshot({ clip }); await show(false)
      r = await read(a2, b2)
    }
    const name = `px:glyph:${p.t.name}`
    if (!r) { rows.push({ id: `${name}:ink-found`, ok: false, v: `no ink at ${Math.round(p.t.x)},${Math.round(p.t.y)} ${Math.round(p.t.w)}x${Math.round(p.t.h)} of ${await page.evaluate('innerWidth')}x${await page.evaluate('innerHeight')}`, lim: '' }); continue }
    if (r.touches) rows.push({ id: `${name}:inside-box`, ok: false, v: 'ink reaches edge', lim: '' })
    const dx = p.x0 + r.cx - p.t.tx, dy = p.y0 + r.cy - p.t.ty
    rows.push({ id: `${name}:x`, ok: Math.abs(dx) <= PIXEL_LIMIT, v: Math.round(dx * 100) / 100, lim: PIXEL_LIMIT })
    rows.push({ id: `${name}:y`, ok: Math.abs(dy) <= PIXEL_LIMIT, v: Math.round(dy * 100) / 100, lim: PIXEL_LIMIT })
  }
  return rows
}

const summary: Array<{ surface: string; font: string; ui: number; pass: number; total: number }> = []
const failures = new Map<string, { n: number; worst: number | string; lim: number | string; where: string }>()
let anyFail = false

for (const font of FONTS) {
  if (onlyFont && !font.includes(onlyFont)) continue
  for (const sc of SCALES) {
    if (onlyScale && Number(onlyScale) !== sc.ui) continue
    for (const surf of SURFACES) {
      if (onlySurface && onlySurface !== surf.name) continue
      const ctx = await browser.newContext({ viewport: { width: sc.w, height: sc.h }, deviceScaleFactor: DPR })
      const page = await ctx.newPage()
      const errs: string[] = []
      page.on('pageerror', (e: Error) => errs.push(String(e)))
      await page.goto(`${base}${surf.path}`)
      await page.addStyleTag({ content: `html *{font-family:"${font}",monospace!important}` })
      // a font swap is what a late web font looks like to the page: tell it, as the browser would
      await page.evaluate(() => window.dispatchEvent(new Event('resize')))
      await page.waitForTimeout(200)
      await page.waitForFunction(() => (window as any).__audit?.ready || (window as any).__audit?.error, null, { timeout: 30000 })
      const err = await page.evaluate(() => (window as any).__audit.error)
      let pass = 0, total = 0
      const tally = (state: string, rows: Row[]) => {
        for (const r of rows) {
          total++
          if (r.ok) { pass++; continue }
          anyFail = true
          const key = `${surf.name}  ${r.id}`
          const f = failures.get(key)
          const mag = typeof r.v === 'number' ? Math.abs(r.v) : 0
          const wmag = f && typeof f.worst === 'number' ? Math.abs(f.worst) : -1
          const where = `${font} @${sc.ui} ${state}`
          if (!f) failures.set(key, { n: 1, worst: r.v, lim: r.lim, where })
          else { f.n++; if (mag > wmag) { f.worst = r.v; f.where = where } }
        }
      }
      if (err) tally('boot', [{ id: 'boot', ok: false, v: err.split('\n')[0], lim: '' }])
      else {
        const ids: string[] = await page.evaluate(() => (window as any).__audit.mine)
        for (const id of ids) {
          const rows: Row[] = await page.evaluate((i: string) => (window as any).__audit.run(i), id)
          tally(id, rows)
          tally(id, await pixelRows(page))
          if (SHOTS[surf.name]?.includes(id)) {
            const slug = id.replace(/[^a-z0-9]+/gi, '-')
            await page.screenshot({ path: join(OUT, `${font.replace(/ /g, '')}-${sc.ui}-${slug}.png`) })
          }
        }
      }
      for (const e of errs) tally('pageerror', [{ id: `pageerror ${e.slice(0, 80)}`, ok: false, v: 'error', lim: '' }])
      summary.push({ surface: surf.name, font, ui: sc.ui, pass, total })
      await ctx.close()
    }
  }
}
await browser.close()
harness.kill()

console.log('surface  font               ui    pass/total')
for (const s of summary) console.log(`${s.surface.padEnd(8)} ${s.font.padEnd(18)} ${String(s.ui).padEnd(5)} ${s.pass}/${s.total}${s.pass === s.total ? '' : '  FAIL'}`)
if (failures.size) {
  console.log('\nfailing checks (count, worst, limit, where)')
  for (const [k, f] of [...failures].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k}  x${f.n}  worst=${f.worst} limit=${f.lim}  [${f.where}]`)
}
console.log(`\n${anyFail ? 'FAIL' : 'ALL GREEN'}  screenshots: ${OUT}`)
void verbose
process.exit(anyFail ? 1 : 0)
