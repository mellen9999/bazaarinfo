import * as store from './store'
import { log } from './log'

const API_KEY = process.env.ANTHROPIC_API_KEY

export interface BoardItem {
  name: string
  matched: boolean
  tier?: string
}

export interface BoardState {
  hero?: string
  playerItems: BoardItem[]
  opponentItems: BoardItem[]
  capturedAt: number
  channel: string
}

const boardStates = new Map<string, BoardState>()
const lastCapture = new Map<string, number>()

export const BOARD_TTL = 10 * 60_000
const BOARD_CAPTURE_CD = 30_000
const BOARD_SETTLED_CD = 3 * 60_000
const AUTO_TICK = 30_000

// --- HLS URL cache (avoid spawning streamlink every capture) ---
const hlsUrls = new Map<string, { url: string; fetchedAt: number }>()
const HLS_URL_TTL = 30 * 60_000 // Twitch HLS tokens last ~6h, refresh every 30min to be safe

async function getHlsUrl(channel: string): Promise<string | null> {
  const cached = hlsUrls.get(channel)
  if (cached && Date.now() - cached.fetchedAt < HLS_URL_TTL) return cached.url

  // streamlink --stream-url just prints the m3u8 URL, no download
  const proc = Bun.spawn(
    ['streamlink', '--stream-url', `twitch.tv/${channel}`, 'best'],
    { stdout: 'pipe', stderr: 'ignore' },
  )
  const exited = await Promise.race([
    proc.exited,
    new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 15_000)),
  ])
  if (exited === 'timeout') { proc.kill(); return null }
  if (exited !== 0) return null

  const url = (await new Response(proc.stdout).text()).trim()
  if (!url || !url.startsWith('http')) return null
  hlsUrls.set(channel, { url, fetchedAt: Date.now() })
  log(`board: cached HLS URL for ${channel}`)
  return url
}

async function captureFrame(channel: string, tmpPath: string): Promise<boolean> {
  const hlsUrl = await getHlsUrl(channel)
  if (!hlsUrl) {
    // fallback: invalidate cache and fail — next tick will retry
    hlsUrls.delete(channel)
    return false
  }

  // fetch m3u8 playlist, grab first .ts segment URL, pipe through ffmpeg
  try {
    const playlistRes = await fetch(hlsUrl, { signal: AbortSignal.timeout(10_000) })
    if (!playlistRes.ok) { hlsUrls.delete(channel); return false }
    const playlist = await playlistRes.text()
    const segUrl = playlist.split('\n').find((l) => l.startsWith('http') && l.includes('.ts'))
    if (!segUrl) { hlsUrls.delete(channel); return false }

    // download segment + extract single frame — ~0.6s vs ~10s with streamlink
    const proc = Bun.spawn(
      ['bash', '-c', `curl -s "${segUrl}" | ffmpeg -y -i pipe: -frames:v 1 -update 1 -q:v 3 ${tmpPath} 2>/dev/null`],
      { stdout: 'ignore', stderr: 'ignore' },
    )
    const exited = await Promise.race([
      proc.exited,
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 10_000)),
    ])
    if (exited === 'timeout') { proc.kill(); return false }
    return exited === 0
  } catch {
    hlsUrls.delete(channel)
    return false
  }
}

let autoTimer: ReturnType<typeof setInterval> | null = null
let liveCheck: () => string[] = () => []
let gameCheck: (ch: string) => string | undefined = () => undefined

const BAZAAR_GAME = 'the bazaar'

export function startAutoCapture(getLiveChannels: () => string[], getGame: (ch: string) => string | undefined) {
  liveCheck = getLiveChannels
  gameCheck = getGame
  if (autoTimer) return
  autoTimer = setInterval(async () => {
    const channels = liveCheck()
    for (const ch of channels) {
      const game = gameCheck(ch)
      if (game && !game.toLowerCase().includes(BAZAAR_GAME)) continue
      const existing = getBoardState(ch)
      if (existing && Date.now() - existing.capturedAt < BOARD_SETTLED_CD) continue
      if (getBoardCooldown(ch) > 0) continue
      try {
        await captureBoard(ch, () => true)
      } catch (e) {
        log('auto board capture error:', e instanceof Error ? e.message : e)
      }
    }
  }, AUTO_TICK)
  log('board auto-capture started (30s until board found, then every 3min, Bazaar only)')
}

export function stopAutoCapture() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null }
}

export function getBoardState(channel: string): BoardState | null {
  const state = boardStates.get(channel.toLowerCase())
  if (!state) return null
  if (Date.now() - state.capturedAt > BOARD_TTL) {
    boardStates.delete(channel.toLowerCase())
    return null
  }
  return state
}

export function getBoardCooldown(channel: string): number {
  const last = lastCapture.get(channel.toLowerCase())
  if (!last) return 0
  const elapsed = Date.now() - last
  return elapsed >= BOARD_CAPTURE_CD ? 0 : Math.ceil((BOARD_CAPTURE_CD - elapsed) / 1000)
}

// tier 1: cheap Haiku call just to classify the scene (~$0.001)
const SCENE_PROMPT = `What scene from "The Bazaar" game is this? Return ONLY one word: board, shop, or other.
board = PvP combat with items on both sides. shop = buying items between rounds. other = menu/lobby/loading/transition/non-Bazaar.`

// tier 2: Sonnet reads card names (only called on board frames, ~$0.01)
const BOARD_PROMPT = `Return ONLY valid JSON, no markdown:
{"hero":null,"playerItems":[{"name":"exact item name","tier":null}],"opponentItems":[{"name":"exact item name","tier":null}]}
This is a Bazaar PvP board. Player items on bottom, opponent on top.
Read card names exactly. tier=Bronze/Silver/Gold/Diamond/Legendary if border visible, else null.
Only include items you can clearly read.`

function crossRef(name: string): BoardItem {
  const card = store.exact(name)
  if (card) return { name: card.Title, matched: true }
  const fuzzy = store.search(name, 1)
  if (fuzzy.length > 0) return { name: fuzzy[0].Title, matched: true }
  return { name, matched: false }
}

interface BoardResponse {
  hero: string | null
  playerItems: { name: string; tier: string | null }[]
  opponentItems: { name: string; tier: string | null }[]
}

async function visionCall(model: string, base64: string, prompt: string, maxTokens: number): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
          { type: 'text', text: prompt },
        ],
      }],
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`vision API ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json() as { content: { text: string }[] }
  return data.content?.[0]?.text ?? ''
}

export async function captureBoard(
  channel: string,
  isLive: () => boolean,
): Promise<{ state: BoardState | null; error?: string }> {
  const ch = channel.toLowerCase()

  const cd = getBoardCooldown(ch)
  if (cd > 0) {
    const cached = getBoardState(ch)
    if (cached) return { state: cached }
    return { state: null, error: `board scan on cooldown (${cd}s)` }
  }

  if (!isLive()) return { state: null, error: 'stream is offline' }
  if (!API_KEY) return { state: null, error: 'vision not configured' }

  lastCapture.set(ch, Date.now())
  const tmpPath = `/tmp/bazaarinfo-board-${ch}.jpg`

  try {
    const ok = await captureFrame(ch, tmpPath)
    if (!ok) return { state: null, error: "couldn't capture stream frame" }

    const file = Bun.file(tmpPath)
    if (!await file.exists()) return { state: null, error: "couldn't capture stream frame" }
    const buf = Buffer.from(await file.arrayBuffer())
    const base64 = buf.toString('base64')

    // tier 1: Haiku classifies the scene (~$0.001)
    const sceneText = (await visionCall('claude-haiku-4-5-20251001', base64, SCENE_PROMPT, 10)).trim().toLowerCase()
    const scene = sceneText.includes('board') ? 'board' : sceneText.includes('shop') ? 'shop' : 'other'

    if (scene !== 'board') {
      const existing = getBoardState(ch)
      if (existing) {
        log(`board scan ${ch}: ${scene} scene, keeping cached state (${existing.playerItems.length} items)`)
        return { state: existing }
      }
      log(`board scan ${ch}: ${scene} scene, no cached state`)
      return { state: null }
    }

    // tier 2: Sonnet reads card names (~$0.01, only on board frames)
    const boardText = await visionCall('claude-sonnet-4-6', base64, BOARD_PROMPT, 400)
    const jsonStr = boardText.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    const parsed: BoardResponse = JSON.parse(jsonStr)

    if (parsed.playerItems.length === 0 && parsed.opponentItems.length === 0) {
      const existing = getBoardState(ch)
      if (existing) {
        log(`board scan ${ch}: board scene but no items read, keeping cached (${existing.playerItems.length} items)`)
        return { state: existing }
      }
      return { state: null }
    }

    const state: BoardState = {
      hero: parsed.hero ?? undefined,
      playerItems: parsed.playerItems.map((i) => ({ ...crossRef(i.name), tier: i.tier ?? undefined })),
      opponentItems: parsed.opponentItems.map((i) => ({ ...crossRef(i.name), tier: i.tier ?? undefined })),
      capturedAt: Date.now(),
      channel: ch,
    }

    boardStates.set(ch, state)
    const names = state.playerItems.map((i) => i.name).join(', ')
    log(`board scan ${ch}: [${names}] vs ${state.opponentItems.length} opp`)
    return { state }
  } catch (e) {
    log('board capture error:', e instanceof Error ? e.message : e)
    return { state: null, error: 'board scan failed, try again' }
  } finally {
    try { const { unlinkSync } = await import('fs'); unlinkSync(tmpPath) } catch {}
  }
}

const TIER_INITIALS: Record<string, string> = {
  Bronze: 'B', Silver: 'S', Gold: 'G', Diamond: 'D', Legendary: 'L',
}

export function formatBoard(state: BoardState): string {
  const heroTag = state.hero ? `[${state.hero}] ` : ''
  const items = state.playerItems.map((i) => {
    const t = i.tier && TIER_INITIALS[i.tier] ? `(${TIER_INITIALS[i.tier]})` : ''
    return i.name + t
  }).join(', ')

  let opp = ''
  if (state.opponentItems.length > 0) {
    opp = ` | opp: ${state.opponentItems.length} items`
  }

  return `${heroTag}🎮 ${items}${opp}`
}

// for tests
export function _reset() {
  boardStates.clear()
  lastCapture.clear()
  hlsUrls.clear()
}
