# Phase 3 Testing Guide - Session Management

This guide walks through testing the complete session lifecycle for Plane ticket automation.

## Prerequisites

1. **Daemon running** on port 5002
2. **tmux-session-service running** on port 5001
3. **terminal-dashboard running** (npm run dev)
4. **Claude Code CLI** installed and accessible in PATH
5. **Plane MCP** configured in ~/.claude.json

## Components Created in Phase 3

### 1. claude-ticket-worker (Shell Script)
**Location:** `/home/cslog/ai-workflow/scripts/claude-ticket-worker`

**Purpose:** Wrapper script that:
- Fetches ticket details from Plane MCP
- Displays ticket title and description
- Launches Claude Code with ticket context
- Allows user to signal completion with `/complete <summary>`

**Test standalone:**
```bash
# This should work even without the daemon
cd /home/cslog/ai-workflow
./scripts/claude-ticket-worker CSLOG-16
```

Expected output:
```
==== 🎫 Working on CSLOG-16 ====
📡 Fetching ticket details from Plane...
📋 Title: Fix database connection retry logic
📝 Description:
Add exponential backoff retry logic to database.py...
============================

🤖 Claude Code will start with ticket context.
💬 You can interact with Claude to guide the work.

When complete, type: /complete <summary of what was done>
```

### 2. Completion Detection
**Location:** `plane-claude-orchestrator/src/daemon.py` (lines 117-152)

**Purpose:** Background loop that:
- Polls `/tmp/completion-{ticket_id}.txt` every 5 seconds
- Reads completion summary from file
- Moves ticket from active → completed queue
- Deletes completion file

**How it works:**
1. User types `/complete <summary>` in Claude Code terminal
2. Script writes summary to `/tmp/completion-CSLOG-16.txt`
3. Daemon detects file within 5 seconds
4. Ticket appears in "Ready to Update Plane" section

### 3. Session Creation Integration
**Location:** `plane-claude-orchestrator/src/api.py` (lines 121-175)

**Purpose:** `/api/approve/{ticket_id}` endpoint now:
- Creates tmux session via tmux-session-service
- Runs `claude-ticket-worker CSLOG-16` in the session
- Returns session_id to dashboard
- Dashboard creates terminal that connects to session

## End-to-End Testing

### Step 1: Add a Test Ticket to Daemon Queue

**Option A: Manually add via Python**
```python
# In another terminal, run this Python snippet:
import requests

response = requests.post("http://localhost:5002/api/pending-tickets", json={
    "id": "CSLOG-999",
    "uuid": "test-uuid-123",
    "project_id": "60293f71-b90e-4329-b432-22d1e4227126",
    "title": "Test ticket for Phase 3",
    "description": "<p>This is a test ticket to verify session creation</p>",
    "trigger_type": "manual_test",
    "created_at": "2025-12-10T20:00:00Z"
})
print(response.json())
```

**Option B: Wait for daemon to poll Plane**
- Create a real ticket in Plane
- Wait up to 60 seconds for daemon to detect it

### Step 2: Verify Ticket Appears in Dashboard

1. Open dashboard: http://localhost:5173
2. Click ⚡ icon in bottom nav
3. Should see test ticket in "Pending Approval" section

### Step 3: Approve the Ticket

1. Click **"Approve & Start Claude"** button
2. Dashboard should:
   - Create "plane-automation" project (if not exists)
   - Add new terminal with session_id
   - Switch to that terminal
   - Close the PlaneSheet

3. Terminal should show:
   - Ticket details being fetched from Plane
   - Claude Code starting with ticket context
   - Initial prompt ready for interaction

**Expected terminal output:**
```
==== 🎫 Working on CSLOG-999 ====
📡 Fetching ticket details from Plane...
📋 Title: Test ticket for Phase 3
============================

🤖 Claude Code will start with ticket context.

[Claude Code loads...]
```

### Step 4: Interact with Claude

1. Ask Claude questions about the codebase
2. Guide Claude to make changes
3. Review Claude's work

### Step 5: Signal Completion

When work is done, in the terminal type:
```
/complete Added test changes to verify workflow. Modified README.md with test notes.
```

**OR use the helper script in another terminal:**
```bash
./scripts/complete-ticket CSLOG-999 "Completed test ticket successfully"
```

### Step 6: Verify Completion Detection

Within 5 seconds:

1. Daemon log should show:
   ```
   Detected completion for CSLOG-999: Completed test ticket successfully
   Marked ticket CSLOG-999 as completed
   ```

2. Dashboard PlaneSheet should show:
   - Ticket moved from "Pending Approval" → "Ready to Update Plane"
   - Summary displayed
   - "Approve & Update Plane" button visible

### Step 7: Update Plane (Phase 4 - not yet implemented)

Click **"Approve & Update Plane"** button:
- This will POST to `/api/update-plane/CSLOG-999`
- Should add comment to Plane ticket
- Should update ticket status
- Should remove from completed queue

*Note: Phase 4 functionality may not be fully tested yet*

## Troubleshooting

### Issue: Ticket doesn't appear in dashboard

**Check:**
1. Daemon logs: `tail -f logs/orchestrator.log`
2. Verify daemon is running: `curl http://localhost:5002/health`
3. Check pending tickets: `curl http://localhost:5002/api/pending-tickets`

### Issue: Terminal doesn't open when approving

**Check:**
1. tmux-session-service running: `curl http://localhost:5001/health`
2. Browser console for errors (F12)
3. Daemon logs for session creation errors

### Issue: Completion not detected

**Check:**
1. Completion file exists: `ls -la /tmp/completion-*.txt`
2. File has content: `cat /tmp/completion-CSLOG-999.txt`
3. Daemon completion loop running (check logs)
4. Ticket is in active_sessions (check /health endpoint)

### Issue: Claude Code doesn't start

**Check:**
1. Claude Code installed: `which claude`
2. Plane MCP configured: `cat ~/.claude.json | grep plane`
3. Script permissions: `ls -la scripts/claude-ticket-worker`
4. Run script manually to see errors

## Manual Testing Commands

```bash
# 1. Check daemon health
curl http://localhost:5002/health

# 2. List pending tickets
curl http://localhost:5002/api/pending-tickets

# 3. Manually trigger completion
echo "Test completion summary" > /tmp/completion-CSLOG-999.txt

# 4. List completed tickets
curl http://localhost:5002/api/completed-tickets

# 5. Check active sessions
curl http://localhost:5001/sessions

# 6. Manually delete ticket
curl -X DELETE http://localhost:5002/api/tickets/CSLOG-999
```

## Success Criteria

Phase 3 is working correctly when:

- ✅ Clicking "Approve" creates a new terminal
- ✅ Terminal shows Claude Code running with ticket context
- ✅ User can interact with Claude normally
- ✅ Typing `/complete <summary>` signals completion
- ✅ Ticket appears in "Ready to Update Plane" within 5 seconds
- ✅ Multiple tickets can be worked on in parallel

## Next Phase

Once Phase 3 is verified, proceed to **Phase 4: Plane Update Workflow** which implements:
- Posting comments to Plane via MCP
- Updating ticket status (Todo → In Progress)
- Cleaning up completed queue after update
