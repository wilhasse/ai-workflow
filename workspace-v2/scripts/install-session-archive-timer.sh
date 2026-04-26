#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_ID="${WSV2_SELF_HOST:-local}"
HOST_NAME=""
INTERVAL="5min"

usage() {
  printf 'Usage: %s [--host-id vm9] [--host-name Supersaber] [--interval 5min]\n' "$0"
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
    --host-name)
      HOST_NAME="${2:?missing --host-name value}"
      shift 2
      ;;
    --interval)
      INTERVAL="${2:?missing --interval value}"
      shift 2
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

if [[ -z "$HOST_NAME" ]]; then
  HOST_NAME="$HOST_ID"
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl not found; run this periodically instead:" >&2
  echo "$ROOT_DIR/scripts/wsv2 archive-scan-local --save --host-id '$HOST_ID' --host-name '$HOST_NAME'" >&2
  exit 1
fi

UNIT_DIR="$HOME/.config/systemd/user"
SERVICE_PATH="$UNIT_DIR/wsv2-session-archive.service"
TIMER_PATH="$UNIT_DIR/wsv2-session-archive.timer"
mkdir -p "$UNIT_DIR"

SCRIPT_PATH="$(escape_systemd_env "$ROOT_DIR/scripts/wsv2")"
ENV_HOST_ID="$(escape_systemd_env "$HOST_ID")"
ENV_HOST_NAME="$(escape_systemd_env "$HOST_NAME")"

{
  echo "[Unit]"
  echo "Description=Workspace v2 Codex/Claude session archive snapshot"
  echo
  echo "[Service]"
  echo "Type=oneshot"
  echo "Environment=\"WSV2_ARCHIVE_HOST_ID=$ENV_HOST_ID\""
  echo "Environment=\"WSV2_ARCHIVE_HOST_NAME=$ENV_HOST_NAME\""
  echo "ExecStart=/usr/bin/env bash -lc '\"$SCRIPT_PATH\" archive-scan-local --save --quiet --host-id \"\$WSV2_ARCHIVE_HOST_ID\" --host-name \"\$WSV2_ARCHIVE_HOST_NAME\"'"
} >"$SERVICE_PATH"

{
  echo "[Unit]"
  echo "Description=Run Workspace v2 session archive snapshots"
  echo
  echo "[Timer]"
  echo "OnBootSec=2min"
  echo "OnUnitActiveSec=$INTERVAL"
  echo "AccuracySec=30s"
  echo "Persistent=true"
  echo
  echo "[Install]"
  echo "WantedBy=timers.target"
} >"$TIMER_PATH"

systemctl --user daemon-reload
systemctl --user enable --now wsv2-session-archive.timer
systemctl --user list-timers --all wsv2-session-archive.timer
