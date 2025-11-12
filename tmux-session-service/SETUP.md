# tmux-session-service Setup Guide

> **Heads up:** The default stack now embeds xterm.js inside `terminal-dashboard` and connects directly to `tmux-session-service` over `/ws/sessions/…`. Shellinabox instructions remain below for historical reference, but new deployments should follow the modern WebSocket flow.

## Modern Setup (xterm.js + WebSocket Bridge)

1. **Start tmux-session-service**
   ```bash
   cd /home/cslog/ai-workflow/tmux-session-service
   npm install   # first run
   npm start
   ```
   Confirm `http://localhost:5001/health` returns `{"ok":true,...}`.

2. **Proxy `/ws/sessions/` through nginx**
   - Ensure `nginx/nginx.conf` contains the WebSocket location block from the repo.
   - Restart nginx: `docker-compose exec nginx nginx -s reload`.

3. **Configure the dashboard**
   - In `terminal-dashboard`, set the project host to your public hostname/IP.
   - Set the base port to the tmux-service port (default `5001`); the app automatically upgrades to `wss://…/ws/sessions/<id>`.

4. **Test the bridge**
   ```bash
   npx wscat -c ws://localhost:5001/ws/sessions/dev-shell
   ```
   Run `pwd`, create a file, disconnect (`Ctrl+C`), reconnect with the same command, and verify state is preserved.

5. **Deploy with Docker Compose**
   ```bash
   docker-compose up -d
   docker-compose logs -f tmux-session-service
   ```
   The dashboard should now show embedded terminals without needing `shellinabox`.

## Legacy shellinabox workflow (deprecated)

This section documents the previous integration path for reference.

## What This Does

**Problem**: When you reload a browser terminal, you lose your shell session, command history, and running processes.

**Solution**: This service creates persistent tmux sessions that survive browser reloads. Each terminal in your dashboard reconnects to the same tmux session instead of starting fresh.

## Architecture

```
Browser (React Dashboard)
    ↓ (opens iframe with terminalId)
shellinabox (Port 4200)
    ↓ (calls attach-session.sh)
tmux-session-service API (Port 5001)
    ↓ (creates/ensures tmux session exists)
tmux session
    ↓ (reattach on reload)
Your persistent shell
```

## Prerequisites

- Node.js 20+ (for the API service)
- tmux installed (`sudo apt-get install tmux` or `yum install tmux`)
- shellinabox running
- curl (for the attach script)

## Step-by-Step Setup

### 1. Start the tmux-session-service

```bash
cd /home/cslog/ai-workflow/tmux-session-service

# Start the service (runs forever in foreground)
npm start
```

**Output**: You should see:
```
tmux-session-service listening on http://0.0.0.0:5001
```

**To run in background**:
```bash
# Using nohup
nohup npm start > /tmp/tmux-session-service.log 2>&1 &

# Or using systemd (recommended for production)
# See "Production Setup" section below
```

### 2. Verify the Service is Running

```bash
# Check health
curl http://127.0.0.1:5001/health

# Should return:
# {"ok":true,"tmuxAvailable":true,"tmuxVersion":"tmux 3.3a","error":null}

# List active sessions
curl http://127.0.0.1:5001/sessions
```

### 3. Configure shellinabox

The key is to use the `attach-session.sh` script as the shell command.

**Export the service URL** (so the script knows where to find the API):
```bash
export SESSION_SERVICE_URL=http://127.0.0.1:5001
```

**Start shellinabox with the attach script**:
```bash
shellinaboxd \
  --service=/workspace:cslog:/home/cslog/ai-workflow/tmux-session-service/scripts/attach-session.sh \
  -p 4200 \
  --disable-ssl
```

**Important syntax notes**:
- `--service=/workspace:cslog:SCRIPT_PATH` - Format is `/path:username:command`
- Use your actual username instead of `cslog`
- Do NOT use quotes around `LOGIN` keyword (only use if you want shellinabox to prompt for login)
- Do NOT put the environment variable in the command string (it causes parsing errors)
- The script must have execute permissions (`chmod +x`)

### 4. Test the Integration

1. **Open your terminal dashboard** (React app at http://localhost:5173)
2. **Create a project** and add a terminal
3. **Open the terminal** - it will connect through shellinabox
4. **Run some commands** in the terminal:
   ```bash
   echo "Testing persistence"
   export TEST_VAR="hello"
   cd /tmp
   ```
5. **Reload the browser tab**
6. **Verify persistence**:
   ```bash
   echo $TEST_VAR  # Should still show "hello"
   pwd             # Should still be in /tmp
   ```

### 5. Verify Sessions are Created

```bash
# List tmux sessions
tmux ls

# Should show sessions with IDs matching your terminal IDs
# Example: terminal-abc123: 1 windows (created Sun Nov 10 08:00:00 2025)

# Check the API
curl http://127.0.0.1:5001/sessions | jq .
```

## How It Works

### Query Parameters Flow

1. **React Dashboard** opens iframe: `https://host:4200/?projectId=project-123&terminalId=terminal-456`
2. **shellinabox** receives connection and sets environment variables:
   - `QUERY_projectId=project-123`
   - `QUERY_terminalId=terminal-456`
3. **attach-session.sh** reads these variables and calls API:
   ```bash
   curl -X PUT http://127.0.0.1:5001/sessions/terminal-456 \
     -d '{"sessionId":"terminal-456","projectId":"project-123"}'
   ```
4. **tmux-session-service** ensures session exists (creates if needed)
5. **Script attaches** to tmux session: `tmux new-session -A -s terminal-456`

### Session Lifecycle

- **First connection**: Service creates new tmux session
- **Reload browser**: Script reattaches to existing tmux session
- **Close browser**: tmux session stays alive
- **Manual cleanup**: `curl -X DELETE http://127.0.0.1:5001/sessions/SESSION_ID`

## Troubleshooting

### Service not starting

**Check Node.js version**:
```bash
node --version  # Should be 20+
```

**Check tmux installation**:
```bash
which tmux
tmux -V
```

### Sessions not persisting

**Verify API is reachable from script**:
```bash
# Run this as the shellinabox user
export SESSION_SERVICE_URL=http://127.0.0.1:5001
curl -s $SESSION_SERVICE_URL/health
```

**Check shellinabox logs**:
```bash
# If running as service
journalctl -u shellinabox -f

# Check environment variables are passed
ps aux | grep shellinabox
```

**Test the script manually**:
```bash
export SESSION_SERVICE_URL=http://127.0.0.1:5001
export QUERY_terminalId=test-terminal
export QUERY_projectId=test-project

/home/cslog/ai-workflow/tmux-session-service/scripts/attach-session.sh
# Should create session and attach
```

### "Cannot look up user id" error

This means shellinabox is misinterpreting the command syntax.

**Wrong**:
```bash
# DON'T quote LOGIN or include SESSION_SERVICE_URL in command
shellinaboxd --service=/workspace:'LOGIN':'SESSION_SERVICE_URL=...'
```

**Correct**:
```bash
# Export variable first, use username, no extra quotes
export SESSION_SERVICE_URL=http://127.0.0.1:5001
shellinaboxd --service=/workspace:cslog:/path/to/attach-session.sh
```

### Sessions not cleaning up

**List all sessions**:
```bash
curl http://127.0.0.1:5001/sessions | jq .
tmux ls
```

**Delete specific session**:
```bash
curl -X DELETE http://127.0.0.1:5001/sessions/SESSION_ID
```

**Kill all tmux sessions** (nuclear option):
```bash
tmux kill-server
```

## Production Setup

### Using systemd for tmux-session-service

Create `/etc/systemd/system/tmux-session-service.service`:

```ini
[Unit]
Description=tmux Session Management Service
After=network.target

[Service]
Type=simple
User=cslog
WorkingDirectory=/home/cslog/ai-workflow/tmux-session-service
ExecStart=/usr/bin/node src/server.js
Restart=always
Environment="PORT=5001"
Environment="HOST=0.0.0.0"

[Install]
WantedBy=multi-user.target
```

**Enable and start**:
```bash
sudo systemctl daemon-reload
sudo systemctl enable tmux-session-service
sudo systemctl start tmux-session-service
sudo systemctl status tmux-session-service
```

### Using systemd for shellinabox

Modify existing shellinabox service or create override:

```bash
sudo systemctl edit shellinabox
```

Add:
```ini
[Service]
Environment="SESSION_SERVICE_URL=http://127.0.0.1:5001"
ExecStart=
ExecStart=/usr/bin/shellinaboxd \
  --service=/workspace:cslog:/home/cslog/ai-workflow/tmux-session-service/scripts/attach-session.sh \
  -p 4200 \
  --disable-ssl
```

## API Reference

### Health Check
```bash
curl http://127.0.0.1:5001/health
```

### List Sessions
```bash
curl http://127.0.0.1:5001/sessions
```

### Create/Ensure Session
```bash
curl -X PUT http://127.0.0.1:5001/sessions/my-session-id \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"my-session-id","projectId":"my-project"}'
```

### Keep Session Alive
```bash
curl -X POST http://127.0.0.1:5001/sessions/my-session-id/keepalive
```

### Delete Session
```bash
curl -X DELETE http://127.0.0.1:5001/sessions/my-session-id
```

## Next Steps

1. **Update React Dashboard** - Ensure terminalIds are stable and passed via query params
2. **Add session cleanup** - Create cron job to clean up old sessions
3. **Monitor sessions** - Use the API to track active sessions
4. **SSL Configuration** - Set up HTTPS for shellinabox in production

## Quick Reference Commands

```bash
# Start service
cd /home/cslog/ai-workflow/tmux-session-service && npm start

# Start shellinabox (export URL first)
export SESSION_SERVICE_URL=http://127.0.0.1:5001
shellinaboxd --service=/workspace:cslog:/home/cslog/ai-workflow/tmux-session-service/scripts/attach-session.sh -p 4200

# Check status
curl http://127.0.0.1:5001/health
curl http://127.0.0.1:5001/sessions
tmux ls

# Clean up
curl -X DELETE http://127.0.0.1:5001/sessions/SESSION_ID
tmux kill-session -t SESSION_ID
```
