# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is a monorepo containing three independent AI workflow tools:

1. **whisper-realtime-api/** - FastAPI service exposing Whisper for audio transcription (batch & streaming)
2. **terminal-dashboard/** - React SPA with xterm.js terminals that organize tmux-backed sessions
3. **tmux-session-service/** - Node.js HTTP + WebSocket API for persistent tmux session management

Each project has its own build system, dependencies, and deployment model. The terminal-dashboard works with tmux-session-service to provide persistent terminal sessions.

## Architecture

### whisper-realtime-api
- **Type**: Dockerized Python FastAPI service with GPU acceleration
- **Key Pattern**: Model singleton loaded at startup, accessed via `app.state.model`
- **Concurrency**: Synchronous transcription runs in thread pool via `asyncio.to_thread()`
- **Streaming**: Uses `asyncio.Queue` with Server-Sent Events for real-time segment delivery
- **Entry point**: `app/main.py`
- **Static UI**: Browser-based audio recorder in `app/static/index.html`

### terminal-dashboard
- **Type**: Vite-powered React SPA with localStorage persistence and embedded xterm.js
- **State Management**: Projects/terminals stored in localStorage, normalized on load
- **Port Strategies**:
  - SEQUENTIAL: Each terminal targets `basePort + offset` (e.g., 5001, 5002) for multi-host bridges
  - SINGLE: All terminals share `basePort` (default 5001, proxied via nginx)
- **Key Components**:
  - `App.jsx` contains all logic (project CRUD, terminal CRUD, socket URL building)
  - `useProjectsState()` hook manages localStorage sync
  - `TerminalViewer` wraps `@xterm/xterm` + WebSocket bridge to tmux-session-service

### tmux-session-service
- **Type**: Lightweight Node.js HTTP + WebSocket service for tmux lifecycle management
- **Purpose**: Enables persistent terminal sessions that survive browser reloads
- **Key Pattern**: Idempotent session creation via PUT /sessions/:id, streaming I/O via `/ws/sessions/:id`
- **WebSocket Flow**: Dashboard connects to `/ws/sessions/:id` which spawns `tmux attach-session` inside `node-pty`
- **Persistence**: Session metadata stored in `data/sessions.json`
- **Flow**: React dashboard (xterm + WebSocket) → tmux-session-service → tmux session

## Development Commands

### whisper-realtime-api

```bash
# Local development (no Docker)
cd whisper-realtime-api
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Docker build & run (GPU)
docker build -t whisper-realtime-api .
docker run --rm --gpus all -p 8000:8000 \
  -e WHISPER_MODEL_SIZE=medium \
  -e WHISPER_DEVICE=cuda \
  -e WHISPER_COMPUTE_TYPE=float16 \
  whisper-realtime-api

# Test endpoints
curl http://localhost:8000/health
curl -X POST http://localhost:8000/transcribe \
  -F "file=@audio.wav" \
  -F "language=pt" \
  -F "translate=false"
curl -N -X POST http://localhost:8000/transcribe/stream \
  -F "file=@audio.wav"
```

**Environment Variables**:
- `WHISPER_MODEL_SIZE`: tiny, base, small, medium, large-v3
- `WHISPER_DEVICE`: cuda, cpu
- `WHISPER_COMPUTE_TYPE`: float16, float32, int8_float16
- `WHISPER_MAX_AUDIO_BYTES`: Upload limit (default 60 MiB)
- `WHISPER_BEAM_SIZE`: Beam search width (default 5)

### terminal-dashboard

```bash
# Install dependencies
cd terminal-dashboard
npm install

# Development server with HMR
npm run dev          # http://localhost:5173

# Production build
npm run build        # Output to dist/

# Preview production build
npm run preview

# Lint
npm run lint
```

**No testing framework** is currently configured. Manual testing workflow:
1. Run `npm run dev`
2. Create projects with different port strategies
3. Add terminals and verify the WebSocket (`/ws/sessions/:id`) connects, resizes, and reconnects cleanly
4. Test protocol/host sanitization with edge cases

### tmux-session-service

```bash
# Start the service
cd tmux-session-service
npm start            # http://0.0.0.0:5001

# Development with auto-reload
npm run dev

# Test API endpoints
curl http://localhost:5001/health
curl http://localhost:5001/sessions
curl -X PUT http://localhost:5001/sessions/test-session \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"test-session","projectId":"test-project"}'

# Test the WebSocket bridge (requires wscat)
npx wscat -c ws://localhost:5001/ws/sessions/dev-shell
```

**Environment Variables**:
- `PORT` / `HOST`: Service binding (default: 5001 / 0.0.0.0)
- `TMUX_BIN`: Path to tmux binary
- `SHELL_CMD`: Default shell command (defaults to $SHELL or /bin/bash)
- `DATA_DIR`: Directory for sessions.json persistence

**Setup Guide**: See `tmux-session-service/SETUP.md` for complete integration instructions with the dashboard WebSocket bridge

## Code Style

### whisper-realtime-api
- Python with async/await for I/O-bound operations
- Synchronous CPU/GPU work offloaded to thread pool
- Temporary files cleaned up in try/finally blocks
- FastAPI dependency injection via `Depends(get_model)`

### terminal-dashboard
- Modern ES modules with `const`/arrow functions
- Two-space indentation, semicolonless formatting
- Components in PascalCase, hooks in camelCase with `use` prefix
- Derived helpers (`buildTerminalSocketUrl`, `sanitizeHost`) colocated in `App.jsx`
- Run `npm run lint` before commits; fix warnings instead of suppressing

## Important Notes

### whisper-realtime-api
- First run downloads Whisper model (~1-3 GB depending on size)
- GPU memory usage scales with model size (medium ~5GB VRAM)
- Audio processing is blocking; adjust uvicorn workers for concurrency
- Browser UI requires HTTPS or localhost for microphone access

### terminal-dashboard
- All state persists to `localStorage` under key `terminal-dashboard-xterm-v1`
- Default connection target auto-detects `window.location` (protocol/hostname) with base port `5001`; update the helpers near the top of `App.jsx` if you need different heuristics
- `sanitizeHost()` strips protocols before storage—always use it for user input
- `TerminalViewer` opens `@xterm/xterm` and uses `/ws/sessions/:id` via WebSocket
- Query params (`?project=...&terminal=...`) enable deep linking and browser tab isolation

## Project-Specific Guidelines

See project-specific files for additional context:
- **whisper-realtime-api/CLAUDE.md** - FastAPI architecture, Docker config, model lifecycle
- **terminal-dashboard/AGENTS.md** - React patterns, commit conventions, security tips
- **tmux-session-service/SETUP.md** - Complete integration guide for the WebSocket bridge
- **tmux-session-service/README.md** - API reference and feature overview
