// keep heatsync's pins equal to the channels we're in. every entry point is fire-and-forget:
// a failure just means the next boot reconcile fixes it. outcomes log once each, no spam.
import * as hs from './hslogs'
import { log } from './log'

const said = new Set<string>()

const PLAIN: Record<string, string> = {
  pin_quota: 'this key hit its pin quota',
  platform_unsupported: 'platform not supported for pins',
  channel_denied: 'key is not allowed on this channel',
  scope_denied: 'key lacks the pin scope',
  api_key_invalid: 'key rejected by heatsync',
  pins_full: 'heatsync pin list is full',
  channel_unavailable: 'channel is delisted or does not exist',
  twitch_unavailable: 'heatsync could not reach twitch',
}

function say(channel: string, code: string): void {
  const k = `${channel}|${code}`
  if (said.has(k)) return
  said.add(k)
  log(`hslogs-pins: #${channel} not pinned: ${PLAIN[code] ?? code}`)
}

export function resetPinNotes(): void { said.clear() }

async function put(channel: string): Promise<void> {
  const r = await hs.pin(channel)
  if (r && !r.ok) say(channel, r.code)
}

async function del(channel: string): Promise<void> {
  const r = await hs.unpin(channel)
  if (r && !r.ok && r.code !== 'http_404') say(channel, r.code)
}

/** desired = every joined channel. pins what's missing, drops extras this key owns. */
export async function reconcilePins(desired: string[]): Promise<void> {
  try {
    if (!hs.hslogsEnabled()) return
    const want = new Set(desired.map((c) => c.toLowerCase()))
    const list = await hs.listPins()
    if (!list) return
    const haveSet = new Set(list.channels)
    for (const c of want) if (!haveSet.has(c)) await put(c)
    for (const c of haveSet) if (!want.has(c)) await del(c)
    log(`hslogs-pins: reconciled want=${want.size} had=${haveSet.size}${list.quota ? ` quota=${list.quota.used}/${list.quota.max}` : ''}`)
  } catch {}
}

export function pinChannel(channel: string): void {
  if (!hs.hslogsEnabled()) return
  void put(channel.toLowerCase()).catch(() => {})
}

export function unpinChannel(channel: string): void {
  if (!hs.hslogsEnabled()) return
  void del(channel.toLowerCase()).catch(() => {})
}
