#!/usr/bin/env bash
# pre-push: typecheck + run tests. set SKIP_PREFLIGHT=1 to bypass.
set -euo pipefail

if [[ "${SKIP_PREFLIGHT:-}" == "1" ]]; then
  echo "[pre-push] SKIP_PREFLIGHT=1, skipping"
  exit 0
fi

cd "$(git rev-parse --show-toplevel)"
echo "[pre-push] typecheck..."
bun run typecheck
echo "[pre-push] test..."
bun run test

echo "[pre-push] python tests..."
if command -v pytest >/dev/null 2>&1 || python3 -m pytest --version >/dev/null 2>&1; then
  python3 -m pytest packages/companion/ -q
else
  echo "[pre-push] warn: pytest not found, skipping companion python tests"
fi

echo "[pre-push] ok"
