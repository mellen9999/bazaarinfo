// bulletproof response JSON. a 200 with an empty or truncated body (seen under
// load when the upstream drops the connection mid-stream) makes res.json() throw
// "Unexpected end of JSON input" — which silently kills the in-flight reply. this
// reads the body as text first and parses defensively, returning a result object
// so callers branch on it instead of catching a throw.
export interface JsonResult<T> {
  ok: boolean // res.ok AND body parsed to a value
  status: number
  empty: boolean // 2xx but no/blank body — caller may retry as a transient error
  data: T | null
}

// Extract the FIRST complete, balanced JSON object from a string — robust to a model
// that wraps its JSON in prose, code fences, or emits a second corrected object after
// it. A greedy /\{[\s\S]*\}/ would span from the first { to the LAST } and swallow any
// in-between prose, breaking JSON.parse; this brace-counts (string/escape aware) and
// stops at the matching close brace.
export function extractFirstJson(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (esc) { esc = false; continue }
    if (c === '\\') { esc = true; continue }
    if (c === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}

export async function readJson<T>(res: Response): Promise<JsonResult<T>> {
  const text = await res.text().catch(() => '')
  if (!text.trim()) {
    return { ok: false, status: res.status, empty: res.ok, data: null }
  }
  try {
    return { ok: res.ok, status: res.status, empty: false, data: JSON.parse(text) as T }
  } catch {
    // malformed/truncated body — treat like a transient empty response if the
    // status was otherwise OK, so callers can retry rather than hard-fail.
    return { ok: false, status: res.status, empty: res.ok, data: null }
  }
}
