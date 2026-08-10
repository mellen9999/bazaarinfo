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
else
  echo "[backup] WARN: $DB_PATH missing, skipping db" >&2
fi

# 2) items.json snapshot (compressed)
if [[ -f "$CACHE_PATH" ]]; then
  out="$BACKUP_DIR/cache/items-${ts}.json.gz"
  gzip -c "$CACHE_PATH" > "$out"
  echo "[backup] cache -> ${out} ($(du -h "$out" | cut -f1))"
fi

# 3) secret-rotation state — tiny but authoritative: losing it silently reverts
# rotated channels to their old (leaked) secrets
ROTATIONS_PATH="${ROTATIONS_PATH:-$HOME/.bazaarinfo-rotations.json}"
if [[ -f "$ROTATIONS_PATH" ]]; then
  cp "$ROTATIONS_PATH" "$BACKUP_DIR/rotations.json"
  echo "[backup] rotations -> $BACKUP_DIR/rotations.json"
fi

# 4) prune older than RETENTION days
find "$BACKUP_DIR/db" -name 'bazaarinfo-*.db.gz' -mtime "+${RETENTION}" -delete -print | sed 's/^/[backup] pruned /'
find "$BACKUP_DIR/cache" -name 'items-*.json.gz' -mtime "+${RETENTION}" -delete -print | sed 's/^/[backup] pruned /'

echo "[backup] done at $(date -Iseconds)"
