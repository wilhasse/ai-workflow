# Hermes Memory Harness

Small harness project for turning historical agent transcripts stored in Doris
into inputs Hermes can use effectively.

The strategy is staged:

1. Import historical transcripts into Hermes `state.db` so `session_search`
   can recall prior work.
2. Generate compact review-first drafts for `MEMORY.md` and `USER.md`.
3. Run an incremental sync service so new Codex/Claude conversations continue
   flowing into Hermes automatically.
4. Add a custom Hermes memory provider later only if automatic prefetch beyond
   session recall is still needed.

This project is intentionally separate from `oh-my-codex`. It targets Hermes'
own persistence and recall model.

## Scope

Current MVP supports:

- inspecting the Doris `agent_history` dataset
- importing deduped historical sessions/messages into Hermes `state.db`
- generating draft memory markdown from historical activity
- incrementally syncing new Doris messages into Hermes via watermarks
- running as a long-lived polling service

Current non-goals:

- modifying Hermes core
- building a live Doris-backed Hermes plugin
- auto-writing raw transcript history into `MEMORY.md`

## Why This Shape

Hermes separates:

- durable memory: `MEMORY.md` / `USER.md`
- transcript recall: `session_search` over `state.db`

So the historical transcript corpus belongs in the session history path first,
not in built-in memory files.

## Install

```bash
cd /home/cslog/ai-workflow/hermes-memory-harness
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```

## Configuration

Defaults are chosen for the current environment:

- Doris host: `10.1.0.7`
- Doris port: `9030`
- Doris database: `agent_history`
- Doris user: `root`
- Hermes home: `$HERMES_HOME` or `~/.hermes`
- Default incremental sources: `codex,claude`
- Default poll interval: `60s`

You can override with env vars:

```bash
export HMH_DORIS_HOST=10.1.0.7
export HMH_DORIS_PORT=9030
export HMH_DORIS_USER=root
export HMH_DORIS_PASSWORD=
export HMH_DORIS_DATABASE=agent_history
export HMH_HERMES_HOME=~/.hermes
export HMH_DEFAULT_SOURCES=codex,claude
export HMH_POLL_INTERVAL_SECONDS=60
```

## Commands

Inspect available history:

```bash
hmh inspect --source codex
```

List top projects:

```bash
hmh list-projects --source codex --limit 25
```

Backfill one project first:

```bash
hmh import-history --source codex --project /home/cslog/smart-sql --replace
```

Backfill a whole source:

```bash
hmh import-history --source codex --replace
hmh import-history --source claude --replace
```

Generate memory drafts:

```bash
hmh draft-memory --source codex
```

Show incremental watermarks:

```bash
hmh watermarks
```

Run one incremental sync pass:

```bash
hmh sync-once --source codex --source claude
```

Run the incremental service in the foreground:

```bash
hmh run-service --source codex --source claude --poll-interval 60
```

## Incremental Sync Semantics

The incremental service uses Hermes-side watermark and fingerprint tables stored
inside `state.db`:

- `import_watermarks`
- `imported_message_fingerprints`

This means:

- the service can restart without losing progress
- duplicate rows from Doris do not create duplicate Hermes messages
- a small overlap window is used when polling to avoid missing same-timestamp
  messages while still remaining idempotent

### First-time use after a full backfill

If no watermark exists for a source, `sync-once` initializes the watermark to the
current maximum Doris timestamp and imports nothing. This is intentional and is
meant for the common case where historical data has already been backfilled.

Typical flow:

1. Do a full backfill with `import-history`
2. Start the ongoing service with `run-service`

## Suggested Workflow

1. Run `hmh inspect --source codex`
2. Backfill one small project slice first
3. Open Hermes and test `session_search`
4. Backfill larger sources (`codex`, `claude`)
5. Generate memory drafts with `hmh draft-memory`
6. Curate the drafts manually into Hermes `memories/`
7. Start the incremental service to keep Hermes current
8. Only then consider a custom Hermes memory provider plugin

## Docker Service

A minimal container/service path is included:

- `Dockerfile`
- `docker-compose.example.yml`
- `scripts/deploy-sync-container.sh`

The deployment helper script is the recommended path on hosts where Docker Compose bridge-network creation is unreliable or exhausted. It uses `docker build` + `docker run --network host` and mounts the local Hermes home directly.

Example:

```bash
cd /home/cslog/ai-workflow/hermes-memory-harness
docker compose -f docker-compose.example.yml up -d
```

This mounts `~/.hermes` into the container and writes directly to Hermes'
`state.db`, so the CLI and the sync service share the same recall store.

## Notes

- The Doris history has significant duplicate rows. This project dedupes at the
  transcript-import layer before writing into Hermes SQLite.
- Imported sessions are namespaced as `doris:<source>:<session_id>` to avoid
  collisions with live Hermes sessions.
- Imported session sources are stored as `history:<source>`.

### Recommended deployment helper

Build and run the sync container against the local Hermes home:

```bash
cd /home/cslog/ai-workflow/hermes-memory-harness
./scripts/deploy-sync-container.sh deploy
```

Common operations:

```bash
./scripts/deploy-sync-container.sh status
./scripts/deploy-sync-container.sh logs
./scripts/deploy-sync-container.sh restart
./scripts/deploy-sync-container.sh stop
```

Override defaults with environment variables when deploying on another machine:

```bash
HMH_HERMES_HOME_HOST=$HOME/.hermes HMH_DORIS_HOST=10.1.0.7 HMH_DORIS_PORT=9030 HMH_DORIS_USER=root HMH_DORIS_PASSWORD= HMH_DEFAULT_SOURCES=codex,claude HMH_POLL_INTERVAL_SECONDS=60 ./scripts/deploy-sync-container.sh deploy
```

This script is intended for the machine that owns the active Hermes home. If run on a different machine, it will feed that machine's mounted Hermes home, not some other remote instance.
