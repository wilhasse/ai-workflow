# Plane Claude Orchestrator - Setup Guide

Complete setup guide for plane-claude-orchestrator daemon that automates Claude Code sessions for Plane tickets.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running the Daemon](#running-the-daemon)
- [Dashboard Integration](#dashboard-integration)
- [Testing the Setup](#testing-the-setup)
- [Monitoring and Metrics](#monitoring-and-metrics)
- [Troubleshooting](#troubleshooting)
- [Production Deployment](#production-deployment)

---

## Overview

The plane-claude-orchestrator is a Python daemon that:

1. **Polls Plane** for new tickets, status changes, and comments
2. **Exposes HTTP API** for dashboard integration
3. **Creates Claude Code sessions** via tmux-session-service when tickets are approved
4. **Monitors completion** via file-based signals (`/tmp/completion-*.txt`)
5. **Updates Plane** with completion summaries and status changes

**Architecture**:
```
Plane API ← (poll) ← Python Daemon → (HTTP API) → terminal-dashboard
                         ↓
                    tmux-session-service → Claude Code sessions
```

---

## Prerequisites

### Required Software

1. **Python 3.11+**
   ```bash
   python3 --version  # Should be 3.11 or higher
   ```

2. **Claude Code CLI** installed and configured
   ```bash
   claude --version
   ```

3. **tmux-session-service** running on port 5001
   ```bash
   curl http://localhost:5001/health
   ```

4. **Plane MCP** configured in `~/.claude.json`
   ```bash
   claude mcp list  # Should show "plane" in the list
   ```

### Required Credentials

1. **Plane API Token** with permissions:
   - Read issues
   - Add comments to issues
   - Update issue status

2. **Plane Workspace and Project IDs**:
   ```bash
   # Get your workspace slug
   # Example: "cslog-workspace"

   # Get project UUID (not the readable identifier like "CSLOG")
   # Example: "60293f71-b90e-4329-b432-22d1e4227126"
   ```

### System Requirements

- **Disk**: 500 MB for logs and state files
- **RAM**: 256 MB minimum
- **Network**: Access to Plane instance and localhost services

---

## Installation

### 1. Clone Repository

```bash
cd /home/cslog/ai-workflow
git pull  # If already cloned
```

### 2. Install Python Dependencies

```bash
cd plane-claude-orchestrator
pip install -r requirements.txt
```

**Dependencies installed**:
- `fastapi` - HTTP API framework
- `uvicorn` - ASGI server
- `aiohttp` - Async HTTP client for Plane API
- `pyyaml` - Configuration parsing
- `python-dotenv` - Environment variable management
- `websockets` - WebSocket support
- `pydantic` - Data validation
- `tenacity` - Retry logic with exponential backoff
- `prometheus-client` - Metrics exposition

### 3. Verify Plane MCP Configuration

```bash
# Test Plane MCP connection
claude mcp call plane get_projects

# Should return your Plane projects
```

If this fails, configure Plane MCP in `~/.claude.json`:
```json
{
  "mcpServers": {
    "plane": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-plane"
      ],
      "env": {
        "PLANE_API_URL": "https://plane.cslog.com.br/api/v1",
        "PLANE_API_TOKEN": "your-api-token-here",
        "PLANE_WORKSPACE_SLUG": "cslog-workspace"
      }
    }
  }
}
```

---

## Configuration

### 1. Create Configuration File

```bash
cd /home/cslog/ai-workflow/plane-claude-orchestrator
cp config.example.yaml config.yaml
```

### 2. Edit Configuration

```yaml
# config.yaml

plane:
  # Plane REST API configuration
  api_url: "https://plane.cslog.com.br/api/v1"
  api_token: "your-plane-api-token"
  workspace_slug: "cslog-workspace"
  project_identifier: "CSLOG"  # Readable identifier (e.g., "CSLOG-16")

  # List of project UUIDs to monitor
  project_ids:
    - "60293f71-b90e-4329-b432-22d1e4227126"  # OLOS project

  # Polling interval in seconds
  poll_interval: 60

tmux_session_service:
  # tmux-session-service API endpoint
  url: "http://localhost:5001"

automation:
  # Repository path for Claude Code sessions
  repo_path: "/home/cslog/ai-workflow"

  # Claude CLI binary path (defaults to "claude" in PATH)
  claude_bin: "claude"

  # Session ID prefix
  session_prefix: "claude-"

  # Project ID for tmux-session-service
  project_id: "plane-automation"

triggers:
  # Enable trigger for new tickets
  new_tickets: true

  # Enable trigger for status changes
  status_changes: true

  # Enable trigger for new comments
  comments: true

logging:
  # Log level: DEBUG, INFO, WARNING, ERROR
  level: "INFO"

  # Log file path (relative to project root)
  file: "logs/orchestrator.log"

api:
  # HTTP API server configuration
  host: "0.0.0.0"
  port: 5002
```

### 3. Get Your Project UUID

If you don't know your project UUID:

```bash
# Using Plane MCP
claude mcp call plane get_projects

# Or using Plane REST API
curl -H "X-Api-Key: your-api-token" \
  https://plane.cslog.com.br/api/v1/workspaces/cslog-workspace/projects/
```

Copy the `id` (UUID format) from your desired project.

---

## Running the Daemon

### Option 1: Docker Compose (Recommended)

The easiest way to run the daemon is via Docker Compose:

```bash
cd /home/cslog/ai-workflow

# Start all services (nginx, dashboard, tmux-service, plane-orchestrator)
docker-compose up -d

# View logs
docker-compose logs -f plane-claude-orchestrator

# Check health
curl https://localhost/health  # Via nginx proxy
curl http://localhost:5002/health  # Direct access
```

**Volumes mounted**:
- `/home/cslog/.claude.json:/root/.claude.json:ro` - Plane MCP config
- `/tmp:/tmp` - Completion signal files
- `plane-orchestrator-data:/app/data` - State persistence
- `plane-orchestrator-logs:/app/logs` - Log files

### Option 2: Manual (Development)

For development or debugging:

```bash
cd /home/cslog/ai-workflow/plane-claude-orchestrator

# Create directories
mkdir -p data logs

# Run the daemon
python -m src.daemon

# Or with custom config
python -m src.daemon --config custom-config.yaml
```

**Expected output**:
```
2025-12-10 14:30:00 - INFO - Starting Plane Claude Orchestrator
2025-12-10 14:30:00 - INFO - Configuration loaded from config.yaml
2025-12-10 14:30:00 - INFO - Plane MCP configured at /home/cslog/.claude.json
2025-12-10 14:30:00 - INFO - HTTP API starting on 0.0.0.0:5002
2025-12-10 14:30:01 - INFO - Polling Plane for triggers...
2025-12-10 14:30:05 - INFO - Poll complete: 0 triggered ticket(s) found
```

### Option 3: systemd Service (Production)

For production auto-start on boot:

```bash
# Create systemd service file
sudo tee /etc/systemd/system/plane-claude-orchestrator.service << EOF
[Unit]
Description=Plane Claude Orchestrator
After=network.target tmux-session-service.service

[Service]
Type=simple
User=cslog
WorkingDirectory=/home/cslog/ai-workflow/plane-claude-orchestrator
ExecStart=/usr/bin/python3 -m src.daemon
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable plane-claude-orchestrator
sudo systemctl start plane-claude-orchestrator

# Check status
sudo systemctl status plane-claude-orchestrator

# View logs
sudo journalctl -u plane-claude-orchestrator -f
```

---

## Dashboard Integration

The terminal-dashboard automatically integrates with the daemon when running in Docker Compose.

### 1. Access Dashboard

Open browser to: **https://localhost** (Docker Compose with nginx)

### 2. Plane Automation Project

The dashboard will automatically create a "⚡ Plane Automation" project that:

- Shows **pending tickets** awaiting approval (with count badge)
- Shows **completed tickets** awaiting Plane update
- Allows **one-click approval** to create Claude Code sessions
- Displays **live terminal output** from Claude sessions

### 3. Workflow

**Approve Pending Ticket**:
1. Click "⚡ Plane" in bottom navigation
2. See list of pending tickets
3. Click **[Approve]** button
4. Terminal automatically opens with Claude Code session

**Update Plane After Completion**:
1. When work is done, type in terminal: `/complete <summary>`
2. Ticket moves to "Completed" section
3. Review summary and click **[Approve Update]**
4. Comment posted to Plane with summary + status update

### 4. Environment Configuration

The dashboard automatically detects the environment:

- **Production (Docker)**: Uses relative URLs (nginx proxy handles routing)
- **Development (npm run dev)**: Uses `http://localhost:5002` for daemon API

No manual configuration needed!

---

## Testing the Setup

### 1. Test Daemon Health

```bash
curl http://localhost:5002/health

# Expected response:
# {
#   "status": "healthy",
#   "tmux_service": true,
#   "pending_count": 0,
#   "active_count": 0,
#   "completed_count": 0
# }
```

### 2. Add Test Ticket

```bash
# Using helper script
cd /home/cslog/ai-workflow
./scripts/add-test-ticket CSLOG-99 "Test ticket for automation"

# Or via API
curl -X POST http://localhost:5002/api/test/add-ticket \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "CSLOG-99",
    "uuid": "test-uuid-123",
    "project_id": "60293f71-b90e-4329-b432-22d1e4227126",
    "title": "Test ticket for automation",
    "description": "This is a test ticket",
    "trigger_type": "new_ticket",
    "created_at": "2025-12-10T14:30:00Z"
  }'
```

### 3. Verify Pending Queue

```bash
curl http://localhost:5002/api/pending-tickets

# Should show the test ticket
```

### 4. Approve Ticket (API)

```bash
curl -X POST http://localhost:5002/api/approve/CSLOG-99

# Expected response:
# {
#   "session_id": "claude-CSLOG-99",
#   "ticket_id": "CSLOG-99",
#   "created_at": "2025-12-10T14:35:00Z"
# }
```

### 5. Verify Session Created

```bash
# Check tmux-session-service
curl http://localhost:5001/sessions

# Should show "claude-CSLOG-99" session

# Attach to session directly
tmux attach-session -t claude-CSLOG-99
```

### 6. Test Completion Flow

In the Claude Code terminal, type:
```
/complete Added retry logic to database.py with exponential backoff
```

Then verify completed queue:
```bash
curl http://localhost:5002/api/completed-tickets

# Should show CSLOG-99 with summary
```

### 7. Test Plane Update

```bash
curl -X POST http://localhost:5002/api/update-plane/CSLOG-99 \
  -H 'Content-Type: application/json' \
  -d '{"summary": "Added retry logic to database.py with exponential backoff"}'

# Expected response:
# {
#   "status": "updated",
#   "ticket_id": "CSLOG-99",
#   "comment_posted": true,
#   "state_updated": true
# }
```

Verify in Plane UI that comment was posted.

---

## Monitoring and Metrics

### Prometheus Metrics

The daemon exposes Prometheus metrics on `/metrics`:

```bash
curl http://localhost:5002/metrics
```

**Available metrics**:

**Queue Metrics** (Gauges):
- `plane_pending_tickets` - Tickets awaiting approval
- `plane_active_sessions` - Claude sessions running
- `plane_completed_tickets` - Tickets awaiting Plane update

**Lifecycle Metrics** (Counters):
- `plane_tickets_approved_total` - Total approved tickets
- `plane_tickets_completed_total` - Total completed tickets
- `plane_updates_total{status="success|failed_comment|failed_state"}` - Plane update results

**Performance Metrics** (Histograms):
- `plane_api_request_duration_seconds{method, endpoint}` - API request latency
- `plane_session_duration_seconds` - Time from approval to completion
- `plane_api_calls_total{operation, status}` - Plane API call results
- `plane_api_retry_total{operation}` - Retry attempts

### Prometheus Configuration

Add to `prometheus.yml`:
```yaml
scrape_configs:
  - job_name: 'plane-orchestrator'
    static_configs:
      - targets: ['localhost:5002']
    metrics_path: '/metrics'
    scrape_interval: 15s
```

### Grafana Dashboard

Example queries:

**Queue Size Over Time**:
```promql
plane_pending_tickets
plane_active_sessions
plane_completed_tickets
```

**Approval Rate**:
```promql
rate(plane_tickets_approved_total[5m])
```

**Plane Update Success Rate**:
```promql
rate(plane_updates_total{status="success"}[5m])
/
rate(plane_updates_total[5m])
```

**Average Session Duration**:
```promql
histogram_quantile(0.5, plane_session_duration_seconds_bucket)
histogram_quantile(0.95, plane_session_duration_seconds_bucket)
```

---

## Troubleshooting

### Issue: Daemon won't start

**Symptom**: Error on startup

**Check**:
```bash
# Verify config file exists
ls -la config.yaml

# Validate YAML syntax
python -c "import yaml; yaml.safe_load(open('config.yaml'))"

# Check port availability
sudo netstat -tlnp | grep 5002
```

**Fix**:
- Ensure `config.yaml` exists and is valid YAML
- Ensure port 5002 is not in use
- Check logs: `cat logs/orchestrator.log`

---

### Issue: No tickets appearing in pending queue

**Symptom**: Daemon polls but no tickets show up

**Check**:
```bash
# Test Plane MCP manually
claude mcp call plane get_projects
claude mcp call plane list_project_issues --project_id "your-project-uuid"

# Check daemon logs
tail -f logs/orchestrator.log | grep -i poll
```

**Fix**:
- Verify `project_ids` in `config.yaml` are correct UUIDs
- Ensure Plane API token has read permissions
- Check `triggers` configuration (new_tickets, status_changes, comments)
- Verify network connectivity to Plane instance

---

### Issue: Session creation fails

**Symptom**: Approval returns 500 error

**Check**:
```bash
# Test tmux-session-service directly
curl http://localhost:5001/health

# Check daemon logs
tail -f logs/orchestrator.log | grep -i session
```

**Fix**:
- Ensure tmux-session-service is running on port 5001
- Verify `repo_path` in `config.yaml` is correct
- Check `claude-ticket-worker` script exists and is executable:
  ```bash
  ls -la /home/cslog/ai-workflow/scripts/claude-ticket-worker
  chmod +x /home/cslog/ai-workflow/scripts/claude-ticket-worker
  ```

---

### Issue: Completion not detected

**Symptom**: Typed `/complete` but ticket not moving to completed queue

**Check**:
```bash
# Verify completion file was created
ls -la /tmp/completion-*.txt

# Check daemon logs
tail -f logs/orchestrator.log | grep -i completion
```

**Fix**:
- Ensure `/tmp` is writable
- Verify daemon has `/tmp` mounted (Docker: check volumes)
- Check `complete-ticket` script is working:
  ```bash
  ./scripts/complete-ticket CSLOG-99 "Test summary"
  ```

---

### Issue: Plane update fails

**Symptom**: Comment not posted to Plane

**Check**:
```bash
# Test Plane MCP comment posting
claude mcp call plane add_issue_comment \
  --project_id "your-project-uuid" \
  --issue_id "issue-uuid" \
  --comment_html "<p>Test comment</p>"

# Check daemon logs
tail -f logs/orchestrator.log | grep -i plane
```

**Fix**:
- Verify Plane API token has comment posting permissions
- Check network connectivity to Plane
- Review retry logs (daemon retries 3 times with exponential backoff)
- Check `plane_api_calls_total` metric for failures

---

### Issue: Dashboard shows "Daemon Unhealthy"

**Symptom**: Red indicator in dashboard UI

**Check**:
```bash
# Test health endpoint
curl http://localhost:5002/health

# In Docker, test via nginx proxy
curl https://localhost/health
```

**Fix**:
- Ensure daemon is running: `docker-compose ps` or `systemctl status plane-claude-orchestrator`
- Check nginx routing (Docker): verify `/health` routes to orchestrator
- Verify CORS settings in `api.py` (should allow dashboard origin)

---

## Production Deployment

For production deployment, see:

- **[PRODUCTION-CHECKLIST.md](PRODUCTION-CHECKLIST.md)** - Comprehensive pre-deployment checklist
- **[DOCKER-DEPLOYMENT.md](../DOCKER-DEPLOYMENT.md)** - Docker Compose deployment guide

**Key Production Considerations**:

1. **Security**:
   - Restrict CORS to dashboard domain only (edit `api.py` line 65)
   - Use HTTPS with valid SSL certificates
   - Protect Plane API token (use environment variables)
   - Set firewall rules to block external access to port 5002

2. **Monitoring**:
   - Set up Prometheus scraping
   - Configure Grafana dashboards
   - Set up alerting for high error rates or queue buildup

3. **Backup**:
   - Backup Docker volumes: `plane-orchestrator-data`, `plane-orchestrator-logs`
   - Backup `config.yaml` and `.claude.json`
   - Test restore procedures

4. **Logging**:
   - Configure log aggregation (e.g., ELK stack, Loki)
   - Set log retention policies
   - Monitor disk space for log volumes

5. **High Availability**:
   - Run daemon with systemd auto-restart
   - Monitor health endpoint with external service (UptimeRobot, Pingdom)
   - Set up alerting for service downtime

---

## Next Steps

After setup:

1. **Test with real Plane ticket**:
   - Create ticket in Plane
   - Wait for polling (up to 60s)
   - Approve in dashboard
   - Complete work with Claude
   - Update Plane

2. **Configure triggers**:
   - Adjust `poll_interval` based on load
   - Enable/disable specific triggers (new_tickets, status_changes, comments)
   - Filter by project ID to monitor specific projects

3. **Set up monitoring**:
   - Add Prometheus scraping
   - Create Grafana dashboards
   - Set up alerts for failures

4. **Production hardening**:
   - Follow [PRODUCTION-CHECKLIST.md](PRODUCTION-CHECKLIST.md)
   - Restrict CORS
   - Enable SSL
   - Configure backups

---

## Support

- **Issues**: Report at [github.com/your-org/ai-workflow/issues](https://github.com/your-org/ai-workflow/issues)
- **Documentation**: See project README and CLAUDE.md
- **Logs**: Check `logs/orchestrator.log` for debugging

---

**Version**: 1.0
**Last Updated**: 2025-12-10
**Author**: plane-claude-orchestrator team
