# Slack Plane Intake

`slack-plane-intake` is the restricted Slack-to-Plane boundary used by Hermes
for CSLOG-179. The authorized user can send one top-level direct message to the
existing Hermes Slack app or invoke the `Create AGENTE ticket` message shortcut
on an alert in another Slack conversation. The service analyzes the exact
source, creates one Plane work item, uploads unchanged originals when Slack
permits file access, and deduplicates retries.

The authorization boundary remains deliberately narrow: Slack only, one
authorized shortcut user, one one-to-one Hermes intake DM, and one Plane
project. The app does not passively consume generic channels. Channel intake
occurs only when the authorized user explicitly selects a message shortcut. It
does not read a whole thread, use reactions as triggers, use Hermes Kanban, or
process WhatsApp.

## Runtime contract

Hermes can call only the MCP tool `create_plane_problem(message_ts)`. The tool
does not trust message text or file paths supplied by the model. It uses the
configured Slack bot token to retrieve the exact source message, validates the
fixed one-to-one DM, author, and top-level status, and downloads only that
message's attachments. Original bytes are SHA-256 hashed and uploaded unchanged.

Text analysis falls back in this order:

1. `kimi-k3`
2. `qwen3.8-max`
3. `deepseek/deepseek-v4-pro`

Visual analysis falls back through `kimi-k3`, `qwen3.8-max`, then
`gpt-5.6-terra`. If all analysis models fail, the service still creates a
clearly marked partial ticket containing the raw evidence and warnings.

The source key `slack:<team>:<channel>:<message_ts>` and a visible, immutable
Plane provenance ID make repeated delivery idempotent. Runtime state is stored under
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
`SPI_PLANE_BASE_URL`, `SPI_PLANE_WORKSPACE`, `SPI_PLANE_PROJECT_NAME`, and
`SPI_PLANE_PROJECT_IDENTIFIER` loaded, run:

```bash
.venv/bin/slack-plane-intake-provision plane-project
```

It finds or creates `AGENTE` with identifier `AGENTE` in the `cslog` workspace
at `https://plane.cslog.com.br`, finds its Backlog state, and prints only the
resulting IDs. Put `project_id` and `state_id` into `SPI_PLANE_PROJECT_ID` and
`SPI_PLANE_STATE_ID` before activating Hermes. Existing ledger entries retain
their historical ticket URLs; only new Slack messages use the new project.

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
install -d -m 0700 ~/.config/systemd/user/hermes-gateway.service.d
install -m 0644 deploy/hermes-gateway-hardening.conf \
  ~/.config/systemd/user/hermes-gateway.service.d/10-cslog-179-hardening.conf
install -d -m 0700 ~/.hermes/skills/problem-intake
install -m 0644 deploy/problem-intake/SKILL.md \
  ~/.hermes/skills/problem-intake/SKILL.md
systemctl --user daemon-reload
```

Hermes may refresh its generated base unit when it starts. The separate
`10-cslog-179-hardening.conf` systemd drop-in persists the protected environment,
private temporary directory, restrictive umask, and privilege restriction across
those refreshes.

Before starting the service, add the Slack bot scope `files:read` and reinstall
the existing Hermes app. The guarded activation command resolves the existing
one-to-one DM from the sole allowed user ID, verifies `im:history`, `im:write`,
and `files:read`, confirms that the reference gateway on `10.1.0.9` is stopped,
validates config and MCP discovery, and only then starts the service:

```bash
scripts/activate-godev.sh
```

Activation also sets `SLACK_HOME_CHANNEL` to this same one-to-one DM. This keeps
Hermes system notices private to the existing conversation and suppresses its
repeated "No home channel" onboarding message; it does not add another channel
or make the DM visible to other workspace members.

Afterward, inspect `systemctl --user is-active hermes-gateway.service` and
`journalctl --user -u hermes-gateway.service -n 100 --no-pager` before live
acceptance messages.

The existing Slack app needs Socket Mode, the `message.im` event subscription,
and bot scopes `im:history`, `im:write`, `chat:write`, `files:read`, and
`users:read`. No channel creation, invitation, or bot mention is required.

For channel alerts, add an **On messages** shortcut to that same app:

- Name: `Create AGENTE ticket`
- Callback ID: `create_agente_ticket`
- Description: `Create a Plane AGENTE ticket from this Slack message`

The patched Hermes adapter registers the callback on its existing Socket Mode
connection, acknowledges it immediately, authorizes the invoking user against
`SPI_SLACK_SHORTCUT_ALLOWED_USERS`, and invokes the intake CLI without an LLM
turn. This shortcut-only allowlist may contain multiple Slack member IDs; keep
`SPI_SLACK_ALLOWED_USERS` restricted to the single Hermes DM owner. If the
shortcut variable is absent, it defaults to that DM owner for backward
compatibility. Its
progress and result are sent ephemerally through Slack's response URL, with the
invoking user's Hermes DM as a private fallback. A monitoring bot is allowed to
be the selected message's author; it is the human shortcut invocation that
grants authority. If the app cannot read a channel permalink or attached file,
the ticket is still created as partial with an explicit warning.

## Acceptance and rollback

Live acceptance requires a text DM, a screenshot DM, a duplicate delivery of
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
