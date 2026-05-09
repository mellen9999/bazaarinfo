#!/usr/bin/env bash
# install local git hooks (typecheck + tests on pre-push)
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
hook_dir="$repo_root/.git/hooks"
mkdir -p "$hook_dir"
ln -sf ../../scripts/pre-push.sh "$hook_dir/pre-push"
chmod +x "$repo_root/scripts/pre-push.sh"
echo "[hooks] pre-push -> scripts/pre-push.sh"
