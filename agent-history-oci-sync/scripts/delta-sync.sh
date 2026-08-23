#!/usr/bin/env bash
# Delta sync Doris -> OCI MySQL via an ad-hoc SSH tunnel to oci-ubuntu-pub.
# The backfill script resumes from its watermark file, so each run only sends
# new/changed rows. Interim path until DNS + Caddy + collector dual-push.
set -euo pipefail

MODULE_DIR="/home/cslog/ai-workflow/agent-history-oci-sync"
CREDS="$HOME/oci/agent-history-oci-credentials.txt"
# Distinct from the manual 5002 tunnel so both can coexist.
TUNNEL_PORT=15002

API_TOKEN=$(grep '^API_TOKEN=' "$CREDS" | cut -d= -f2)

cleanup() {
  [[ -n "${SSH_PID:-}" ]] && kill "$SSH_PID" 2>/dev/null || true
}
trap cleanup EXIT

ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -f -N \
  -L ${TUNNEL_PORT}:127.0.0.1:5002 oci-ubuntu-pub
SSH_PID=$(pgrep -f "ExitOnForwardFailure=yes -f -N -L ${TUNNEL_PORT}" | head -1)
sleep 1

cd "$MODULE_DIR"
OCI_API_URL="http://127.0.0.1:${TUNNEL_PORT}" API_TOKEN="$API_TOKEN" \
  node scripts/backfill.js
