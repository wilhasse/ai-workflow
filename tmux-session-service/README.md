# tmux-session-service

A lightweight HTTP + WebSocket service that keeps tmux-backed shells alive so the terminal dashboard can reconnect without losing state. Each REST request ensures a tmux session exists (creating it if necessary), records metadata, and exposes lifecycle endpoints, while the WebSocket bridge streams tmux I/O directly into the dashboard’s xterm.js client.

## Documentation

- **[INSTALL.md](INSTALL.md)** - Complete installation guide from scratch
- **[QUICKSTART.md](QUICKSTART.md)** - 2-minute quick start guide
- **[SETUP.md](SETUP.md)** - Detailed integration and troubleshooting guide
- **[CONFIGURATION-SUMMARY.md](CONFIGURATION-SUMMARY.md)** - Current configuration details

## Features
- **Stateless HTTP interface**: `POST /sessions` to create or `PUT /sessions/:id` to idempotently ensure a session exists.
- **tmux orchestration**: Uses `tmux new-session -d` to spawn background shells and `tmux has-session`/`kill-session` to inspect lifecycle.
- **Metadata tracking**: Persists simple JSON metadata to `data/sessions.json` (mounted volume friendly) so restarts remember labels and timestamps.
- **Container ready**: Includes a minimal Node entrypoint and example Dockerfile plus `node-pty` for streaming tmux output.
- **WebSocket bridge**: `/ws/sessions/:id` spawns `tmux attach-session -t :id` inside a pseudo-terminal and streams bytes to/from the browser.

## Running
```bash
# Install dependencies and start the server
cd tmux-session-service
npm install
npm start                         # listens on http://0.0.0.0:5001
```
Environment variables:
- `PORT` / `HOST` – default `5001` / `0.0.0.0`.
- `TMUX_BIN` – override path to `tmux` binary.
- `SHELL_CMD` – default shell command when creating a session (defaults to `$SHELL` or `/bin/bash`).
- `DATA_DIR` – directory for `sessions.json` persistence.
- `TMUX_BRIDGE_NAME` – optional terminal name passed to `node-pty` (defaults to `xterm-256color`).

## Docker
```
cd tmux-session-service
docker build -t tmux-session-service .
docker run --rm -p 5001:5001 \
  -e SHELL_CMD=/bin/bash \
  tmux-session-service
```
Make sure `tmux` is installed inside the container image (extend from `node:20-slim` and `apt-get install tmux python3 make g++`). Bind-mount `sessions.json` if you want durable metadata.

## Using the WebSocket Bridge
1. Ensure the dashboard and nginx proxy `/ws/sessions/` to this service (see `nginx/nginx.conf`).
2. Each terminal tab connects to `wss://<host>/ws/sessions/<terminalId>?projectId=<projectId>`.
3. The service guarantees the tmux session exists, attaches using `tmux attach-session -t <terminalId>`, and streams bytes over the socket.
4. Resize events (`{"type":"resize","cols":120,"rows":40}`) update the underlying pty; input events (`{"type":"input","payload":"ls\n"}`) feed the tmux client.
5. You can manually test via `npx wscat -c ws://localhost:5001/ws/sessions/dev-shell`.

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
