// mods-only control center. vanilla ts, no deps, bundled by Bun.build into panel.js.
// every string on this page is untrusted chat/user content — DOM is built with
// textContent/attributes only, never innerHTML, so it's XSS-safe by construction.

import type { Snapshot, Action } from '../src/control'

// --- types derived from the server contract (no runtime import — types only) -----------

type Feature = Snapshot['pauses'][number]['feature']
type Pace = Snapshot['raid']['pace']
type PaneKey = 'pauses' | 'vibes' | 'trivia' | 'asks' | 'audit' | 'raid' | 'ai' | 'depths' | 'ignored'

interface Me { login: string; admin: boolean; channels: string[] }

const FEATURES: Feature[] = ['trivia', 'depths', 'ai', 'all']
const PACES: Pace[] = ['fast', 'normal', 'slow']
const IGNORE_DURATIONS: [string, number | undefined][] = [['1h', 60], ['24h', 1440], ['7d', 10080], ['forever', undefined]]
const PANE_ORDER: PaneKey[] = ['pauses', 'vibes', 'trivia', 'asks', 'audit', 'ignored', 'raid', 'ai', 'depths']
const CHANNEL_KEY = 'bzi-panel-channel'
const SAY_MAX = 450
const STALE_MS = 10_000

// --- tiny dom helpers ---------------------------------------------------------------

function $<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id)
  if (!e) throw new Error(`missing #${id}`)
  return e as T
}

interface ElOpts { class?: string; text?: string; title?: string }

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, opts: ElOpts = {}, ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (opts.class) e.className = opts.class
  if (opts.text !== undefined) e.textContent = opts.text
  if (opts.title !== undefined) e.title = opts.title
  for (const c of children) e.append(c)
  return e
}

function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

function isTypingTarget(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
}

// --- format helpers ------------------------------------------------------------------

function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

// remaining-time label: 45 → "45m", 180 → "3h", 2880 → "2d"
function ttl(mins: number): string {
  if (mins >= 2880) return `${Math.round(mins / 1440)}d`
  if (mins >= 120) return `${Math.round(mins / 60)}h`
  return `${mins}m`
}

function compactNum(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`
  return `${(n / 1_000_000).toFixed(1)}m`
}

function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(sec).padStart(2, '0')}s`
}

function parseSqlTime(s: string): number {
  const iso = /Z$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`
  const t = Date.parse(iso)
  return Number.isNaN(t) ? Date.now() : t
}

// --- state ------------------------------------------------------------------------------

interface ConfirmArm { key: string; expiresAt: number }

interface PanelState {
  me: Me | null
  channel: string
  snap: Snapshot | null
  lastSnapAt: number
  es: EventSource | null
  focusedPane: number
  selection: Partial<Record<PaneKey, number>>
  confirmArmed: ConfirmArm | null
  pauseArm: 'feature' | 'minutes' | null
  pauseFeature: Feature | null
  cmdAction: Action | null
  helpOpen: boolean
}

const state: PanelState = {
  me: null,
  channel: '',
  snap: null,
  lastSnapAt: 0,
  es: null,
  focusedPane: 0,
  selection: {},
  confirmArmed: null,
  pauseArm: null,
  pauseFeature: null,
  cmdAction: null,
  helpOpen: false,
}

let esBackoff = 1000
let cmdDebounce = 0
let parseSeq = 0

// --- static dom refs ------------------------------------------------------------------

const loginScreen = $<HTMLDivElement>('login-screen')
const mainScreen = $<HTMLDivElement>('main-screen')
const channelTabs = $<HTMLElement>('channel-tabs')
const liveDot = $<HTMLSpanElement>('live-dot')
const streamGame = $<HTMLSpanElement>('stream-game')
const streamViewers = $<HTMLSpanElement>('stream-viewers')
const streamUptime = $<HTMLSpanElement>('stream-uptime')
const staleFlag = $<HTMLSpanElement>('stale-flag')
const whoami = $<HTMLSpanElement>('whoami')
const logoutBtn = $<HTMLButtonElement>('logout-btn')
const cmdInput = $<HTMLInputElement>('cmd-input')
const cmdPreview = $<HTMLSpanElement>('cmd-preview')
const adminStrip = $<HTMLDivElement>('admin-strip')
const joinInput = $<HTMLInputElement>('join-input')
const joinBtn = $<HTMLButtonElement>('join-btn')
const partBtn = $<HTMLButtonElement>('part-btn')
const sayInput = $<HTMLInputElement>('say-input')
const sayBtn = $<HTMLButtonElement>('say-btn')
const statusLine = $<HTMLDivElement>('status-line')
const helpOverlay = $<HTMLDivElement>('help-overlay')

const paneEl: Record<PaneKey, HTMLElement> = {
  pauses: $('pane-pauses'), vibes: $('pane-vibes'), trivia: $('pane-trivia'), asks: $('pane-asks'),
  audit: $('pane-audit'), raid: $('pane-raid'), ai: $('pane-ai'), depths: $('pane-depths'),
  ignored: $('pane-ignored'),
}
const paneBody: Record<PaneKey, HTMLElement> = {
  pauses: $('pauses-body'), vibes: $('vibes-body'), trivia: $('trivia-body'), asks: $('asks-body'),
  audit: $('audit-body'), raid: $('raid-body'), ai: $('ai-body'), depths: $('depths-body'),
  ignored: $('ignored-body'),
}

let topicInputEl: HTMLInputElement | null = null
let ignoreInputEl: HTMLInputElement | null = null

// --- api -------------------------------------------------------------------------------

async function fetchMe(): Promise<Me | null> {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' })
    if (!res.ok) return null
    return await res.json() as Me
  } catch {
    return null
  }
}

async function doAct(action: Action): Promise<void> {
  try {
    const res = await fetch('/api/act', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: state.channel, action }),
    })
    if (res.status === 401) { showLogin(); return }
    if (res.status === 403) { setStatus('not allowed', 'fail'); return }
    const data = await res.json() as { ok: boolean; msg: string }
    setStatus(data.msg, data.ok ? 'ok' : 'fail')
  } catch {
    setStatus('request failed', 'fail')
  }
}

async function doLogout(): Promise<void> {
  try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }) } catch {}
  state.es?.close()
  state.es = null
  state.me = null
  state.snap = null
  showLogin()
}

// --- live stream (SSE) ------------------------------------------------------------------

function connectStream(channel: string): void {
  state.es?.close()
  const es = new EventSource(`/api/stream?ch=${encodeURIComponent(channel)}`)
  state.es = es
  es.addEventListener('snap', (ev: MessageEvent) => {
    if (state.channel !== channel) return
    try {
      state.snap = JSON.parse(ev.data) as Snapshot
      state.lastSnapAt = Date.now()
      esBackoff = 1000
      staleFlag.hidden = true
      renderAll()
    } catch {}
  })
  es.addEventListener('error', () => {
    es.close()
    if (state.channel !== channel) return
    const delay = esBackoff
    esBackoff = Math.min(esBackoff * 2, 30_000)
    window.setTimeout(() => { if (state.channel === channel) connectStream(channel) }, delay)
  })
}

function checkStale(): void {
  if (!state.snap) return
  staleFlag.hidden = Date.now() - state.lastSnapAt <= STALE_MS
}

// --- channel switching -------------------------------------------------------------------

function saveChannel(ch: string): void {
  try { localStorage.setItem(CHANNEL_KEY, ch) } catch {}
}

function restoreChannel(channels: string[]): string {
  try {
    const saved = localStorage.getItem(CHANNEL_KEY)
    if (saved && channels.includes(saved)) return saved
  } catch {}
  return channels[0] ?? ''
}

function switchChannel(ch: string): void {
  if (!ch || ch === state.channel) return
  state.channel = ch
  state.snap = null
  saveChannel(ch)
  connectStream(ch)
  renderAll()
}

function switchChannelByIndex(idx: number): void {
  const ch = state.me?.channels[idx]
  if (ch) switchChannel(ch)
}

// --- confirm-armed (two-press destructive actions) ---------------------------------------

function confirmArmedNow(key: string): boolean {
  return state.confirmArmed?.key === key && state.confirmArmed.expiresAt > Date.now()
}

function triggerConfirm(key: string, run: () => void): void {
  if (confirmArmedNow(key)) {
    state.confirmArmed = null
    run()
    renderAll()
    return
  }
  state.confirmArmed = { key, expiresAt: Date.now() + 3000 }
  renderAll()
  window.setTimeout(() => {
    if (state.confirmArmed?.key === key) { state.confirmArmed = null; renderAll() }
  }, 3100)
}

function confirmButton(key: string, label: string, run: () => void): HTMLButtonElement {
  const armed = confirmArmedNow(key)
  const b = el('button', { class: armed ? 'danger' : '', text: armed ? 'again to confirm' : label })
  b.type = 'button'
  b.addEventListener('click', () => triggerConfirm(key, run))
  return b
}

// --- selection / pane focus ---------------------------------------------------------------

function focusedPaneKey(): PaneKey {
  return PANE_ORDER[state.focusedPane] ?? 'pauses'
}

function paneRowCount(key: PaneKey): number {
  if (!state.snap) return 0
  switch (key) {
    case 'pauses': return FEATURES.length
    case 'vibes': return state.snap.vibes.length
    case 'trivia': return state.snap.trivia.bans.length
    case 'ignored': return state.snap.ignored.length
    default: return 0
  }
}

function selectionIndex(key: PaneKey): number {
  const count = paneRowCount(key)
  if (count === 0) return -1
  const cur = state.selection[key] ?? 0
  return Math.min(Math.max(cur, 0), count - 1)
}

function isSelected(key: PaneKey, idx: number): boolean {
  return focusedPaneKey() === key && selectionIndex(key) === idx
}

function movePane(dir: number): void {
  const n = PANE_ORDER.length
  state.focusedPane = ((state.focusedPane + dir) % n + n) % n
}

function moveSelection(dir: number): void {
  const key = focusedPaneKey()
  const count = paneRowCount(key)
  if (count === 0) return
  const cur = selectionIndex(key)
  state.selection[key] = (cur + dir + count) % count
}

function pauseEntryFor(f: Feature): { by: string; minutes: number } | undefined {
  if (!state.snap) return undefined
  const allEntry = state.snap.pauses.find(p => p.feature === 'all')
  return state.snap.pauses.find(p => p.feature === f) ?? (f !== 'all' ? allEntry : undefined)
}

function activateSelected(): void {
  if (!state.snap) return
  const key = focusedPaneKey()
  if (key === 'pauses') {
    const idx = selectionIndex('pauses')
    if (idx < 0) return
    const f = FEATURES[idx]
    doAct(pauseEntryFor(f) ? { kind: 'resume', feature: f } : { kind: 'pause', feature: f, minutes: 30 })
  } else if (key === 'trivia') {
    const idx = selectionIndex('trivia')
    const ban = idx >= 0 ? state.snap.trivia.bans[idx] : undefined
    if (ban) doAct({ kind: 'topic-unban', topic: ban.topic })
  } else if (key === 'ignored') {
    unignoreSelected()
  }
}

function unignoreSelected(): void {
  if (!state.snap || focusedPaneKey() !== 'ignored') return
  const idx = selectionIndex('ignored')
  const row = idx >= 0 ? state.snap.ignored[idx] : undefined
  if (row) doAct({ kind: 'unignore', user: row.login })
}

function resumeSelectedPause(): void {
  if (!state.snap || focusedPaneKey() !== 'pauses') return
  const idx = selectionIndex('pauses')
  if (idx < 0) return
  doAct({ kind: 'resume', feature: FEATURES[idx] })
}

function dropSelectedVibe(): void {
  if (!state.snap || focusedPaneKey() !== 'vibes') return
  const idx = selectionIndex('vibes')
  const v = idx >= 0 ? state.snap.vibes[idx] : undefined
  if (v) doAct({ kind: 'vibe-drop', index: v.n })
}

// --- pause-arm ("p" then feature then minutes) --------------------------------------------

function cancelPauseArm(): void {
  state.pauseArm = null
  state.pauseFeature = null
}

function armPauseMenu(): void {
  state.pauseArm = 'feature'
  setStatus('pause: t)rivia d)epths a)i A)ll · esc cancel')
}

function handlePauseFeatureKey(key: string): void {
  const map: Partial<Record<string, Feature>> = { t: 'trivia', d: 'depths', a: 'ai', A: 'all' }
  const f = map[key]
  if (!f) { cancelPauseArm(); return }
  state.pauseFeature = f
  state.pauseArm = 'minutes'
  setStatus(`pause ${f}: 1)5m 3)0m 6)0m · esc cancel`)
}

function handlePauseMinutesKey(key: string): void {
  const map: Partial<Record<string, number>> = { '1': 15, '3': 30, '6': 60 }
  const m = map[key]
  const f = state.pauseFeature
  cancelPauseArm()
  if (m && f) doAct({ kind: 'pause', feature: f, minutes: m })
}

// --- status line / help overlay ------------------------------------------------------------

function setStatus(msg: string, kind?: 'ok' | 'fail'): void {
  statusLine.textContent = msg
  statusLine.className = `status-line${kind ? ` ${kind}` : ''}`
}

const HELP_ROWS: [string, string][] = [
  ['1-9', 'switch channel'],
  ['j / k', 'move selection'],
  ['h / l, tab / shift-tab', 'move between panes'],
  ['enter', 'activate selected'],
  ['p then t/d/a/A then 1/3/6', 'pause menu'],
  ['r', 'resume selected pause'],
  ['x / u', 'drop selected vibe / unignore selected'],
  ['i', 'focus ignore input'],
  ['t', 'start trivia (focus topic)'],
  ['s', 'skip trivia round'],
  ['/', 'focus say box'],
  [':', 'command bar'],
  ['esc', 'blur / cancel'],
  ['?', 'toggle this help'],
]

function openHelp(): void {
  clear(helpOverlay)
  const box = el('div', { class: 'help-box' })
  box.append(el('h3', { text: 'keys' }))
  for (const [k, d] of HELP_ROWS) {
    const row = el('div', { class: 'row' })
    row.append(el('span', { class: 'help-key', text: k }))
    row.append(el('span', { class: 'dim', text: d }))
    box.append(row)
  }
  helpOverlay.append(box)
  helpOverlay.hidden = false
  state.helpOpen = true
}

function closeHelp(): void {
  helpOverlay.hidden = true
  state.helpOpen = false
}

// --- screens -------------------------------------------------------------------------------

function showLogin(): void {
  loginScreen.hidden = false
  mainScreen.hidden = true
}

function showMain(): void {
  loginScreen.hidden = true
  mainScreen.hidden = false
}

// --- render: header --------------------------------------------------------------------------

function renderHeader(): void {
  const me = state.me
  clear(channelTabs)
  if (me) {
    me.channels.forEach((ch, i) => {
      const tab = el('button', {
        class: `channel-tab${ch === state.channel ? ' active' : ''}`,
        text: ch,
      })
      tab.type = 'button'
      if (i < 9) tab.prepend(el('span', { class: 'num', text: `${i + 1}` }))
      tab.addEventListener('click', () => switchChannel(ch))
      channelTabs.append(tab)
    })
    whoami.textContent = me.admin ? `${me.login} (admin)` : me.login
    adminStrip.hidden = !me.admin
  }

  const snap = state.snap
  liveDot.className = `dot${snap?.stream.live ? ' live' : ''}`
  streamGame.textContent = snap?.stream.game ?? ''
  streamGame.title = snap?.stream.title ?? ''
  streamViewers.textContent = snap?.stream.viewers != null ? `${compactNum(snap.stream.viewers)} viewers` : ''
  if (snap?.stream.live && snap.stream.startedAt) {
    streamUptime.textContent = formatUptime(snap.now - snap.stream.startedAt)
  } else {
    streamUptime.textContent = ''
  }

  partBtn.textContent = confirmArmedNow('part') ? 'again to confirm' : 'leave current'
  partBtn.classList.toggle('danger', confirmArmedNow('part'))
}

// --- render: panes ---------------------------------------------------------------------------

function paneEmpty(body: HTMLElement, text: string): void {
  body.append(el('div', { class: 'pane-empty', text }))
}

function renderPauses(snap: Snapshot): void {
  const body = paneBody.pauses
  clear(body)
  FEATURES.forEach((f, i) => {
    const entry = pauseEntryFor(f)
    const row = el('div', { class: `row${isSelected('pauses', i) ? ' selected' : ''}` })
    row.append(el('span', { text: f }))
    if (entry) {
      row.append(el('span', { class: 'warn row-label', text: `paused ${ttl(entry.minutes)} · by ${entry.by}` }))
      const resumeBtn = el('button', { text: 'resume' })
      resumeBtn.type = 'button'
      resumeBtn.addEventListener('click', () => doAct({ kind: 'resume', feature: f }))
      row.append(resumeBtn)
    } else {
      row.append(el('span', { class: 'ok-dim row-label', text: 'on' }))
      const btns = el('div', { class: 'mono-btns' })
      for (const m of [15, 30, 60]) {
        const b = el('button', { text: `${m}` })
        b.type = 'button'
        b.addEventListener('click', () => doAct({ kind: 'pause', feature: f, minutes: m }))
        btns.append(b)
      }
      row.append(btns)
    }
    body.append(row)
  })
}

function renderVibes(snap: Snapshot): void {
  const body = paneBody.vibes
  clear(body)
  const list = el('div', { class: 'list-scroll' })
  if (!snap.vibes.length) paneEmpty(list, 'no active vibes')
  snap.vibes.forEach((v, i) => {
    const wrap = el('div', { class: `vibe-row${isSelected('vibes', i) ? ' selected' : ''}` })
    const line1 = el('div', { class: 'row' })
    line1.append(el('span', { text: `#${v.n}` }))
    line1.append(el('span', { class: v.mod ? 'warn' : 'info', text: v.mod ? 'mod' : 'viewer' }))
    line1.append(el('span', { class: 'row-label', text: v.target ? `${v.planter} →${v.target}` : v.planter }))
    if (v.mute) line1.append(el('span', { class: 'danger', text: 'mute' }))
    line1.append(el('span', { class: 'dim', text: ttl(v.minutes) }))
    const x = el('button', { text: 'x' })
    x.type = 'button'
    x.addEventListener('click', () => doAct({ kind: 'vibe-drop', index: v.n }))
    line1.append(x)
    wrap.append(line1)
    wrap.append(el('div', { class: 'vibe-instruction', text: v.instruction, title: v.instruction }))
    list.append(wrap)
  })
  body.append(list)
  const controls = el('div', { class: 'pane-controls' })
  controls.append(confirmButton('vibe-clear', 'clear all', () => doAct({ kind: 'vibe-clear' })))
  body.append(controls)
}

function renderTrivia(snap: Snapshot): void {
  const body = paneBody.trivia
  clear(body)
  const t = snap.trivia
  const roundRow = el('div', { class: 'row' })
  if (t.round) {
    roundRow.append(el('span', { class: 'info row-label', text: t.round.question, title: t.round.question }))
    roundRow.append(el('span', { class: 'dim', text: `${t.round.secondsLeft}s` }))
    roundRow.append(el('span', { class: 'dim', text: `${t.round.guesses} guesses` }))
  } else {
    roundRow.append(el('span', { class: 'dim', text: 'no round running' }))
  }
  body.append(roundRow)

  if (t.queue.length) {
    body.append(el('div', { class: 'dim', text: `queue (${t.queue.length})` }))
    const q = el('div', { class: 'list-scroll' })
    for (const item of t.queue) {
      const full = `${item.topic} — ${item.user}`
      q.append(el('div', { class: 'row' }, el('span', { class: 'row-label', text: full, title: full })))
    }
    body.append(q)
  }

  body.append(el('div', { class: 'dim', text: 'topic bans' }))
  const bans = el('div', { class: 'list-scroll' })
  if (!t.bans.length) paneEmpty(bans, 'none')
  t.bans.forEach((b, i) => {
    const row = el('div', { class: `row${isSelected('trivia', i) ? ' selected' : ''}` })
    row.append(el('span', { class: 'row-label', text: b.topic, title: b.topic }))
    row.append(el('span', { class: 'dim', text: ttl(b.minutes) }))
    const unban = el('button', { text: 'unban' })
    unban.type = 'button'
    unban.addEventListener('click', () => doAct({ kind: 'topic-unban', topic: b.topic }))
    row.append(unban)
    bans.append(row)
  })
  body.append(bans)

  const controls = el('div', { class: 'pane-controls' })
  const topicInput = el('input', {}) as HTMLInputElement
  topicInput.type = 'text'
  topicInput.placeholder = 'topic (optional)'
  topicInput.autocomplete = 'off'
  topicInput.spellcheck = false
  topicInputEl = topicInput
  const startBtn = el('button', { text: 'start' })
  startBtn.type = 'button'
  const start = (): void => {
    doAct({ kind: 'trivia-start', topic: topicInput.value.trim() || undefined })
    topicInput.value = ''
  }
  startBtn.addEventListener('click', start)
  topicInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); start() } })
  const skipBtn = el('button', { text: 'skip' })
  skipBtn.type = 'button'
  skipBtn.addEventListener('click', () => doAct({ kind: 'trivia-skip' }))
  controls.append(topicInput, startBtn, skipBtn)
  body.append(controls)
}

function renderDepths(snap: Snapshot): void {
  const body = paneBody.depths
  clear(body)
  body.append(el('div', { class: 'row' }, el('span', { class: 'row-label', text: snap.depths, title: snap.depths })))
  const controls = el('div', { class: 'pane-controls' })
  controls.append(confirmButton('depths-reset', 'reset', () => doAct({ kind: 'depths-reset' })))
  body.append(controls)
}

function renderRaid(snap: Snapshot): void {
  const body = paneBody.raid
  clear(body)
  const stateRow = el('div', { class: 'row' })
  stateRow.append(el('span', { class: snap.raid.enabled ? 'ok' : 'dim', text: snap.raid.enabled ? 'on' : 'off' }))
  if (snap.raid.enabled) {
    stateRow.append(confirmButton('raid-off', 'turn off', () => doAct({ kind: 'raid', on: false })))
  } else {
    const onBtn = el('button', { text: 'turn on' })
    onBtn.type = 'button'
    onBtn.addEventListener('click', () => doAct({ kind: 'raid', on: true }))
    stateRow.append(onBtn)
  }
  body.append(stateRow)

  const paceRow = el('div', { class: 'row' })
  paceRow.append(el('span', { class: 'dim', text: 'pace' }))
  for (const p of PACES) {
    const b = el('button', { class: p === snap.raid.pace ? 'selected' : '', text: p })
    b.type = 'button'
    b.addEventListener('click', () => doAct({ kind: 'raid-pace', pace: p }))
    paceRow.append(b)
  }
  body.append(paceRow)
}

function renderAi(snap: Snapshot): void {
  const body = paneBody.ai
  clear(body)
  const a = snap.ai
  const enabledRow = el('div', { class: 'row' })
  enabledRow.append(el('span', { class: a.enabled ? 'ok' : 'dim', text: a.enabled ? 'enabled' : 'disabled' }))
  const toggle = el('button', { text: a.enabled ? 'disable' : 'enable' })
  toggle.type = 'button'
  toggle.addEventListener('click', () => doAct({ kind: 'ai', on: !a.enabled }))
  enabledRow.append(toggle)
  body.append(enabledRow)

  body.append(el('div', { class: 'row' }, el('span', { class: a.breaker ? 'danger' : 'ok', text: a.breaker ? 'breaker open' : 'breaker closed' })))
  body.append(el('div', { class: 'row' }, el('span', { class: 'dim', text: `slots ${a.slots} · queue ${a.queue}` })))
  if (a.hardStop) body.append(el('div', { class: 'row' }, el('span', { class: 'danger row-label', text: a.hardStop, title: a.hardStop })))
  body.append(el('div', { class: 'row' }, el('span', { class: 'dim row-label', text: `tokens today ${compactNum(a.tokensToday)} · calls ${a.callsToday}` })))
  body.append(el('div', { class: 'row' }, el('span', { class: 'dim row-label', text: `global tokens ${compactNum(a.globalTokensToday)} · searches ${a.searchesToday}` })))
}

function renderAsks(snap: Snapshot): void {
  const body = paneBody.asks
  clear(body)
  const list = el('div', { class: 'list-scroll' })
  if (!snap.asks.length) paneEmpty(list, 'no asks yet')
  for (const a of snap.asks) {
    const full = `${a.user}: ${a.query} → ${a.response}`
    const row = el('div', { class: 'row ask-row' })
    row.append(el('span', { class: 'ask-line', text: full, title: full }))
    list.append(row)
  }
  body.append(list)
}

function renderAudit(snap: Snapshot): void {
  const body = paneBody.audit
  clear(body)
  const list = el('div', { class: 'list-scroll' })
  if (!snap.audit.length) paneEmpty(list, 'no actions yet')
  for (const a of snap.audit) {
    const line = `${relTime(a.ts)} ${a.login} ${a.detail || a.action}`
    const row = el('div', { class: 'row audit-row' })
    row.append(el('span', { class: 'audit-line', text: line, title: line }))
    list.append(row)
  }
  body.append(list)
}

function renderIgnored(snap: Snapshot): void {
  const body = paneBody.ignored
  clear(body)
  const list = el('div', { class: 'list-scroll' })
  if (!snap.ignored.length) paneEmpty(list, 'nobody ignored')
  snap.ignored.forEach((row, i) => {
    const r = el('div', { class: `row${isSelected('ignored', i) ? ' selected' : ''}` })
    r.append(el('span', { class: 'row-label', text: row.login, title: row.login }))
    r.append(el('span', { class: 'dim', text: `by ${row.by}` }))
    r.append(el('span', { class: 'dim', text: row.minutes == null ? '∞' : ttl(row.minutes) }))
    const x = el('button', { text: 'x' })
    x.type = 'button'
    x.addEventListener('click', () => doAct({ kind: 'unignore', user: row.login }))
    r.append(x)
    list.append(r)
  })
  body.append(list)

  const controls = el('div', { class: 'pane-controls' })
  const nameInput = el('input', {}) as HTMLInputElement
  nameInput.type = 'text'
  nameInput.placeholder = 'ignore @user'
  nameInput.autocomplete = 'off'
  nameInput.spellcheck = false
  ignoreInputEl = nameInput
  controls.append(nameInput)
  for (const [label, minutes] of IGNORE_DURATIONS) {
    const b = el('button', { text: label })
    b.type = 'button'
    b.addEventListener('click', () => {
      const user = nameInput.value.trim().replace(/^@/, '')
      if (!user) return
      doAct(minutes === undefined ? { kind: 'ignore', user } : { kind: 'ignore', user, minutes })
      nameInput.value = ''
    })
    controls.append(b)
  }
  body.append(controls)
}

function renderPanes(): void {
  const snap = state.snap
  for (const key of PANE_ORDER) {
    paneEl[key].classList.toggle('focused', focusedPaneKey() === key)
  }
  if (!snap) {
    for (const key of PANE_ORDER) {
      clear(paneBody[key])
      paneEmpty(paneBody[key], 'waiting for data…')
    }
    return
  }
  renderPauses(snap)
  renderVibes(snap)
  renderTrivia(snap)
  renderAsks(snap)
  renderAudit(snap)
  renderRaid(snap)
  renderAi(snap)
  renderDepths(snap)
  renderIgnored(snap)
}

function renderAll(): void {
  renderHeader()
  renderPanes()
}

// --- command bar --------------------------------------------------------------------------

function focusCmd(): void {
  cmdInput.focus()
}

function clearCmd(): void {
  cmdInput.value = ''
  cmdPreview.textContent = ''
  cmdPreview.className = 'cmd-preview'
  state.cmdAction = null
}

async function runParse(text: string): Promise<void> {
  const seq = ++parseSeq
  try {
    const res = await fetch('/api/parse', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: state.channel, text }),
    })
    if (seq !== parseSeq) return
    if (res.status === 401) { showLogin(); return }
    if (res.status === 403) { setStatus('not allowed', 'fail'); return }
    const data = await res.json() as { action: Action | null; preview?: string }
    state.cmdAction = data.action
    if (data.action) {
      cmdPreview.textContent = `→ ${data.preview ?? ''}`
      cmdPreview.className = 'cmd-preview'
    } else {
      cmdPreview.textContent = "didn't catch that"
      cmdPreview.className = 'cmd-preview err'
    }
  } catch {
    if (seq === parseSeq) {
      cmdPreview.textContent = 'request failed'
      cmdPreview.className = 'cmd-preview err'
    }
  }
}

function bindCmdBar(): void {
  cmdInput.addEventListener('input', () => {
    const text = cmdInput.value
    window.clearTimeout(cmdDebounce)
    if (!text.trim()) { clearCmd(); return }
    cmdDebounce = window.setTimeout(() => runParse(text), 200)
  })
  cmdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (state.cmdAction) { doAct(state.cmdAction); clearCmd() }
    } else if (e.key === 'Escape') {
      clearCmd()
      cmdInput.blur()
    }
  })
}

// --- say box / admin strip -----------------------------------------------------------------

function sendSay(): void {
  const text = sayInput.value.trim()
  if (!text || text.length > SAY_MAX) return
  doAct({ kind: 'say', text })
  sayInput.value = ''
}

function bindSay(): void {
  sayBtn.addEventListener('click', sendSay)
  sayInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendSay() } })
}

function bindAdmin(): void {
  joinBtn.addEventListener('click', () => {
    const target = joinInput.value.trim().toLowerCase()
    if (!target) return
    doAct({ kind: 'join', target })
    joinInput.value = ''
  })
  joinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); joinBtn.click() } })
  partBtn.addEventListener('click', () => {
    triggerConfirm('part', () => doAct({ kind: 'part', target: state.channel }))
  })
}

// --- keyboard ------------------------------------------------------------------------------

function blurActive(): void {
  const a = document.activeElement
  if (a instanceof HTMLElement && a !== document.body) a.blur()
}

function handleGlobalKey(e: KeyboardEvent): void {
  if (state.helpOpen) {
    if (e.key === '?' || e.key === 'Escape') { closeHelp(); e.preventDefault() }
    return
  }
  if (e.key === 'Escape') {
    blurActive()
    cancelPauseArm()
    state.confirmArmed = null
    setStatus('')
    renderAll()
    return
  }
  if (isTypingTarget(e.target)) return

  if (state.pauseArm === 'feature') { handlePauseFeatureKey(e.key); renderAll(); return }
  if (state.pauseArm === 'minutes') { handlePauseMinutesKey(e.key); renderAll(); return }

  if (e.key === '?') { openHelp(); e.preventDefault(); return }
  if (e.key === ':') { focusCmd(); e.preventDefault(); return }
  if (e.key === '/') { sayInput.focus(); e.preventDefault(); return }
  if (/^[1-9]$/.test(e.key)) { switchChannelByIndex(Number(e.key) - 1); return }

  switch (e.key) {
    case 'p': armPauseMenu(); break
    case 'r': resumeSelectedPause(); break
    case 'x': dropSelectedVibe(); unignoreSelected(); break
    case 'u': unignoreSelected(); break
    case 'i': state.focusedPane = PANE_ORDER.indexOf('ignored'); ignoreInputEl?.focus(); break
    case 't': state.focusedPane = PANE_ORDER.indexOf('trivia'); topicInputEl?.focus(); break
    case 's': doAct({ kind: 'trivia-skip' }); break
    case 'j': moveSelection(1); break
    case 'k': moveSelection(-1); break
    case 'h': movePane(-1); break
    case 'l': movePane(1); break
    case 'Tab': movePane(e.shiftKey ? -1 : 1); e.preventDefault(); break
    case 'Enter': activateSelected(); break
    default: return
  }
  renderAll()
}

// --- init ------------------------------------------------------------------------------------

async function init(): Promise<void> {
  bindCmdBar()
  bindSay()
  bindAdmin()
  logoutBtn.addEventListener('click', doLogout)
  document.addEventListener('keydown', handleGlobalKey)

  const me = await fetchMe()
  if (!me) { showLogin(); return }
  state.me = me
  showMain()
  renderHeader()

  if (!me.channels.length) {
    setStatus('no channels available for this account', 'fail')
    return
  }
  state.channel = restoreChannel(me.channels)
  renderAll()
  connectStream(state.channel)
  window.setInterval(checkStale, 2000)
}

init()
