# Plane Codex Worker

This host-side worker connects the CSLOG-179 Hermes intake to the existing
AI Workflow Codex app-server:

```text
Slack DM -> Hermes -> Plane AGENTE/Backlog -> Plane Codex Worker
          -> codex-control-service -> codex app-server -> Agent Board
          -> Plane Review or Blocked
```

Plane remains the durable queue. The worker polls only project `AGENTE`, claims
each Backlog issue once in a full-synchronous SQLite ledger, moves it to
`In Progress`, and starts one persistent Codex thread. The automatic turn is
strictly read-only and treats the issue contents as untrusted evidence. Its
Portuguese result is posted as a Plane comment and the issue moves to `Review`.
Failures or an explicit `Disposition: BLOCKED` move to `Blocked` without
claiming a resolution.

The worker deliberately does not monitor Slack or create Plane work items;
those responsibilities remain in `slack-plane-intake`. It also does not deploy,
restart services, change databases, or send messages automatically. A human can
open the recorded thread in Agent Board, review its context, and start a separate
controlled execution thread when a concrete workspace and action are approved.

## Configuration

The systemd unit contains only non-secret project/runtime settings. By default,
the worker reads the existing Plane MCP host, workspace, and API key from
`~/.codex/config.toml`; `PCW_PLANE_API_KEY` can override the key without putting
it in the repository or unit. Useful settings:

- `PCW_PLANE_PROJECT_ID` and `PCW_PLANE_PROJECT_IDENTIFIER`
- `PCW_CODEX_SOCKET`, `PCW_CODEX_CWD`, and `PCW_CODEX_PRESET`
- `PCW_POLL_SECONDS` and `PCW_TURN_TIMEOUT_SECONDS`
- `PCW_MAX_ISSUES_PER_POLL`, `PCW_MAX_ISSUE_CHARS`, and `PCW_MAX_RESULT_CHARS`
- `PCW_STATE_ROOT` or `PCW_STATE_DB`

Provision the `Review` and `Blocked` states, validate both external boundaries,
and perform one poll without starting the daemon:

```bash
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
PCW_PLANE_PROJECT_ID=688b0196-af21-49f0-83eb-7b849a9145a8 \
  .venv/bin/plane-codex-worker provision
PCW_PLANE_PROJECT_ID=688b0196-af21-49f0-83eb-7b849a9145a8 \
  .venv/bin/plane-codex-worker validate-config
PCW_PLANE_PROJECT_ID=688b0196-af21-49f0-83eb-7b849a9145a8 \
  .venv/bin/plane-codex-worker once
```

Install and start the checked-in user service:

```bash
./scripts/install-user-service.sh
```

No Plane key, Codex credential, Slack token, issue body, or model output is
written to the service journal beyond bounded safe status/error messages.
