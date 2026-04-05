# Hermes Memory Harness

Small harness project for turning historical agent transcripts stored in Doris
into inputs Hermes can use effectively.

The current strategy is intentionally staged:

1. Import historical transcripts into Hermes `state.db` so `session_search`
   can recall prior work.
2. Generate compact review-first drafts for `MEMORY.md` and `USER.md`.
3. Add a custom Hermes memory provider later only if automatic prefetch is
   still needed.

This project is intentionally separate from `oh-my-codex`. It targets Hermes'
own persistence and recall model.

## Scope

Current MVP supports:

- inspecting the Doris `agent_history` dataset
- importing deduped historical sessions/messages into Hermes `state.db`
- generating draft memory markdown from historical activity

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

You can override with env vars:

```bash
export HMH_DORIS_HOST=10.1.0.7
export HMH_DORIS_PORT=9030
export HMH_DORIS_USER=root
export HMH_DORIS_PASSWORD=
export HMH_DORIS_DATABASE=agent_history
export HMH_HERMES_HOME=~/.hermes
```

## Commands

Inspect available history:

```bash
hmh inspect --source codex
```

Import a small batch first:

```bash
hmh import-history --source codex --limit-sessions 25 --replace
```

Restrict import to one project:

```bash
hmh import-history --source codex --project /home/cslog/smart-sql --replace
```

Generate draft memory files:

```bash
hmh draft-memory --source codex
```

Output draft files are written under:

```text
.generated/MEMORY.draft.md
.generated/USER.draft.md
```

## Suggested Workflow

1. Run `hmh inspect --source codex`
2. Import a small subset with `hmh import-history --limit-sessions 25`
3. Open Hermes and test `session_search`
4. Generate memory drafts with `hmh draft-memory`
5. Curate the drafts manually into Hermes `memories/`
6. Only then consider a custom Hermes memory provider plugin

## Notes

- The Doris history has significant duplicate rows. This project dedupes at the
  transcript-import layer before writing into Hermes SQLite.
- Imported sessions are namespaced as `doris:<source>:<session_id>` to avoid
  collisions with live Hermes sessions.
- Imported session sources are stored as `history:<source>`.
