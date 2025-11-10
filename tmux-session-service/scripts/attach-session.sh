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

SESSION_ID="${1:-}" || true
PROJECT_ID="${2:-}" || true

if [[ -z "$SESSION_ID" && -n "${QUERY_terminalId:-}" ]]; then
  SESSION_ID="$QUERY_terminalId"
fi
if [[ -z "$PROJECT_ID" && -n "${QUERY_projectId:-}" ]]; then
  PROJECT_ID="$QUERY_projectId"
fi

SESSION_ID="$(sanitize "${SESSION_ID:-}")"
PROJECT_ID="$(sanitize "${PROJECT_ID:-}")"

if [[ -z "$SESSION_ID" ]]; then
  SESSION_ID="session-$(random_id)"
fi

payload="{\"sessionId\":\"$SESSION_ID\""
if [[ -n "$PROJECT_ID" ]]; then
  payload+=" ,\"projectId\":\"$PROJECT_ID\""
fi
payload+='}'

if command -v curl >/dev/null 2>&1; then
  curl -sS -X PUT "$SERVICE_URL/sessions/$SESSION_ID" \
    -H 'Content-Type: application/json' \
    -d "$payload" >/dev/null || echo "[attach-session] warning: session service unavailable"
else
  echo "[attach-session] warning: curl not found; skipping controller API call"
fi

exec tmux new-session -A -s "$SESSION_ID" "$DEFAULT_SHELL"
