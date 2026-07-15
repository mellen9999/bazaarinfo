import { fetchWorldCup, type WcData, type WcMatch } from './worldcup'
import { log } from './log'

// posts concise world cup announcements — kickoff, goals, and full time. piggybacks on
// worldcup.ts's fetcher (which also refreshes the shared query cache), so a live match
// costs 4 tiny ESPN requests per minute total. dormant off-tournament: empty slate →
// next check hours away, zero requests wasted, zero chat noise.
//
// audience is gated by the caller (index.ts): offline chats only, never over a live
// stream — soccer spam mid-broadcast is worse than silence.

const LIVE_POLL_MS = 15_000
const IDLE_POLL_MS = 10 * 60_000
const DORMANT_POLL_MS = 6 * 60 * 60_000
const PRUNE_MS = 48 * 60 * 60 * 1000

interface Tracked {
  announced: [number, number] // last score chat was told (or silently seeded)
  live: boolean // seen in-play at least once — gates the FT line
  final: boolean // FT already announced
  kicked: boolean // kickoff announced, or seeded past it (first seen already in/post)
  date: string
}

export type GoalState = Map<string, Tracked>

const keyOf = (m: WcMatch) => `${m.date}|${m.teams[0].name}|${m.teams[1].name}`

// "45'" / "90'+7'" carry a digit worth showing; "HT"/"Half" etc. do too — but a
// bare empty detail gets no parens
const minuteTag = (detail: string) => (detail ? ` (${detail})` : '')

// name the scorer(s) when ESPN's scoring plays line up with the score. the list
// also carries shootout pens, so trust the order only when its length equals the
// score sum — anything off falls back to the plain score line, never a wrong name.
function goalLine(m: WcMatch, prevTotal: number): string {
  const [a, b] = m.teams
  const score = `${a.name} ${a.score}-${b.score} ${b.name}`
  const goals = m.goals ?? []
  const total = a.score + b.score
  if (goals.length === total && total > prevTotal) {
    const fresh = goals.slice(prevTotal)
    if (fresh.every((g) => g.scorer && g.minute)) {
      const who = fresh
        .map((g) => `${g.scorer}${g.penalty ? ' (pen)' : g.ownGoal ? ' (og)' : ''} ${g.minute}`)
        .join(', ')
      return `⚽ ${who} — ${score}`
    }
  }
  return `⚽ goal — ${score}${minuteTag(m.detail)}`
}

function kickoffLine(m: WcMatch): string {
  const [a, b] = m.teams
  return `⚽ kickoff — ${a.name} vs ${b.name}`
}

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
    const k = keyOf(m)
    const [a, b] = m.teams
    const t = state.get(k)
    if (!t) {
      // first sighting seeds silently — a restart mid-tournament must never replay
      // history. kicked seeds true unless we caught the match while still pre, so only
      // a genuine pre→in transition we witnessed can fire a kickoff line.
      state.set(k, {
        announced: [a.score, b.score],
        live: m.state === 'in',
        final: m.state === 'post',
        kicked: m.state !== 'pre',
        date: m.date,
      })
      continue
    }
    if (m.state === 'in') {
      if (!t.kicked) {
        out.push(kickoffLine(m))
        t.kicked = true
      }
      t.live = true
      const [pa, pb] = t.announced
      if (a.score !== pa || b.score !== pb) {
        out.push(a.score > pa || b.score > pb
          ? goalLine(m, pa + pb)
          : `⚽ goal disallowed — ${a.name} ${a.score}-${b.score} ${b.name}${minuteTag(m.detail)}`)
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
            log(`worldcup: ${msg} → ${chs.length} channel(s)`)
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
