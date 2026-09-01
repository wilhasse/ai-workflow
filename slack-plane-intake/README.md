# Slack Plane Intake

`slack-plane-intake` is the restricted Slack-to-Plane boundary used by Hermes
for CSLOG-179. The authorized user can send one top-level direct message to the
existing Hermes Slack app or invoke the `Create Plane ticket` message shortcut
on one or more messages in another Slack conversation. The service analyzes the
exact selected sources, creates one Plane work item, uploads unchanged originals
when Slack permits file access, and deduplicates retries.

The authorization boundary remains deliberately narrow: Slack only, one
authorized shortcut allowlist and one one-to-one Hermes intake DM. The shortcut
lists only Plane projects in which the invoking Plane user is a member, with
`DELTA` selected by default when available and the configured project as the
fallback. The app does not passively consume generic channels. Channel intake
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

1. `deepseek-v4-flash-0731`
2. `kimi-k3`
3. `qwen3.8-max`
4. `deepseek/deepseek-v4-pro`

Visual analysis falls back through `gpt-5.6-terra`, `kimi-k3`, then
`qwen3.8-max`. If all analysis models fail, the service still creates a
clearly marked partial ticket containing the raw evidence and warnings.

The Hermes gateway can use `grok-4.6` as a separate fallback through the same
CLIProxyAPI endpoint. Register the account with CLIProxyAPI's `--xai-login`
flow before enabling that entry in `deploy/hermes-config.example.yaml`. Keep
the generated xAI credential in CLIProxyAPI's protected auth directory; never
copy it into this repository. Verify that the credential file has mode `0600`
after login and token rotation.

The source key `slack:<team>:<channel>:<message_ts>` and a visible, immutable
Plane provenance ID make repeated delivery idempotent. Multi-message sources use
`slack-bundle:<team>:<channel>:<sha256-of-ordered-timestamps>` while retaining
each message's author, UTC timestamp, text, permalink, and attachments. Runtime
state is stored under `~/.local/state/slack-plane-intake` by default. The SQLite
ledger and shortcut drafts use
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

- Name: `Create Plane ticket`
- Callback ID: `create_agente_ticket`
- Description: `Create one Plane ticket from selected Slack messages`

The patched Hermes adapter registers both the shortcut and its Slack-native modal
callback on the existing Socket Mode connection. It acknowledges the shortcut,
opens the modal before Slack's trigger expires, authorizes the invoking user
against `SPI_SLACK_SHORTCUT_ALLOWED_USERS`, and invokes the restricted modal CLI
without an LLM turn. This shortcut-only allowlist may contain multiple Slack
member IDs; keep `SPI_SLACK_ALLOWED_USERS` restricted to the single Hermes DM
owner. If the shortcut variable is absent, it defaults to that DM owner for
backward compatibility.

To create one ticket from several messages in the same conversation:

1. Run `Create Plane ticket` on the first message in the request burst.
2. The modal loads that message and at most the next 19 eligible messages sent
   during the following 30 minutes.
3. All loaded messages start selected. Each option shows its São Paulo date/time
   and Slack author; deselect unrelated messages, confirm `DELTA` or choose
   another destination in **Projeto Plane**, then choose **Criar ticket**.

The project list is loaded with the authenticated invoking user's Plane token.
On submission, the selected project is fetched again with that same token before
the workflow resolves the project's initial state and creates the work item.
Read-only/public projects in which the user is not a member are not offered.

Channel shortcuts, including `#alertas`, use the Hermes bot token. The bot
already needs `channels:history` and `groups:history`. For a public channel the
bot is not in, intake joins it with `channels:join` and then reads the bounded
history window. If the channel is private or otherwise invisible to the bot,
the modal still opens with the message that was selected. Nearby messages in
those private channels need the Hermes app invited, or a user token with
`channels:history` / `groups:history`.

Reading a normal person-to-person DM requires a Slack User OAuth token because
the Hermes bot is not a member of that conversation. In the existing Slack app,
add the User Token Scopes `im:history` and `files:read`, reinstall the app as the
DM owner, and put the resulting user token and owner ID in the protected runtime
environment:

```bash
SPI_SLACK_HISTORY_USER_ID=U_REDACTED
SPI_SLACK_HISTORY_USER_TOKEN=xoxp-redacted
```

This is an intentional permission expansion: the user token can read private
conversations visible to that user. The implementation binds the token to that
exact Slack user, verifies the workspace and user through `auth.test`, queries
only the bounded 30 minutes following the explicitly selected message, keeps
that anchor plus at most the next 19 eligible messages, and never uses that token
for another shortcut user. Activation validates the token identity and both
required user scopes before restarting Hermes.

For multiple users, store each person's Slack User OAuth token together with
their own Plane personal API key in a rootless service-owned file rather than in
the shared environment. Copy `deploy/user-credentials.example.json` to a path
under `~/.hermes`, replace the placeholders, restrict it, and reference it from
the environment:

```bash
install -m 0600 deploy/user-credentials.example.json \
  ~/.hermes/slack-plane-users.json
# Edit the protected file without pasting tokens into shell history.
SPI_USER_CREDENTIALS_FILE=/home/cslog/.hermes/slack-plane-users.json
```

Each JSON key must be a member of `SPI_SLACK_SHORTCUT_ALLOWED_USERS`. Its
`slack_user_token` must belong to that exact Slack user and include
`im:history` plus `files:read`; `plane_api_key` must be that person's Plane
personal API key with access to the configured AGENTE project, the default
`DELTA` project, and any other project they need in the selector. Activation
validates Slack identity/workspace/scopes, the Plane current-user response, and
AGENTE read access before restarting Hermes. At submission time the workflow selects both
credentials exclusively by the authenticated Slack invoking-user ID. Users not
present in this registry retain the existing collector/global-Plane fallback.

Each authorized user has one private draft per Slack conversation. Repeating the
shortcut on the same message is idempotent, drafts expire after two hours, and a
draft accepts at most 20 messages. Users without a configured history token keep
the explicit collector fallback: each shortcut adds one message and closing the
modal preserves the draft. A
successful, partial, or already-existing Plane result clears it; a failure keeps
it for retry. For diagnostics, a content-free audit retains the offered and
selected Slack timestamps, result status, and Plane key for 30 days; message text
and attachment metadata are not copied into that audit. Slack progress and
results are delivered privately in the invoking user's Hermes DM. A monitoring
bot is allowed to be a selected message's author;
it is the human shortcut invocation that grants authority. The workflow does not
passively monitor conversations; it requests a bounded history window only after
the bound user explicitly invokes the shortcut on one message. This makes the
picker work in human-to-human DMs without adding the Hermes bot to them.
If the app cannot read a permalink or attached file, the ticket is still created
as partial with an explicit warning.

## Acceptance and rollback

Live acceptance requires invoking the shortcut once on the first message of a DM
burst containing at least two texts and one screenshot. The modal must show the
selected message and following 30-minute history with date/time and author
labels, initially select all loaded messages, default the project selector to
DELTA when available, and create exactly one ticket in the chosen project
containing every selected message's provenance and original attachment. A
token/user mismatch and an unauthorized-user attempt must fail before any DM
history is returned.
The Plane description combines all selected Slack text under one **Mensagem**
field; individual author, timestamp, permalink, and attachment provenance remain
listed below it without numbered message headings.

Rollback stops and disables only the new service on `10.1.0.7`:

```bash
systemctl --user disable --now hermes-gateway.service
```

Do not delete completed Plane tickets during rollback. A previous intake
release can be restored by repointing
`~/.local/share/slack-plane-intake/current` to an earlier release directory and
then restarting only `hermes-gateway.service`.
