# tmux-session-service Installation Guide

Complete step-by-step installation and configuration guide for setting up persistent terminal sessions with shellinabox.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Installation](#installation)
3. [Configuration](#configuration)
4. [Verification](#verification)
5. [Production Setup](#production-setup)
6. [Troubleshooting](#troubleshooting)

## Prerequisites

### Required Software

```bash
# Update package lists
sudo apt-get update

# Install Node.js (version 20 or higher)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install tmux
sudo apt-get install -y tmux

# Install shellinabox (if not already installed)
sudo apt-get install -y shellinabox

# Install curl (for API testing)
sudo apt-get install -y curl

# Install jq (for JSON parsing, optional but recommended)
sudo apt-get install -y jq
```

### Verify Installations

```bash
# Check Node.js version (should be 20+)
node --version

# Check tmux version
tmux -V

# Check shellinabox installation
which shellinaboxd
```

## Installation

### Step 1: Clone or Copy the Repository

If you're setting this up from scratch:

```bash
cd /home/cslog
git clone https://github.com/wilhasse/ai-workflow.git
cd ai-workflow/tmux-session-service
```

Or if you already have the repository:

```bash
cd /home/cslog/ai-workflow/tmux-session-service
```

### Step 2: Install Node.js Dependencies

The service has no external dependencies, but you should verify package.json:

```bash
# Optional: Initialize package-lock.json
npm install --package-lock-only

# Verify the service starts
node --check src/server.js
```

### Step 3: Verify Script Permissions

Ensure the attach script is executable:

```bash
chmod +x scripts/attach-session.sh

# Verify permissions
ls -la scripts/attach-session.sh
# Should show: -rwxr-xr-x
```

### Step 4: Create Data Directory

```bash
# The data directory should already exist, but verify:
mkdir -p data
ls -la data/

# If sessions.json doesn't exist, create it:
echo '{"sessions":{}}' > data/sessions.json
```

## Configuration

### Step 5: Configure shellinabox Service

#### 5.1 Backup Current Configuration

```bash
sudo cp /etc/default/shellinabox /etc/default/shellinabox.backup
```

#### 5.2 Update Configuration File

Edit the shellinabox configuration:

```bash
sudo nano /etc/default/shellinabox
```

Replace the contents with:

```bash
# Should shellinaboxd start automatically
SHELLINABOX_DAEMON_START=1

# TCP port that shellinboxd's webserver listens on
SHELLINABOX_PORT=4200

# Session service URL for tmux persistence
export SESSION_SERVICE_URL=http://127.0.0.1:5001

# Parameters that are managed by the system and usually should not need
# changing:
# SHELLINABOX_DATADIR=/var/lib/shellinabox
# SHELLINABOX_USER=shellinabox
# SHELLINABOX_GROUP=shellinabox

# Custom service definition for tmux session persistence
# Format: url-path:username:groupname:working-dir:command
# IMPORTANT: Replace 'cslog' with your actual username
SHELLINABOX_ARGS="--no-beep --disable-ssl --service=/:cslog:cslog:/home/cslog:/home/cslog/ai-workflow/tmux-session-service/scripts/attach-session.sh"
```

**Important**: Replace `cslog` with your actual username in three places:
- `:cslog:cslog:` (username and groupname)
- `/home/cslog:` (working directory)
- `/home/cslog/ai-workflow/...` (script path)

Save and exit (Ctrl+X, Y, Enter in nano).

#### 5.3 Verify Configuration Syntax

```bash
cat /etc/default/shellinabox
```

Ensure:
- ✅ `SESSION_SERVICE_URL` is set to `http://127.0.0.1:5001`
- ✅ `SHELLINABOX_ARGS` contains the full path to `attach-session.sh`
- ✅ Username and paths match your system

### Step 6: Start tmux-session-service

Open a new terminal or use screen/tmux to run the service in background:

```bash
cd /home/cslog/ai-workflow/tmux-session-service

# Start the service (runs in foreground)
npm start
```

You should see:
```
tmux-session-service listening on http://0.0.0.0:5001
```

**For background execution** (temporary):
```bash
# Using nohup
nohup npm start > /tmp/tmux-session-service.log 2>&1 &

# Or using screen
screen -S tmux-service
npm start
# Press Ctrl+A, then D to detach
```

**For production**, see [Step 10: Production Setup](#step-10-production-setup-systemd-service).

### Step 7: Restart shellinabox Service

```bash
# Restart shellinabox to pick up new configuration
sudo systemctl restart shellinabox

# Check status
sudo systemctl status shellinabox
```

Expected output:
```
● shellinabox.service - LSB: Shell In A Box Daemon
   Active: active (running) since...
```

Look for the command line showing `--service=/:cslog:cslog:/home/cslog:...` in the process list.

## Verification

### Step 8: Verify Installation

#### 8.1 Check tmux-session-service API

```bash
# Test health endpoint
curl http://127.0.0.1:5001/health

# Expected output:
# {"ok":true,"tmuxAvailable":true,"tmuxVersion":"tmux X.X","error":null}

# List sessions
curl http://127.0.0.1:5001/sessions

# Expected output:
# {"sessions":[]}
```

#### 8.2 Test Session Creation via API

```bash
# Create a test session
curl -X PUT http://127.0.0.1:5001/sessions/test-install \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"test-install","projectId":"test"}'

# Verify it was created
curl http://127.0.0.1:5001/sessions | jq .

# Check tmux directly
tmux ls
# Should show: test-install: 1 windows (created...)

# Clean up test session
curl -X DELETE http://127.0.0.1:5001/sessions/test-install
```

#### 8.3 Test shellinabox Integration

```bash
# Check if shellinabox is running with correct config
ps aux | grep shellinabox | grep attach-session.sh
```

Should show a process with your attach-session.sh path.

### Step 9: End-to-End Testing

#### 9.1 Test with React Dashboard

1. **Start React Dashboard** (if not already running):
   ```bash
   cd /home/cslog/ai-workflow/terminal-dashboard
   npm install
   npm run dev
   ```

2. **Open in browser**: http://localhost:5173

3. **Create a project**:
   - Click "Add" in the project tabs
   - Name: "Test Project"
   - Description: "Testing tmux persistence"

4. **Add a terminal**:
   - Click "+ Add terminal"
   - Name: "Test Terminal"
   - Notes: "Testing session persistence"
   - Click "Save terminal"

5. **Test persistence**:
   In the terminal, run:
   ```bash
   echo "Testing persistence!"
   cd /tmp
   export MY_VAR="Hello from tmux"
   pwd
   ```

6. **Reload the browser tab** (F5 or Ctrl+R)

7. **Verify persistence**:
   ```bash
   pwd              # Should still be /tmp
   echo $MY_VAR     # Should print "Hello from tmux"
   history          # Should show previous commands
   ```

#### 9.2 Verify in API and tmux

```bash
# Check sessions via API
curl http://127.0.0.1:5001/sessions | jq .

# Check tmux sessions
tmux ls

# You should see your terminal session listed
```

## Production Setup

### Step 10: Production Setup (systemd Service)

For production, run tmux-session-service as a systemd service:

#### 10.1 Create systemd Service File

```bash
sudo nano /etc/systemd/system/tmux-session-service.service
```

Add the following content (adjust username and paths as needed):

```ini
[Unit]
Description=tmux Session Management Service
Documentation=https://github.com/wilhasse/ai-workflow
After=network.target

[Service]
Type=simple
User=cslog
Group=cslog
WorkingDirectory=/home/cslog/ai-workflow/tmux-session-service
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=10

# Environment variables
Environment="PORT=5001"
Environment="HOST=0.0.0.0"
Environment="NODE_ENV=production"

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=tmux-session-service

[Install]
WantedBy=multi-user.target
```

#### 10.2 Enable and Start Service

```bash
# Reload systemd
sudo systemctl daemon-reload

# Enable service to start on boot
sudo systemctl enable tmux-session-service

# Start the service
sudo systemctl start tmux-session-service

# Check status
sudo systemctl status tmux-session-service
```

#### 10.3 Verify systemd Service

```bash
# Check logs
sudo journalctl -u tmux-session-service -f

# Test API
curl http://127.0.0.1:5001/health
```

### Step 11: Configure shellinabox Systemd Environment

If `SESSION_SERVICE_URL` doesn't get passed from `/etc/default/shellinabox`, create a systemd override:

```bash
sudo systemctl edit shellinabox
```

Add:
```ini
[Service]
Environment="SESSION_SERVICE_URL=http://127.0.0.1:5001"
```

Save and exit, then:
```bash
sudo systemctl daemon-reload
sudo systemctl restart shellinabox
```

### Step 12: Optional - Session Cleanup Cron Job

Create a daily cleanup script for old sessions:

```bash
sudo nano /etc/cron.daily/cleanup-tmux-sessions
```

Add:
```bash
#!/bin/bash
# Cleanup tmux sessions older than 7 days

SESSIONS=$(curl -s http://127.0.0.1:5001/sessions | jq -r '.sessions[] | select(.active == false) | .sessionId')

for session in $SESSIONS; do
  echo "Cleaning up inactive session: $session"
  curl -X DELETE http://127.0.0.1:5001/sessions/$session
done
```

Make it executable:
```bash
sudo chmod +x /etc/cron.daily/cleanup-tmux-sessions
```

## Troubleshooting

### Common Issues and Solutions

#### Issue 1: "Cannot look up group" Error

**Symptom**: shellinabox fails to start with "Cannot look up group" error.

**Solution**: The service format is incorrect. Verify `/etc/default/shellinabox`:
```bash
# Correct format:
SHELLINABOX_ARGS="--service=/:username:groupname:/home/username:/path/to/script"

# Wrong (causes error):
SHELLINABOX_ARGS="--service=/:username:/path/to/script"  # Missing groupname and workdir
```

#### Issue 2: API Not Reachable

**Symptom**: `curl http://127.0.0.1:5001/health` fails.

**Solutions**:
```bash
# Check if service is running
ps aux | grep "node.*server.js"

# If using systemd:
sudo systemctl status tmux-session-service

# Check if port is in use
sudo lsof -i :5001

# Check firewall
sudo ufw status
```

#### Issue 3: Sessions Not Persisting

**Symptom**: Browser reload starts a new shell instead of reconnecting.

**Solutions**:

1. **Check environment variable**:
   ```bash
   # Verify shellinabox sees the variable
   sudo systemctl show shellinabox | grep Environment
   ```

2. **Test script manually**:
   ```bash
   export SESSION_SERVICE_URL=http://127.0.0.1:5001
   export QUERY_terminalId=test-manual
   export QUERY_projectId=test-project
   /home/cslog/ai-workflow/tmux-session-service/scripts/attach-session.sh
   ```

3. **Check shellinabox logs**:
   ```bash
   sudo journalctl -u shellinabox -n 50
   ```

4. **Verify script permissions**:
   ```bash
   ls -la /home/cslog/ai-workflow/tmux-session-service/scripts/attach-session.sh
   # Should be: -rwxr-xr-x
   ```

#### Issue 4: Port 4200 Already in Use

**Symptom**: shellinabox fails to start, port already in use.

**Solution**:
```bash
# Find what's using port 4200
sudo lsof -i :4200

# If it's an old shellinabox instance:
sudo systemctl stop shellinabox
sudo killall shellinaboxd

# Then restart
sudo systemctl start shellinabox
```

#### Issue 5: tmux Not Found

**Symptom**: API health check shows `tmuxAvailable: false`.

**Solution**:
```bash
# Install tmux
sudo apt-get install tmux

# Verify installation
which tmux
tmux -V

# Restart tmux-session-service
sudo systemctl restart tmux-session-service
```

### Logs and Debugging

#### View Service Logs

```bash
# tmux-session-service logs (if using systemd)
sudo journalctl -u tmux-session-service -f

# shellinabox logs
sudo journalctl -u shellinabox -f

# All logs together
sudo journalctl -f -u tmux-session-service -u shellinabox
```

#### Enable Verbose Logging

For debugging, you can add verbose logging:

```bash
# Edit systemd service
sudo systemctl edit tmux-session-service
```

Add:
```ini
[Service]
Environment="DEBUG=*"
```

Then:
```bash
sudo systemctl daemon-reload
sudo systemctl restart tmux-session-service
```

### Manual Cleanup

```bash
# Kill all tmux sessions (nuclear option)
tmux kill-server

# Delete all session metadata
curl -s http://127.0.0.1:5001/sessions | jq -r '.sessions[].sessionId' | while read sid; do
  curl -X DELETE http://127.0.0.1:5001/sessions/$sid
done

# Reset data file
echo '{"sessions":{}}' > /home/cslog/ai-workflow/tmux-session-service/data/sessions.json
```

## Post-Installation

### Verification Checklist

- [ ] tmux-session-service responding to API calls
- [ ] shellinabox running with custom service configuration
- [ ] Test session created successfully via API
- [ ] Browser terminal connects successfully
- [ ] Session persists after browser reload
- [ ] Both services configured to start on boot (if production)

### Monitoring

Set up monitoring for:

```bash
# API health check (add to monitoring system)
curl http://127.0.0.1:5001/health

# Check active sessions count
curl -s http://127.0.0.1:5001/sessions | jq '.sessions | length'

# Check disk usage
du -sh /home/cslog/ai-workflow/tmux-session-service/data/
```

### Security Considerations

1. **Firewall**: Ensure port 5001 is only accessible locally
   ```bash
   sudo ufw status
   # Port 5001 should NOT be exposed externally
   ```

2. **User permissions**: The service runs as your user, ensure proper file permissions

3. **Session cleanup**: Configure the cleanup cron job to prevent unlimited session growth

## Uninstallation

If you need to remove the setup:

```bash
# Stop services
sudo systemctl stop tmux-session-service
sudo systemctl stop shellinabox

# Disable services
sudo systemctl disable tmux-session-service

# Remove systemd service file
sudo rm /etc/systemd/system/tmux-session-service.service
sudo systemctl daemon-reload

# Restore shellinabox config
sudo cp /etc/default/shellinabox.backup /etc/default/shellinabox
sudo systemctl restart shellinabox

# Remove cron job
sudo rm /etc/cron.daily/cleanup-tmux-sessions

# Remove tmux sessions
tmux kill-server

# Remove repository (if desired)
rm -rf /home/cslog/ai-workflow
```

## Additional Resources

- **Quick Start**: See `QUICKSTART.md` for a 2-minute setup guide
- **Setup Guide**: See `SETUP.md` for detailed configuration options
- **API Reference**: See `README.md` for API documentation
- **Configuration Summary**: See `CONFIGURATION-SUMMARY.md` for current setup details

## Support

For issues, questions, or contributions:
- GitHub: https://github.com/wilhasse/ai-workflow
- Issues: https://github.com/wilhasse/ai-workflow/issues

## Version

Installation guide for tmux-session-service v0.1.0
