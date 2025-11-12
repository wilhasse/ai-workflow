# Quick Start Guide

## TL;DR – Test the Bridge in Two Minutes

1. Start `tmux-session-service`.
2. Connect with `wscat` (or the dashboard) to `ws://localhost:5001/ws/sessions/dev-shell`.
3. Run a few commands, disconnect, reconnect with the same session id, and confirm your shell picks up exactly where it left off.

## 1. Start tmux-session-service

```bash
cd /home/cslog/ai-workflow/tmux-session-service
npm install        # first run only
npm start
```

You should see:
```
tmux-session-service listening on http://0.0.0.0:5001
```

Leave this terminal running.

## 2. Open a WebSocket session

In a new terminal, install `wscat` if needed and connect to the bridge:

```bash
npx wscat -c ws://127.0.0.1:5001/ws/sessions/dev-shell
```

Type a few commands once the prompt appears:

```
pwd
mkdir -p /tmp/xterm-demo
cd /tmp/xterm-demo
echo "bridge test" > note.txt
```

Press `Ctrl+C` to close `wscat` (the tmux session keeps running).

## 3. Reconnect to the same session

Run the exact same command:

```bash
npx wscat -c ws://127.0.0.1:5001/ws/sessions/dev-shell
```

You should land inside the same tmux session (`pwd` stays `/tmp/xterm-demo`, `cat note.txt` still prints `bridge test`). This mirrors what the React dashboard does via the embedded xterm.js client.

## Helpful Commands

```bash
# Health and metadata
curl http://127.0.0.1:5001/health
curl http://127.0.0.1:5001/sessions | jq .

# Inspect tmux directly
tmux ls
tmux attach -t dev-shell

# Clean up a session
curl -X DELETE http://127.0.0.1:5001/sessions/dev-shell
```

## Understanding the Flow

```
React dashboard (xterm.js) ── WebSocket (/ws/sessions/:id) ──> tmux-session-service
                                                           └─> tmux attach-session -t :id
```

- The dashboard chooses a `terminalId` (stored in localStorage) and connects via `wss://host/ws/sessions/<terminalId>?projectId=<...>`.
- tmux-session-service ensures the tmux session exists, attaches via `tmux attach-session`, and pipes bytes to the browser.
- Resizes send `{"type":"resize","cols":..., "rows":...}`; keystrokes are forwarded via `{"type":"input","payload":"ls\n"}`.
- Disconnecting only detaches the tmux client; reconnecting with the same `terminalId` reattaches instantly.

## Need Help?

```bash
# Watch the server logs
docker-compose logs -f tmux-session-service

# Test from inside the nginx container (ensures proxy is working)
docker-compose exec nginx \
  npx wscat -c ws://tmux-session-service:5001/ws/sessions/proxy-check

# Reset everything
tmux kill-server
rm tmux-session-service/data/sessions.json
```

If the WebSocket refuses to connect, verify that nginx includes the `/ws/sessions/` location block and that `tmux` is installed inside the service container.
