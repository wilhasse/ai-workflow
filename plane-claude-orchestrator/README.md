# Plane Claude Orchestrator

Automated workflow for spinning up supervised Claude Code instances for Plane tickets.

## Architecture

- **Python daemon** polls Plane via MCP for ticket triggers
- **FastAPI** exposes HTTP API for dashboard integration
- **tmux-session-service** manages persistent Claude Code sessions
- **terminal-dashboard** provides UI for approvals and monitoring

## Setup

### 1. Install Dependencies

```bash
cd plane-claude-orchestrator
pip install -r requirements.txt
```

### 2. Configure

Edit `config.yaml` to match your setup:

- `plane.project_ids`: Plane project UUIDs to monitor
- `plane.project_identifier`: Readable project identifier (e.g., "CSLOG")
- `automation.repo_path`: Path to your repository

### 3. Run Daemon

```bash
# From plane-claude-orchestrator directory
python -m src.daemon

# Or from ai-workflow root
cd plane-claude-orchestrator && python -m src.daemon
```

The daemon will:
- Poll Plane every 30 seconds for triggers
- Expose API on `http://localhost:5002`
- Store state in `data/pending-tickets.json`

## API Endpoints

### GET /health
Health check with service status

### GET /api/pending-tickets
List tickets awaiting approval

### GET /api/completed-tickets
List tickets awaiting Plane update

### POST /api/approve/{ticket_id}
Approve ticket and create Claude Code session

### POST /api/update-plane/{ticket_id}
Update Plane with completion summary

### DELETE /api/tickets/{ticket_id}
Remove ticket from queue

## Testing

### Test Plane Polling

```bash
# Check if daemon can reach Plane
curl http://localhost:5002/health

# Manually trigger a ticket (for testing)
# Add a ticket to pending queue by creating Plane ticket or changing status
```

### Test Session Creation

```bash
# Approve a test ticket
curl -X POST http://localhost:5002/api/approve/CSLOG-TEST

# Verify session was created
curl http://localhost:5001/sessions
```

## Integration with terminal-dashboard

The dashboard polls these endpoints:
- `/api/pending-tickets` - Shows "Approve" buttons
- `/api/completed-tickets` - Shows "Update Plane" buttons

When user clicks "Approve":
1. Dashboard calls `/api/approve/{ticket_id}`
2. Daemon creates tmux session via tmux-session-service
3. Dashboard opens terminal connected to session WebSocket

## Completion Workflow

When work is done:

1. User types `/complete <summary>` in terminal OR
2. Exits Claude and is prompted for summary
3. Summary written to `/tmp/completion-{ticket_id}.txt`
4. Daemon detects file and moves ticket to completed queue
5. Dashboard shows completion with "Approve Update" button
6. User clicks button → daemon posts to Plane via MCP

## Logging

Logs written to `data/orchestrator.log` with INFO level by default.

## Troubleshooting

**Daemon won't start:**
- Check config.yaml is valid YAML
- Verify Python 3.11+ is installed
- Check dependencies installed: `pip list`

**Plane polling not working:**
- Verify `.claude/config.json` has Plane MCP configured
- Test manually: `claude mcp call plane list_project_issues --project_id <uuid>`

**Sessions not creating:**
- Check tmux-session-service is running: `curl http://localhost:5001/health`
- Verify `scripts/claude-ticket-worker` exists and is executable

**Completion not detected:**
- Check `/tmp/completion-*.txt` files are being created
- Verify completion polling loop is running (check logs)
