#!/usr/bin/env bash
# install systemd user units for bazaarinfo backups + health alerting.
# idempotent — safe to re-run.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
unit_dir="$HOME/.config/systemd/user"
mkdir -p "$unit_dir" "$HOME/.config/bazaarinfo"

units=(
  bazaarinfo-backup.service
  bazaarinfo-backup.timer
  bazaarinfo-health.service
  bazaarinfo-health.timer
  bazaarinfo-alert@.service
)

for u in "${units[@]}"; do
  ln -sf "$repo/scripts/$u" "$unit_dir/$u"
  echo "[systemd] linked $u"
done

if [[ ! -f "$HOME/.config/bazaarinfo/alert.env" ]]; then
  cat > "$HOME/.config/bazaarinfo/alert.env" <<'EOF'
# bazaarinfo alert config — set these to enable ntfy push notifications
# NTFY_TOPIC=bazaarinfo-mellen
# NTFY_BASE=https://ntfy.sh
EOF
  chmod 600 "$HOME/.config/bazaarinfo/alert.env"
  echo "[systemd] wrote stub ~/.config/bazaarinfo/alert.env (set NTFY_TOPIC to enable push)"
fi

systemctl --user daemon-reload
systemctl --user enable --now bazaarinfo-backup.timer bazaarinfo-health.timer

echo
echo "[systemd] active timers:"
systemctl --user list-timers 'bazaarinfo-*' --no-pager || true
echo
echo "to wire OnFailure alerts on existing units, run:"
echo "  systemctl --user edit bazaarinfo.service"
echo "  systemctl --user edit bazaarinfo-ebs.service"
echo "  systemctl --user edit bazaarinfo-companion.service"
echo "and add:"
echo "  [Unit]"
echo "  OnFailure=bazaarinfo-alert@%n.service"
