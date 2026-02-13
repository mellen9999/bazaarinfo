import { homedir } from 'os'
import { resolve } from 'path'
import { chmod, rename } from 'fs/promises'
import { log } from './log'

const CHANNELS_PATH = resolve(homedir(), '.bazaarinfo-channels.json')

export async function load(): Promise<string[]> {
  try {
    return await Bun.file(CHANNELS_PATH).json()
  } catch {
    return []
  }
}

async function save(channels: string[]) {
  const tmp = CHANNELS_PATH + '.tmp'
  await Bun.write(tmp, JSON.stringify(channels, null, 2))
  await chmod(tmp, 0o600)
  await rename(tmp, CHANNELS_PATH)
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
