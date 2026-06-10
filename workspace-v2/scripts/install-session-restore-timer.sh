#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_ID="${WSV2_SELF_HOST:-self}"
SINCE_HOURS="72"
ON_BOOT_SEC="3min"
RUN_NOW="false"

usage() {
  cat <<USAGE
Usage: $0 [--host-id vm10|self] [--since-hours 72] [--on-boot-sec 3min] [--run-now]

Installs a user systemd timer that restores recent archived Codex/Claude
sessions into detached tmux windows once per machine boot.
USAGE
}

escape_systemd_env() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host-id)
      HOST_ID="${2:?missing --host-id value}"
      shift 2
      ;;
    --since-hours)
      SINCE_HOURS="${2:?missing --since-hours value}"
      shift 2
      ;;
    --on-boot-sec)
      ON_BOOT_SEC="${2:?missing --on-boot-sec value}"
      shift 2
      ;;
    --run-now)
      RUN_NOW="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl not found; run this manually after reboot instead:" >&2
  echo "WSV2_RESTORE_HOST='$HOST_ID' WSV2_RESTORE_SINCE_HOURS='$SINCE_HOURS' $ROOT_DIR/scripts/restore-after-reboot.sh" >&2
  exit 1
fi

UNIT_DIR="$HOME/.config/systemd/user"
SERVICE_PATH="$UNIT_DIR/wsv2-session-restore.service"
TIMER_PATH="$UNIT_DIR/wsv2-session-restore.timer"
mkdir -p "$UNIT_DIR"

RESTORE_ONCE_SCRIPT="$(escape_systemd_env "$ROOT_DIR/scripts/restore-once-after-boot.sh")"
ENV_HOST_ID="$(escape_systemd_env "$HOST_ID")"
ENV_SINCE_HOURS="$(escape_systemd_env "$SINCE_HOURS")"

{
  echo "[Unit]"
  echo "Description=Restore Workspace v2 tmux sessions from Codex/Claude archive"
  echo "After=default.target"
  echo
  echo "[Service]"
  echo "Type=oneshot"
  echo "Environment=\"WSV2_RESTORE_HOST=$ENV_HOST_ID\""
  echo "Environment=\"WSV2_RESTORE_SINCE_HOURS=$ENV_SINCE_HOURS\""
  echo "ExecStart=$RESTORE_ONCE_SCRIPT"
} >"$SERVICE_PATH"

{
  echo "[Unit]"
  echo "Description=Restore Workspace v2 tmux sessions after boot"
  echo
  echo "[Timer]"
  echo "OnBootSec=$ON_BOOT_SEC"
  echo "AccuracySec=30s"
  echo "Persistent=true"
  echo
  echo "[Install]"
  echo "WantedBy=timers.target"
} >"$TIMER_PATH"

if [[ "$RUN_NOW" != "true" ]]; then
  STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/ai-workflow"
  mkdir -p "$STATE_DIR"
  cat /proc/sys/kernel/random/boot_id >"$STATE_DIR/wsv2-session-restore-$HOST_ID.boot"
fi

systemctl --user daemon-reload
systemctl --user enable --now wsv2-session-restore.timer

if [[ "$RUN_NOW" == "true" ]]; then
  systemctl --user start wsv2-session-restore.service
fi

systemctl --user list-timers --all wsv2-session-restore.timer
