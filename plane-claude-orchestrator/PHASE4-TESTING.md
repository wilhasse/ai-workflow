# Phase 4 Testing Guide - Plane Update Workflow

This guide walks through testing the complete Plane update workflow after completing work on a ticket.

## What Phase 4 Does

Phase 4 closes the automation loop by posting results back to Plane:

1. **Adds a comment** to the ticket with the completion summary
2. **Updates ticket status** from "Todo" → "In Progress" (or any state → "Started" group)
3. **Removes ticket** from completed queue after successful update

## Prerequisites

- All components from Phases 1-3 running
- Valid Plane API credentials in `config.yaml`
- At least one ticket in the **completed queue**

## Already Implemented Components

Phase 4 is **already fully implemented**! Here's what exists:

### 1. Plane MCP Client Methods (`src/plane_client.py`)

**add_issue_comment(project_id, issue_id, comment_html)**
- Posts HTML comment to Plane issue
- Returns `True` on success, `False` on failure
- Uses Plane REST API: `POST /issues/{id}/comments/`

**get_in_progress_state_id(project_id)**
- Finds state with `group == "started"`
- Falls back to name matching ("progress", "started", "doing")
- Returns state UUID or `None`

**update_issue_state(project_id, issue_id, state_id)**
- Updates issue to target state
- Uses Plane REST API: `PATCH /issues/{id}/`
- Returns `True` on success

### 2. API Endpoint (`src/api.py`)

**POST /api/update-plane/{ticket_id}**
- Accepts: `{"summary": "Completion summary text"}`
- Validates ticket in completed queue
- Posts comment with summary + "🤖 Completed with Claude Code assistance"
- Updates ticket state to "In Progress" 
- Removes from completed queue on success
- Returns: `{"status": "updated", "ticket_id": "CSLOG-16"}`

### 3. Dashboard Integration (from Phase 2)

Already built in `PlaneAutomationProject.jsx`:
- Displays completed tickets with summary
- "Edit Summary" button to modify before updating
- "Approve & Update Plane" button
- Calls `/api/update-plane/{id}` with summary

## End-to-End Testing

### Step 1: Complete a Ticket (Phase 3)

First, get a ticket into the completed queue:

```bash
# Add test ticket
./scripts/add-test-ticket CSLOG-888 "Test Plane update workflow"

# Open dashboard and approve it
# http://localhost:5173 → Click ⚡ → Approve

# Wait for terminal to open, then signal completion
./scripts/complete-ticket CSLOG-888 "Added retry logic to database.py with exponential backoff (3 attempts, 5s delay). Modified src/database/connection.py lines 45-67."
```

Or manually in the Claude Code terminal:
```
/complete Added retry logic to database.py with exponential backoff. Modified src/database/connection.py.
```

### Step 2: Verify Ticket in Completed Queue

Check daemon API:
```bash
curl http://localhost:5002/api/completed-tickets | jq '.'
```

Expected output:
```json
[
  {
    "id": "CSLOG-888",
    "uuid": "...",
    "title": "Test Plane update workflow",
    "summary": "Added retry logic to database.py...",
    "completed_at": "2025-12-10T20:45:00Z"
  }
]
```

Check dashboard:
- Click ⚡ icon
- Should see ticket in "Ready to Update Plane" section
- Summary should be displayed
- Two buttons: "Approve & Update Plane" and "Edit Summary"

### Step 3: (Optional) Edit Summary

1. Click **"Edit Summary"** button
2. Modify the text in the textarea
3. Click **"Save & Update Plane"**

OR just proceed with existing summary:

### Step 4: Update Plane

1. Click **"Approve & Update Plane"** button
2. Watch for success/error message

**What happens behind the scenes:**
```
Dashboard → POST /api/update-plane/CSLOG-888
           {"summary": "Added retry logic..."}

Daemon → Plane API:
  1. POST /issues/{uuid}/comments/
     {"comment_html": "<p>Added retry logic...</p><p>🤖 Completed with Claude Code assistance</p>"}
  
  2. GET /projects/{id}/states/ → Find "In Progress" state
  
  3. PATCH /issues/{uuid}/
     {"state": "in-progress-state-uuid"}

Daemon → Removes CSLOG-888 from completed_tickets

Dashboard → Polls /api/completed-tickets → Ticket disappears from UI
```

### Step 5: Verify in Plane

1. Open Plane: https://plane.cslog.com.br
2. Navigate to the ticket (CSLOG-888)
3. Verify:
   - ✅ New comment with your summary
   - ✅ Comment includes "🤖 Completed with Claude Code assistance"
   - ✅ Ticket status changed to "In Progress" (or "Started" group state)

### Step 6: Check Daemon Logs

```bash
tail -f /home/cslog/ai-workflow/plane-claude-orchestrator/logs/orchestrator.log
```

Look for:
```
INFO - Added comment to issue {uuid}
INFO - Updated state for issue {uuid}
INFO - Updated Plane ticket CSLOG-888
```

## Testing Error Scenarios

### 1. Invalid Ticket ID

```bash
curl -X POST http://localhost:5002/api/update-plane/INVALID-999 \
  -H "Content-Type: application/json" \
  -d '{"summary": "Test"}'
```

Expected: `404 Not Found` - "Ticket not found in completed queue"

### 2. Empty Summary

In dashboard:
1. Edit summary
2. Delete all text
3. Try to save

Expected: Button should be disabled (UI validation)

### 3. Plane API Failure

If Plane is unreachable or API token is invalid:
- Check daemon logs for error details
- Error response from `/api/update-plane` endpoint
- Ticket remains in completed queue (not removed)

## Monitoring and Debugging

### Check Queue Status

```bash
# Full health check
curl http://localhost:5002/health | jq '.'

# Output shows:
{
  "status": "healthy",
  "pending_count": 0,
  "active_count": 1,
  "completed_count": 1
}
```

### View All Queues

```bash
# Pending tickets
curl http://localhost:5002/api/pending-tickets | jq '.[] | {id, title, trigger_type}'

# Active sessions (being worked on)
# No direct endpoint, but visible in /health

# Completed tickets
curl http://localhost:5002/api/completed-tickets | jq '.[] | {id, title, summary}'
```

### Test Plane API Connection

```bash
# Verify credentials in config.yaml are correct
cat /home/cslog/ai-workflow/plane-claude-orchestrator/config.yaml | grep -A 10 plane:

# Test Plane API directly (outside daemon)
PLANE_TOKEN="your-token"
WORKSPACE="cslog"
PROJECT_ID="60293f71-b90e-4329-b432-22d1e4227126"

curl "https://plane.cslog.com.br/api/v1/workspaces/$WORKSPACE/projects/$PROJECT_ID/states/" \
  -H "X-Api-Key: $PLANE_TOKEN" | jq '.results[] | {name, group}'
```

## Success Criteria

Phase 4 is working when:

- ✅ Clicking "Approve & Update Plane" posts comment to Plane
- ✅ Comment includes the summary text
- ✅ Comment includes "🤖 Completed with Claude Code assistance"
- ✅ Ticket status updates to "In Progress" or equivalent "started" state
- ✅ Ticket disappears from dashboard completed queue
- ✅ Can edit summary before updating
- ✅ Errors are logged and reported to user

## Common Issues

### Issue: "Failed to add comment to Plane"

**Possible causes:**
- Invalid Plane API token
- Incorrect project_id or issue_id (UUID)
- Network connectivity to Plane instance
- Insufficient permissions on API token

**Fix:**
1. Verify token in `config.yaml`
2. Check daemon logs for detailed error
3. Test Plane API directly with curl (see above)

### Issue: Status doesn't update

**Possible causes:**
- No "In Progress" or "Started" state exists
- State is in different project
- API token lacks permission to update states

**Fix:**
1. Check available states: `list_states()` in plane_client
2. Verify state group is "started"
3. Check Plane workspace settings

### Issue: Ticket doesn't disappear from completed queue

**Possible causes:**
- Update failed but error wasn't shown
- Browser cache (dashboard not refreshing)
- Polling interval delay (up to 5 seconds)

**Fix:**
1. Check daemon logs for errors
2. Manually check: `curl http://localhost:5002/api/completed-tickets`
3. Hard refresh browser (Ctrl+F5)

## Next Steps

After Phase 4 is verified, you have a **complete end-to-end workflow**:

1. Daemon polls Plane for new tickets
2. Dashboard shows pending tickets
3. User approves → Claude Code session starts
4. User guides Claude to complete work
5. User signals completion with summary
6. Dashboard shows completed work
7. User approves Plane update
8. Comment and status posted to Plane

**Ready for Phase 5: Polish & Production!** 🚀
