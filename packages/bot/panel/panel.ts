// mods-only control center. vanilla ts, no deps, bundled by Bun.build into panel.js.
// every string on this page is untrusted chat/user content — DOM is built with
// textContent/attributes only, never innerHTML, so it's XSS-safe by construction.
//
// render contract: every free-text input is a STATIC node (declared once in index.html,
// looked up once via $()) that a box's rebuild never touches — typing/focus survive a
// snapshot arriving mid-keystroke. each box rebuilds only when its own slice of the
// snapshot (plus, for boxes with a row selection, a local "ui revision" counter) actually
// changed, compared as JSON — a live trivia round ticking every 2s must not blow away
// what a mod is mid-typing in an unrelated box.

import type { Snapshot, Action } from '../src/control'

// --- types derived from the server contract (no runtime import — types only) -----------

type Feature = Snapshot['pauses'][number]['feature']
type Pace = Snapshot['raid']['pace']
type BoxKey = 'switches' | 'chatrules' | 'trivia' | 'questions' | 'activity' | 'people' | 'raidgeon' | 'log'
type Tab = { ch: string; live: boolean; viewers: number | null }

interface Me { login: string; admin: boolean; channels: string[] }

const PACES: Pace[] = ['fast', 'normal', 'slow']
const IGNORE_DURATIONS: [string, number | undefined][] = [['1h', 60], ['24h', 1440], ['7d', 10080], ['forever', undefined]]
const BOX_ORDER: BoxKey[] = ['switches', 'chatrules', 'trivia', 'questions', 'activity', 'people', 'raidgeon', 'log']
const CHANNEL_KEY = 'bzi-panel-channel'
const SAY_MAX = 450
const STALE_MS = 10_000
const SPARK_CHARS = '▁▂▃▄▅▆▇█'

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

function btn(text: string, title: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', { text, title, class: cls })
  b.type = 'button'
  b.addEventListener('click', onClick)
  return b
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

function formatUptime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  return `${m}m`
}

function sparkLine(vals: number[]): string {
  const max = Math.max(1, ...vals)
  return vals.map((v) => SPARK_CHARS[Math.min(SPARK_CHARS.length - 1, Math.floor((v / max) * (SPARK_CHARS.length - 1)))]).join('')
}

// square text meter: [████░░░░] — 10 cells, filled by ratio. plain brackets rather than
// the eighth-block glyphs (▕▏) — those aren't in every monospace font's coverage and
// rendered as tofu on at least one real check; █/░ are near-universal.
function meterBar(used: number, cap: number, width = 10): string {
  if (cap <= 0) return ''
  const ratio = Math.max(0, Math.min(1, used / cap))
  const filled = Math.round(ratio * width)
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`
}

// --- state ------------------------------------------------------------------------------

interface ConfirmArm { key: string; expiresAt: number }

interface PanelState {
  me: Me | null
  channel: string
  snap: (Snapshot & { tabs?: Tab[] }) | null
  lastSnapAt: number
  es: EventSource | null
  focusedBox: number
  selection: Partial<Record<BoxKey, number>>
  confirmArmed: ConfirmArm | null
  pauseArm: 'feature' | 'minutes' | null
  pauseFeature: Feature | null
  cmdAction: Action | null
  helpOpen: boolean
  questionsMode: 'asks' | 'misses'
  uiRev: number
}

const state: PanelState = {
  me: null,
  channel: '',
  snap: null,
  lastSnapAt: 0,
  es: null,
  focusedBox: 0,
  selection: {},
  confirmArmed: null,
  pauseArm: null,
  pauseFeature: null,
  cmdAction: null,
  helpOpen: false,
  questionsMode: 'asks',
  uiRev: 0,
}

let esBackoff = 1000
let cmdDebounce = 0
let parseSeq = 0

// --- static dom refs ------------------------------------------------------------------

const loginScreen = $<HTMLDivElement>('login-screen')
const mainScreen = $<HTMLDivElement>('main-screen')
const channelTabs = $<HTMLElement>('channel-tabs')
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
const actionStatus = $<HTMLDivElement>('action-status')
const helpOverlay = $<HTMLDivElement>('help-overlay')
const questionsTitle = $<HTMLElement>('questions-title')

// inputs that must NEVER be recreated by a box rebuild — a snapshot arriving mid-keystroke
// (a trivia round ticks the panel every 2s) would otherwise wipe what's being typed.
const topicInput = $<HTMLInputElement>('topic-input')
const triviaStartBtn = $<HTMLButtonElement>('trivia-start-btn')
const triviaSkipBtn = $<HTMLButtonElement>('trivia-skip-btn')
const ignoreInput = $<HTMLInputElement>('ignore-input')

const boxEl: Record<BoxKey, HTMLElement> = {
  switches: $('pane-switches'), chatrules: $('pane-chatrules'), trivia: $('pane-trivia'),
  questions: $('pane-questions'), activity: $('pane-activity'), people: $('pane-people'),
  raidgeon: $('pane-raidgeon'), log: $('pane-log'),
}
const boxBody: Record<BoxKey, HTMLElement> = {
  switches: $('switches-body'), chatrules: $('chatrules-body'), trivia: $('trivia-body'),
  questions: $('questions-body'), activity: $('activity-body'), people: $('people-body'),
  raidgeon: $('raidgeon-body'), log: $('log-body'),
}
// sub-containers inside boxes whose outer shell (index.html) already holds the static
// inputs — only these lists get rebuilt, never the box body itself for trivia/people.
const triviaRoundEl = $<HTMLElement>('trivia-round')
const triviaQueueEl = $<HTMLElement>('trivia-queue')
const triviaBansEl = $<HTMLElement>('trivia-bans')
const peopleIgnoredEl = $<HTMLElement>('people-ignored')
const peopleTimedOutEl = $<HTMLElement>('people-timedout')
const peopleTopEl = $<HTMLElement>('people-top')

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
      state.snap = JSON.parse(ev.data) as Snapshot & { tabs?: Tab[] }
      state.lastSnapAt = Date.now()
      esBackoff = 1000
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

function isStale(): boolean {
  return !!state.snap && Date.now() - state.lastSnapAt > STALE_MS
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
    bumpUi()
    return
  }
  state.confirmArmed = { key, expiresAt: Date.now() + 3000 }
  bumpUi()
  window.setTimeout(() => {
    if (state.confirmArmed?.key === key) { state.confirmArmed = null; bumpUi() }
  }, 3100)
}

function confirmButton(key: string, label: string, title: string, run: () => void): HTMLButtonElement {
  const armed = confirmArmedNow(key)
  return btn(armed ? 'again to confirm' : label, armed ? 'click again within 3s to confirm' : title, () => triggerConfirm(key, run), armed ? 'danger' : '')
}

// bumps the ui revision so selection/confirm-armed-dependent boxes rebuild even though
// nothing in the snapshot itself changed (a keypress, not a server push).
function bumpUi(): void {
  state.uiRev++
  renderAll()
}

// --- selection / box focus ---------------------------------------------------------------

function focusedBoxKey(): BoxKey {
  return BOX_ORDER[state.focusedBox] ?? 'switches'
}

function boxRowCount(key: BoxKey): number {
  if (!state.snap) return 0
  switch (key) {
    case 'chatrules': return state.snap.vibes.length
    case 'trivia': return state.snap.trivia.bans.length
    case 'questions': return state.questionsMode === 'asks' ? state.snap.asks.length : state.snap.misses.length
    case 'people': return state.snap.ignored.length
    default: return 0
  }
}

function selectionIndex(key: BoxKey): number {
  const count = boxRowCount(key)
  if (count === 0) return -1
  const cur = state.selection[key] ?? 0
  return Math.min(Math.max(cur, 0), count - 1)
}

function isSelected(key: BoxKey, idx: number): boolean {
  return focusedBoxKey() === key && selectionIndex(key) === idx
}

function moveBox(dir: number): void {
  const n = BOX_ORDER.length
  state.focusedBox = ((state.focusedBox + dir) % n + n) % n
}

function moveSelection(dir: number): void {
  const key = focusedBoxKey()
  const count = boxRowCount(key)
  if (count === 0) return
  const cur = selectionIndex(key)
  state.selection[key] = (cur + dir + count) % count
}

function jumpSelection(toEnd: boolean): void {
  const key = focusedBoxKey()
  const count = boxRowCount(key)
  if (count === 0) return
  state.selection[key] = toEnd ? count - 1 : 0
}

function pauseEntryFor(f: Feature): { by: string; minutes: number } | undefined {
  if (!state.snap) return undefined
  const allEntry = state.snap.pauses.find((p) => p.feature === 'all')
  return state.snap.pauses.find((p) => p.feature === f) ?? (f !== 'all' ? allEntry : undefined)
}

function purgeSelectedQuestion(): void {
  if (!state.snap || focusedBoxKey() !== 'questions' || state.questionsMode !== 'asks') return
  const idx = selectionIndex('questions')
  const row = idx >= 0 ? state.snap.asks[idx] : undefined
  if (row) triggerConfirm(`ask-purge-${row.id}`, () => doAct({ kind: 'ask-purge', id: row.id }))
}

function ignoreSelectedAsker(): void {
  if (!state.snap || focusedBoxKey() !== 'questions' || state.questionsMode !== 'asks') return
  const idx = selectionIndex('questions')
  const row = idx >= 0 ? state.snap.asks[idx] : undefined
  if (row) triggerConfirm(`ignore-${row.user}`, () => doAct({ kind: 'ignore', user: row.user, minutes: 1440 }))
}

function flipQuestionsMode(): void {
  state.questionsMode = state.questionsMode === 'asks' ? 'misses' : 'asks'
  state.selection.questions = 0
}

function unignoreSelected(): void {
  if (!state.snap || focusedBoxKey() !== 'people') return
  const idx = selectionIndex('people')
  const row = idx >= 0 ? state.snap.ignored[idx] : undefined
  if (row) doAct({ kind: 'unignore', user: row.login })
}

function dropSelectedVibe(): void {
  if (!state.snap || focusedBoxKey() !== 'chatrules') return
  const idx = selectionIndex('chatrules')
  const v = idx >= 0 ? state.snap.vibes[idx] : undefined
  if (v) doAct({ kind: 'vibe-drop', index: v.n })
}

function unbanSelectedTopic(): void {
  if (!state.snap || focusedBoxKey() !== 'trivia') return
  const idx = selectionIndex('trivia')
  const ban = idx >= 0 ? state.snap.trivia.bans[idx] : undefined
  if (ban) doAct({ kind: 'topic-unban', topic: ban.topic })
}

// --- pause-arm ("p" then feature then minutes) --------------------------------------------

function cancelPauseArm(): void {
  state.pauseArm = null
  state.pauseFeature = null
}

function armPauseMenu(): void {
  state.pauseArm = 'feature'
  setStatus('pause: t)rivia d)ungeon a)i A)ll · esc cancel')
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
  actionStatus.textContent = msg
  actionStatus.className = `status-line${kind ? ` ${kind}` : ''}`
  actionStatus.hidden = !msg // no message → the bar itself takes no space, not just blank
}

const HELP_ROWS: [string, string][] = [
  ['1-9', 'switch channel'],
  ['j / k', 'move selection'],
  ['g / G', 'top / bottom of box'],
  ['h / l, tab / shift-tab', 'move between boxes'],
  ['enter', 'activate selected'],
  ['p then t/d/a/A then 1/3/6', 'pause menu'],
  ['r', 'resume selected pause'],
  ['x', 'drop vibe / lift ignore (whichever box is focused)'],
  ['D', 'remove selected question\'s reply (confirm)'],
  ['I', 'ignore the selected asker 24h (confirm)'],
  ['f', 'flip questions box: answered / didn\'t answer'],
  ['i', 'focus the ignore-user box'],
  ['t', 'start trivia (focus topic box)'],
  ['s', 'skip trivia round'],
  ['/', 'focus the say box'],
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

// --- render: header + status line -----------------------------------------------------------

function renderHeader(): void {
  const me = state.me
  clear(channelTabs)
  if (me) {
    const tabs = state.snap?.tabs
    me.channels.forEach((ch, i) => {
      const info = tabs?.find((t) => t.ch === ch)
      const tab = el('button', { class: `channel-tab${ch === state.channel ? ' active' : ''}`, title: `switch to #${ch}` })
      if (i < 9) tab.append(el('span', { class: 'num', text: `${i + 1}` }))
      tab.append(el('span', { class: `dot${info?.live ? ' live' : ''}` }))
      tab.append(document.createTextNode(ch))
      if (info?.live && info.viewers != null) tab.append(el('span', { class: 'dim', text: ` ${compactNum(info.viewers)}` }))
      tab.addEventListener('click', () => switchChannel(ch))
      channelTabs.append(tab)
    })
    whoami.textContent = me.admin ? `${me.login} (admin)` : me.login
    adminStrip.hidden = !me.admin
  }
  partBtn.textContent = confirmArmedNow('part') ? 'again to confirm' : 'leave current'
  partBtn.classList.toggle('danger', confirmArmedNow('part'))
}

function brainLabel(ai: Snapshot['ai']): { text: string; cls: string } {
  if (ai.breaker) return { text: 'brain: overloaded', cls: 'danger' }
  if (ai.hardStop) {
    const back = ai.hardStopUntil ? ` · back ${new Date(ai.hardStopUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''
    return { text: `brain: out of credit${back}`, cls: 'danger' }
  }
  return { text: 'brain: ok', cls: 'ok' }
}

function renderStatusLine(): void {
  clear(statusLine)
  const snap = state.snap
  if (!snap) { statusLine.append(el('span', { class: 'dim', text: 'connecting…' })); return }

  // built as a list of present chunks, joined with │ only BETWEEN them — a field that
  // isn't available yet (health, before index.ts wires it up) must never leave a
  // dangling separator with nothing after it.
  const chunks: HTMLElement[] = []

  const s = snap.stream
  chunks.push(el('span', { class: 'status-seg' }, el('span', { class: `dot${s.live ? ' live' : ''}` }),
    document.createTextNode(s.live ? 'live' : 'offline'),
    ...(s.live && s.viewers != null ? [document.createTextNode(` ${compactNum(s.viewers)}`)] : []),
    ...(s.game ? [document.createTextNode(` · ${s.game}`)] : []),
    ...(s.live && s.startedAt ? [document.createTextNode(` · ${formatUptime((snap.now - s.startedAt) / 1000)}`)] : [])))

  const h = snap.health
  chunks.push(el('span', { class: 'status-seg', title: h?.irc ? 'the bot can currently send and receive chat' : 'the bot has lost its chat connection' },
    el('span', { class: `dot${h?.irc ? ' live' : ' danger'}` }), document.createTextNode('chat link')))

  const brain = brainLabel(snap.ai)
  chunks.push(el('span', { class: 'status-seg' },
    el('span', { class: brain.cls, title: 'whether the bot can currently think (call the ai)' }, document.createTextNode(brain.text)),
    document.createTextNode(' · '),
    el('span', { class: 'dim', title: 'rounds being generated right now · rounds waiting their turn' },
      document.createTextNode(`thinking ${snap.ai.slots} · waiting ${snap.ai.queue}/${snap.ai.queueMax}`))))

  chunks.push(el('span', { class: 'status-seg dim', title: 'real-world facts looked up today, out of the daily cap' },
    document.createTextNode(`web searches ${snap.ai.searchesToday}/${snap.ai.searchCap}`)))

  if (h) {
    chunks.push(el('span', { class: 'status-seg' },
      el('span', { class: 'dim', title: 'chat messages sent in the last 30 seconds, out of the limit' }, document.createTextNode(`messages ${h.sends.used}/${h.sends.limit}`)),
      document.createTextNode(' · '),
      el('span', { class: h.privileged ? 'ok-dim' : 'warn', title: h.privileged ? 'the bot is a mod here — full speed' : 'the bot is not a mod here — slower message limit' },
        document.createTextNode(h.privileged ? 'bot is mod ✓' : 'bot is not mod (slow lane)'))))
    chunks.push(el('span', { class: 'status-seg dim', title: 'how long the bot has been running without a restart' }, document.createTextNode(`up ${formatUptime(h.uptimeSec)}`)))
  }

  chunks.forEach((c, i) => {
    if (i > 0) statusLine.append(el('span', { class: 'status-sep', text: '│' }))
    statusLine.append(c)
  })
  if (isStale()) statusLine.append(el('span', { class: 'warn', title: 'the live connection to the bot dropped — this may be out of date' }, document.createTextNode(' · stale')))
}

// --- render: switches box ------------------------------------------------------------------

interface SwitchDef { label: string; tip: string; feature?: Feature; on?: boolean; toggle?: (on: boolean) => void }

function switchDefs(snap: Snapshot): SwitchDef[] {
  return [
    { label: 'bot replies', tip: 'whether the bot answers questions in this chat at all', feature: 'ai', on: snap.ai.enabled, toggle: (on) => doAct({ kind: 'ai', on }) },
    { label: 'trivia', tip: 'the trivia game', feature: 'trivia' },
    { label: 'dungeon', tip: 'the depths dungeon game', feature: 'depths' },
    { label: 'raid', tip: 'the raid game', on: snap.raid.enabled, toggle: (on) => doAct({ kind: 'raid', on }) },
    { label: 'goal alerts', tip: 'unprompted world cup goal announcements in this chat', on: snap.goals, toggle: (on) => doAct({ kind: 'goals', on }) },
  ]
}

const PAUSE_CHIPS: [string, number][] = [['15m', 15], ['30m', 30], ['1h', 60]]

// one line per switch: label · state dot+text · buttons. `stateOn: null` renders the
// paused (yellow) dot — a pause is neither "on" nor "off", it's a timer.
function switchRow(label: string, tip: string, stateOn: boolean | null, stateText: string, buttons: HTMLElement[]): HTMLDivElement {
  const row = el('div', { class: 'row switch-row' })
  row.append(el('span', { class: 'switch-label', text: label, title: tip }))
  row.append(el('span', { class: 'switch-state' },
    el('span', { class: `dot${stateOn === null ? ' warn' : stateOn ? ' live' : ' danger'}` }),
    document.createTextNode(stateText)))
  row.append(el('div', { class: 'switch-btns' }, ...buttons))
  return row
}

function renderSwitches(snap: Snapshot): void {
  const body = boxBody.switches
  clear(body)
  for (const def of switchDefs(snap)) {
    const entry = def.feature ? pauseEntryFor(def.feature) : undefined
    if (entry) {
      body.append(switchRow(def.label, def.tip, null, `paused ${ttl(entry.minutes)}`,
        [btn('resume', `turn ${def.label} back on now`, () => doAct({ kind: 'resume', feature: def.feature! }))]))
      continue
    }
    const on = def.toggle ? !!def.on : true
    const buttons: HTMLElement[] = []
    // button text is the action it performs (the state you'd land in), not a repeat of
    // the state readout to its left — "off" while on means "click to turn it off"
    if (def.toggle) buttons.push(btn(on ? 'off' : 'on', `turn ${def.label} ${on ? 'off' : 'on'}`, () => def.toggle!(!on)))
    if (def.feature) for (const [label, m] of PAUSE_CHIPS) buttons.push(btn(label, `pause ${def.label} for ${label}`, () => doAct({ kind: 'pause', feature: def.feature!, minutes: m })))
    body.append(switchRow(def.label, def.tip, on, on ? 'on' : 'off', buttons))
  }
  if (state.me?.admin) {
    const on = snap.ai.aiTrivia
    body.append(switchRow('ai trivia', 'whether the ai can write brand-new trivia questions — applies to every channel', on, on ? 'on' : 'off',
      [btn(on ? 'off' : 'on', `turn ai trivia ${on ? 'off' : 'on'}, everywhere`, () => doAct({ kind: 'ai-trivia', on: !on }))]))
  }
}

// --- render: chat rules (vibes) box ---------------------------------------------------------

function renderChatRules(snap: Snapshot): void {
  const body = boxBody.chatrules
  clear(body)
  const list = el('div', { class: 'list-scroll' })
  if (!snap.vibes.length) list.append(el('div', { class: 'pane-empty', text: 'no chat rules right now' }))
  snap.vibes.forEach((v, i) => {
    const row = el('div', { class: `row${isSelected('chatrules', i) ? ' selected' : ''}` })
    row.append(el('span', { class: v.mod ? 'warn' : 'info', text: v.mod ? 'mod' : 'viewer' }))
    const who = v.target ? `${v.planter} →${v.target}` : v.planter
    const what = v.mute ? 'mute' : v.instruction
    const full = `${who}: ${what}`
    row.append(el('span', { class: 'row-label', text: `${who} — ${what}`, title: full }))
    row.append(el('span', { class: 'dim', text: ttl(v.minutes) }))
    row.append(btn('x', 'drop this chat rule', () => doAct({ kind: 'vibe-drop', index: v.n })))
    list.append(row)
  })
  body.append(list)
  const controls = el('div', { class: 'pane-controls' })
  controls.append(confirmButton('vibe-clear', 'clear all', 'drop every chat rule at once', () => doAct({ kind: 'vibe-clear' })))
  body.append(controls)
}

// --- render: trivia box (round/queue/bans rebuild; topic input+buttons are static) ----------

function renderTrivia(snap: Snapshot): void {
  const t = snap.trivia
  clear(triviaRoundEl)
  if (t.round) {
    triviaRoundEl.append(el('span', { class: 'info row-label', text: t.round.question, title: t.round.question }))
    triviaRoundEl.append(el('span', { class: 'dim', text: `${t.round.secondsLeft}s` }))
    triviaRoundEl.append(el('span', { class: 'dim', text: `${t.round.guesses} guesses` }))
  } else {
    triviaRoundEl.append(el('span', { class: 'dim', text: 'no game running' }))
  }

  clear(triviaQueueEl)
  if (t.queue.length) {
    for (const item of t.queue) {
      const full = `${item.topic} — ${item.user}`
      triviaQueueEl.append(el('div', { class: 'row' }, el('span', { class: 'row-label', text: full, title: full })))
    }
  }

  clear(triviaBansEl)
  if (!t.bans.length) triviaBansEl.append(el('div', { class: 'pane-empty', text: 'none' }))
  t.bans.forEach((b, i) => {
    const row = el('div', { class: `row${isSelected('trivia', i) ? ' selected' : ''}` })
    row.append(el('span', { class: 'row-label', text: b.topic, title: b.topic }))
    row.append(el('span', { class: 'dim', text: ttl(b.minutes) }))
    row.append(btn('unban', `allow "${b.topic}" trivia again`, () => doAct({ kind: 'topic-unban', topic: b.topic })))
    triviaBansEl.append(row)
  })
}

// --- render: questions box (asks / didn't answer, toggled with 'f') -------------------------

function renderQuestions(snap: Snapshot): void {
  const body = boxBody.questions
  clear(body)
  const asks = state.questionsMode === 'asks'
  questionsTitle.textContent = asks ? 'questions' : "didn't answer"
  const list = el('div', { class: 'list-scroll' })
  if (asks) {
    if (!snap.asks.length) list.append(el('div', { class: 'pane-empty', text: 'no questions yet' }))
    snap.asks.forEach((a, i) => {
      const row = el('div', { class: `row q-row${isSelected('questions', i) ? ' selected' : ''}` })
      row.append(el('span', { class: 'q-age', text: relTime(new Date(`${a.at}Z`).getTime()) }))
      row.append(el('span', { class: 'q-user', text: a.user, title: a.user }))
      const full = `${a.query} → ${a.response}`
      row.append(el('span', { class: 'q-line', text: full, title: full }))
      if (a.latencyMs != null) row.append(el('span', { class: 'q-ms', text: `${(a.latencyMs / 1000).toFixed(1)}s` }))
      list.append(row)
    })
  } else {
    if (!snap.misses.length) list.append(el('div', { class: 'pane-empty', text: "the bot hasn't missed anything recently" }))
    snap.misses.forEach((m, i) => {
      const row = el('div', { class: `row q-row${isSelected('questions', i) ? ' selected' : ''}` })
      row.append(el('span', { class: 'q-age', text: relTime(new Date(`${m.at}Z`).getTime()) }))
      row.append(el('span', { class: 'q-user', text: m.user, title: m.user }))
      row.append(el('span', { class: 'q-line', text: m.query, title: m.query }))
      row.append(el('span', { class: 'q-miss-reason', text: m.reason, title: m.reason }))
      list.append(row)
    })
  }
  body.append(list)
  body.append(el('div', { class: 'q-hint', title: 'keyboard shortcuts while this box is focused' },
    document.createTextNode(`f: switch to ${asks ? "didn't answer" : 'questions'} · D: remove reply · I: ignore asker 24h`)))
}

// --- render: activity box (sparkline + meters) ------------------------------------------------

function renderActivity(snap: Snapshot): void {
  const body = boxBody.activity
  clear(body)
  body.append(el('div', { class: 'dim', title: 'questions asked per minute, over the last hour' }, document.createTextNode('questions / min (last hour)')))
  const peak = Math.max(0, ...snap.spark)
  if (peak === 0) {
    body.append(el('div', { class: 'dim' }, document.createTextNode('quiet — 0 questions in the last hour')))
  } else {
    body.append(el('div', { class: 'spark', title: `busiest minute: ${peak}` }, document.createTextNode(sparkLine(snap.spark))))
  }

  const a = snap.ai
  if (a.tokenCap > 0) {
    const used = a.tokensToday
    const ratio = used / a.tokenCap
    const cls = ratio >= 1 ? 'danger' : ratio >= 0.8 ? 'warn' : ''
    body.append(el('div', { class: 'meter-row' },
      el('div', { class: 'meter-label', title: 'how many words of thinking the bot has spent today, out of today\'s cap' },
        el('span', { class: 'dim', text: 'words used' }), el('span', { class: 'dim', text: `${compactNum(used)} / ${compactNum(a.tokenCap)}` })),
      el('div', { class: `meter-bar ${cls}`, text: meterBar(used, a.tokenCap) })))
  } else {
    body.append(el('div', { class: 'meter-row' },
      el('div', { class: 'meter-label', title: 'how many words of thinking the bot has spent today — no cap is set' },
        el('span', { class: 'dim', text: 'words used today' }), el('span', { class: 'dim', text: compactNum(a.tokensToday) }))))
  }

  body.append(el('div', { class: 'meter-row' },
    el('div', { class: 'meter-label', title: 'real-world facts looked up today, out of the daily cap' },
      el('span', { class: 'dim', text: 'web searches' }), el('span', { class: 'dim', text: `${a.searchesToday} / ${a.searchCap}` })),
    el('div', { class: `meter-bar${a.searchesToday >= a.searchCap ? ' danger' : ''}`, text: meterBar(a.searchesToday, a.searchCap) })))

  if (snap.health) {
    const h = snap.health
    body.append(el('div', { class: 'meter-row' },
      el('div', { class: 'meter-label', title: 'chat messages sent in the last 30 seconds, out of the limit' },
        el('span', { class: 'dim', text: 'messages (30s)' }), el('span', { class: 'dim', text: `${h.sends.used} / ${h.sends.limit}` })),
      el('div', { class: `meter-bar${h.sends.used >= h.sends.limit ? ' danger' : ''}`, text: meterBar(h.sends.used, h.sends.limit) })))
    if (h.lastDrop) {
      body.append(el('div', { class: 'danger', title: 'the last time twitch refused to deliver one of the bot\'s messages' },
        document.createTextNode(`last dropped message: ${relTime(h.lastDrop.at)} ago (${h.lastDrop.reason})`)))
    }
    body.append(el('div', { class: 'dim', title: 'how stale the game data (items, cards, etc) is' }, document.createTextNode(`game data: ${h.dataAgeSec < 0 ? 'unknown' : `${formatUptime(h.dataAgeSec)} old`}`)))
  }
}

// --- render: people box (ignoring / timed out / top askers) -----------------------------------

function renderPeople(snap: Snapshot): void {
  clear(peopleIgnoredEl)
  if (!snap.ignored.length) peopleIgnoredEl.append(el('div', { class: 'pane-empty', text: 'nobody ignored' }))
  snap.ignored.forEach((row, i) => {
    const r = el('div', { class: `row${isSelected('people', i) ? ' selected' : ''}` })
    r.append(el('span', { class: 'row-label', text: row.login, title: row.login }))
    r.append(el('span', { class: 'dim', text: `by ${row.by}` }))
    r.append(el('span', { class: 'dim', text: row.minutes == null ? '∞' : ttl(row.minutes) }))
    r.append(btn('x', 'let the bot reply to this person again', () => doAct({ kind: 'unignore', user: row.login })))
    peopleIgnoredEl.append(r)
  })

  clear(peopleTimedOutEl)
  if (!snap.timedOut.length) peopleTimedOutEl.append(el('div', { class: 'pane-empty', text: 'nobody' }))
  for (const row of snap.timedOut) {
    peopleTimedOutEl.append(el('div', { class: 'row', title: 'twitch timed this person out — not the bot\'s doing' },
      el('span', { class: 'row-label', text: row.login }), el('span', { class: 'dim', text: `${ttl(row.minutesLeft)} left` })))
  }

  clear(peopleTopEl)
  if (!snap.topUsers.length) peopleTopEl.append(el('div', { class: 'pane-empty', text: 'nobody yet today' }))
  for (const u of snap.topUsers) {
    const row = el('div', { class: 'row top-user-row' })
    row.append(el('span', { class: 'row-label', text: u.user, title: u.user }))
    row.append(el('span', { class: 'top-user-cap', title: 'ai questions used today, out of the daily limit', text: u.cap > 0 ? `${u.units} / ${u.cap}` : `${u.units}` }))
    row.append(btn('reset', `give ${u.user} their questions back for today`, () => triggerConfirm(`cap-reset-${u.user}`, () => doAct({ kind: 'cap-reset', user: u.user })), confirmArmedNow(`cap-reset-${u.user}`) ? 'danger' : ''))
    peopleTopEl.append(row)
  }
}

// --- render: raid + dungeon box ----------------------------------------------------------------

function renderRaidgeon(snap: Snapshot): void {
  const body = boxBody.raidgeon
  clear(body)
  const raidRow = el('div', { class: 'row' })
  raidRow.append(el('span', { class: 'dim', text: 'raid' }))
  raidRow.append(el('span', { class: snap.raid.enabled ? 'ok-dim' : 'dim', text: snap.raid.enabled ? 'on' : 'off' }))
  body.append(raidRow)

  const paceRow = el('div', { class: 'row', title: 'how fast the raid game moves' })
  paceRow.append(el('span', { class: 'dim', text: 'raid speed' }))
  for (const p of PACES) paceRow.append(btn(p, `set raid speed to ${p}`, () => doAct({ kind: 'raid-pace', pace: p }), p === snap.raid.pace ? 'selected' : ''))
  body.append(paceRow)

  body.append(el('div', { class: 'row', title: 'the dungeon\'s current run' }, el('span', { class: 'row-label', text: snap.depths, title: snap.depths })))
  const controls = el('div', { class: 'pane-controls' })
  controls.append(confirmButton('depths-reset', 'reset dungeon', 'end the current dungeon run and start fresh', () => doAct({ kind: 'depths-reset' })))
  body.append(controls)
}

// --- render: log box (audit trail) --------------------------------------------------------------

function renderLog(snap: Snapshot): void {
  const body = boxBody.log
  clear(body)
  const list = el('div', { class: 'list-scroll' })
  if (!snap.audit.length) list.append(el('div', { class: 'pane-empty', text: 'no actions yet' }))
  for (const a of snap.audit) {
    const what = a.detail || a.action
    const row = el('div', { class: 'row audit-row' })
    row.append(el('span', { class: 'q-age', text: relTime(a.ts) }))
    row.append(el('span', { class: 'q-user', text: a.login, title: a.login }))
    row.append(el('span', { class: 'audit-line', text: what, title: what }))
    row.append(el('span', { class: 'audit-source', text: a.source, title: a.source === 'chat' ? 'done by typing in twitch chat' : 'done from this panel' }))
    list.append(row)
  }
  body.append(list)
}

// --- render orchestration: rebuild a box only when its slice (+ ui state) changed -------------

const lastBoxJson: Partial<Record<BoxKey, string>> = {}
const SELECTABLE: ReadonlySet<BoxKey> = new Set(['chatrules', 'trivia', 'questions', 'people'])

function sliceFor(key: BoxKey, snap: Snapshot): unknown {
  switch (key) {
    case 'switches': return { ai: snap.ai.enabled, aiTrivia: snap.ai.aiTrivia, pauses: snap.pauses, raid: snap.raid.enabled, goals: snap.goals, admin: state.me?.admin }
    case 'chatrules': return snap.vibes
    case 'trivia': return snap.trivia
    case 'questions': return state.questionsMode === 'asks' ? snap.asks : snap.misses
    case 'activity': return { spark: snap.spark, ai: snap.ai, health: snap.health }
    case 'people': return { ignored: snap.ignored, timedOut: snap.timedOut, topUsers: snap.topUsers }
    case 'raidgeon': return { raid: snap.raid, depths: snap.depths }
    case 'log': return snap.audit
  }
}

const RENDERERS: Record<BoxKey, (snap: Snapshot) => void> = {
  switches: renderSwitches, chatrules: renderChatRules, trivia: renderTrivia, questions: renderQuestions,
  activity: renderActivity, people: renderPeople, raidgeon: renderRaidgeon, log: renderLog,
}

// trivia and people own static children (topic/ignore inputs + buttons, declared once in
// index.html) that must never be wiped — only their own sub-lists get cleared here, so the
// pre-first-snapshot paint can never destroy them the way a whole-body clear would.
function renderTriviaEmpty(): void {
  clear(triviaRoundEl)
  triviaRoundEl.append(el('span', { class: 'dim', text: 'no game running' }))
  clear(triviaQueueEl)
  clear(triviaBansEl)
  triviaBansEl.append(el('div', { class: 'pane-empty', text: 'none' }))
}

function renderPeopleEmpty(): void {
  for (const list of [peopleIgnoredEl, peopleTimedOutEl, peopleTopEl]) {
    clear(list)
    list.append(el('div', { class: 'pane-empty', text: '—' }))
  }
}

function renderBoxes(): void {
  const snap = state.snap
  for (const key of BOX_ORDER) boxEl[key].classList.toggle('focused', focusedBoxKey() === key)
  if (!snap) {
    for (const key of BOX_ORDER) {
      if (key === 'trivia') { renderTriviaEmpty(); continue }
      if (key === 'people') { renderPeopleEmpty(); continue }
      clear(boxBody[key])
      boxBody[key].append(el('div', { class: 'pane-empty', text: 'waiting for data…' }))
    }
    return
  }
  for (const key of BOX_ORDER) {
    // selectable boxes fold the ui revision into their cache key so a bare keypress (no
    // snapshot change) still redraws the selection highlight / confirm-armed state.
    const json = JSON.stringify(sliceFor(key, snap)) + (SELECTABLE.has(key) ? `::${state.uiRev}::${state.focusedBox}` : '')
    if (lastBoxJson[key] === json) continue
    lastBoxJson[key] = json
    RENDERERS[key](snap)
  }
}

function renderAll(): void {
  renderHeader()
  renderStatusLine()
  renderBoxes()
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

// --- say box / admin strip / trivia / ignore (static inputs) --------------------------------

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

function bindTrivia(): void {
  const start = (): void => {
    doAct({ kind: 'trivia-start', topic: topicInput.value.trim() || undefined })
    topicInput.value = ''
  }
  triviaStartBtn.addEventListener('click', start)
  topicInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); start() } })
  triviaSkipBtn.addEventListener('click', () => doAct({ kind: 'trivia-skip' }))
}

function bindIgnore(): void {
  const ids = ['ignore-1h-btn', 'ignore-24h-btn', 'ignore-7d-btn', 'ignore-forever-btn'] as const
  ids.forEach((id, i) => {
    const [, minutes] = IGNORE_DURATIONS[i]
    $<HTMLButtonElement>(id).addEventListener('click', () => {
      const user = ignoreInput.value.trim().replace(/^@/, '')
      if (!user) return
      doAct(minutes === undefined ? { kind: 'ignore', user } : { kind: 'ignore', user, minutes })
      ignoreInput.value = ''
    })
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
    bumpUi()
    return
  }
  if (isTypingTarget(e.target)) return

  if (state.pauseArm === 'feature') { handlePauseFeatureKey(e.key); bumpUi(); return }
  if (state.pauseArm === 'minutes') { handlePauseMinutesKey(e.key); bumpUi(); return }

  if (e.key === '?') { openHelp(); e.preventDefault(); return }
  if (e.key === ':') { focusCmd(); e.preventDefault(); return }
  if (e.key === '/') { sayInput.focus(); e.preventDefault(); return }
  if (/^[1-9]$/.test(e.key)) { switchChannelByIndex(Number(e.key) - 1); return }

  switch (e.key) {
    case 'p': armPauseMenu(); break
    case 'r': {
      const key = focusedBoxKey()
      if (key === 'switches') {
        const idx = state.selection.switches ?? 0
        const def = state.snap ? switchDefs(state.snap)[idx] : undefined
        if (def?.feature) doAct({ kind: 'resume', feature: def.feature })
      }
      break
    }
    case 'x': {
      const key = focusedBoxKey()
      if (key === 'chatrules') dropSelectedVibe()
      else if (key === 'people') unignoreSelected()
      break
    }
    case 'D': purgeSelectedQuestion(); break
    case 'I': ignoreSelectedAsker(); break
    case 'f': flipQuestionsMode(); break
    case 'i': state.focusedBox = BOX_ORDER.indexOf('people'); ignoreInput.focus(); break
    case 't': state.focusedBox = BOX_ORDER.indexOf('trivia'); topicInput.focus(); break
    case 's': doAct({ kind: 'trivia-skip' }); break
    case 'j': moveSelection(1); break
    case 'k': moveSelection(-1); break
    case 'g': jumpSelection(false); break
    case 'G': jumpSelection(true); break
    case 'h': moveBox(-1); break
    case 'l': moveBox(1); break
    case 'Tab': moveBox(e.shiftKey ? -1 : 1); e.preventDefault(); break
    case 'Enter': {
      const key = focusedBoxKey()
      if (key === 'chatrules') { /* enter has no distinct action beyond x here */ }
      else if (key === 'trivia') unbanSelectedTopic()
      else if (key === 'people') unignoreSelected()
      break
    }
    default: return
  }
  bumpUi()
}

// --- init ------------------------------------------------------------------------------------

async function init(): Promise<void> {
  bindCmdBar()
  bindSay()
  bindAdmin()
  bindTrivia()
  bindIgnore()
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
  window.setInterval(renderStatusLine, 2000) // ticks the "stale" flag + relative times
}

init()
