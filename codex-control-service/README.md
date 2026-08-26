# Codex Control Service

This host-side Node 20 service is the application layer between the AI Workflow
dashboard and the open-source Codex harness. It connects to one shared,
authenticated `codex app-server` over JSON-RPC/WebSocket and exposes a small
HTTP + SSE API.
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

The installer provisions two user units. `codex-app-server.service` owns the
shared harness process and listens with capability-token authentication only on
the host gateway of the private Compose network. `codex-control-service.service`
connects to that endpoint and continues exposing the Board API only through its
Unix socket. Both use the current user's `~/.codex` state. The app-server
launcher sources `~/.codex/provider-env` when that file exists so custom-provider
credentials are available even though systemd does not load interactive shell
startup files. Keep that file outside the repository and readable only by the
user. Set `CODEX_APP_SERVER_PROVIDER_ENV_FILE` in a systemd drop-in to use a
different private file.

`./deploy/install-user-service.sh` also creates, without overwriting, a private
capability token and an internal CA/server certificate under
`runtime/codex-remote/`. The token, CA private key, and server private key remain
untracked and mode `0600`.

Override other settings by adding a systemd drop-in for
`codex-control-service.service`; useful variables include
`CODEX_CONTROL_DEFAULT_CWD`, `CODEX_CONTROL_ALLOWED_ROOTS` (comma-separated),
`CODEX_CONTROL_REQUEST_TIMEOUT_MS`, and `CODEX_CONTROL_COMPARISON_TIMEOUT_MS`.
The units set separate soft memory boundaries for the small Node application
layer and the shared app-server; these are not hard kill limits.

## No-tunnel remote CLI

Nginx exposes a dedicated root-path WebSocket listener at
`wss://10.1.0.10:4501`. Port `4501` is bound only to the host's `10.1.0.10`
interface. TLS terminates at Nginx, which forwards the bearer header to the
capability-token-protected app-server over the private Docker bridge. The
existing dashboard listeners on ports 80 and 443 are unchanged.

After installing the user services, rebuild only the proxy:

```bash
docker compose up -d --build nginx
```

Each client must trust the private CA and possess the bearer token. From Windows
PowerShell, copy only the public CA certificate and token over SSH; never copy
`ca.key` or `server.key`:

```powershell
New-Item -ItemType Directory -Force "$HOME\.codex\remote-godev4" | Out-Null
scp cslog@10.1.0.10:/home/cslog/ai-workflow/runtime/codex-remote/tls/ca.crt "$HOME\.codex\remote-godev4\ca.crt"
scp cslog@10.1.0.10:/home/cslog/ai-workflow/runtime/codex-remote/app-server-token "$HOME\.codex\remote-godev4\app-server-token"
Import-Certificate -FilePath "$HOME\.codex\remote-godev4\ca.crt" -CertStoreLocation Cert:\CurrentUser\Root
$env:CODEX_REMOTE_TOKEN = (Get-Content "$HOME\.codex\remote-godev4\app-server-token" -Raw).Trim()
codex --remote wss://10.1.0.10:4501 --remote-auth-token-env CODEX_REMOTE_TOKEN
```

Verify the CA SHA-256 fingerprint printed by
`deploy/provision-remote-secrets.sh` before trusting it on a new machine. Remove
the environment variable after the session with
`Remove-Item Env:CODEX_REMOTE_TOKEN`. Multiple clients can connect and create
independent threads concurrently; coordinate a single writer when two clients
open the same thread.

## HTTP surface

- `GET /health`, `/presets`, `/threads`, `/threads/:id`, `/events`
- `POST /threads`, `/threads/:id/resume`, `/threads/:id/turns`
- `POST /threads/:id/steer`, `/threads/:id/interrupt`
- `GET /approvals`, `POST /approvals/:id`
- `POST /compare`, `GET /comparisons/:id`
