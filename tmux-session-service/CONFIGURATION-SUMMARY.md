# Configuration Summary

## ✅ Setup Complete!

Your tmux-session-service is now fully integrated with shellinabox running as a systemd service.

## What Was Configured

### 1. tmux-session-service
- **Status**: Running on port 5001
- **Started with**: `npm start` in `/home/cslog/ai-workflow/tmux-session-service`
- **Health check**: http://127.0.0.1:5001/health
- **API**: http://127.0.0.1:5001/sessions

### 2. shellinabox systemd service
- **Status**: Active and running
- **Configuration file**: `/etc/default/shellinabox`
- **Backup saved**: `/etc/default/shellinabox.backup`
- **Port**: 4200
- **Service command**: Uses `/home/cslog/ai-workflow/tmux-session-service/scripts/attach-session.sh`

### Configuration Details

File: `/etc/default/shellinabox`
```bash
SHELLINABOX_PORT=4200
export SESSION_SERVICE_URL=http://127.0.0.1:5001
SHELLINABOX_ARGS="--no-beep --disable-ssl --service=/:cslog:cslog:/home/cslog:/home/cslog/ai-workflow/tmux-session-service/scripts/attach-session.sh"
```

## How It Works

1. **User opens terminal in React dashboard** → `http://host:4200/?projectId=X&terminalId=Y`
2. **shellinabox receives connection** → Sets `QUERY_projectId` and `QUERY_terminalId` env vars
3. **Runs attach-session.sh** → Script reads env vars
4. **Script calls API** → `PUT http://127.0.0.1:5001/sessions/Y`
5. **API ensures tmux session exists** → Creates if needed, or returns existing
6. **Script attaches to tmux** → `tmux new-session -A -s Y`
7. **User gets persistent shell** → Survives browser reloads!

## Testing

### Test persistence:
1. Open your React dashboard at http://localhost:5173
2. Create a project and add a terminal
3. In the terminal, run:
   ```bash
   echo "Testing persistence"
   cd /tmp
   export MY_VAR="hello world"
   ```
4. **Reload the browser tab**
5. Verify persistence:
   ```bash
   pwd              # Should be /tmp
   echo $MY_VAR     # Should print "hello world"
   ```

### Monitor sessions:
```bash
# Check API sessions
curl http://127.0.0.1:5001/sessions | jq .

# Check tmux sessions directly
tmux ls

# Check shellinabox service
sudo systemctl status shellinabox
```

## Management Commands

### shellinabox service:
```bash
# Restart after config changes
sudo systemctl restart shellinabox

# Check status
sudo systemctl status shellinabox

# View logs
sudo journalctl -u shellinabox -f
```

### tmux-session-service:
```bash
# Start (manual)
cd /home/cslog/ai-workflow/tmux-session-service
npm start

# Check health
curl http://127.0.0.1:5001/health

# List sessions
curl http://127.0.0.1:5001/sessions

# Delete a session
curl -X DELETE http://127.0.0.1:5001/sessions/SESSION_ID
```

### tmux operations:
```bash
# List all sessions
tmux ls

# Attach to a session manually
tmux attach -t SESSION_ID

# Kill a specific session
tmux kill-session -t SESSION_ID

# Kill all sessions (nuclear option)
tmux kill-server
```

## Troubleshooting

### Sessions not persisting?

**Check if tmux-session-service is running:**
```bash
curl http://127.0.0.1:5001/health
# Should return: {"ok":true,"tmuxAvailable":true,...}
```

**Check shellinabox logs:**
```bash
sudo journalctl -u shellinabox -f
```

**Verify attach script is executable:**
```bash
ls -la /home/cslog/ai-workflow/tmux-session-service/scripts/attach-session.sh
# Should show: -rwxr-xr-x
```

### Environment variable not set?

The `/etc/default/shellinabox` file exports `SESSION_SERVICE_URL`, but if it's not working, you can also add it to the systemd service:

```bash
sudo systemctl edit shellinabox
```

Add:
```ini
[Service]
Environment="SESSION_SERVICE_URL=http://127.0.0.1:5001"
```

Then:
```bash
sudo systemctl daemon-reload
sudo systemctl restart shellinabox
```

## Production Recommendations

### 1. Make tmux-session-service a systemd service

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

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable tmux-session-service
sudo systemctl start tmux-session-service
sudo systemctl status tmux-session-service
```

### 2. Set up session cleanup cron

Create `/etc/cron.daily/cleanup-tmux-sessions`:
```bash
#!/bin/bash
# Delete sessions older than 7 days
# Add your cleanup logic here based on API
```

### 3. Monitor the service

Add monitoring for:
- tmux-session-service health endpoint
- Number of active sessions
- Disk usage for session metadata

## Files Modified

- ✅ `/etc/default/shellinabox` - Updated with custom service command
- ✅ Backup saved at: `/etc/default/shellinabox.backup`

## Next Steps

1. ✅ Test persistence in your React dashboard
2. ⬜ Configure tmux-session-service as systemd service (optional, for production)
3. ⬜ Set up session cleanup automation
4. ⬜ Configure SSL for shellinabox in production
5. ⬜ Add monitoring/alerting

## Support

- **Setup Guide**: `tmux-session-service/SETUP.md`
- **Quick Start**: `tmux-session-service/QUICKSTART.md`
- **API Reference**: `tmux-session-service/README.md`

## Quick Reference

```bash
# Check everything is running
curl http://127.0.0.1:5001/health          # API health
sudo systemctl status shellinabox          # shellinabox status
tmux ls                                    # tmux sessions

# Restart services
sudo systemctl restart shellinabox         # Restart shellinabox
# (restart tmux-session-service manually if not using systemd)

# Clean up
curl -X DELETE http://127.0.0.1:5001/sessions/SESSION_ID  # Delete specific session
tmux kill-session -t SESSION_ID            # Kill tmux session
```
