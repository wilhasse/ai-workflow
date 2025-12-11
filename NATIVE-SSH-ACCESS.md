# Native SSH + tmux Access

This guide explains how to access persistent tmux sessions directly from Windows using WezTerm and SSH, while maintaining full compatibility with the web dashboard.

## Overview

The ai-workflow system supports two ways to access terminal sessions:

1. **Web Dashboard** - Browser-based access via terminal-dashboard (React + xterm.js)
2. **Native SSH** - Direct terminal access via WezTerm, Windows Terminal, or any SSH client

Both methods connect to the **same tmux sessions** on the host, meaning you can:
- Start a session in the web dashboard and continue it via SSH
- Create a session via SSH and see it in the web dashboard
- Have multiple clients attached to the same session simultaneously

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Windows Client                               │
│  ┌─────────────────────┐     ┌─────────────────────────────┐    │
│  │  WezTerm / Terminal │     │  Browser (Web Dashboard)    │    │
│  │  (Native SSH)       │     │  https://server/            │    │
│  └──────────┬──────────┘     └─────────────┬───────────────┘    │
└─────────────┼──────────────────────────────┼────────────────────┘
              │ SSH                          │ WebSocket
              │                              │
┌─────────────┼──────────────────────────────┼────────────────────┐
│             │          Linux Host          │                     │
│             ▼                              ▼                     │
│   ┌─────────────────┐          ┌─────────────────────────┐      │
│   │ tmux attach     │          │ tmux-session-service    │      │
│   │ (via SSH)       │          │ (Docker container)      │      │
│   └────────┬────────┘          └───────────┬─────────────┘      │
│            │                               │                     │
│            └───────────┬───────────────────┘                    │
│                        │                                         │
│            ┌───────────▼───────────┐                            │
│            │ tmux server           │                            │
│            │ (/tmp/tmux-1000)      │                            │
│            │                       │                            │
│            │ Sessions:             │                            │
│            │  - ai-workflow        │                            │
│            │  - project-x          │                            │
│            │  - dev-shell          │                            │
│            └───────────────────────┘                            │
│                                                                  │
│            User: cslog (UID 1000)                               │
└──────────────────────────────────────────────────────────────────┘
```

### How It Works

1. **tmux runs on the host** (not in Docker) as the `cslog` user
2. **Docker container** mounts the tmux socket (`/tmp/tmux-1000`) to communicate with host tmux
3. **SSH sessions** connect directly to the host and run `tmux attach`
4. **Both methods** see and can attach to the same sessions

## Quick Start

### 1. Install WezTerm on Windows

Download and install WezTerm from: https://wezfurlong.org/wezterm/

### 2. Configure WezTerm

Copy the example configuration:

```powershell
# From PowerShell
copy \\server\path\to\ai-workflow\wezterm\wezterm-example.lua $env:USERPROFILE\.wezterm.lua
```

Or manually copy `wezterm/wezterm-example.lua` to `%USERPROFILE%\.wezterm.lua`

Edit the configuration to set your server hostname:

```lua
local SSH_HOST = "your-server-ip-or-hostname"
local SSH_USER = "cslog"
```

### 3. Set Up SSH Key Authentication (Recommended)

On Windows PowerShell:

```powershell
# Generate SSH key (if you don't have one)
ssh-keygen -t ed25519

# Copy public key to server
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh cslog@your-server "cat >> ~/.ssh/authorized_keys"
```

### 4. Connect

- Press `Alt+P` to open the project launcher
- Select a project or "General Shell"
- Your session is now persistent - close WezTerm and reconnect anytime

## Session Management

### Creating Project Sessions

Use `tmux-project.sh` to create organized sessions with multiple windows:

```bash
# SSH to server, then:
tmux-project.sh myproject --dir=/home/cslog/src/myproject

# Or specify custom windows:
tmux-project.sh myproject --windows=code,tests,server,logs --dir=~/src/myproject
```

From WezTerm, use `Alt+P` to launch configured projects directly.

### Listing Sessions

View all sessions from both SSH and web sources:

```bash
list-sessions.sh

# Output:
# SESSION                  PROJECT              SOURCE       ATTACHED   WINDOWS  CREATED
# ------------------------------------------------------------------------------------------
# ai-workflow              ai-workflow          ssh          yes        3        2025-12-07 10:30
# cde7a279-0b94...        shell-workspace       web          no         1        2025-11-10 13:36
# dev-shell                (none)               unknown      no         2        2025-12-06 08:00
```

Options:
- `--json` - Output in JSON format
- `--active-only` - Show only attached sessions

### Syncing Sessions to Web Dashboard

SSH-created sessions may not appear in the web dashboard until synced:

```bash
# Preview what would be synced
sync-sessions.sh --dry-run

# Sync all sessions
sync-sessions.sh

# Force re-sync of all sessions
sync-sessions.sh --force

# Clean up metadata for deleted sessions
sync-sessions.sh --cleanup
```

## Script Reference

All scripts are located in `/home/cslog/ai-workflow/tmux-session-service/scripts/`

### tmux-project.sh

Creates or attaches to a project-based tmux session.

```bash
Usage: tmux-project.sh <project-name> [options]

Options:
  --windows=LIST  Comma-separated list of windows (default: shell,editor,logs)
  --dir=PATH      Change to this directory in all windows
  --register      Register session with web service
  --help          Show help

Examples:
  tmux-project.sh myproject
  tmux-project.sh myproject --windows=code,tests --dir=~/src/myproject
```

### list-sessions.sh

Lists all tmux sessions with metadata.

```bash
Usage: list-sessions.sh [options]

Options:
  --json         Output in JSON format
  --active-only  Show only active (attached) sessions
  --help         Show help

Environment:
  SESSION_SERVICE_URL  URL of web service (for metadata)
```

### sync-sessions.sh

Syncs sessions to web service metadata.

```bash
Usage: sync-sessions.sh [options]

Options:
  --dry-run              Show what would be synced
  --force                Re-register all sessions
  --cleanup              Remove orphaned metadata
  --project-pattern=RE   Regex to extract project name
  --help                 Show help
```

## WezTerm Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+P` | Open project launcher menu |
| `Alt+L` | List all sessions (new tab) |
| `Alt+N` | New general shell session |
| `Alt+Shift+S` | Sync sessions to dashboard |

## Web Dashboard Integration

Sessions created via SSH can be made visible in the web dashboard:

1. **Automatic** (recommended): Run `sync-sessions.sh` periodically or after creating sessions
2. **On creation**: Use `--register` flag with `tmux-project.sh`
3. **Server auto-discovery**: The server can be enhanced to auto-discover sessions (see below)

### Enabling Auto-Discovery

To have the web service automatically discover SSH-created sessions, add this to `tmux-session-service/src/server.js`:

```javascript
// Add after loadStore() in the start() function
await discoverTmuxSessions()
setInterval(discoverTmuxSessions, 60000) // Every 60 seconds
```

Where `discoverTmuxSessions()` is:

```javascript
const discoverTmuxSessions = async () => {
  try {
    const active = await tmuxListSessions()
    for (const sessionId of active) {
      if (!sessionStore.has(sessionId)) {
        sessionStore.set(sessionId, {
          sessionId,
          projectId: null,
          source: 'discovered',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
      }
    }
    await persistStore()
  } catch (error) {
    console.warn('Session discovery failed:', error.message)
  }
}
```

## Multi-User Setup

For teams with multiple users:

### Option A: Separate Sessions Per User (Recommended)

Each user creates their own sessions:

```bash
# User alice
tmux-project.sh alice-projectx --dir=~/src/projectx

# User bob
tmux-project.sh bob-projectx --dir=~/src/projectx
```

### Option B: Shared Sessions (Pair Programming)

Multiple users can attach to the same session:

```bash
# First user creates/attaches
tmux new-session -A -s shared-projectx

# Second user attaches to same session
tmux attach -t shared-projectx
```

Both users see the same terminal in real-time.

## Troubleshooting

### SSH Connection Refused

```bash
# Check SSH service is running
sudo systemctl status sshd

# Check firewall
sudo ufw status
```

### Cannot Attach to Session

```bash
# List available sessions
tmux ls

# Check socket permissions
ls -la /tmp/tmux-1000/

# Fix socket permissions if needed
chmod 700 /tmp/tmux-1000
```

### Session Not Appearing in Web Dashboard

```bash
# Sync sessions manually
sync-sessions.sh

# Check if web service can see sessions
curl http://localhost:5001/sessions
```

### "no server running" Error

```bash
# Start tmux server
tmux start-server

# Or just create a session
tmux new-session -d -s test
```

### WezTerm SSH Timeout

Add to your WezTerm config:

```lua
config.ssh_options = {
    identities_only = false,
}
```

Or add to `~/.ssh/config`:

```
Host your-server
    ServerAliveInterval 60
    ServerAliveCountMax 3
```

## Security Considerations

1. **SSH Key Authentication**: Always prefer SSH keys over passwords
2. **User Isolation**: Sessions run as the connecting user; don't share the `cslog` account
3. **Firewall**: Only expose SSH port (22), not the web service port (5001) directly
4. **Session Names**: Avoid sensitive data in session names (they're visible in process lists)

## Environment Variables

Scripts use these environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `SESSION_SERVICE_URL` | `http://localhost:5001` | URL of tmux-session-service API |
| `SESSION_SHELL` | `$SHELL` or `/bin/bash` | Default shell for new sessions |

Set in your shell profile (`~/.bashrc` or `~/.zshrc`):

```bash
export SESSION_SERVICE_URL="http://localhost:5001"
```

## See Also

- [CLAUDE.md](CLAUDE.md) - Main project documentation
- [tmux-session-service/README.md](tmux-session-service/README.md) - API reference
- [tmux-session-service/SETUP.md](tmux-session-service/SETUP.md) - WebSocket integration guide
- [DEPLOY.md](DEPLOY.md) - Production deployment guide
