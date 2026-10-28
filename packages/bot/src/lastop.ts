// !lastop: the channel owner's newest heatsync OP (a root post, not a reply). public read, no key.
const TTL = 60_000
const cache = new Map<string, { exp: number; line: string }>()

function base(): string {
  return (process.env.HEATSYNC_URL || 'https://heatsync.org').replace(/\/+$/, '')
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${base()}${path}`, { signal: AbortSignal.timeout(4000), headers: { Accept: 'application/json' } })
    return res.ok ? await res.json() as T : null
  } catch { return null }
}

function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000))
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

interface Post { base36_id?: string; content?: string; subject?: string | null; reply_to?: string | null; is_op?: boolean; created_at?: string }

export async function lastOp(owner: string): Promise<string> {
  const login = owner.toLowerCase()
  if (!/^[a-z0-9_]{1,25}$/.test(login)) return 'no op found'
  const hit = cache.get(login)
  if (hit && hit.exp > Date.now()) return hit.line
  const prof = await getJson<{ profile?: { id?: string } }>(`/api/profile/${login}`)
  const id = prof?.profile?.id
  if (!id || !/^\d+$/.test(id)) return `${login} isn't on heatsync`
  const r = await getJson<{ messages?: Post[] }>(`/api/messages?sort=time&time_range=all&limit=30&user_id=${id}`)
  if (!r) return 'heatsync is not answering'
  const op = (r.messages ?? []).find((p) => p.base36_id && !p.reply_to && p.created_at)
  if (!op) return `${login} has no ops on heatsync`
  const text = (op.subject?.trim() || op.content || '').replace(/\s+/g, ' ').trim()
  const clip = [...text].length > 200 ? [...text].slice(0, 199).join('') + '…' : text
  const line = `${login}'s last op (${ago(op.created_at!)}): ${clip} heatsync.org/thread/${Number.parseInt(op.base36_id!, 10)}`
  cache.set(login, { exp: Date.now() + TTL, line })
  return line
}
