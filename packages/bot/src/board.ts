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
const BOARD_CAPTURE_CD = 30_000 // 30s retry when hunting for a board
const BOARD_SETTLED_CD = 3 * 60_000 // 3 min once we have a valid board
const AUTO_TICK = 30_000 // check every 30s

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
      // only capture when streamer is playing The Bazaar
      const game = gameCheck(ch)
      if (game && !game.toLowerCase().includes(BAZAAR_GAME)) continue
      const existing = getBoardState(ch)
      // if we have a fresh board state, wait the full 3min interval
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

const VISION_PROMPT = `This is a screenshot from "The Bazaar" (PvP auto-battler card game stream on Twitch).
Identify all item cards visible on the PvP combat board (both players).

Return ONLY valid JSON, no markdown fences:
{"scene":"board","hero":null,"playerItems":[{"name":"exact item name","tier":null}],"opponentItems":[{"name":"exact item name","tier":null}]}

scene must be one of:
- "board" — active PvP combat, items arranged on both sides
- "shop" — buying/selling between rounds (item cards with price tags)
- "other" — menu, lobby, loading, matchmaking, transition, victory/defeat screen, streamer's webcam only, non-Bazaar content

ONLY return items when scene="board". For "shop" or "other", return empty arrays.

Rules:
- Player board is on the bottom, opponent on top
- Read item names exactly as shown on the cards
- tier = "Bronze","Silver","Gold","Diamond","Legendary" if border color visible, else null
- Only include items you can clearly read — do NOT guess`

function crossRef(name: string): BoardItem {
  const card = store.exact(name)
  if (card) return { name: card.Title, matched: true }
  const fuzzy = store.search(name, 1)
  if (fuzzy.length > 0) return { name: fuzzy[0].Title, matched: true }
  return { name, matched: false }
}

interface VisionResponse {
  scene: 'board' | 'shop' | 'other'
  hero: string | null
  playerItems: { name: string; tier: string | null }[]
  opponentItems: { name: string; tier: string | null }[]
}

export async function captureBoard(
  channel: string,
  isLive: () => boolean,
): Promise<{ state: BoardState | null; error?: string }> {
  const ch = channel.toLowerCase()

  // check cooldown — return cached if available
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
    // capture a single frame via streamlink+ffmpeg
    const proc = Bun.spawn(
      ['bash', '-c', `streamlink --stdout twitch.tv/${ch} best 2>/dev/null | dd bs=2M count=1 iflag=fullblock 2>/dev/null | ffmpeg -y -i pipe: -frames:v 1 -update 1 -q:v 3 ${tmpPath} 2>/dev/null`],
      { stdout: 'ignore', stderr: 'ignore' },
    )
    const exited = await Promise.race([
      proc.exited,
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 30_000)),
    ])
    if (exited === 'timeout') {
      proc.kill()
      return { state: null, error: "couldn't capture stream frame" }
    }
    if (exited !== 0) return { state: null, error: "couldn't capture stream frame" }

    // read + base64 encode
    const file = Bun.file(tmpPath)
    if (!await file.exists()) return { state: null, error: "couldn't capture stream frame" }
    const buf = Buffer.from(await file.arrayBuffer())
    const base64 = buf.toString('base64')

    // vision API call
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
            { type: 'text', text: VISION_PROMPT },
          ],
        }],
      }),
      signal: AbortSignal.timeout(30_000),
    })

    if (!res.ok) {
      log(`board vision API ${res.status}:`, await res.text())
      return { state: null, error: 'board scan failed, try again' }
    }

    const data = await res.json() as { content: { text: string }[] }
    const text = data.content?.[0]?.text ?? ''
    const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    const parsed: VisionResponse = JSON.parse(jsonStr)

    const scene = parsed.scene ?? 'other'
    if (scene !== 'board' || (parsed.playerItems.length === 0 && parsed.opponentItems.length === 0)) {
      // non-board frame — keep existing cached state alive instead of nuking it
      const existing = getBoardState(ch)
      if (existing) {
        log(`board scan ${ch}: ${scene} scene, keeping cached state (${existing.playerItems.length} items)`)
        return { state: existing }
      }
      log(`board scan ${ch}: ${scene} scene, no cached state`)
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
    log(`board scan ${ch}: ${state.playerItems.length} player + ${state.opponentItems.length} opp items`)
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
}
