# Deliver Slack problem intake through Hermes and Plane

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept current while implementation proceeds. Maintain it according to `.agent/PLANS.md` from the repository root.

## Purpose / Big Picture

After this work, an authorized Slack user can post one top-level message in a dedicated intake channel, attach screenshots or files to that same message, and mention `@Hermes`. A fresh Hermes Agent running on `10.1.0.7` will create exactly one `PROB-N` work item in Plane, attach the unchanged original files, and reply in Slack with the ticket link. Repeating the same request returns the existing ticket rather than creating a duplicate.

The current repository has no Slack-to-Plane intake boundary. Without one, Hermes would need to know Slack retrieval details, model-routing rules, Plane's multi-step upload sequence, deduplication, and failure recovery. This work concentrates those rules in one deep Python package with a single MCP operation. MCP, or Model Context Protocol, is the JSON-RPC protocol Hermes uses to call an external tool process. Hermes only supplies the Slack message timestamp; the intake service owns every security and sequencing decision.

Version one processes Slack only. It does not use Hermes Kanban, reaction triggers, thread-wide context, or WhatsApp. The normalized source-message data type is deliberately independent of Slack so WhatsApp can be added later without changing analysis or Plane behavior.

## Progress

- [x] (2026-08-23 23:41Z) Locked the product decisions and inspected Plane issue `CSLOG-179`, the repository, Hermes on `10.1.0.9`, current upstream Hermes, and the target host `10.1.0.7`.
- [x] (2026-08-23 23:41Z) Verified live CLIProxyAPI model catalog and image capability: `kimi-k3`, `qwen3.8-max`, and `gpt-5.6-terra` accepted images; `deepseek/deepseek-v4-pro` rejected image input.
- [x] (2026-08-23 23:41Z) Created this work item on isolated branch `cslog-179-slack-plane-intake`, based on `origin/main`, preserving two unrelated local `main` commits.
- [x] (2026-08-24 00:28Z) Implemented the `slack-plane-intake` package, Plane project provisioner, deployment/guarded-activation scripts and templates, pinned Hermes integration patch, operator documentation, and contract suite (`29 passed`, Ruff clean, shell syntax clean, release archive inspected).
- [x] (2026-08-24 00:14Z) Created and idempotently reverified Plane project `Problem Intake` with identifier `PROB` and its Backlog state.
- [x] (2026-08-24 00:19Z) Installed the intake release and pinned Hermes `0.20.5` checkout on `10.1.0.7`, applied the bounded timestamp patch, transferred only Slack/Plane secrets plus the selected allowlist from `10.1.0.9`, and proved a K3 one-shot plus the one-tool MCP handshake.
- [ ] Configure and start the restricted Slack gateway, then complete live text, image, duplicate, authorization, and failure-path acceptance checks.
- [ ] Record final evidence, commit only CSLOG-179 files, and mark the work item complete.

## Surprises & Discoveries

- Observation: `10.1.0.7` has no Hermes process, systemd service, or Hermes directory, but it has Python 3.11, Node 22, 47 GB free, an active per-user systemd manager, and linger enabled for `cslog`.
  Evidence: read-only SSH checks returned no Hermes matches, `Python 3.11.2`, `v22.19.0`, `State=active`, and `Linger=yes`.

- Observation: DeepSeek is available for text through CLIProxyAPI but is not a visual fallback.
  Evidence: a live OpenAI-compatible chat-completions request containing a synthetic PNG returned HTTP 404 with `No endpoints found that support image input` for `deepseek/deepseek-v4-pro`; K3, Qwen, and Terra correctly named the test image colors.

- Observation: the existing Hermes checkout on `10.1.0.9` contains unrelated modified and untracked files and its gateway is stopped.
  Evidence: read-only `git status` and process inspection on that host. This checkout must remain reference-only.

- Observation: MCP Python SDK 2.0 removed the old `FastMCP` import path but current upstream Hermes already supports the replacement `mcp.server.MCPServer` interface.
  Evidence: the clean development install resolved `mcp==2.0.0`; the intake server imports and instantiates `MCPServer`, and all package tests pass.

- Observation: pinned Hermes carries the Slack triggering timestamp as trusted event metadata for replies and threading but, unlike Discord message IDs, does not expose it in the current model turn.
  Evidence: `plugins/platforms/slack/adapter.py` sets `MessageEvent.message_id=ts`, while `gateway/run.py` only injected `event.message_id` into model content for `Platform.DISCORD`. Without a bounded integration patch, the model could not supply the exact timestamp required by the restricted MCP contract.

- Observation: a Python virtual environment cannot be relocated after console scripts are generated because their shebangs retain the absolute creation path.
  Evidence: the first target release passed its tests in the staging directory, but `slack-plane-intake-provision` failed after the release directory was moved. The installer now moves source first, creates the venv at its final path, and has a regression test enforcing that order.

- Observation: Hermes' Slack extra does not include the MCP client SDK; MCP is a separate upstream install extra.
  Evidence: the pinned Hermes one-shot K3 call returned `HERMES_READY` and `hermes mcp list` found one selected intake tool, but the first `hermes mcp test` reported that the MCP Python SDK was absent. The installer now requests `[slack,mcp]` and has a regression assertion for both extras.

- Observation: the existing Slack app cannot yet satisfy live attachment intake or create the dedicated channel.
  Evidence: `auth.test` succeeds and the app has mention, chat, channel/group history, channel read/join, and user-read scopes, but its granted scopes omit `files:read`; `conversations.create` returned `missing_scope`, and only the unjoined `#cslog` channel is visible. The service remains disabled and inactive until a human creates `#problem-intake`, adds `files:read`, reinstalls the app, and makes the bot a channel member.

- Observation: target Python links SQLite 3.40.1, which Hermes doctor identifies as affected by the upstream WAL-reset defect.
  Evidence: pre-activation `hermes doctor` reported the affected source ID. The intake ledger now uses `journal_mode=DELETE` plus `synchronous=FULL`, confirmed by a regression test, while retaining `BEGIN IMMEDIATE` claim serialization.

- Observation: CLIProxyAPI's `kimi-k3` route rejects an explicit zero temperature.
  Evidence: the first live intake analyses fell back to Qwen; a bounded raw probe returned HTTP 400 with `invalid temperature: only 1 is allowed for this model`. The analyzer now omits the optional temperature field, allowing each provider's compatible default, and its request contract asserts the field stays absent.

## Decision Log

- Decision: Install all new runtime components on `10.1.0.7`; treat `10.1.0.9` only as a source for selected configuration values.
  Rationale: The target host already runs CLIProxyAPI and has no competing Hermes installation, reducing network and rollback complexity while preserving the user's test checkout.
  Date/Author: 2026-08-23 / user and Codex.

- Decision: Trigger only on an authorized top-level Slack message that mentions Hermes, and process only that message and its own attachments.
  Rationale: This provides a clear authorization gesture, bounded data access, and an exact idempotency key. A thread reply receives guidance to repost as one top-level intake message.
  Date/Author: 2026-08-23 / user and Codex.

- Decision: Keep analysis and external sequencing in the intake package instead of trusting model-supplied raw message content or Plane fields.
  Rationale: The MCP caller passes only a timestamp. The service refetches and validates the source, treats content as evidence, selects models, uploads attachments, and reconciles retries. That hides complexity and narrows prompt-injection impact.
  Date/Author: 2026-08-23 / Codex.

- Decision: Route text through `kimi-k3`, then `qwen3.8-max`, then `deepseek/deepseek-v4-pro`; route visual input through `kimi-k3`, then `qwen3.8-max`, then `gpt-5.6-terra`.
  Rationale: This is the user's requested order, adjusted only for the live-proven fact that DeepSeek does not accept image input.
  Date/Author: 2026-08-23 / user and Codex.

- Decision: Create tickets automatically in a dedicated Plane project named `Problem Intake`, identifier `PROB`, initially Backlog, unassigned, and with no priority.
  Rationale: This replaces the original Kanban concept with the user's chosen system of record and keeps intake neutral until a human triages it.
  Date/Author: 2026-08-23 / user and Codex.

- Decision: Derive the Slack bot user ID from `auth.test` on each MCP process lifetime instead of requiring `SPI_SLACK_BOT_USER_ID`.
  Rationale: Slack is authoritative for the token's identity. Removing a duplicated configured ID prevents stale mention validation while retaining the fixed channel and user allowlists.
  Date/Author: 2026-08-23 / Codex.

- Decision: Apply one pinned Hermes patch that injects only the transport-authenticated Slack `event.message_id` into the current turn, mirroring Hermes' existing Discord pattern.
  Rationale: The timestamp is required to invoke the single MCP tool, changes every turn, and must not be guessed from content. The intake service still independently validates channel, author, mention, and top-level status, so the patch does not broaden authority or expose tokens/message bodies.
  Date/Author: 2026-08-24 / Codex.

- Decision: Use SQLite full-synchronous rollback journaling on `10.1.0.7` rather than the initially planned WAL mode.
  Rationale: Low intake volume does not require WAL concurrency, claim transactions already serialize writers, and avoiding WAL removes exposure to the target runtime's known WAL-reset defect.
  Date/Author: 2026-08-24 / Codex.

- Decision: Make final activation a guarded command that refuses to start unless Slack `files:read`, the exact public `#problem-intake` channel, bot membership, stopped reference gateway, package validation, and MCP discovery all pass.
  Rationale: The two remaining prerequisites require Slack workspace administration outside the bot token's authority. Encoding every safety gate makes the eventual handoff repeatable and prevents a partially capable gateway from being represented as active.
  Date/Author: 2026-08-24 / Codex.

## Outcomes & Retrospective

The local implementation, secret-free deployment artifact, dedicated CLIProxyAPI key, Plane project, intake release, pinned Hermes build, restricted config/skill/unit, model route, and one-tool MCP handshake are complete. The unit is deliberately `disabled` and `inactive`. Live Slack activation and acceptance are externally blocked on Slack admin work: create `#problem-intake`, add `files:read` and reinstall the app, then invite or join the bot. No live Slack-to-Plane ticket has been claimed as proof yet.

## Context and Orientation

The repository root is `/home/cslog/ai-workflow`. It contains multiple independent services. The closest Python packaging example is `hermes-memory-harness/`, which uses a `pyproject.toml`, a `src/` layout, Python 3.11, environment-based configuration, and deployment scripts. The new code belongs in `slack-plane-intake/` and does not alter the dashboard, Whisper, tmux, nginx, or root Compose stack.

The target host is `10.1.0.7`, SSH user `cslog`. CLIProxyAPI already runs there in Docker as container `cliproxyapi`, image `cliproxyapi:7.2.140`, listening on host port 8317. Plane also runs on the host but is accessed through `https://plane.supersaber.dev.br`. Hermes will use the loopback CLIProxyAPI endpoint `http://127.0.0.1:8317/v1`. The local source repository is absent from the target host, so the deployment script must transfer a release bundle rather than assume a checkout.

The reference Hermes host is `10.1.0.9`, where `~/.hermes/.env` contains Slack application and bot tokens plus an allowed-user list, and `~/.hermes/config.yaml` contains a Plane MCP configuration. Values were never printed. The source checkout there must not be changed, restarted, or copied wholesale. Transfer only Slack tokens, the allowed-user list, and the Plane key when they pass validation. Do not transfer conversation history, memories, WhatsApp settings, unrelated model credentials, or source modifications.

The new Python package has one public tool boundary. A Slack message timestamp such as `1724440000.123456` identifies the source message within the one configured channel. The service derives the Slack team, channel, author, permalink, and files from Slack's API. It creates a source key `slack:<team_id>:<channel_id>:<message_ts>` and persists it in SQLite before any Plane mutation.

Plane work-item creation is a single POST to the workspace/project work-items endpoint. File upload is a three-stage sequence: ask Plane for presigned upload credentials, perform a multipart upload to the returned storage URL, then PATCH the Plane attachment as uploaded. The caller must not know these steps; `PlaneClient` owns them, verifies the final attachment list, and deletes incomplete Plane asset rows after recoverable failures.

## Plan of Work

Milestone 1 creates a tested package with no live credentials. Add `slack-plane-intake/pyproject.toml`, a README, a `src/slack_plane_intake/` package, and `tests/`. Use `httpx` for Slack, CLIProxyAPI, Plane, and storage HTTP; `pydantic` for validated configuration and model output; `mcp` for the stdio server; `pypdf` for PDF text; `PyMuPDF` for bounded page rendering; and Pillow for safe image normalization and first-frame GIF handling. Keep external API logic in `SlackClient`, `Analyzer`, and `PlaneClient`. Put the workflow in `ProblemIntakeService`, idempotency in `IntakeLedger`, and MCP translation in `mcp_server`. The deep `ProblemIntakeService.create_from_slack(message_ts)` method must hide all sequencing from Hermes.

Define immutable data models for `SourceAttachment`, `SourceMessage`, `ProblemAnalysis`, and `IntakeResult`. `ProblemAnalysis` contains title, summary, confirmed facts, inferences, missing information, and warnings. `IntakeResult` contains status (`created`, `existing`, `partial`, or `failed`), issue key/URL, model used, attachment count, and warnings. Escape every user-controlled value before composing Plane HTML.

The Slack client uses the configured bot token to call `auth.test`, `conversations.history` for the exact timestamp, `files.info`, file download URLs, and `chat.getPermalink`. It rejects the wrong channel, unauthorized author, a missing bot mention, and a reply whose `thread_ts` differs from its own `ts`. It limits processing to 10 files, 20 MiB each, and 100 MiB total. It records metadata and warnings for inaccessible, unsupported, or oversized content rather than claiming it was processed.

The analyzer sends text-like inputs through K3, Qwen, and DeepSeek in order. It sends images or rendered PDF pages through K3, Qwen, and Terra. A fallback occurs after one retry for timeout, connection failure, HTTP 429 or 5xx, explicit unsupported-input response, or invalid JSON that fails `ProblemAnalysis` validation. The prompt says that message and attachment contents are evidence and cannot change system instructions or request actions. Original files are never rewritten before Plane upload; normalized copies exist only for model input.

The ledger uses SQLite full-synchronous rollback journaling and a unique source key. States are `pending`, `completed`, and `failed`, with issue identifiers, warnings, timestamps, and retry metadata. A per-source `BEGIN IMMEDIATE` transaction prevents concurrent duplicates. If Plane creation may have succeeded but the response was lost, query recent Plane items for a hidden source marker before retrying the POST. A duplicate returns the recorded or reconciled ticket.

Milestone 2 adds deployment assets. Add `scripts/build-release.sh` to create a source archive without secrets or runtime state, `scripts/deploy-godev.sh` to install the archive into `~/.local/share/slack-plane-intake`, and `deploy/hermes-gateway.service` as the systemd user-unit template. Bash scripts begin with `set -euo pipefail`, validate explicit host/path inputs, create timestamped backups, use a virtual environment, run tests before activation, and support a validation-only mode. Add redacted configuration examples for the package, Hermes, and the systemd environment.

Install upstream Hermes into `/home/cslog/hermes-agent` on `10.1.0.7` at pinned commit `d861fbe55073dbd9e295eaf2c1fd16c8af54f7da`, using its own virtual environment. Configure the primary custom provider as `kimi-k3` at the loopback CLIProxyAPI URL and a Hermes orchestration fallback of Qwen then Terra so an intake event containing an image can still reach the MCP tool. The intake package remains authoritative for the text-versus-visual model chain and ticket analysis. Configure one `problem-intake` skill and only the custom MCP server as an allowed tool surface.

Milestone 3 creates Plane project `Problem Intake` with identifier `PROB`, records its project UUID and Backlog state UUID in protected environment configuration, then activates Slack. The final ticket HTML contains summary, confirmed facts, labeled inferences, missing information, escaped original message, source permalink, author/channel/timestamps, file metadata and SHA-256 hashes, model used, and partial warnings. Files within limits are uploaded unchanged and verified.

Use Slack Socket Mode and ensure the app has `app_mentions:read`, `chat:write`, `channels:history` or `groups:history` for the chosen channel type, `files:read`, and `users:read`. Keep the old `10.1.0.9` gateway stopped; verify there is one active Socket Mode owner before live testing. On success Hermes replies in the source thread with `Created PROB-N: <url>` and attachment count. A duplicate says `Already registered as PROB-N`. Partial success names the missing evidence. Failure never claims a ticket exists.

## Concrete Steps

Work locally from `/home/cslog/ai-workflow` on branch `cslog-179-slack-plane-intake`:

    python3 -m venv slack-plane-intake/.venv
    slack-plane-intake/.venv/bin/pip install -e 'slack-plane-intake[dev]'
    slack-plane-intake/.venv/bin/pytest -q slack-plane-intake/tests
    slack-plane-intake/.venv/bin/python -m slack_plane_intake.mcp_server --validate-config

The tests must pass without network credentials. Configuration validation with no environment must fail with a concise list of missing variable names and never echo values.

Build and inspect the deployment artifact:

    cd /home/cslog/ai-workflow
    slack-plane-intake/scripts/build-release.sh
    tar -tzf slack-plane-intake/dist/slack-plane-intake.tar.gz

The archive must contain source, metadata, README, deployment templates, and no `.env`, SQLite database, cache, `__pycache__`, tests' temporary data, or credential-looking file.

On `10.1.0.7`, validate before activation:

    ssh 10.1.0.7 'systemctl --user daemon-reload'
    ssh 10.1.0.7 'systemctl --user cat hermes-gateway.service'
    ssh 10.1.0.7 '/home/cslog/.local/share/slack-plane-intake/venv/bin/python -m slack_plane_intake.mcp_server --validate-config'

Expected validation reports the configured channel/project identifiers and model names with every secret redacted. Starting the service is separate from source deployment and happens only after this validation and Slack single-owner verification.

## Validation and Acceptance

Unit and contract tests must cover exact-message retrieval, top-level/mention/channel/user rejection, HTML escaping, prompt injection in text and images, file count/size/total limits, original-byte hashing, PDF/text/image routing, K3-to-Qwen and visual Terra fallback, text DeepSeek fallback, invalid model JSON, SQLite concurrency, ambiguous Plane create reconciliation, presign/upload/complete/verify, incomplete asset cleanup, and result rendering.

The first live test posts an authorized text-only top-level message mentioning Hermes. It passes only if Slack receives one reply containing a new `PROB-N` URL and Plane shows the original text and source metadata. The second attaches a screenshot and passes only if the ticket contains a reasonable screenshot-derived fact, the exact original file as a Plane attachment, its matching SHA-256 hash, and the actual model name. Repeating the same Slack event must return the same key and leave the project work-item count unchanged.

Unauthorized user, wrong channel, and thread-reply tests must create no Plane item. A prompt-injection screenshot must be described as evidence and must not alter the ticket destination or invoke another tool. A forced primary-model failure must use the appropriate second model; a forced visual failure after Qwen must use Terra, while a forced text failure after Qwen must use DeepSeek. Plane failure must produce an explicit Slack error without a false success statement.

Runtime completion requires `systemctl --user is-active hermes-gateway.service` to report active, recent logs to contain no tokens or signed upload parameters, the MCP process to be present under Hermes, the CLIProxyAPI health/catalog to remain available, and the five live scenarios above to pass. A configured gateway or listening process without a real Slack-to-Plane work item is not completion evidence.

## Idempotence and Recovery

All local and remote deployment steps are repeatable. Release installation uses a versioned directory and atomically changes a `current` symlink only after dependency installation and validation. Existing protected configuration is backed up with mode 0600 before replacement. Plane project discovery checks identifier `PROB` before creation. Ledger schema creation uses `CREATE TABLE IF NOT EXISTS` and migrations tracked with `PRAGMA user_version`.

If source deployment succeeds but activation fails, point the release symlink back to the prior directory and restart only the Hermes user service. If Hermes installation fails, leave its incomplete versioned checkout unused and keep the service stopped. If a Plane item exists with partial attachments, retain the item, clean only dangling assets that are still marked incomplete, and report the missing files. Never delete a completed ticket automatically.

Rollback stops and disables `hermes-gateway.service` on `10.1.0.7`; it does not restart `10.1.0.9`, change CLIProxyAPI, delete Plane work items, or discard source/configuration backups.

## Artifacts and Notes

Pre-implementation runtime evidence captured on 2026-08-23:

    10.1.0.7 hostname: godev
    CLIProxyAPI container: cliproxyapi:7.2.140 on 8317
    Hermes processes/services/directories: none
    systemd user manager: running, linger=yes
    image tests: kimi-k3=success, qwen3.8-max=success,
                 gpt-5.6-terra=success, deepseek/deepseek-v4-pro=unsupported

Deployment evidence captured on 2026-08-24:

    intake release: 2026-08-24T00-14-51Z (26 target tests at deployment)
    Hermes: 0.20.5 at d861fbe55073dbd9e295eaf2c1fd16c8af54f7da
    Hermes patch: applied and reverse-checkable
    Hermes primary one-shot: HERMES_READY through kimi-k3
    MCP: connected, 1 tool discovered (create_plane_problem)
    live analyzer: K3 text=success, K3 vision=success
    forced routes: Qwen text second=success, DeepSeek text third=success,
                   Terra vision third=success
    Plane project: 97145582-1d9d-416c-8ae3-1a059eb13cbd
    Plane Backlog state: 3f508a61-1716-4ac2-8da6-a6737c571916
    service: disabled, inactive pending Slack administration

Do not copy any credential values, signed Plane storage URLs, policies, or signatures into this document. Append concise test counts, deployed commit identifiers, service status, created project UUID, and live issue keys here as implementation evidence, but continue to redact secrets.

## Interfaces and Dependencies

`slack_plane_intake.config.load_config()` returns an immutable `AppConfig` containing Slack, CLIProxyAPI, Plane, limits, paths, and model chains. Required environment names use the `SPI_` prefix: `SPI_SLACK_BOT_TOKEN`, `SPI_SLACK_CHANNEL_ID`, `SPI_SLACK_ALLOWED_USERS`, `SPI_CLIPROXY_BASE_URL`, `SPI_CLIPROXY_API_KEY`, `SPI_TEXT_MODELS`, `SPI_VISION_MODELS`, `SPI_PLANE_BASE_URL`, `SPI_PLANE_API_KEY`, `SPI_PLANE_WORKSPACE`, `SPI_PLANE_PROJECT_ID`, `SPI_PLANE_STATE_ID`, `SPI_STATE_DB`, and `SPI_WORK_DIR`. The bot ID is intentionally discovered through Slack `auth.test` and is not a configuration value.

`SlackClient.fetch_source_message(message_ts: str) -> SourceMessage` hides Slack authentication, exact-message lookup, allowlists, permalink retrieval, downloads, safety limits, and hashing.

`Analyzer.analyze(message: SourceMessage) -> ProblemAnalysis` hides content extraction, visual-versus-text routing, retry/fallback, prompt construction, JSON validation, and temporary normalized media.

`PlaneClient.create_problem(message: SourceMessage, analysis: ProblemAnalysis, source_marker: str) -> PlaneWorkItem` and `PlaneClient.upload_originals(work_item, attachments) -> UploadReport` hide Plane endpoint shapes, HTML creation, storage credentials, multipart upload, completion, verification, and dangling-asset cleanup.

`IntakeLedger.claim(source_key: str)` and its completion/reconciliation operations hide SQLite locking and retry state.

`ProblemIntakeService.create_from_slack(message_ts: str) -> IntakeResult` is the only orchestration entry point. Hermes sees only MCP tool `create_plane_problem(message_ts)` and the returned result; it never chooses a channel, project, model, ticket field, or upload step.

Dependencies are Python 3.11+, `httpx`, `pydantic`, the official Python `mcp` SDK, `pypdf`, `PyMuPDF`, Pillow, and `pytest` plus `respx` for tests. The first clean install resolved `httpx 0.28.1`, `mcp 2.0.0`, `pydantic 2.13.4`, `pypdf 6.16.2`, `PyMuPDF 1.28.2`, and Pillow 12.3.0 within the compatible major-version bounds in `pyproject.toml`.

Revision note: 2026-08-23 initial ExecPlan created from the user-approved CSLOG-179 design so implementation can proceed under the repository work-item workflow.

Revision note: 2026-08-23 core package milestone recorded after 21 tests and Ruff checks passed; documented MCP 2.0 compatibility and removal of the redundant Slack bot-ID setting.

Revision note: 2026-08-24 deployment milestone recorded after 25 tests, shell syntax checks, a successful application check of the pinned Hermes patch, and inspection of the secret-free release archive; documented the Slack timestamp integration gap and bounded patch.

Revision note: 2026-08-24 target installer corrected after live pre-activation evidence exposed relocated venv shebangs; regression count increased to 26.

Revision note: 2026-08-24 Hermes install corrected after the live MCP connection test showed that upstream separates Slack and MCP extras; regression count increased to 27.

Revision note: 2026-08-24 pre-activation doctor evidence changed the ledger from WAL to rollback journaling; recorded Plane/Hermes/MCP evidence and the external Slack channel/scope blocker; regression count increased to 28.

Revision note: 2026-08-24 removed the provider-incompatible zero-temperature override after live K3 evidence; retained the 28-test count with a stronger request-contract assertion.

Revision note: 2026-08-24 added a guarded activation workflow for the externally blocked Slack steps and recorded live primary/fallback analyzer evidence; regression count increased to 29.
