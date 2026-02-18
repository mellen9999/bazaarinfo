// in-memory ring buffer — cheap chat context for AI without hitting SQLite

interface ChatEntry {
  username: string
  message: string
  ts: number
}

const CHANNEL_SIZE = 50
const USER_SIZE = 15

const channelBufs = new Map<string, ChatEntry[]>()
const userBufs = new Map<string, ChatEntry[]>()

function push(buf: Map<string, ChatEntry[]>, key: string, entry: ChatEntry, maxSize: number) {
  let arr = buf.get(key)
  if (!arr) { arr = []; buf.set(key, arr) }
  arr.push(entry)
  if (arr.length > maxSize) arr.shift()
}

export function record(channel: string, username: string, message: string) {
  const entry = { username, message, ts: Date.now() }
  push(channelBufs, channel, entry, CHANNEL_SIZE)
  push(userBufs, username.toLowerCase(), entry, USER_SIZE)
}

export function getChannelChat(channel: string, limit = 25): ChatEntry[] {
  return (channelBufs.get(channel) ?? []).slice(-limit)
}

export function getUserChat(username: string, limit = 10): ChatEntry[] {
  return (userBufs.get(username.toLowerCase()) ?? []).slice(-limit)
}
