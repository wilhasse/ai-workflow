# tmux-session-service

A lightweight HTTP API that keeps tmux-backed shells alive so browser terminals can reconnect without losing state. The service lives next to your `shellinabox` gateway; every request ensures a tmux session exists (creating it if necessary), records metadata, and offers lifecycle endpoints. Pair it with the provided `attach-session.sh` helper to make each dashboard tab reconnect to the same tmux session via the `projectId`/`terminalId` query params.

## Documentation

- **[INSTALL.md](INSTALL.md)** - Complete installation guide from scratch
- **[QUICKSTART.md](QUICKSTART.md)** - 2-minute quick start guide
- **[SETUP.md](SETUP.md)** - Detailed integration and troubleshooting guide
- **[CONFIGURATION-SUMMARY.md](CONFIGURATION-SUMMARY.md)** - Current configuration details

## Features
- **Stateless HTTP interface**: `POST /sessions` to create or `PUT /sessions/:id` to idempotently ensure a session exists.
- **tmux orchestration**: Uses `tmux new-session -d` to spawn background shells and `tmux has-session`/`kill-session` to inspect lifecycle.
- **Metadata tracking**: Persists simple JSON metadata to `data/sessions.json` (mounted volume friendly) so restarts remember labels and timestamps.
- **Container ready**: Includes a minimal Node entrypoint and example Dockerfile; no extra dependencies beyond `tmux` are required.
- **Shellinabox hook**: `scripts/attach-session.sh` reads `QUERY_terminalId`/`QUERY_projectId`, pings the API, then runs `tmux new-session -A -s <id>` so reconnecting browser tabs reattach instantly.

## Running
```bash
# Install dependencies (none required) and start the server
cd tmux-session-service
npm install --package-lock-only  # optional once
npm start                         # listens on http://0.0.0.0:5001
```
Environment variables:
- `PORT` / `HOST` – default `5001` / `0.0.0.0`.
- `TMUX_BIN` – override path to `tmux` binary.
- `SHELL_CMD` – default shell command when creating a session (defaults to `$SHELL` or `/bin/bash`).
- `DATA_DIR` – directory for `sessions.json` persistence.

## Docker
```
cd tmux-session-service
docker build -t tmux-session-service .
docker run --rm -p 5001:5001 \
  -v /var/run/tmux:/var/run/tmux \  # mount tmux socket or run container with tmux installed
  -e SHELL_CMD=/bin/bash \
  tmux-session-service
```
Make sure `tmux` is installed inside the container image (extend from `node:20-slim` and `apt-get install tmux`). Bind-mount `sessions.json` if you want durable metadata.

## Hooking up shellinabox
1. Copy `scripts/attach-session.sh` into the host that runs `shellinabox` (or mount the repository).
2. Configure the service to accept requests (e.g., `SESSION_SERVICE_URL=http://localhost:5001`).
3. Launch shellinabox with a service similar to:
   ```bash
   shellinaboxd \
     --service=/workspace:'LOGIN':'SESSION_SERVICE_URL=http://127.0.0.1:5001 \
       /opt/tmux-session-service/scripts/attach-session.sh'
   ```
   When your React dashboard opens `https://host:4200/?projectId=foo&terminalId=bar`, shellinabox exposes `QUERY_projectId` and `QUERY_terminalId`, so the script ensures the tmux session `bar` exists (creating it if needed) before attaching. Reloading the browser reuses the same `terminalId`, so tmux reattaches to the preserved shell state.

4. (Optional) Call the HTTP API from automation: store metadata, list active sessions, or clean up idle sessions via `DELETE /sessions/:id`.

## API sketch
| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Returns tmux availability/version. |
| `GET` | `/sessions` | Lists known sessions (active flag reflects tmux state). |
| `POST` | `/sessions` | Create/ensure a session; body may include `sessionId`, `projectId`, `command`. |
| `PUT` | `/sessions/:id` | Idempotently ensure a specific session exists. |
| `POST` | `/sessions/:id/keepalive` | Update timestamps without touching tmux. |
| `DELETE` | `/sessions/:id` | Kill a tmux session and drop metadata. |

Responses contain structured errors when tmux is unreachable or ids are invalid, making it easy to automate clean-up cron jobs or integrate with your dashboard.
