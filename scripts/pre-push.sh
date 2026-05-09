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
echo "[pre-push] ok"
