import { homedir } from 'os'
import { resolve } from 'path'
import { log } from './log'
import { writeAtomic } from './fs-util'

const CHANNELS_PATH = resolve(homedir(), '.bazaarinfo-channels.json')

export async function load(): Promise<string[]> {
  try {
    return await Bun.file(CHANNELS_PATH).json()
  } catch {
    return []
  }
}

async function save(channels: string[]) {
  await writeAtomic(CHANNELS_PATH, JSON.stringify(channels, null, 2))
}

export async function add(name: string): Promise<boolean> {
  const channels = await load()
  if (channels.includes(name)) return false
  channels.push(name)
  await save(channels)
  log(`channel stored: ${name}`)
  return true
}

export async function remove(name: string): Promise<boolean> {
  const channels = await load()
  const idx = channels.indexOf(name)
  if (idx === -1) return false
  channels.splice(idx, 1)
  await save(channels)
  log(`channel removed: ${name}`)
  return true
}
