#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_ID="${WSV2_RESTORE_HOST:-self}"
SINCE_HOURS="${WSV2_RESTORE_SINCE_HOURS:-72}"

exec "$ROOT_DIR/scripts/wsv2" archive-restore \
  --host "$HOST_ID" \
  --since-hours "$SINCE_HOURS" \
  "$@"
