#!/bin/bash
# Switch from local nginx to direct port exposure

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  else
    docker-compose "$@"
  fi
}

echo "=== Switching to no-nginx setup ==="
echo ""

cd "$SCRIPT_DIR"

echo "1. Stopping current stack..."
compose down

echo "2. Starting no-nginx stack..."
compose -f docker-compose-no-nginx.yml up -d --build

echo ""
echo "=== Done! ==="
echo ""
echo "Services now exposed on:"
echo "  - Port 80:   terminal-dashboard"
echo "  - Port 5001: tmux-session-service"
echo ""
echo "Configure your Nginx Proxy Manager to route:"
echo "  /              → 10.1.0.10:80"
echo "  /ws/sessions/* → 10.1.0.10:5001"
echo "  /api/sessions/* → 10.1.0.10:5001"
echo ""
echo "IMPORTANT: Enable WebSockets support in Nginx Proxy Manager!"
