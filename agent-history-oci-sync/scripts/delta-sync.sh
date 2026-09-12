#!/usr/bin/env bash
set -euo pipefail
umask 077

MODULE_DIR="${OCI_SYNC_MODULE_DIR:-/home/cslog/ai-workflow/agent-history-oci-sync}"
CREDS="${OCI_SYNC_CREDENTIALS:-$HOME/oci/agent-history-oci-credentials.txt}"
SYNC_MODE="${1:---delta}"
if [[ "$SYNC_MODE" != '--delta' && "$SYNC_MODE" != '--reconcile' && "$SYNC_MODE" != '--verify-session' ]]; then
  echo 'Usage: delta-sync.sh [--delta|--reconcile|--verify-session SESSION_ID VM_ID] [backfill arguments]' >&2
  exit 1
fi
if (( $# > 0 )); then shift; fi

# Every scheduled replay mode shares the checkpoint and tunnel. The descriptor
# remains held while the child runs; no PID lookup can kill an unrelated tunnel.
exec 9>"${OCI_SYNC_LOCK:-$HOME/.agent-history-oci-sync.lock}"
if ! flock -n 9; then
  echo '[sync] another replay/verification is running; deferring to the next timer activation'
  if [[ "$SYNC_MODE" == '--verify-session' ]]; then exit 75; fi
  exit 0
fi

if [[ -z "${API_TOKEN:-}" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == API_TOKEN=* ]]; then
      API_TOKEN="${line#API_TOKEN=}"
      API_TOKEN="${API_TOKEN%$'\r'}"
      break
    fi
  done < "$CREDS"
fi
if [[ -z "${API_TOKEN:-}" ]]; then
  echo '[sync] API_TOKEN is missing' >&2
  exit 1
fi
export API_TOKEN

SSH_PID=''
cleanup() {
  if [[ -n "$SSH_PID" ]]; then
    kill "$SSH_PID" 2>/dev/null || true
    wait "$SSH_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -z "${OCI_API_URL:-}" ]]; then
  TUNNEL_PORT="${OCI_SYNC_TUNNEL_PORT:-15002}"
  ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -o ConnectTimeout=15 \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -N \
    -L "127.0.0.1:${TUNNEL_PORT}:127.0.0.1:5002" "${OCI_SYNC_SSH_HOST:-oci-ubuntu-pub}" &
  SSH_PID=$!
  OCI_API_URL="http://127.0.0.1:${TUNNEL_PORT}"
  READY=0
  for ((attempt=0; attempt<30; attempt++)); do
    if ! kill -0 "$SSH_PID" 2>/dev/null; then
      echo '[sync] SSH tunnel exited before becoming ready' >&2
      exit 1
    fi
    if curl --fail --silent --output /dev/null --max-time 2 "$OCI_API_URL/health"; then
      READY=1
      break
    fi
    sleep 1
  done
  if (( ! READY )); then
    echo '[sync] SSH tunnel did not become ready' >&2
    exit 1
  fi
fi
export OCI_API_URL
cd "$MODULE_DIR"
if [[ "$SYNC_MODE" == '--verify-session' ]]; then
  node scripts/verify-sync-session.js "$@"
else
  node scripts/backfill.js "$SYNC_MODE" "$@"
fi
