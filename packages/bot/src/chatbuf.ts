interface ChatEntry {
  user: string
  text: string
}

const buffers = new Map<string, ChatEntry[]>()
const MAX_SIZE = 30

export function record(channel: string, user: string, text: string) {
  let buf = buffers.get(channel)
  if (!buf) {
    buf = []
    buffers.set(channel, buf)
  }
  buf.push({ user, text })
  if (buf.length > MAX_SIZE) buf.shift()
}

export function getRecent(channel: string, count: number): ChatEntry[] {
  const buf = buffers.get(channel)
  if (!buf) return []
  return buf.slice(-count)
}
