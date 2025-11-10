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
cd /home/USERNAME
git clone https://github.com/wilhasse/ai-workflow.git
cd ai-workflow/tmux-session-service
```

Or if you already have the repository:

```bash
cd /home/USERNAME/ai-workflow/tmux-session-service
```

### Step 2: Install Node.js Dependencies

The service has no external dependencies, but verify package.json:

```bash
# Verify the service starts
node --check src/server.js
```

### Step 3: Create System-Wide Script Location

The shellinabox service runs as the `shellinabox` user, so we need to install the script where it can access it:

```bash
# Create system directory
sudo mkdir -p /usr/local/bin/tmux-session-service

# Copy the attach script
sudo cp scripts/attach-session.sh /usr/local/bin/tmux-session-service/

# Make it executable
sudo chmod +x /usr/local/bin/tmux-session-service/attach-session.sh

# Verify permissions
ls -la /usr/local/bin/tmux-session-service/
# Should show: -rwxr-xr-x ... attach-session.sh
```

### Step 4: Verify Script Content

The script must extract terminalId from `SHELLINABOX_URL`. Verify it contains:

```bash
cat /usr/local/bin/tmux-session-service/attach-session.sh
```

Key sections to look for:
- `if [[ -n "${SHELLINABOX_URL:-}" ]]; then`
- `if [[ "$SHELLINABOX_URL" =~ terminalId=([^&]+) ]]; then`
- `exec tmux new-session -A -s "$SESSION_ID" "$DEFAULT_SHELL"`

### Step 5: Create Data Directory

```bash
# Create data directory in the source location
mkdir -p data

# Initialize sessions file
echo '{"sessions":{}}' > data/sessions.json

# Verify
ls -la data/
```

## Configuration

### Step 6: Configure shellinabox Service

#### 6.1 Backup Current Configuration

```bash
sudo cp /etc/default/shellinabox /etc/default/shellinabox.backup
```

#### 6.2 Update Configuration File

Edit the shellinabox configuration:

```bash
sudo nano /etc/default/shellinabox
```

Replace the contents with (adjust USERNAME and paths):

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
# Script extracts terminalId from SHELLINABOX_URL environment variable
SHELLINABOX_ARGS="--no-beep --service=/:USERNAME:USERNAME:/home/USERNAME:/usr/local/bin/tmux-session-service/attach-session.sh"
```

**IMPORTANT - Replace these placeholders:**
- `USERNAME` - Your actual username (appears 3 times)
- First `USERNAME` - User to run shell as
- Second `USERNAME` - Group name (usually same as username)
- `/home/USERNAME` - Working directory

**Example for user `cslog`:**
```bash
SHELLINABOX_ARGS="--no-beep --service=/:cslog:cslog:/home/cslog:/usr/local/bin/tmux-session-service/attach-session.sh"
```

**SSL/HTTPS Note:**
- We removed `--disable-ssl` to enable HTTPS (required if your dashboard uses HTTPS)
- shellinabox will use a self-signed certificate by default
- Your browser will show a certificate warning (safe to proceed for internal use)

Save and exit (Ctrl+X, Y, Enter in nano).

#### 6.3 Verify Configuration

```bash
cat /etc/default/shellinabox
```

Ensure:
- ✅ `SESSION_SERVICE_URL` is set to `http://127.0.0.1:5001`
- ✅ `SHELLINABOX_ARGS` contains full path to script in `/usr/local/bin/`
- ✅ Username and paths match your system
- ✅ No `--disable-ssl` flag (HTTPS enabled by default)

### Step 7: Start tmux-session-service

Open a terminal and start the service:

```bash
cd /home/USERNAME/ai-workflow/tmux-session-service

# Start the service (runs in foreground)
npm start
```

You should see:
```
tmux-session-service listening on http://0.0.0.0:5001
```

**Keep this terminal open** or see Step 10 for running as a systemd service.

**For temporary background execution:**
```bash
# Using nohup
nohup npm start > /tmp/tmux-session-service.log 2>&1 &

# View logs
tail -f /tmp/tmux-session-service.log
```

### Step 8: Restart shellinabox Service

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

Verify the command line shows your script path:
```bash
ps aux | grep shellinabox | grep attach-session
```

Should show: `--service=/:USERNAME:USERNAME:/home/USERNAME:/usr/local/bin/tmux-session-service/attach-session.sh`

## Verification

### Step 9: Verify Installation

#### 9.1 Check tmux-session-service API

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

#### 9.2 Test Session Creation via API

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
tmux kill-session -t test-install
```

#### 9.3 Test shellinabox HTTPS Connection

```bash
# Test HTTPS connection (use -k to accept self-signed cert)
curl -k -I https://YOUR_SERVER_IP:4200/

# Should return: HTTP/1.1 200 OK
```

#### 9.4 Check shellinabox Environment

The script relies on `SHELLINABOX_URL` being set. To verify:

```bash
# Check shellinabox process
ps aux | grep shellinabox

# Should show the attach-session.sh in the command line
```

### Step 10: End-to-End Testing

#### 10.1 Test with React Dashboard

1. **Start React Dashboard** (if not already running):
   ```bash
   cd /home/USERNAME/ai-workflow/terminal-dashboard
   npm install
   npm run dev
   ```

2. **Open in browser**: http://localhost:5173

3. **Create a project**:
   - Click "Add" in the project tabs
   - Name: "Test Project"
   - Configure connection settings:
     - Protocol: https
     - Host: YOUR_SERVER_IP (e.g., 10.1.0.10)
     - Base port: 4200
     - Port strategy: Single (reuse base port)

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
   echo "Session started at: $(date)"
   pwd
   ```

6. **Reload the browser tab** (F5 or Ctrl+R)

7. **Verify persistence**:
   ```bash
   pwd              # Should still be /tmp
   echo $MY_VAR     # Should print "Hello from tmux"
   history          # Should show previous commands
   ```

**Success Indicators:**
- ✅ Terminal connects without login prompt
- ✅ You're logged in as your user automatically
- ✅ Working directory persists after reload
- ✅ Environment variables persist after reload
- ✅ Command history is maintained

#### 10.2 Verify in API and tmux

```bash
# Check sessions via API
curl http://127.0.0.1:5001/sessions | jq .

# Should show a session with your terminalId (UUID format)
# Example: "cde7a279-0b94-48f9-b596-4061ad98e2a7"

# Check tmux sessions
tmux ls

# Should show the same session ID
```

## Production Setup

### Step 11: Production Setup (systemd Service)

For production, run tmux-session-service as a systemd service:

#### 11.1 Create systemd Service File

```bash
sudo nano /etc/systemd/system/tmux-session-service.service
```

Add the following content (adjust username and paths):

```ini
[Unit]
Description=tmux Session Management Service
Documentation=https://github.com/wilhasse/ai-workflow
After=network.target

[Service]
Type=simple
User=USERNAME
Group=USERNAME
WorkingDirectory=/home/USERNAME/ai-workflow/tmux-session-service
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

Replace `USERNAME` with your actual username.

#### 11.2 Enable and Start Service

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

#### 11.3 Verify systemd Service

```bash
# Check logs
sudo journalctl -u tmux-session-service -f

# Test API
curl http://127.0.0.1:5001/health

# Should return: {"ok":true,"tmuxAvailable":true,...}
```

### Step 12: Optional - Session Cleanup Cron Job

Create a daily cleanup script for inactive sessions:

```bash
sudo nano /etc/cron.daily/cleanup-tmux-sessions
```

Add:
```bash
#!/bin/bash
# Cleanup inactive tmux sessions

# Get list of sessions from API
SESSIONS=$(curl -s http://127.0.0.1:5001/sessions | jq -r '.sessions[] | select(.active == false) | .sessionId')

for session in $SESSIONS; do
  echo "Cleaning up inactive session: $session"
  curl -s -X DELETE http://127.0.0.1:5001/sessions/$session
done
```

Make it executable:
```bash
sudo chmod +x /etc/cron.daily/cleanup-tmux-sessions
```

## Troubleshooting

### Common Issues and Solutions

#### Issue 1: "Permission Denied" When Running Script

**Symptom**: shellinabox fails to execute attach-session.sh

**Cause**: Script is in user's home directory, shellinabox user can't access it

**Solution**: Script must be in `/usr/local/bin/tmux-session-service/`
```bash
# Verify location
ls -la /usr/local/bin/tmux-session-service/attach-session.sh

# Should be owned by root and executable by all:
# -rwxr-xr-x 1 root root ... attach-session.sh

# If not there, copy it:
sudo cp scripts/attach-session.sh /usr/local/bin/tmux-session-service/
sudo chmod +x /usr/local/bin/tmux-session-service/attach-session.sh
```

#### Issue 2: "Invalid Response" in Browser

**Symptom**: Browser shows "invalid response" error when loading terminal

**Cause**: Protocol mismatch - dashboard uses HTTPS but shellinabox uses HTTP

**Solution**: Enable HTTPS in shellinabox (remove `--disable-ssl`)
```bash
# Edit config
sudo nano /etc/default/shellinabox

# Ensure SHELLINABOX_ARGS does NOT contain --disable-ssl
# Correct:
SHELLINABOX_ARGS="--no-beep --service=/:user:user:/home/user:/path/to/script"

# Wrong (causes mixed content error):
SHELLINABOX_ARGS="--no-beep --disable-ssl --service=..."

# Restart
sudo systemctl restart shellinabox
```

#### Issue 3: Sessions Not Persisting (Creating New Session Each Time)

**Symptom**: Every browser reload creates a new session instead of reconnecting

**Cause**: Script not extracting terminalId from `SHELLINABOX_URL`

**Solution**: Verify script extracts from SHELLINABOX_URL
```bash
# Check the script content
cat /usr/local/bin/tmux-session-service/attach-session.sh | grep SHELLINABOX_URL

# Should see lines like:
# if [[ -n "${SHELLINABOX_URL:-}" ]]; then
# if [[ "$SHELLINABOX_URL" =~ terminalId=([^&]+) ]]; then

# If missing, recreate the script from the repository:
sudo cp scripts/attach-session.sh /usr/local/bin/tmux-session-service/
sudo chmod +x /usr/local/bin/tmux-session-service/attach-session.sh
sudo systemctl restart shellinabox
```

**Debug**: Create a test to see what environment variables are available:
```bash
# Create debug script
cat > /tmp/debug-env.sh << 'EOF'
#!/bin/bash
echo "SHELLINABOX_URL: ${SHELLINABOX_URL:-NOT SET}"
env | grep SHELLINABOX
read -p "Press enter to continue..."
exec /bin/bash
EOF
chmod +x /tmp/debug-env.sh

# Temporarily use debug script
sudo nano /etc/default/shellinabox
# Change SHELLINABOX_ARGS to use /tmp/debug-env.sh
sudo systemctl restart shellinabox

# Open terminal in browser and check output
# Should show: SHELLINABOX_URL: https://...?projectId=...&terminalId=...

# Restore original script after debugging
```

#### Issue 4: API Not Reachable

**Symptom**: `curl http://127.0.0.1:5001/health` fails

**Solutions**:
```bash
# Check if service is running
ps aux | grep "node.*server.js"

# If using systemd:
sudo systemctl status tmux-session-service

# Check if port is in use
sudo lsof -i :5001

# Check firewall (should allow local connections)
sudo ufw status

# Restart the service
sudo systemctl restart tmux-session-service

# Check logs
sudo journalctl -u tmux-session-service -n 50
```

#### Issue 5: Port 4200 Already in Use

**Symptom**: shellinabox fails to start, port already in use

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

#### Issue 6: tmux Not Found

**Symptom**: API health check shows `tmuxAvailable: false`

**Solution**:
```bash
# Install tmux
sudo apt-get update
sudo apt-get install tmux

# Verify installation
which tmux
tmux -V

# Restart tmux-session-service
sudo systemctl restart tmux-session-service

# Verify
curl http://127.0.0.1:5001/health | jq .
```

#### Issue 7: Browser Shows "Login:" Prompt

**Symptom**: Terminal shows login prompt instead of direct shell access

**Cause**: shellinabox is using default LOGIN service instead of custom script

**Solution**: Verify configuration has custom service defined
```bash
# Check config
cat /etc/default/shellinabox | grep SHELLINABOX_ARGS

# Must contain: --service=/:user:user:/home/user:/path/to/script
# If missing or wrong, edit:
sudo nano /etc/default/shellinabox

# Restart
sudo systemctl restart shellinabox
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

```bash
# For tmux-session-service
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

### Manual Testing

#### Test Script Manually

```bash
# Set environment variables
export SESSION_SERVICE_URL=http://127.0.0.1:5001
export SHELLINABOX_URL="https://10.1.0.10:4200/?projectId=test&terminalId=test-123"

# Run script
/usr/local/bin/tmux-session-service/attach-session.sh

# Should create and attach to tmux session "test-123"
# Press Ctrl+B, then D to detach

# Verify session was created
tmux ls
curl http://127.0.0.1:5001/sessions | jq .
```

### Manual Cleanup

```bash
# Kill all tmux sessions (nuclear option)
tmux kill-server

# Delete all session metadata via API
curl -s http://127.0.0.1:5001/sessions | jq -r '.sessions[].sessionId' | while read sid; do
  curl -X DELETE http://127.0.0.1:5001/sessions/$sid
done

# Reset data file
echo '{"sessions":{}}' > /home/USERNAME/ai-workflow/tmux-session-service/data/sessions.json
```

## Post-Installation

### Verification Checklist

- [ ] tmux-session-service responding to API calls
- [ ] shellinabox running with HTTPS enabled
- [ ] Script installed in `/usr/local/bin/tmux-session-service/`
- [ ] Test session created successfully via API
- [ ] Browser terminal connects without login prompt
- [ ] Session persists after browser reload (pwd, env vars, history preserved)
- [ ] API shows correct terminalId from dashboard
- [ ] Both services configured to start on boot (production)

### Monitoring

Set up monitoring for:

```bash
# API health check (add to monitoring system)
curl http://127.0.0.1:5001/health

# Check active sessions count
curl -s http://127.0.0.1:5001/sessions | jq '.sessions | length'

# Check tmux sessions
tmux ls | wc -l

# Check disk usage
du -sh /home/USERNAME/ai-workflow/tmux-session-service/data/
```

### Security Considerations

1. **Firewall**: Ensure port 5001 is only accessible locally
   ```bash
   sudo ufw status
   # Port 5001 should NOT be exposed externally
   ```

2. **HTTPS Certificate**: For production, use proper SSL certificates
   ```bash
   # Install certbot for Let's Encrypt
   sudo apt-get install certbot

   # Generate certificate (adjust domain)
   sudo certbot certonly --standalone -d yourdomain.com

   # Configure shellinabox to use certificate
   # Add to SHELLINABOX_ARGS:
   # --cert=/etc/letsencrypt/live/yourdomain.com/fullchain.pem
   ```

3. **User permissions**: The service runs as your user, ensure proper file permissions

4. **Session cleanup**: Configure the cleanup cron job to prevent unlimited session growth

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

# Remove system script
sudo rm -rf /usr/local/bin/tmux-session-service/

# Remove cron job
sudo rm /etc/cron.daily/cleanup-tmux-sessions

# Remove tmux sessions
tmux kill-server

# Remove repository (if desired)
rm -rf /home/USERNAME/ai-workflow
```

## Additional Resources

- **Quick Start**: See `QUICKSTART.md` for a 2-minute setup guide
- **Architecture**: See `ARCHITECTURE.md` for how everything works
- **Setup Guide**: See `SETUP.md` for detailed configuration options
- **API Reference**: See `README.md` for API documentation
- **Configuration Summary**: See `CONFIGURATION-SUMMARY.md` for current setup details

## Support

For issues, questions, or contributions:
- GitHub: https://github.com/wilhasse/ai-workflow
- Issues: https://github.com/wilhasse/ai-workflow/issues

## Version

Installation guide for tmux-session-service v0.1.0
Last updated: 2025-11-10
