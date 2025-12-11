# Docker Deployment Fixes

**Date:** 2025-12-10

## Issue: Test Ticket Script Failed in Docker Environment

### Problem
The `add-test-ticket` script was failing with "Not Found" error and showing degraded health status after Docker deployment:

```bash
$ ./scripts/add-test-ticket CSLOG-99 "Test automation"
Response: {"detail": "Not Found"}
Health: {"status": "degraded", "tmux_service": false}
```

### Root Cause
The script was configured for local development (calling `localhost:5002` directly), but after containerization:
- The orchestrator runs inside Docker on an internal network
- External access must go through nginx reverse proxy
- Direct localhost:5002 connections fail because that port isn't exposed

### Fix Applied

Updated `scripts/add-test-ticket` to use nginx proxy:

**Before:**
```bash
DAEMON_URL="http://localhost:5002"
curl -s -X POST "$DAEMON_URL/api/test/add-ticket" ...
curl -s "$DAEMON_URL/health" | jq '.'
```

**After:**
```bash
DAEMON_URL="https://localhost"
CURL_OPTS="-k"  # Accept self-signed certificates in dev
curl -s $CURL_OPTS -X POST "$DAEMON_URL/api/test/add-ticket" ...
curl -s $CURL_OPTS "$DAEMON_URL/orchestrator/health" | jq '.'
```

### Verification

After the fix:
```bash
$ ./scripts/add-test-ticket CSLOG-99 "Test automation workflow"
✅ Ticket added successfully!

Response:
{
  "id": "CSLOG-99",
  "uuid": "test-uuid-1765414302",
  "project_id": "60293f71-b90e-4329-b432-22d1e4227126",
  "title": "Test automation workflow",
  ...
}

📊 Check daemon health:
{
  "status": "healthy",
  "tmux_service": true,
  "pending_count": 1,
  "active_count": 0,
  "completed_count": 0
}
```

**Pending tickets API:**
```bash
$ curl -sk https://localhost/api/pending-tickets | jq '.'
[
  {
    "id": "CSLOG-99",
    "title": "Test automation workflow",
    ...
  }
]
```

## Nginx Routing Reference

The orchestrator API endpoints are accessible through nginx:

```nginx
# Test ticket endpoint (regex match)
location ~ ^/api/(pending-tickets|completed-tickets|approve|update-plane|tickets|test) {
    proxy_pass http://plane_orchestrator;
    ...
}

# Health check endpoint
location = /orchestrator/health {
    proxy_pass http://plane_orchestrator/health;
    ...
}

# Metrics endpoint
location = /metrics {
    proxy_pass http://plane_orchestrator/metrics;
    ...
}
```

## URL Mapping

| Direct (Dev) | Docker (via nginx) | Description |
|--------------|-------------------|-------------|
| http://localhost:5002/api/test/add-ticket | https://localhost/api/test/add-ticket | Add test ticket |
| http://localhost:5002/health | https://localhost/orchestrator/health | Health check |
| http://localhost:5002/metrics | https://localhost/metrics | Prometheus metrics |
| http://localhost:5002/api/pending-tickets | https://localhost/api/pending-tickets | Pending queue |
| http://localhost:5002/api/completed-tickets | https://localhost/api/completed-tickets | Completed queue |
| http://localhost:5002/api/approve/{id} | https://localhost/api/approve/{id} | Approve ticket |
| http://localhost:5002/api/update-plane/{id} | https://localhost/api/update-plane/{id} | Update Plane |

## Scripts Status

| Script | Docker Compatible | Notes |
|--------|------------------|-------|
| `add-test-ticket` | ✅ Fixed | Now uses nginx proxy |
| `complete-ticket` | ✅ Works | Writes to `/tmp` (volume mounted) |
| `claude-ticket-worker` | ✅ Works | Runs inside tmux session (host environment) |

## Development vs Production

**Development (current):**
- Self-signed SSL certificates (curl requires `-k` flag)
- Dashboard at `https://localhost`
- CORS allows all origins (`*`)

**Production (see PRODUCTION-CHECKLIST.md):**
- Let's Encrypt SSL certificates
- Restrict CORS to specific domain
- Firewall rules for port 443 only
- Domain name instead of localhost

---

**Status:** All systems operational after fix ✅
