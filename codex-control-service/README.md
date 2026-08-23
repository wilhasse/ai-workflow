# Codex Control Service

This host-side Node 20 service is the application layer between the AI Workflow
dashboard and the open-source Codex harness. It supervises one local
`codex app-server` process over JSON-RPC/stdio and exposes a small HTTP + SSE API.
The browser never receives Codex credentials, provider URLs, or arbitrary model
configuration.

## Capabilities

- list and read stored Codex threads with live status and token metadata;
- start or resume controlled threads using the `default`, `k3`, and `qwen` presets;
- start turns, steer in-flight turns, and interrupt work;
- surface command and file-change approvals and return explicit decisions;
- run the same prompt across two or three providers in ephemeral read-only threads;
- identify threads owned by active tmux Codex processes and expose their exact host/session/window;
- stream bounded state changes to the dashboard over Server-Sent Events.

Comparison mode always forces the app-server wire values `sandbox=read-only`, `approvalPolicy=never`, and
`ephemeral=true`. Normal thread creation only exposes `readOnly` and
`workspaceWrite`; there is no browser route for danger-full-access mode or
arbitrary provider/model injection.

The service correlates stored thread IDs with the Workspace V2 session archive.
When an active tmux process owns a thread, the dashboard offers a terminal jump
instead of app-server controls. Resume, turn, steer, and interrupt routes return
HTTP 409 while that ownership is active, preventing a second Codex process from
writing to the same conversation.

## Development

```bash
npm test
CODEX_CONTROL_PORT=5006 npm start
curl http://127.0.0.1:5006/health
```

Vite proxies `/api/codex/*` to the TCP development port. Production uses a Unix
socket under `runtime/codex-control/`; nginx mounts that directory read-only and
proxies `/api/codex/*`. This keeps the mutation API from listening directly on
the LAN.

## User service

Install the checked-in systemd user unit from the repository:

```bash
./deploy/install-user-service.sh
```

The unit uses the current user's `~/.local/bin/codex`, `~/.codex` state, and
provider configuration without copying or modifying them. Its launcher sources
`~/.codex/provider-env` when that file exists so credentials exported there are
available to custom providers even though systemd does not load interactive
shell startup files. Keep that file outside the repository and readable only by
the user. Set `CODEX_CONTROL_PROVIDER_ENV_FILE` in a systemd drop-in to use a
different private file.

Override other settings by adding a systemd drop-in for
`codex-control-service.service`; useful variables include
`CODEX_CONTROL_DEFAULT_CWD`, `CODEX_CONTROL_ALLOWED_ROOTS` (comma-separated),
`CODEX_CONTROL_REQUEST_TIMEOUT_MS`, and `CODEX_CONTROL_COMPARISON_TIMEOUT_MS`.
The unit also sets a soft `MemoryHigh=768M` boundary so app-server's reclaimable
startup file cache does not become permanent overhead; it is not a hard kill limit.

## HTTP surface

- `GET /health`, `/presets`, `/threads`, `/threads/:id`, `/events`
- `POST /threads`, `/threads/:id/resume`, `/threads/:id/turns`
- `POST /threads/:id/steer`, `/threads/:id/interrupt`
- `GET /approvals`, `POST /approvals/:id`
- `POST /compare`, `GET /comparisons/:id`
