#!/usr/bin/env bash
set -euo pipefail

SERVICE_URL="${SESSION_SERVICE_URL:-http://127.0.0.1:5001}"
DEFAULT_SHELL="${SESSION_SHELL:-${SHELL:-/bin/bash}}"

sanitize() {
  local value="$1"
  value="${value//[^A-Za-z0-9_-]/}"
  echo "${value:0:64}"
}

random_id() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | cut -c1-8
  else
    date +%s%N | sha256sum | cut -c1-8
  fi
}

# Extract terminalId and projectId from SHELLINABOX_URL
SESSION_ID=""
PROJECT_ID=""

if [[ -n "${SHELLINABOX_URL:-}" ]]; then
  # Extract query parameters from URL
  # Example: https://10.1.0.10:4200/?projectId=shell-workspace&terminalId=cde7a279...
  
  # Extract terminalId
  if [[ "$SHELLINABOX_URL" =~ terminalId=([^&]+) ]]; then
    SESSION_ID="${BASH_REMATCH[1]}"
  fi
  
  # Extract projectId
  if [[ "$SHELLINABOX_URL" =~ projectId=([^&]+) ]]; then
    PROJECT_ID="${BASH_REMATCH[1]}"
  fi
fi

# Sanitize IDs
SESSION_ID="$(sanitize "${SESSION_ID:-}")"
PROJECT_ID="$(sanitize "${PROJECT_ID:-}")"

# Generate random ID if still empty
if [[ -z "$SESSION_ID" ]]; then
  SESSION_ID="session-$(random_id)"
fi

# Build JSON payload
payload="{\"sessionId\":\"$SESSION_ID\""
if [[ -n "$PROJECT_ID" ]]; then
  payload+=",\"projectId\":\"$PROJECT_ID\""
fi
payload+='}'

# Call API to ensure session exists
if command -v curl >/dev/null 2>&1; then
  curl -sS -X PUT "$SERVICE_URL/sessions/$SESSION_ID" \
    -H 'Content-Type: application/json' \
    -d "$payload" >/dev/null 2>&1 || echo "[attach-session] warning: session service unavailable" >&2
fi

# Attach to tmux session
exec tmux new-session -A -s "$SESSION_ID" "$DEFAULT_SHELL"
