// structured JSON logging — one line per call, lvl/comp inferred from message prefix.
// journald handles rotation; we just emit clean lines.

const COMP_RE = /^([a-z][a-z0-9-]{1,15}):\s+/i

function fmt(arg: unknown): string {
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`
  if (typeof arg === 'string') return arg
  try { return JSON.stringify(arg) } catch { return String(arg) }
}

function emit(lvl: 'info' | 'warn' | 'error', args: unknown[]): void {
  const ts = new Date().toISOString()
  const parts = args.map(fmt)
  let raw = parts.join(' ')
  let comp = ''
  const m = raw.match(COMP_RE)
  if (m) { comp = m[1].toLowerCase(); raw = raw.slice(m[0].length) }
  const line: Record<string, unknown> = { ts, lvl, msg: raw }
  if (comp) line.comp = comp
  const stream = lvl === 'error' ? process.stderr : process.stdout
  stream.write(JSON.stringify(line) + '\n')
}

export function log(...args: unknown[]): void { emit('info', args) }
export function warn(...args: unknown[]): void { emit('warn', args) }
export function error(...args: unknown[]): void { emit('error', args) }
