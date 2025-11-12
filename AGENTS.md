# Repository Guidelines

## Project Structure & Module Organization
AI Workflow Tools hosts three services: `whisper-realtime-api/` (FastAPI stack, entrypoint `app/main.py`, static UI in `app/static`), `terminal-dashboard/` (Vite React SPA with xterm.js terminals defined in `src/App.jsx` and assets under `src/assets`), and `tmux-session-service/` (Node HTTP + WebSocket bridge with `src/server.js` and persistence in `data/sessions.json`). Supporting infrastructure lives in `nginx/` (reverse-proxy image) and the root `docker-compose.yml`; the legacy `shellinabox/` directory is preserved for reference but no longer part of the Compose stack.

## Build, Test, and Development Commands
- `docker-compose up -d` bootstraps nginx, the dashboard, and tmux-session-service; inspect with `docker-compose logs -f SERVICE` or restart selectively.
- `cd terminal-dashboard && npm install && npm run dev` starts Vite on `5173`; `npm run build && npm run preview` validates the `dist/` bundle.
- `cd tmux-session-service && npm start` runs the API/WebSocket bridge on `:5001` (`npm run dev` adds `--watch`); use `npx wscat -c ws://localhost:5001/ws/sessions/dev-shell` to sanity-check the terminal stream.
- `cd whisper-realtime-api && pip install -r requirements.txt && uvicorn app.main:app --reload --port 8000` runs the FastAPI app; `docker build -t whisper-realtime-api .` produces the GPU image.

## Coding Style & Naming Conventions
Python modules follow Black-style four-space indentation, double quotes, and type-annotated Pydantic models; keep new endpoints consistent. React code uses modern ES modules, two-space indentation, semicolonless formatting, PascalCase components, and helpers like `buildTerminalSocketUrl` colocated with their consumers. The tmux service targets Node 20 with `const`, arrow functions, async/await, and `node-pty` for streaming tmux output. Bash helpers should open with `set -euo pipefail`.

## Testing Guidelines
Automated suites are pending, so lean on quick checks: `npm run lint` for the dashboard, `curl http://localhost:5001/health` plus a PUT round-trip for the tmux API, and the `curl` samples for Whisper endpoints. When extending behavior, add Vitest + React Testing Library specs under `terminal-dashboard/src/__tests__/`, node integration tests for tmux session flows, or FastAPI `TestClient` cases covering transcription responses and payload limits.

## Commit & Pull Request Guidelines
Recent commits show the preferred short, imperative style; keep subjects under ~72 characters and focus each commit on one concern. In PRs, name the subprojects touched, list the verification commands you ran (`npm run lint`, `curl /transcribe`, etc.), attach screenshots for UI work or terminal logs for services, and link relevant issues.

## Security & Configuration Tips
Externalize credentials and hosts via env vars such as `WHISPER_*` plus the dashboard’s default detection helpers (`detectDefaultProtocol/Host`, `DEFAULT_BASE_PORT`). Always sanitize hostnames before persisting to `localStorage`, avoid storing secrets in the repo, and keep `nginx/nginx.conf` TLS settings aligned with `docker-compose.yml` (including the `/ws/sessions/` proxy) before exposing the stack.
