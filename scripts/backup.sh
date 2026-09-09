#!/usr/bin/env bash
# bazaarinfo daily backup — sqlite hot-copy + items.json snapshot
# install via systemd user timer (see scripts/bazaarinfo-backup.{service,timer})
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/bazaarinfo}"
DB_PATH="${DB_PATH:-$HOME/.bazaarinfo.db}"
CACHE_PATH="${CACHE_PATH:-$HOME/projects/bazaarinfo/cache/items.json}"
RETENTION="${RETENTION:-30}"

mkdir -p "$BACKUP_DIR/db" "$BACKUP_DIR/cache"
ts="$(date -u +%Y%m%dT%H%M%SZ)"

# 1) sqlite online backup (safe even while bot has WAL connection open)
if [[ -f "$DB_PATH" ]]; then
  out="$BACKUP_DIR/db/bazaarinfo-${ts}.db"
  sqlite3 "$DB_PATH" ".backup '$out'"
  gzip -9 "$out"
  echo "[backup] db -> ${out}.gz ($(du -h "${out}.gz" | cut -f1))"
  # stable path to the newest dump, hardlinked so it costs nothing on the same fs.
  # the offsite restic target backs up this one file instead of the whole 30-day
  # directory: restic already keeps its own snapshot history, and mirroring 30
  # local rotations into it would plateau ~15x larger for no extra recoverability.
  mkdir -p "$BACKUP_DIR/latest"
  ln -f "${out}.gz" "$BACKUP_DIR/latest/bazaarinfo.db.gz"
else
  echo "[backup] WARN: $DB_PATH missing, skipping db" >&2
fi

# 2) items.json snapshot (compressed)
if [[ -f "$CACHE_PATH" ]]; then
  out="$BACKUP_DIR/cache/items-${ts}.json.gz"
  gzip -c "$CACHE_PATH" > "$out"
  echo "[backup] cache -> ${out} ($(du -h "$out" | cut -f1))"
fi

# 3) irreplaceable small state. none of this is regenerable and, until now, none of
# it was backed up anywhere: the rotation ledger is authoritative (losing it
# silently reverts rotated channels to their old, leaked secrets), the tokens file
# holds the only copy of the bot's twitch refresh token, and the env files hold the
# api keys. kept 0700/0600 — these are secrets sitting on disk.
ROTATIONS_PATH="${ROTATIONS_PATH:-$HOME/.bazaarinfo-rotations.json}"
STATE_DIR="$BACKUP_DIR/state"
STATE_FILES=(
  "$ROTATIONS_PATH:rotations.json"
  "$HOME/.bazaarinfo-tokens.json:tokens.json"
  "$HOME/.bazaarinfo-channels.json:channels.json"
  "$HOME/.bazaarinfo-ebs.env:ebs.env"
  "$HOME/projects/bazaarinfo/.env:bot.env"
)
(
  umask 077
  mkdir -p "$STATE_DIR"
  for pair in "${STATE_FILES[@]}"; do
    src="${pair%:*}" dest="${pair##*:}"
    if [[ -f "$src" ]]; then
      cp "$src" "$STATE_DIR/$dest"
      echo "[backup] state -> $STATE_DIR/$dest"
    else
      echo "[backup] WARN: $src missing, not backed up" >&2
    fi
  done
)
chmod 700 "$STATE_DIR"

# 4) prune older than RETENTION days
find "$BACKUP_DIR/db" -name 'bazaarinfo-*.db.gz' -mtime "+${RETENTION}" -delete -print | sed 's/^/[backup] pruned /'
find "$BACKUP_DIR/cache" -name 'items-*.json.gz' -mtime "+${RETENTION}" -delete -print | sed 's/^/[backup] pruned /'

echo "[backup] done at $(date -Iseconds)"
