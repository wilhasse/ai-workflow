# Terminal Reuse Fix - Unique Session IDs

**Date:** 2025-12-10
**Issue:** Approving the same ticket multiple times caused session ID conflicts

## Problem

When approving the same Plane ticket multiple times (e.g., after deleting the terminal and re-adding the ticket), the system tried to create a terminal with the same session ID:

**Example:**
1. Approve CSLOG-101 → creates session `claude-CSLOG-101`
2. Delete terminal from dashboard
3. Re-add CSLOG-101 to pending queue (via test script)
4. Approve CSLOG-101 again → tries to create session `claude-CSLOG-101` (conflict!)

**Result:** The dashboard tried to reuse the old terminal ID, causing:
- Connection issues (old session might be closed)
- Stale data in localStorage
- Confusing UX (terminal appears closed even though script runs)

## Root Cause

The orchestrator generated session IDs using only the ticket ID:

`plane-claude-orchestrator/src/api.py` (line 159, old code):
```python
# Create session ID
session_id = f"{self.config.automation.session_prefix}{ticket_id}"
# Result: claude-CSLOG-101 (always the same for this ticket)
```

This meant:
- Every approval of CSLOG-101 → session ID `claude-CSLOG-101`
- No uniqueness per approval
- Conflicts when the same ticket is approved multiple times

## Solution

**Added timestamp to session ID for uniqueness:**

`plane-claude-orchestrator/src/api.py` (line 158-160, new code):
```python
# Create unique session ID with timestamp to allow re-approving same ticket
timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
session_id = f"{self.config.automation.session_prefix}{ticket_id}-{timestamp}"
# Result: claude-CSLOG-101-20251210-222945 (unique per approval)
```

### Benefits

1. **Multiple approvals work:** You can approve the same ticket multiple times
2. **No ID conflicts:** Each approval gets a unique session ID
3. **Clean separation:** Each session is independent and doesn't interfere with previous ones
4. **Traceable:** Timestamp in ID helps identify when the session was created

## Examples

### Before Fix
- 1st approval: `claude-CSLOG-101` ← Original
- Delete terminal
- 2nd approval: `claude-CSLOG-101` ← Conflict! Same ID as before

### After Fix
- 1st approval: `claude-CSLOG-101-20251210-222000`
- Delete terminal
- 2nd approval: `claude-CSLOG-101-20251210-222945` ← Different ID, no conflict!

## Testing

### Test Case 1: Re-approve same ticket
```bash
# Add ticket
./scripts/add-test-ticket CSLOG-102 "Test unique IDs"

# Approve in dashboard → creates claude-CSLOG-102-20251210-222945
# Delete the terminal in dashboard
# Add same ticket again
./scripts/add-test-ticket CSLOG-102 "Test unique IDs"

# Approve again → creates claude-CSLOG-102-20251210-223012 (new ID!)
```

### Test Case 2: Multiple concurrent approvals
```bash
# Add multiple instances of the same ticket
./scripts/add-test-ticket CSLOG-103 "First instance"
./scripts/add-test-ticket CSLOG-103 "Second instance"

# Approve both → each gets unique ID:
# - claude-CSLOG-103-20251210-223100
# - claude-CSLOG-103-20251210-223130
```

## Terminal Naming in Dashboard

The dashboard terminal shows:
- **Terminal name:** `CSLOG-101` (ticket ID, for readability)
- **Terminal ID:** `claude-CSLOG-101-20251210-222945` (session ID, for uniqueness)
- **Notes:** Ticket title (for context)

This means:
- UI shows clean ticket IDs: "CSLOG-101", "CSLOG-102", etc.
- Underlying system uses unique session IDs to prevent conflicts
- Best of both worlds: readable UI + robust backend

## Session ID Format

```
claude-{ticket_id}-{timestamp}

Where:
  claude-      = Session prefix (configurable in config.yaml)
  CSLOG-101    = Ticket identifier from Plane
  20251210     = Date (YYYYMMDD)
  222945       = Time (HHMMSS)

Example: claude-CSLOG-101-20251210-222945
```

## Related Files

- `plane-claude-orchestrator/src/api.py` - Session ID generation (line 158-160)
- `terminal-dashboard/src/App.jsx` - Terminal creation using session_id from API
- `scripts/add-test-ticket` - Test script for adding tickets

## Backwards Compatibility

**Existing sessions:** Old sessions without timestamps (like `claude-CSLOG-99`) will continue to work. The change only affects NEW approvals.

**Migration:** No migration needed. Old sessions can coexist with new timestamped sessions.

## Future Enhancements

Potential improvements (not implemented):

1. **UUID instead of timestamp:** Use `uuid4()` for guaranteed uniqueness across distributed systems
2. **Counter-based IDs:** `claude-CSLOG-101-1`, `claude-CSLOG-101-2`, etc.
3. **Session cleanup:** Auto-delete old sessions after N days
4. **Session reuse detection:** Warn user if trying to approve an already-active ticket

---

**Status:** ✅ Fixed - Session IDs now include timestamp for uniqueness
