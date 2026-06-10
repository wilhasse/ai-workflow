#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_ID="${WSV2_RESTORE_HOST:-self}"
SINCE_HOURS="${WSV2_RESTORE_SINCE_HOURS:-72}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/ai-workflow"
BOOT_ID="$(cat /proc/sys/kernel/random/boot_id)"
STAMP_PATH="$STATE_DIR/wsv2-session-restore-$HOST_ID.boot"

mkdir -p "$STATE_DIR"

if [[ -f "$STAMP_PATH" ]] && [[ "$(cat "$STAMP_PATH")" == "$BOOT_ID" ]]; then
  echo "workspace sessions already restored for boot $BOOT_ID"
  exit 0
fi

WSV2_RESTORE_HOST="$HOST_ID" \
WSV2_RESTORE_SINCE_HOURS="$SINCE_HOURS" \
  "$ROOT_DIR/scripts/restore-after-reboot.sh"

echo "$BOOT_ID" >"$STAMP_PATH"
