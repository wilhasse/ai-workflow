# AI Workflow Tools

A collection of productivity tools for AI-powered development workflows.

## Projects

### 🎙️ Whisper Realtime API

FastAPI service that exposes OpenAI's Whisper model for audio transcription with GPU acceleration.

**Features:**
- Batch and streaming transcription endpoints
- Browser-based audio recorder UI
- Docker deployment with CUDA support
- Multiple model sizes (tiny to large-v3)

**Quick Start:**
```bash
cd whisper-realtime-api
docker build -t whisper-realtime-api .
docker run --rm --gpus all -p 8000:8000 whisper-realtime-api
# Open http://localhost:8000 for web UI
```

[More details →](whisper-realtime-api/README.md)

---

### 🖥️ Terminal Dashboard

React SPA with an embedded xterm.js client for organizing tmux-backed browser terminals across projects.

**Features:**
- Multi-project terminal organization
- Persistent session management via localStorage
- Flexible port strategies (single or sequential) to target different bridge hosts
- Deep linking, browser tab isolation, and clipboard-friendly xterm.js terminals
- Talks directly to tmux-session-service for session lifecycle + streaming I/O

**Quick Start:**
```bash
cd terminal-dashboard
npm install
npm run dev
# Open http://localhost:5173
```

[More details →](terminal-dashboard/README.md)

---

### 🔄 tmux Session Service

Lightweight Node.js HTTP + WebSocket service that provisions persistent tmux sessions for the dashboard.

**Features:**
- Persistent shell sessions that survive browser reloads
- HTTP API for session lifecycle management
- Built-in WebSocket bridge that streams tmux output to xterm.js
- Automatic session creation and reattachment
- Metadata tracking and cleanup endpoints

**Quick Start:**
```bash
cd tmux-session-service
npm start
# Service runs on http://0.0.0.0:5001

# Test the WebSocket bridge (requires wscat)
npx wscat -c ws://localhost:5001/ws/sessions/dev-shell
```

[Setup Guide →](tmux-session-service/SETUP.md) | [API Reference →](tmux-session-service/README.md)

---

## 🐳 Production Deployment with Docker

Deploy the entire AI Workflow stack with a single command using Docker Compose.

### Quick Start

```bash
# Clone the repository
git clone https://github.com/wilhasse/ai-workflow.git
cd ai-workflow

# Start all services
docker-compose up -d

# Access the application
# Open browser to https://localhost
```

### What's Included

The Docker deployment includes:
- **nginx** - Reverse proxy with SSL termination + WebSocket upgrades
- **terminal-dashboard** - React frontend with embedded terminals
- **tmux-session-service** - Session persistence API + WebSocket bridge
- **whisper-realtime-api** (optional) - Voice transcription

### Architecture

```
Internet → nginx (443) ─→ terminal-dashboard (React + xterm)
                      └→ tmux-session-service (API + WebSocket)
```

### Services

| Service | Container Port | External Port | Purpose |
|---------|---------------|---------------|---------|
| nginx | 80, 443 | 80, 443 | Reverse proxy, SSL |
| terminal-dashboard | 3000 | via nginx | React frontend |
| tmux-session-service | 5001 | proxied via nginx | Session API + terminal bridge |

### Complete Documentation

📖 **[Full Deployment Guide →](DEPLOY.md)**

Includes:
- Production setup with Let's Encrypt SSL
- Monitoring and logging
- Backup and restore procedures
- Troubleshooting guide
- Security best practices

### Common Commands

```bash
# View status
docker-compose ps

# View logs
docker-compose logs -f

# Restart services
docker-compose restart

# Stop all services
docker-compose down

# Update deployment
git pull && docker-compose build && docker-compose up -d
```

---

## Development

Each project is independent with its own dependencies and build system. See [CLAUDE.md](CLAUDE.md) for comprehensive development guidelines.

### Development vs Production

**Development** (manual setup):
- Run each service independently
- Vite dev server for hot reload
- Direct process management

**Production** (Docker Compose):
- All services containerized
- nginx reverse proxy
- Automatic restarts and health checks
- Production-optimized builds

## License

MIT
