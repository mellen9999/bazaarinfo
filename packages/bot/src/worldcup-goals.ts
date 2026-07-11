import { fetchWorldCup, type WcData, type WcMatch } from './worldcup'
import { log } from './log'

// posts a concise announcement in OFFLINE chats when a world cup goal goes in.
// piggybacks on worldcup.ts's fetcher (which also refreshes the shared query cache),
// so a live match costs 4 tiny ESPN requests per minute total. dormant off-tournament:
// empty slate → next check hours away, zero requests wasted, zero chat noise.
// live channels never get a line — soccer spam over a stream is worse than silence.

const LIVE_POLL_MS = 15_000
const IDLE_POLL_MS = 10 * 60_000
const DORMANT_POLL_MS = 6 * 60 * 60_000
const PRUNE_MS = 48 * 60 * 60 * 1000

interface Tracked {
  announced: [number, number] // last score chat was told (or silently seeded)
  live: boolean // seen in-play at least once — gates the FT line
  final: boolean // FT already announced
  date: string
}

export type GoalState = Map<string, Tracked>

const keyOf = (m: WcMatch) => `${m.date}|${m.teams[0].name}|${m.teams[1].name}`

// "45'" / "90'+7'" carry a digit worth showing; "HT"/"Half" etc. do too — but a
// bare empty detail gets no parens
const minuteTag = (detail: string) => (detail ? ` (${detail})` : '')

function ftLine(m: WcMatch): string {
  const [a, b] = m.teams
  const score = `${a.name} ${a.score}-${b.score} ${b.name}`
  if (a.shootout != null && b.shootout != null) {
    const w = a.shootout > b.shootout ? a : b
    const l = w === a ? b : a
    return `⚽ full time — ${score}, ${w.name} wins ${w.shootout}-${l.shootout} on pens`
  }
  return `⚽ full time — ${score}` // winner is legible from the score; only pens need words
}

// pure diff: compares the fresh scoreboard against tracked state, mutates state,
// returns the lines to post. first sighting of any match seeds silently — a bot
// restart mid-match must never replay history into chat.
export function diffAnnouncements(data: WcData, state: GoalState, now = Date.now()): string[] {
  const out: string[] = []
  for (const [k, t] of state) {
    if (now - new Date(t.date).getTime() > PRUNE_MS) state.delete(k)
  }
  for (const m of data.matches) {
    if (m.state === 'pre') continue
    const k = keyOf(m)
    const [a, b] = m.teams
    const t = state.get(k)
    if (!t) {
      state.set(k, { announced: [a.score, b.score], live: m.state === 'in', final: m.state === 'post', date: m.date })
      continue
    }
    if (m.state === 'in') {
      t.live = true
      const [pa, pb] = t.announced
      if (a.score !== pa || b.score !== pb) {
        const line = a.score > pa || b.score > pb
          ? `⚽ goal — ${a.name} ${a.score}-${b.score} ${b.name}${minuteTag(m.detail)}`
          : `⚽ goal disallowed — ${a.name} ${a.score}-${b.score} ${b.name}${minuteTag(m.detail)}`
        out.push(line)
        t.announced = [a.score, b.score]
      }
    } else if (m.state === 'post' && t.live && !t.final) {
      out.push(ftLine(m))
      t.final = true
      t.announced = [a.score, b.score]
    }
  }
  return out
}

// poll cadence from the slate: 15s while anything is (or should be) in play,
// clamp to the next kickoff when one is coming, hours when the window is quiet.
export function nextDelay(data: WcData, now = Date.now()): number {
  const liveish = data.matches.some(
    (m) => m.state === 'in' || (m.state === 'pre' && Date.parse(m.date) <= now),
  )
  if (liveish) return LIVE_POLL_MS
  const upcoming = data.matches
    .filter((m) => m.state === 'pre')
    .map((m) => Date.parse(m.date))
    .filter((t) => Number.isFinite(t) && t > now)
  if (upcoming.length) return Math.min(Math.max(Math.min(...upcoming) - now, LIVE_POLL_MS), IDLE_POLL_MS)
  return DORMANT_POLL_MS
}

type Say = (channel: string, msg: string) => void

const tracked: GoalState = new Map()
let timer: ReturnType<typeof setTimeout> | null = null

export function startGoalWatch(say: Say, offlineChannels: () => string[]) {
  const tick = async () => {
    let delay = DORMANT_POLL_MS
    try {
      const data = await fetchWorldCup()
      if (data) {
        const msgs = diffAnnouncements(data, tracked)
        if (msgs.length > 0) {
          const chs = offlineChannels()
          for (const msg of msgs) {
            log(`worldcup goal: ${msg} → ${chs.length} offline channel(s)`)
            for (const ch of chs) say(ch, msg)
          }
        }
        delay = nextDelay(data)
      } else {
        delay = IDLE_POLL_MS // fetch failed — retry on the idle cadence, never a hot loop
      }
    } catch (e) {
      log(`worldcup goalwatch: ${e}`)
      delay = IDLE_POLL_MS
    }
    timer = setTimeout(tick, delay)
  }
  timer = setTimeout(tick, 5_000) // stay off the boot path
}

export function stopGoalWatch() {
  if (timer) clearTimeout(timer)
  timer = null
  tracked.clear()
}
