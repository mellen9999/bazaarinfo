import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { log } from './log'

export type NotifyPriority = 'low' | 'default' | 'high' | 'urgent'

interface AlertConfig {
  ntfyTopic?: string
  ntfyBase: string
}

const DEFAULT_BASE = 'https://ntfy.sh'
const DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000

// null = not loaded, or previously missing — retried on next call
let cached: AlertConfig | null = null
const lastSent = new Map<string, number>()

function alertEnvPath(): string {
  return process.env.BAZAARINFO_ALERT_ENV || join(homedir(), '.config/bazaarinfo/alert.env')
}

// shell-style KEY=value — tolerates `export ` prefix, #comments, quoted values; ignores malformed lines
function parseEnv(raw: string): AlertConfig {
  const vars: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(t)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    vars[m[1]] = v
  }
  return { ntfyTopic: vars.NTFY_TOPIC || undefined, ntfyBase: vars.NTFY_BASE || DEFAULT_BASE }
}

function loadConfig(): AlertConfig {
  if (cached) return cached
  try {
    cached = parseEnv(readFileSync(alertEnvPath(), 'utf8'))
    return cached
  } catch {
    // no config yet — stays null so the next call retries (e.g. file created after boot)
    return { ntfyBase: DEFAULT_BASE }
  }
}

// ntfy headers must be latin-1 safe
function asciiSafe(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, '')
}

// owner alert via ntfy, sharing systemd's config. always logs; ntfy send is best-effort
// and deduped per key (max once per 6h) so a hot failure loop can't spam the phone.
export async function notify(key: string, title: string, body: string, priority: NotifyPriority = 'default'): Promise<void> {
  log(`notify: ${key} — ${title}`)

  const cfg = loadConfig()
  if (!cfg.ntfyTopic) return

  const now = Date.now()
  const last = lastSent.get(key)
  if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return
  lastSent.set(key, now)

  try {
    await fetch(`${cfg.ntfyBase}/${cfg.ntfyTopic}`, {
      method: 'POST',
      body,
      headers: {
        Title: asciiSafe(title),
        Priority: priority,
      },
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    // ntfy down/unreachable — never throw, we already logged
  }
}

export function resetNotifyForTests(): void {
  cached = null
  lastSent.clear()
}
