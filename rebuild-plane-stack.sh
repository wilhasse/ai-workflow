#!/bin/bash
# Rebuild and restart the plane-claude-orchestrator service in docker-compose

set -e

echo "🔄 Rebuilding plane-claude-orchestrator service..."

# Stop the service
echo "⏹️  Stopping plane-claude-orchestrator..."
docker-compose stop plane-claude-orchestrator

# Rebuild the service
echo "🔨 Building plane-claude-orchestrator image..."
docker-compose build plane-claude-orchestrator

# Start the service
echo "▶️  Starting plane-claude-orchestrator..."
docker-compose up -d plane-claude-orchestrator

# Show logs
echo ""
echo "📋 Service logs (Ctrl+C to exit):"
docker-compose logs -f plane-claude-orchestrator
