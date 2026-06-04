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
