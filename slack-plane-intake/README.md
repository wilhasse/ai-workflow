# Slack Plane Intake

`slack-plane-intake` is the restricted Slack-to-Plane boundary used by Hermes
for CSLOG-179. An authorized user posts one top-level message in the configured
Slack channel, attaches any evidence to that message, and mentions Hermes. The
service refetches that exact message, analyzes it, creates one Plane work item,
uploads the unchanged originals, and deduplicates retries.

Version 1 is deliberately narrow: Slack only, one channel, an explicit bot
mention, an author allowlist, and one Plane project. It does not read a whole
thread, use reactions as triggers, use Hermes Kanban, or process WhatsApp.

## Runtime contract

Hermes can call only the MCP tool `create_plane_problem(message_ts)`. The tool
does not trust message text or file paths supplied by the model. It uses the
configured Slack bot token to retrieve the exact source message, validates the
channel, author, mention and top-level status, and downloads only that message's
attachments. Original bytes are SHA-256 hashed and uploaded unchanged.

Text analysis falls back in this order:

1. `kimi-k3`
2. `qwen3.8-max`
3. `deepseek/deepseek-v4-pro`

Visual analysis falls back through `kimi-k3`, `qwen3.8-max`, then
`gpt-5.6-terra`. If all analysis models fail, the service still creates a
clearly marked partial ticket containing the raw evidence and warnings.

The source key `slack:<team>:<channel>:<message_ts>` and a hidden Plane marker
make repeated delivery idempotent. Runtime state is stored under
`~/.local/state/slack-plane-intake` by default. The SQLite ledger uses
full-synchronous rollback journaling because the current target host's SQLite
version is affected by an upstream WAL-reset defect.

## Local development

```bash
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/ruff format --check .
.venv/bin/ruff check .
.venv/bin/pytest -q
```

Configuration is environment-only. Copy `deploy/hermes.env.example` to a
protected file outside the repository, replace every redacted value, and keep
it mode `0600`. Validate without making network calls:

```bash
set -a
. ~/.hermes/.env
set +a
.venv/bin/python -m slack_plane_intake.mcp_server --validate-config
```

The validation output contains identifiers and model names only; it never
prints tokens or API keys.

## Plane provisioning

The project helper is idempotent. With `SPI_PLANE_API_KEY`,
`SPI_PLANE_BASE_URL`, and `SPI_PLANE_WORKSPACE` loaded, run:

```bash
.venv/bin/slack-plane-intake-provision plane-project
```

It finds or creates `Problem Intake` with identifier `PROB`, finds its Backlog
state, and prints only the resulting IDs. Put `project_id` and `state_id` into
`SPI_PLANE_PROJECT_ID` and `SPI_PLANE_STATE_ID` before activating Hermes.

## Deployment to godev

The deployment scripts default to `10.1.0.7` and never activate the gateway as
a side effect:

```bash
scripts/build-release.sh
scripts/deploy-godev.sh --host 10.1.0.7
scripts/install-hermes-godev.sh --host 10.1.0.7
```

Hermes is installed with its `slack` and `mcp` extras and pinned to commit
`d861fbe55073dbd9e295eaf2c1fd16c8af54f7da`. The installer applies the small
patch in `patches/hermes-slack-trigger-message-id.patch`; it exposes the
transport-authenticated Slack message timestamp to the current model turn so
the model can pass it to the MCP tool. No message body, token, or additional
Slack capability is added by the patch.

Install the redacted templates as follows, filling in non-secret IDs and
loading secrets through `~/.hermes/.env`:

```bash
install -m 0600 deploy/hermes-config.example.yaml ~/.hermes/config.yaml
install -m 0644 deploy/hermes-gateway.service \
  ~/.config/systemd/user/hermes-gateway.service
install -d -m 0700 ~/.hermes/skills/problem-intake
install -m 0644 deploy/problem-intake/SKILL.md \
  ~/.hermes/skills/problem-intake/SKILL.md
systemctl --user daemon-reload
```

Before starting the service, validate the package config, Hermes config and
MCP discovery. Confirm that the reference gateway on `10.1.0.9` is stopped and
that there is only one Socket Mode owner. Activation is then explicit:

```bash
systemctl --user enable --now hermes-gateway.service
systemctl --user is-active hermes-gateway.service
journalctl --user -u hermes-gateway.service -n 100 --no-pager
```

The Slack app needs Socket Mode and, for a public intake channel,
`app_mentions:read`, `chat:write`, `channels:history`, `files:read`, and
`users:read`. A private channel uses `groups:history` and the matching message
event instead. The bot must be invited to the configured channel.

## Acceptance and rollback

Live acceptance requires a text message, a screenshot message, a duplicate of
one event, an unauthorized-user attempt, and a thread-reply attempt. Only the
first two may create tickets; the duplicate must return the same key. Original
Plane attachments and their recorded hashes must match.

Rollback stops and disables only the new service on `10.1.0.7`:

```bash
systemctl --user disable --now hermes-gateway.service
```

Do not delete completed Plane tickets during rollback. A previous intake
release can be restored by repointing
`~/.local/share/slack-plane-intake/current` to an earlier release directory and
then restarting only `hermes-gateway.service`.
