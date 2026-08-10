// Per-channel companion-secret rotation state.
// Sparse map channelId -> version. An absent channel is version 0, which derives
// the legacy secret — so a missing file is valid fresh state and unrotated
// channels never need migration. A corrupt file throws instead of being ignored:
// silently starting with an empty map would resurrect every rotated-away secret.

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

function rotationsPath(): string {
  return process.env.ROTATIONS_PATH ?? join(homedir(), '.bazaarinfo-rotations.json')
}

let versions: Record<string, number> | null = null

function parseRotations(raw: string): Record<string, number> {
  const data = JSON.parse(raw)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('rotations file is not an object')
  }
  for (const [channel, v] of Object.entries(data)) {
    if (!Number.isInteger(v) || (v as number) < 1) {
      throw new Error(`rotations file has invalid version for channel ${channel}`)
    }
  }
  return data as Record<string, number>
}

// Returns the number of rotated channels. Throws on a corrupt file — the caller
// must refuse to start rather than fail open.
export function loadRotations(): number {
  let raw: string
  try {
    raw = readFileSync(rotationsPath(), 'utf-8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      versions = {}
      return 0
    }
    throw e
  }
  versions = parseRotations(raw)
  return Object.keys(versions).length
}

function ensureLoaded(): Record<string, number> {
  if (!versions) loadRotations()
  return versions!
}

export function getVersion(channelId: string): number {
  return ensureLoaded()[channelId] ?? 0
}

// Persist-then-commit: the new version hits disk (atomic temp+rename) before it
// hits memory. A failed write throws and leaves both unchanged — the old secret
// keeps working, which beats a rotation that evaporates on restart.
export function bumpVersion(channelId: string): number {
  const current = ensureLoaded()
  const next = { ...current, [channelId]: (current[channelId] ?? 0) + 1 }
  const path = rotationsPath()
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(next))
  renameSync(tmp, path)
  versions = next
  return next[channelId]
}

export function rotationCount(): number {
  return Object.keys(ensureLoaded()).length
}
