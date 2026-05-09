#!/usr/bin/env bash
# bazaarinfo alert dispatcher — sends to ntfy if NTFY_TOPIC is set, otherwise journald only.
# called by systemd OnFailure= and by the health probe.
set -u

title="${1:-bazaarinfo alert}"
body="${2:-no detail}"
priority="${3:-default}"  # min|low|default|high|urgent
topic="${NTFY_TOPIC:-}"
ntfy_base="${NTFY_BASE:-https://ntfy.sh}"

# always log to journal so we have a paper trail even if ntfy is down
echo "[alert] [$priority] $title — $body" >&2

if [[ -z "$topic" ]]; then
  exit 0
fi

# best-effort, 5s timeout, no retry — we don't want alert noise to itself fail loud
curl -sS --max-time 5 \
  -H "Title: $title" \
  -H "Priority: $priority" \
  -H "Tags: warning,bazaarinfo" \
  -d "$body" \
  "$ntfy_base/$topic" >/dev/null 2>&1 || echo "[alert] ntfy push failed" >&2
