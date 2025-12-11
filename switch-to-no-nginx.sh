#!/bin/bash
# Switch from local nginx to direct port exposure

echo "=== Switching to no-nginx setup ==="
echo ""

# Stop current stack
echo "1. Stopping current stack..."
docker-compose down

# Backup current config
echo "2. Backing up current docker-compose.yml..."
cp docker-compose.yml docker-compose-with-nginx.yml.bak

# Replace with no-nginx version
echo "3. Replacing docker-compose.yml..."
cp docker-compose-no-nginx.yml docker-compose.yml

# Start new stack
echo "4. Starting new stack..."
docker-compose up -d

echo ""
echo "=== Done! ==="
echo ""
echo "Services now exposed on:"
echo "  - Port 80:   terminal-dashboard"
echo "  - Port 5001: tmux-session-service"
echo "  - Port 5002: plane-claude-orchestrator"
echo ""
echo "Configure your Nginx Proxy Manager to route:"
echo "  /              → 10.1.0.10:80"
echo "  /ws/sessions/* → 10.1.0.10:5001"
echo "  /api/sessions/* → 10.1.0.10:5001"
echo "  /orchestrator/* → 10.1.0.10:5002"
echo ""
echo "IMPORTANT: Enable WebSockets support in Nginx Proxy Manager!"
