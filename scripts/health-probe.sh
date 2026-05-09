#!/usr/bin/env bash
# bazaarinfo health probe — runs every 5min via systemd timer.
# hits /health/ready and the public tunnel; alerts on failure.
set -u

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
alert="$repo_root/scripts/alert.sh"

local_url="${EBS_LOCAL_URL:-http://127.0.0.1:3100/health/ready}"
public_url="${EBS_PUBLIC_URL:-https://ebs.bazaarinfo.com/health/live}"

failures=()

probe() {
  local label="$1" url="$2"
  local out
  out="$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' "$url" 2>&1)" || {
    failures+=("$label: connect failed — $out")
    return
  }
  if [[ "$out" != "200" ]]; then
    failures+=("$label: HTTP $out at $url")
  fi
}

probe "ebs-local" "$local_url"
probe "ebs-public" "$public_url"

# bot service status (best-effort — bot doesn't expose http)
if command -v systemctl >/dev/null; then
  for unit in bazaarinfo bazaarinfo-ebs bazaarinfo-companion; do
    if systemctl --user list-unit-files "${unit}.service" >/dev/null 2>&1; then
      state="$(systemctl --user is-active "$unit" 2>/dev/null || true)"
      if [[ "$state" != "active" ]]; then
        failures+=("$unit: $state")
      fi
    fi
  done
fi

if (( ${#failures[@]} > 0 )); then
  body="$(printf '%s\n' "${failures[@]}")"
  "$alert" "bazaarinfo: $(hostname) health probe failed" "$body" high
  exit 1
fi

exit 0
