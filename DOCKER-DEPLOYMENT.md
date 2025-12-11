# Docker Deployment Guide

Complete guide for deploying the AI workflow stack with Docker Compose, including the new plane-claude-orchestrator service.

## Architecture Overview

The stack consists of four containerized services orchestrated by nginx:

```
┌─────────────────────────────────────────────────────────────┐
│  nginx (reverse proxy + SSL termination)                    │
│  Ports: 80 (HTTP redirect), 443 (HTTPS)                     │
└─────────────────────────────────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┬───────────────┐
        │                  │                  │               │
┌───────▼────────┐ ┌──────▼──────┐ ┌─────────▼────────┐ ┌───▼────────┐
│ terminal-      │ │ tmux-session│ │ plane-claude-    │ │ whisper-   │
│ dashboard      │ │ -service    │ │ orchestrator     │ │ realtime-  │
│ (React SPA)    │ │ (Node.js)   │ │ (Python FastAPI) │ │ api        │
│ Port: 3000     │ │ Port: 5001  │ │ Port: 5002       │ │ (optional) │
└────────────────┘ └─────────────┘ └──────────────────┘ └────────────┘
```

## Services

### 1. nginx
- **Purpose**: Reverse proxy, SSL termination, static file serving
- **Ports**: 80 (HTTP), 443 (HTTPS)
- **Routes**:
  - `/` → terminal-dashboard (React SPA)
  - `/api/pending-tickets`, `/api/completed-tickets`, etc. → plane-claude-orchestrator
  - `/api/sessions/*` → tmux-session-service
  - `/ws/sessions/*` → tmux-session-service (WebSocket)
  - `/api/whisper/*` → remote GPU host (10.1.1.218:8000)

### 2. terminal-dashboard
- **Purpose**: React frontend with xterm.js terminals
- **Technology**: Vite-built React SPA
- **Port**: 3000 (internal)
- **Access**: Via nginx at `https://localhost/`

### 3. tmux-session-service
- **Purpose**: Persistent tmux session management via HTTP + WebSocket
- **Technology**: Node.js with node-pty
- **Port**: 5001 (internal)
- **Access**: Via nginx at `/api/sessions/*` and `/ws/sessions/*`
- **Volumes**:
  - `tmux-session-data:/app/data` - Session metadata persistence
  - `/tmp/tmux-1000:/tmp/tmux-1000` - Host tmux socket (read/write)
  - `/home/cslog:/home/cslog` - Host environment access

### 4. plane-claude-orchestrator (NEW)
- **Purpose**: Plane ticket automation daemon
- **Technology**: Python FastAPI with asyncio
- **Port**: 5002 (internal)
- **Access**: Via nginx at `/api/pending-tickets`, `/api/approve/*`, etc.
- **Volumes**:
  - `plane-orchestrator-data:/app/data` - State file persistence
  - `plane-orchestrator-logs:/app/logs` - Log file persistence
  - `/home/cslog/.claude.json:/root/.claude.json:ro` - Plane MCP config (read-only)
  - `/tmp:/tmp` - Completion signal files (shared with host tmux sessions)
  - `/home/cslog/ai-workflow:/workspace:ro` - Workspace access (read-only)

### 5. whisper-realtime-api (Optional)
- **Purpose**: Audio transcription via Whisper
- **Status**: Commented out by default
- **Port**: 8000 (if enabled)

## Quick Start

### First-Time Setup

```bash
# 1. Build all services
cd /home/cslog/ai-workflow
docker-compose build

# 2. Start the stack
docker-compose up -d

# 3. Verify all services are healthy
docker-compose ps
docker-compose logs -f

# 4. Access the dashboard
# Open browser to: https://localhost
# (Accept self-signed certificate warning)
```

### Daily Development Workflow

```bash
# Restart all services
./rebuild-stack.sh

# Rebuild and restart just the plane orchestrator
./rebuild-plane-stack.sh

# View logs for specific service
docker-compose logs -f plane-claude-orchestrator
docker-compose logs -f tmux-session-service

# Check health status
curl https://localhost/health -k
docker-compose ps
```

## Environment Configuration

The plane-claude-orchestrator requires a valid Plane MCP configuration at `/home/cslog/.claude.json`. This file is mounted read-only into the container.

**Example `.claude.json` (Plane MCP section):**
```json
{
  "mcpServers": {
    "plane": {
      "command": "npx",
      "args": ["-y", "@ccl-dev/plane-mcp"],
      "env": {
        "PLANE_API_KEY": "your-plane-api-key",
        "PLANE_WORKSPACE_SLUG": "cslog",
        "PLANE_API_URL": "https://plane.cslog.com.br/api/v1"
      }
    }
  }
}
```

## Volume Management

### Persistent Data

The stack creates three Docker volumes for data persistence:

1. **tmux-session-data** - tmux session metadata (sessions.json, users.json)
2. **plane-orchestrator-data** - Plane ticket state files (pending-tickets.json, etc.)
3. **plane-orchestrator-logs** - Daemon logs (orchestrator.log)

**View volume data:**
```bash
# List volumes
docker volume ls

# Inspect volume
docker volume inspect ai-workflow_plane-orchestrator-data

# Access volume data (running container)
docker exec -it ai-workflow-plane-orchestrator ls -la /app/data
docker exec -it ai-workflow-plane-orchestrator cat /app/logs/orchestrator.log
```

**Backup volumes:**
```bash
# Backup orchestrator data
docker run --rm -v ai-workflow_plane-orchestrator-data:/data -v $(pwd):/backup alpine tar czf /backup/plane-data-$(date +%Y%m%d).tar.gz -C /data .

# Restore orchestrator data
docker run --rm -v ai-workflow_plane-orchestrator-data:/data -v $(pwd):/backup alpine tar xzf /backup/plane-data-20251210.tar.gz -C /data
```

### Host Mounts

The following host directories are mounted into containers:

- `/tmp/tmux-1000` → tmux-session-service (tmux socket)
- `/tmp` → plane-claude-orchestrator (completion signal files)
- `/home/cslog` → tmux-session-service (host environment)
- `/home/cslog/.claude.json` → plane-claude-orchestrator (Plane MCP config)
- `/home/cslog/ai-workflow` → plane-claude-orchestrator (workspace)

## Networking

All services communicate via the `ai-workflow-network` Docker bridge network.

**Internal service URLs (container → container):**
- `http://terminal-dashboard:3000` - React frontend
- `http://tmux-session-service:5001` - Tmux API
- `http://plane-claude-orchestrator:5002` - Plane daemon
- `ws://tmux-session-service:5001/ws/sessions/{id}` - Terminal WebSocket

**External access (browser → nginx):**
- `https://localhost/` - Dashboard
- `https://localhost/api/pending-tickets` - Plane API (proxied)
- `https://localhost/api/sessions/` - Tmux API (proxied)
- `wss://localhost/ws/sessions/{id}` - Terminal WebSocket (proxied)

## Health Checks

Each service has a health check configured in docker-compose.yml:

```bash
# Check all service health
docker-compose ps

# Sample output:
NAME                          STATUS
ai-workflow-dashboard         Up (healthy)
ai-workflow-nginx             Up (healthy)
ai-workflow-plane-orchestrator Up (healthy)
ai-workflow-tmux-service      Up (healthy)
```

**Individual health endpoints:**
```bash
# nginx
curl -k https://localhost/health
# Response: healthy

# plane-claude-orchestrator (via Docker)
docker exec ai-workflow-plane-orchestrator curl -f http://localhost:5002/health
# Response: {"status":"healthy","tmux_service":true,"pending_count":0,"active_count":0,"completed_count":0}

# tmux-session-service (via Docker)
docker exec ai-workflow-tmux-service curl -f http://localhost:5001/health
# Response: OK
```

## Troubleshooting

### Issue: plane-claude-orchestrator fails to start

**Check logs:**
```bash
docker-compose logs plane-claude-orchestrator
```

**Common causes:**
1. Missing `.claude.json` file
   - Solution: Ensure `/home/cslog/.claude.json` exists with valid Plane MCP config
2. Invalid Plane API credentials
   - Solution: Verify `PLANE_API_KEY` in `.claude.json`
3. Port conflict on 5002
   - Solution: Stop any services using port 5002 or change PORT env var

### Issue: Completion detection not working

**Symptoms:** Typing `/complete <summary>` in Claude Code terminal doesn't move ticket to completed queue

**Diagnosis:**
```bash
# 1. Check completion files are being created
ls -la /tmp/completion-*.txt

# 2. Check daemon can access /tmp
docker exec ai-workflow-plane-orchestrator ls -la /tmp/

# 3. Check daemon logs for completion detection
docker-compose logs -f plane-claude-orchestrator | grep completion
```

**Solution:** The daemon container mounts the host's `/tmp` directory, so completion files written by host tmux sessions should be visible to the daemon.

### Issue: nginx routing conflicts

**Symptoms:** API requests to `/api/pending-tickets` return 404 or wrong responses

**Diagnosis:**
```bash
# Test nginx routing directly
curl -k https://localhost/api/pending-tickets
curl -k https://localhost/api/sessions

# Check nginx logs
docker-compose logs nginx
```

**Solution:** Verify nginx.conf routes plane-specific paths BEFORE the general `/api/` catchall

### Issue: Dashboard can't connect to daemon in production

**Symptoms:** Dashboard shows "daemon unhealthy" or pending tickets don't load

**Diagnosis:**
```bash
# 1. Check if running in production mode
docker exec ai-workflow-dashboard env | grep MODE

# 2. Test nginx proxy manually
curl -k https://localhost/api/pending-tickets

# 3. Check browser console for CORS errors
# Open DevTools → Network tab
```

**Solution:**
- In production, dashboard uses relative URLs (nginx proxy)
- In development (`npm run dev`), dashboard uses `http://localhost:5002` directly
- Verify `import.meta.env.MODE` is set correctly in Vite build

## Deployment to Production

### 1. Update SSL Certificates

Replace self-signed certificates with Let's Encrypt:

```bash
# Install certbot
sudo apt install certbot

# Generate certificate
sudo certbot certonly --standalone -d yourdomain.com

# Update nginx/nginx.conf
ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

# Mount certificates in docker-compose.yml
volumes:
  - /etc/letsencrypt:/etc/letsencrypt:ro
```

### 2. Harden Security

```bash
# Restrict CORS in api.py (plane-claude-orchestrator)
# Edit: plane-claude-orchestrator/src/api.py
# Change: allow_origins=["*"]
# To:     allow_origins=["https://yourdomain.com"]

# Rebuild
docker-compose build plane-claude-orchestrator
docker-compose up -d
```

### 3. Set up Log Rotation

```bash
# Create logrotate config
sudo tee /etc/logrotate.d/plane-orchestrator << EOF
/var/lib/docker/volumes/ai-workflow_plane-orchestrator-logs/_data/*.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
    create 0644 root root
}
EOF
```

### 4. Enable Auto-Restart on Boot

```bash
# Services already have restart: unless-stopped
# Ensure Docker starts on boot
sudo systemctl enable docker

# Test restart
sudo docker-compose down
sudo docker-compose up -d
```

## Monitoring

### Prometheus Metrics (Future Enhancement)

The plane-claude-orchestrator can be extended with prometheus_client:

```python
# Add to requirements.txt
prometheus-client==0.20.0

# Add to src/api.py
from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST

# Metrics
tickets_approved = Counter('plane_tickets_approved_total', 'Total tickets approved')
ticket_completion_time = Histogram('plane_ticket_completion_seconds', 'Time to complete tickets')

# Endpoint
@app.get("/metrics")
async def metrics():
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)
```

## Summary

The containerized stack provides:
- ✅ Persistent tmux sessions that survive container restarts
- ✅ Automated Plane ticket workflow integration
- ✅ Nginx SSL termination and reverse proxy
- ✅ Health checks for all services
- ✅ Volume-backed data persistence
- ✅ Easy rebuild and deployment scripts

**Next Steps:**
- Test the full workflow end-to-end
- Set up production SSL with Let's Encrypt
- Configure log rotation and monitoring
- Document backup/restore procedures
