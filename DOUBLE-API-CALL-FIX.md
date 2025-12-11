# Double API Call Fix - Plane Ticket Approval

**Date:** 2025-12-10
**Issue:** "Ticket not found in pending queue" error when clicking "Approve & Start Claude"

## Problem

When clicking "Approve & Start Claude" on a pending ticket, the API endpoint `/api/approve/{ticket_id}` was being called **twice** in rapid succession:

```
01:20:19 - "POST /api/approve/CSLOG-99 HTTP/1.0" 200 OK  ← First call succeeded
01:20:19 - "POST /api/approve/CSLOG-99 HTTP/1.0" 404 Not Found  ← Second call failed
```

**Result:** User saw error "Failed to approve ticket: Ticket not found in pending queue" even though the ticket was successfully approved and the Claude Code session was created.

## Root Cause

The approval flow had duplicate API calls in the component hierarchy:

### Call #1: From usePlaneTickets Hook
`terminal-dashboard/src/hooks/usePlaneTickets.js` (line 73-93):
```javascript
const approveTicket = useCallback(async (ticketId) => {
  const response = await fetch(`${DAEMON_API_BASE}/api/approve/${ticketId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.detail || `Failed to approve ticket: ${response.status}`)
  }
  await fetchPendingTickets() // Refresh list
  return await response.json()
}, [fetchPendingTickets])
```

### Call #2: From App.jsx Handler
`terminal-dashboard/src/components/plane/PlaneAutomationProject.jsx` (line 21-34):
```javascript
const handleApprove = async (ticket) => {
  setProcessingTicket(ticket.id)
  try {
    const result = await approveTicket(ticket.id) // ← Hook's approveTicket (API CALL #1)
    if (onApproveTicket) {
      onApproveTicket(ticket, result) // ← Calls App.jsx handler
    }
  } catch (err) {
    alert(`Failed to approve ticket: ${err.message}`)
  } finally {
    setProcessingTicket(null)
  }
}
```

`terminal-dashboard/src/App.jsx` (old code, line 590-654):
```javascript
const handleApproveTicket = useCallback(async (ticket) => {
  try {
    // THIS WAS THE DUPLICATE CALL!
    const response = await fetch(approveEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }) // ← API CALL #2

    const result = await response.json()
    // ... create terminal ...
  } catch (error) {
    alert(`Failed to approve ticket: ${error.message}`)
  }
}, [projects])
```

### Why the Double Call Happened

1. User clicks "Approve & Start Claude"
2. `PlaneAutomationProject.handleApprove()` calls `approveTicket(ticket.id)` from hook
3. **FIRST API CALL** (from hook) → 200 OK, ticket moved from pending to active
4. Hook returns result
5. Component calls `onApproveTicket(ticket, result)` prop
6. `App.jsx.handleApproveTicket()` receives the call
7. **SECOND API CALL** (from App.jsx) → 404 Not Found (ticket already in active queue)

## Solution

**Modified `App.jsx` to eliminate duplicate API call:**

Changed `handleApproveTicket` from:
- Making its own API call (`async (ticket) => { fetch(...) }`)
- To receiving the result from the hook (`(ticket, result) => { ... }`)

### Fixed Code

`terminal-dashboard/src/App.jsx` (line 590-633):
```javascript
const handleApproveTicket = useCallback((ticket, result) => {
  // Note: API call is handled by usePlaneTickets.approveTicket()
  // This function only handles terminal creation after approval

  // Ensure we have a "plane-automation" project
  let planeProject = projects.find((p) => p.id === 'plane-automation')

  if (!planeProject) {
    // Create plane-automation project if it doesn't exist
    planeProject = {
      id: 'plane-automation',
      name: '⚡ Plane Automation',
      description: 'Claude Code sessions for Plane tickets',
      protocol: DEFAULT_PROTOCOL,
      baseHost: DEFAULT_HOST,
      basePort: DEFAULT_BASE_PORT,
      portStrategy: DEFAULT_PORT_STRATEGY,
      portStrategyLocked: true,
      terminals: [],
    }
    setProjects((prev) => [...prev, planeProject])
  }

  // Create terminal for this ticket
  const terminal = {
    id: result.session_id,
    name: ticket.id,
    offset: findNextOffset(planeProject.terminals),
    notes: ticket.title,
  }

  setProjects((prev) =>
    prev.map((project) =>
      project.id === 'plane-automation'
        ? { ...project, terminals: [...project.terminals, terminal] }
        : project,
    ),
  )

  // Switch to plane-automation project and select the new terminal
  setActiveProjectId('plane-automation')
  setActiveTerminalId(terminal.id)
  setActiveSheet(null)
}, [projects])
```

### Key Changes

1. **Signature changed:** `async (ticket) => {...}` → `(ticket, result) => {...}`
2. **No async:** Function is now synchronous (no API call)
3. **Receives result:** The `result` parameter contains the API response from the hook's call
4. **Single responsibility:** Only handles UI state (project/terminal creation)

## Verification

After the fix, the approval flow works correctly:

1. User clicks "Approve & Start Claude"
2. Component calls hook's `approveTicket(ticket.id)`
3. **ONE API CALL** to `/api/approve/{ticket_id}` → 200 OK
4. Ticket moved from pending to active
5. tmux session created: `claude-CSLOG-99`
6. Hook returns result: `{ session_id: "claude-CSLOG-99", ticket_id: "CSLOG-99", created_at: "..." }`
7. Component calls `onApproveTicket(ticket, result)` with the result
8. `App.jsx.handleApproveTicket()` creates terminal using the result
9. No second API call!

### Testing Steps

```bash
# 1. Add a test ticket
./scripts/add-test-ticket CSLOG-101 "Test double-call fix"

# 2. Open dashboard: https://localhost

# 3. Click ⚡ icon in desktop mode (or swipe up in mobile)

# 4. Click "Approve & Start Claude" on CSLOG-101

# 5. Watch orchestrator logs (should see only ONE approval request)
docker-compose logs -f plane-claude-orchestrator

# Expected output:
# INFO - Approved ticket CSLOG-101, created session claude-CSLOG-101
# INFO - "POST /api/approve/CSLOG-101 HTTP/1.0" 200 OK
# (NO second 404 error!)

# 6. Verify terminal was created in dashboard
# Should see new terminal "CSLOG-101" in "⚡ Plane Automation" project
```

## Bundle History

- `index-BsjXSaqK.js` - Had double API call bug
- `index-CKZokg49.js` - **Fixed** (current)

## Related Files

- `terminal-dashboard/src/App.jsx` - Fixed `handleApproveTicket` function
- `terminal-dashboard/src/hooks/usePlaneTickets.js` - Contains the single API call
- `terminal-dashboard/src/components/plane/PlaneAutomationProject.jsx` - Calls both hook and handler
- `plane-claude-orchestrator/src/api.py` - `/api/approve/{ticket_id}` endpoint

## Lessons Learned

**Problem:** Having the same API call in multiple layers of the component hierarchy leads to duplicate requests.

**Solution:** Follow single responsibility principle:
- **Hook layer:** Handles API calls and state updates
- **Component layer:** Handles user interaction and calls hooks
- **Parent layer (App.jsx):** Handles UI state (terminals, projects) based on results

**Pattern to avoid:**
```javascript
// BAD: Both hook and parent make the same API call
const hook = () => {
  const doSomething = async () => {
    await fetch('/api/something') // ← API call #1
  }
  return { doSomething }
}

const Parent = () => {
  const { doSomething } = useHook()
  const handleSomething = async () => {
    await doSomething() // ← Calls API
    await fetch('/api/something') // ← API call #2 (DUPLICATE!)
  }
}
```

**Correct pattern:**
```javascript
// GOOD: Hook makes API call, parent handles result
const hook = () => {
  const doSomething = async () => {
    const result = await fetch('/api/something') // ← Single API call
    return result
  }
  return { doSomething }
}

const Parent = () => {
  const { doSomething } = useHook()
  const handleSomething = async () => {
    const result = await doSomething() // ← Gets result from hook
    // Use result to update UI state
    updateUIState(result)
  }
}
```

---

**Status:** ✅ Fixed in bundle `index-CKZokg49.js`
