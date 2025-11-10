# Quick Start Guide

## TL;DR - Get It Running in 2 Minutes

### 1. Start the tmux-session-service

```bash
cd /home/cslog/ai-workflow/tmux-session-service
npm start
```

You should see:
```
tmux-session-service listening on http://0.0.0.0:5001
```

Leave this running (open a new terminal for next steps).

### 2. Start shellinabox with the correct command

**The correct way** (works with your user `cslog`):

```bash
export SESSION_SERVICE_URL=http://127.0.0.1:5001

shellinaboxd \
  --service=/workspace:cslog:/home/cslog/ai-workflow/tmux-session-service/scripts/attach-session.sh \
  -p 4200 \
  --disable-ssl
```

**Why this works:**
- `export SESSION_SERVICE_URL=...` - Sets environment variable BEFORE running shellinabox
- `--service=/workspace:cslog:SCRIPT_PATH` - Format is `/path:username:command`
- No quotes around `cslog` - It's a literal username
- No `SESSION_SERVICE_URL=...` inside the command - That causes parsing errors

### 3. Test it

1. Open your React dashboard: http://localhost:5173
2. Create a project, add a terminal
3. Open the terminal, run some commands:
   ```bash
   echo "Testing persistence"
   cd /tmp
   export MY_VAR="hello"
   ```
4. **Reload the browser tab**
5. Check if it persisted:
   ```bash
   pwd        # Should still be /tmp
   echo $MY_VAR  # Should print "hello"
   ```

## Common Mistakes

### ❌ Wrong: Including SESSION_SERVICE_URL in the command

```bash
# DON'T DO THIS - causes "Cannot look up group" error
shellinaboxd --service=/workspace:cslog:'SESSION_SERVICE_URL=http://127.0.0.1:5001 script.sh'
```

The `:` in the URL makes shellinabox think it's a field separator.

### ❌ Wrong: Quoting LOGIN keyword

```bash
# DON'T DO THIS - causes "Cannot look up user id" error
shellinaboxd --service=/workspace:'LOGIN':'/path/to/script.sh'
```

`LOGIN` is a special keyword that means "use authenticated user". Only use it if you want shellinabox to prompt for login.

### ✅ Correct: Export first, use username, simple path

```bash
export SESSION_SERVICE_URL=http://127.0.0.1:5001
shellinaboxd --service=/workspace:cslog:/path/to/attach-session.sh -p 4200
```

## Verification Commands

```bash
# Check if service is running
curl http://127.0.0.1:5001/health

# List active sessions
curl http://127.0.0.1:5001/sessions | jq .

# List tmux sessions directly
tmux ls

# Check shellinabox is running
ps aux | grep shellinabox
```

## Understanding the Flow

```
1. Browser opens: http://localhost:4200/?terminalId=abc123&projectId=myproject
2. shellinabox receives connection
3. shellinabox sets: QUERY_terminalId=abc123, QUERY_projectId=myproject
4. shellinabox runs: attach-session.sh (from --service parameter)
5. Script reads QUERY_terminalId and calls API:
   curl -X PUT http://127.0.0.1:5001/sessions/abc123
6. API ensures tmux session "abc123" exists (creates if needed)
7. Script runs: tmux new-session -A -s abc123
8. User gets attached to persistent tmux session
9. On browser reload → steps 1-8 repeat, but step 6 finds existing session
```

## Next Steps

- Read [SETUP.md](./SETUP.md) for complete integration guide
- See [README.md](./README.md) for API reference
- Configure systemd for production (see SETUP.md)

## Need Help?

**Sessions not persisting?**
```bash
# Test the script manually
export SESSION_SERVICE_URL=http://127.0.0.1:5001
export QUERY_terminalId=test-terminal
export QUERY_projectId=test-project
/home/cslog/ai-workflow/tmux-session-service/scripts/attach-session.sh
```

**Can't reach API?**
```bash
# Check from shellinabox user context
sudo -u cslog curl http://127.0.0.1:5001/health
```

**Want to clean up?**
```bash
# Delete specific session
curl -X DELETE http://127.0.0.1:5001/sessions/SESSION_ID

# Kill all tmux sessions (nuclear option)
tmux kill-server
```
