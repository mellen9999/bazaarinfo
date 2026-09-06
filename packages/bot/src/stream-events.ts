// renders a twitch USERNOTICE (sub/resub/raid/gift/announce) into a chat-transcript line
// and a structured event for the per-user log. pure — no db, no network. the only state is
// an in-memory gift-train collapse map, reset per test via __resetTrainsForTest.
import { stripChatMessage } from './ai-build'
import type { IrcUserNotice } from './twitch'

export interface UserEvent {
  channel: string
  login: string
  kind: 'sub' | 'resub' | 'gift' | 'raid' | 'announce'
  detail: string
  months?: number
  count?: number
}

export interface RenderedUserNotice {
  text: string
  collapseKey?: string
  event?: UserEvent
}

// twitch sends N individual subgift notices right after a mass gift — those must not
// re-render (the mass-gift line already announced the total). a solo subgift (no mass
// gift precedes it) starts its own train so a SECOND solo gift from the same person
// collapses into a running count instead of stacking N separate chat lines.
const TRAIN_WINDOW_MS = 10 * 60_000
const TRAIN_CAP = 500

interface Train {
  count: number
  pendingBudget: number
  startedAt: number
}

const trains = new Map<string, Train>()

export function __resetTrainsForTest() {
  trains.clear()
}

function evictTrains(now: number) {
  if (trains.size <= TRAIN_CAP) return
  for (const [k, t] of trains) {
    if (now - t.startedAt > TRAIN_WINDOW_MS) trains.delete(k)
  }
  if (trains.size <= TRAIN_CAP) return
  // still over cap (pathological) — drop the oldest until back under
  const byAge = [...trains.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)
  for (const [k] of byAge) {
    if (trains.size <= TRAIN_CAP) break
    trains.delete(k)
  }
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

// user-typed text (resub note, announcement body) — strip any spoofed section header
// before it can masquerade as a context row, then cap so a wall of text can't eat the
// chat budget.
function capText(s: string): string {
  return stripChatMessage(s).slice(0, 200)
}

function planLabel(plan: string | undefined): string | null {
  if (plan === 'Prime') return 'prime'
  if (plan === '1000') return 'tier 1'
  if (plan === '2000') return 'tier 2'
  if (plan === '3000') return 'tier 3'
  return null
}

function isAnonGifter(login: string, displayName: string): boolean {
  return login.toLowerCase() === 'ananonymousgifter' || /^an anonymous/i.test(displayName)
}

// known type, but a param we need is missing/unparseable — never guess, fall back to
// twitch's own system-msg summary. empty/missing system-msg → nothing rendered at all.
function fallback(n: IrcUserNotice): RenderedUserNotice | null {
  return n.systemMsg ? { text: `* ${capText(n.systemMsg)}` } : null
}

export function renderUserNotice(n: IrcUserNotice): RenderedUserNotice | null {
  const now = Date.now()
  const p = n.params
  const name = n.displayName || n.login

  switch (n.msgId) {
    case 'raid': {
      const raiderLogin = (p['msg-param-login'] || n.login || '').toLowerCase()
      const raiderName = p['msg-param-displayName'] || raiderLogin
      const viewers = Number(p['msg-param-viewerCount'])
      if (!raiderLogin || !Number.isFinite(viewers)) return fallback(n)
      const viewerWord = viewers === 1 ? 'viewer' : 'viewers'
      const detail = `raided with ${formatCount(viewers)} ${viewerWord}`
      return {
        text: `* raid: ${raiderName} arrived with ${formatCount(viewers)} ${viewerWord}`,
        event: { channel: n.channel, login: raiderLogin, kind: 'raid', detail, count: viewers },
      }
    }

    case 'sub': {
      const plan = planLabel(p['msg-param-sub-plan'])
      if (!plan) return fallback(n)
      const detail = `subscribed (${plan})`
      return { text: `* ${name} ${detail}`, event: { channel: n.channel, login: n.login, kind: 'sub', detail } }
    }

    case 'resub': {
      const months = Number(p['msg-param-cumulative-months'])
      if (!Number.isFinite(months)) return fallback(n)
      const userText = n.text ? capText(n.text) : ''
      const quoted = userText ? `: "${userText}"` : ''
      const detail = `resubbed (${months} months)${quoted}`
      return {
        text: `* ${name} ${detail}`,
        event: { channel: n.channel, login: n.login, kind: 'resub', detail, months },
      }
    }

    case 'submysterygift': {
      const giftCount = Number(p['msg-param-mass-gift-count'])
      if (!Number.isFinite(giftCount) || giftCount <= 0) return fallback(n)
      const anon = isAnonGifter(n.login, n.displayName)
      const gifterLabel = anon ? 'an anonymous gifter' : name
      const key = `${n.channel}:${n.login.toLowerCase()}`
      let train = trains.get(key)
      if (!train || now - train.startedAt > TRAIN_WINDOW_MS) {
        train = { count: 0, pendingBudget: 0, startedAt: now }
        trains.set(key, train)
      }
      train.count += giftCount
      train.pendingBudget += giftCount
      evictTrains(now)
      const detail = `gifted ${train.count} subs`
      return {
        text: `* ${gifterLabel} gifted ${formatCount(train.count)} subs`,
        collapseKey: key,
        event: { channel: n.channel, login: n.login, kind: 'gift', detail, count: train.count },
      }
    }

    case 'subgift': {
      const recipientLogin = p['msg-param-recipient-user-name']
      const recipientName = p['msg-param-recipient-display-name'] || recipientLogin
      const anon = isAnonGifter(n.login, n.displayName)
      const gifterLabel = anon ? 'an anonymous gifter' : name
      const key = `${n.channel}:${n.login.toLowerCase()}`
      const train = trains.get(key)
      if (train && now - train.startedAt <= TRAIN_WINDOW_MS) {
        if (train.pendingBudget > 0) {
          // one of the N individual notices twitch sends after a mass gift — already
          // counted, don't re-render.
          train.pendingBudget -= 1
          return null
        }
        train.count += 1
        const detail = `gifted ${train.count} subs`
        return {
          text: `* ${gifterLabel} gifted ${formatCount(train.count)} subs`,
          collapseKey: key,
          event: { channel: n.channel, login: n.login, kind: 'gift', detail, count: train.count },
        }
      }
      // first gift ever from this gifter (or the prior train expired) — starts a fresh
      // train, singular render naming the recipient.
      if (!recipientLogin) return fallback(n)
      trains.set(key, { count: 1, pendingBudget: 0, startedAt: now })
      evictTrains(now)
      const detail = `gifted a sub to ${recipientLogin.toLowerCase()}`
      return {
        text: `* ${gifterLabel} gifted a sub to ${recipientName}`,
        collapseKey: key,
        event: { channel: n.channel, login: n.login, kind: 'gift', detail, count: 1 },
      }
    }

    case 'announcement': {
      const userText = n.text ? capText(n.text) : ''
      if (!userText) return fallback(n)
      // "[mod" is the exact token the system prompt already trusts for mod authority —
      // reuse it verbatim so an /announce inherits that rule with zero new prompt text.
      return {
        text: `* [mod announce] ${userText}`,
        event: { channel: n.channel, login: n.login, kind: 'announce', detail: userText },
      }
    }

    // twitch sends these but they carry nothing worth surfacing as chat context (a paid
    // upgrade is a resub twitch already announced separately; a channel-points reward
    // redemption/ritual/bits-badge/unraid are noise for this purpose). never emit raw tags.
    case 'giftpaidupgrade':
    case 'anongiftpaidupgrade':
    case 'rewardgift':
    case 'ritual':
    case 'bitsbadgetier':
    case 'unraid':
      return null

    default:
      // a msg-id twitch added that this bot doesn't know — never guess at its shape.
      return null
  }
}

// only a sub/resub note that opens with an explicit ask routes through the command
// pipeline as a real question — an announcement (a mod's /announce) never does, and a
// plain "thanks for the sub!" resub note is just chat colour, not a command.
export function routesAsAsk(n: IrcUserNotice, botName: string): boolean {
  if (n.msgId !== 'sub' && n.msgId !== 'resub') return false
  const t = n.text?.trim()
  if (!t) return false
  if (/^!b\b/i.test(t)) return true
  return new RegExp(`^@${botName}\\s+`, 'i').test(t)
}

// the per-user log, read back: "resubbed (14 months): "gg" 3d ago; gifted 20 subs 9d ago
// (#rogue)". detail is already a sentence fragment; only the age and a foreign channel
// are added. announcements are a mod's broadcast, not something the person "did" — skipped.
export function formatUserEvents(rows: { channel: string; kind: string; detail: string; created_at: string }[], channel: string, now = Date.now(), max = 3): string {
  const out: string[] = []
  for (const r of rows) {
    if (r.kind === 'announce') continue
    const age = ageOf(r.created_at, now)
    const where = r.channel.toLowerCase() === channel.toLowerCase() ? '' : ` (#${r.channel})`
    out.push(`${r.detail} ${age}${where}`)
    if (out.length >= max) break
  }
  return out.join('; ')
}

function ageOf(createdAt: string, now: number): string {
  const mins = Math.round((now - new Date(createdAt.replace(' ', 'T') + 'Z').getTime()) / 60_000)
  if (!Number.isFinite(mins) || mins < 0) return 'just now'
  return mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`
}
