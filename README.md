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

React SPA for organizing and managing multiple shellinabox terminal sessions across projects.

**Features:**
- Multi-project terminal organization
- Persistent session management via localStorage
- Flexible port strategies (single or sequential)
- Deep linking and browser tab isolation
- Integrates with tmux-session-service for persistent shells

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

Lightweight Node.js HTTP API that manages persistent tmux sessions for browser terminals.

**Features:**
- Persistent shell sessions that survive browser reloads
- HTTP API for session lifecycle management
- shellinabox integration via attach script
- Automatic session creation and reattachment
- Metadata tracking and cleanup endpoints

**Quick Start:**
```bash
cd tmux-session-service
npm start
# Service runs on http://0.0.0.0:5001

# Configure shellinabox to use it
export SESSION_SERVICE_URL=http://127.0.0.1:5001
shellinaboxd --service=/workspace:USER:/path/to/scripts/attach-session.sh -p 4200
```

[Setup Guide →](tmux-session-service/SETUP.md) | [API Reference →](tmux-session-service/README.md)

---

## Development

Each project is independent with its own dependencies and build system. See [CLAUDE.md](CLAUDE.md) for comprehensive development guidelines.

## License

MIT
