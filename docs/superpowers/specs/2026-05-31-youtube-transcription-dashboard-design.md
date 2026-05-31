# YouTube Transcription in the Dashboard — Design

**Date:** 2026-05-31
**Status:** Approved (design); pending implementation plan

## Summary

Add a YouTube-transcription feature to the terminal dashboard. A user pastes a
YouTube URL into a new **Transcripts** view, a new backend service downloads the
audio and transcribes it via Deepgram, stores the result in Apache Doris, and the
dashboard lists past transcriptions with their status and full text.

This reuses the already-working `youtube-transcribe/transcribe.py` logic
(yt-dlp download + Deepgram `nova-3` + the DNS-over-HTTPS IP-pinning workaround
for Deepgram's partly-unroutable IP pool).

## Decisions (locked during brainstorming)

- **Backend:** a new dedicated Python/FastAPI service `youtube-transcribe-service`
  (mirrors the existing `whisper-realtime-api` pattern). Not folded into
  `agent-history-service`.
- **Storage:** Apache Doris at `10.1.0.7:9030`, existing DB `agent_history`,
  **new table** `youtube_transcripts`.
- **UI location:** a top-level **Terminals / Transcripts** toggle in the dashboard
  header. Transcripts view = paste box + list + detail. The separate `:5003`
  agent-history UI is unchanged.
- **Submit form:** URL only. Auto-detect language, `nova-3`, no diarization.
  Re-submitting an already-transcribed video **reuses** the existing result.
- **Hosting:** service runs on the `10.1.0.10` host beside the dashboard, connects
  out to Doris on `10.1.0.7`.

## Architecture

```
 Dashboard SPA (10.1.0.10)
   header toggle:  [ Terminals | Transcripts ]
        │  REST via nginx  →  /api/transcribe/*
        ▼
 youtube-transcribe-service   (NEW · Python/FastAPI · port 5005)
   POST /jobs   {url}      → dedup check, enqueue, return job
   GET  /jobs             → list (feeds the dashboard list)
   GET  /jobs/{video_id}  → detail + full transcript text
   GET  /health           → liveness + Doris connectivity
   [background worker]  yt-dlp → Deepgram → write Doris
        │  MySQL protocol (Doris speaks MySQL wire protocol)
        ▼
 Apache Doris  10.1.0.7:9030 · DB agent_history · table youtube_transcripts
```

### Code reuse

The core of `youtube-transcribe/transcribe.py` is refactored into an importable
module `youtube-transcribe/transcribe_core.py` exposing:

- `resolve_pool(host)` / `reachable_ip(host)` — DoH-based IP discovery + reachable
  IP selection (the existing Deepgram routing workaround).
- `PinnedHTTPSConnection` — pins HTTPS to a reachable IP with correct SNI/cert.
- `download_audio(url, workdir)` — yt-dlp download.
- `deepgram_transcribe(audio_path, api_key, params)` — POST to Deepgram.
- `extract_transcript(result, diarize)` — readable text extraction.
- `video_id_from_url(url)` and metadata extraction (title, channel, duration)
  via `yt-dlp --print`/`--dump-json`.

Both the existing CLI (`transcribe.py`) and the new service import from this
module so there is one transcription code path.

## Data model — `youtube_transcripts` (Doris, DB `agent_history`)

| column | type | notes |
|---|---|---|
| `video_id` | VARCHAR(32) NOT NULL | YouTube id; **UNIQUE KEY** — dedup / reuse |
| `url` | VARCHAR(512) | original URL |
| `title` | STRING | from yt-dlp |
| `channel` | STRING | uploader/channel |
| `duration_seconds` | INT | audio duration |
| `language` | VARCHAR(16) | detected language |
| `model` | VARCHAR(32) | Deepgram model (`nova-3`) |
| `status` | VARCHAR(16) NOT NULL | `queued` \| `processing` \| `done` \| `failed` |
| `error` | STRING | failure reason when `status=failed` |
| `transcript_text` | STRING | full transcript; INVERTED index for future search |
| `created_at` | DATETIME NOT NULL | first submitted |
| `updated_at` | DATETIME NOT NULL | last status change |

DDL notes:

- `UNIQUE KEY(video_id)` (Doris unique-key model = upsert). The worker re-inserts
  the full row as `status` advances. Volume is low (handful of transcriptions),
  so update frequency is a non-issue.
- `DISTRIBUTED BY HASH(video_id) BUCKETS 4`, `"replication_num" = "1"` — matches
  the small `agent_history`/`agent_tasks` tables in the existing schema.
- `INVERTED` index on `transcript_text` (and optionally `title`) using
  `"parser" = "unicode"` — same convention as `agent_messages.content_text`, to
  enable full-text search later (not exposed in v1 UI).

## Job / worker model

- **Submit (`POST /jobs`):**
  1. Validate the URL and extract `video_id`. Reject unparseable URLs with HTTP 400.
  2. Query Doris for an existing row. If a `done` row exists → return it (reuse,
     no re-run). If a `queued`/`processing` row exists → return that job.
  3. Otherwise insert a `queued` row (with whatever metadata is cheaply available)
     and enqueue the `video_id`.
- **Worker:** a single background task (asyncio task pulling from an
  `asyncio.Queue`) processing **one job at a time** to avoid CPU/network spikes.
  Per job: set `processing` → fetch metadata + download audio (yt-dlp) → Deepgram
  → set `done` with `transcript_text` + metadata → delete temp audio. Any
  exception → set `failed` with the error message.
- **Restart recovery:** on startup, re-enqueue `queued` rows and mark orphaned
  `processing` rows as `failed` (their temp audio is gone). The user can resubmit
  a failed video to retry.

## Dashboard UI

- **Header toggle** `Terminals | Transcripts`, persisted (localStorage) and
  deep-linkable via `?view=transcripts` (consistent with existing query-param
  deep-linking). Default view stays `Terminals`.
- **Transcripts view** (new component, e.g. `src/components/transcripts/`):
  - **Submit box:** URL input + "Transcribe" button → `POST /jobs`. On success the
    new/returned job is shown at the top of the list. Inline error on HTTP 400.
  - **List:** rows show title (or URL while pending), status icon (✓ done / ⧗
    processing / ✗ failed), duration, language, relative created time. The list
    polls `GET /jobs` every ~3 s while any row is `queued`/`processing`, then stops.
  - **Detail:** clicking a row calls `GET /jobs/{video_id}` and shows metadata,
    the full transcript, a copy button, and a link to the original video.
- Styling follows existing dashboard conventions (`App.jsx` helpers, two-space
  semicolonless formatting).

### API client

A small `transcribeApi` helper in the dashboard builds base URLs from
`window.location` (like the existing socket-URL helpers) and targets
`/api/transcribe/*`.

## Config / infra

- **Service env:** `DEEPGRAM_API_KEY`, `DORIS_HOST` (10.1.0.7), `DORIS_PORT`
  (9030), `DORIS_USER`, `DORIS_PASSWORD`, `DORIS_DATABASE` (agent_history),
  `PORT` (5005). The Deepgram key comes from `.env.production` / compose env and
  is **never committed**.
- **Docker image** for the service includes `yt-dlp` and `ffmpeg`.
- **docker-compose:** add `youtube-transcribe-service` to `docker-compose.yml`
  and the `docker-compose.10.1.0.10.yml` variant.
- **nginx:** add `location /api/transcribe/ { proxy_pass http://youtube-transcribe-service:5005/; }`
  alongside the existing `/api/sessions` and `/ws/sessions` routes (rewrite so the
  service sees `/jobs`, `/health`, etc.).
- **Doris bootstrap:** the service ensures the `youtube_transcripts` table exists
  at startup (an `ensureSchema`-style DDL run, mirroring `agent-history-service`).

## Error handling

| Failure | Behavior |
|---|---|
| Unparseable / unsupported URL | `POST /jobs` → HTTP 400, inline UI error |
| Private / removed video (yt-dlp fails) | row → `failed`, error surfaced in detail |
| Deepgram HTTP error | row → `failed` with status + body excerpt |
| All Deepgram IPs unreachable | row → `failed` with the routing message (host issue) |
| Doris unreachable | `/health` 503; `POST /jobs` returns 503; UI shows service-down |

## Testing

- **Service (pytest):** `video_id_from_url` parsing (various URL shapes), reuse
  logic (existing `done` row short-circuits), `extract_transcript` against a
  recorded Deepgram JSON fixture, and the queue state machine
  (`queued→processing→done/failed`) with yt-dlp + Deepgram mocked.
- **Dashboard:** manual verification (no test framework configured), per
  `terminal-dashboard` convention — submit a URL, watch the row progress, open the
  detail, verify reuse on re-submit.

## Out of scope (v1)

- Diarization / language override / force-re-transcribe (deliberately deferred —
  schema/worker already accept a `params` dict, so adding them later is small).
- Full-text search UI over transcripts (the INVERTED index is created now to make
  it cheap later).
- Surfacing transcripts in the `:5003` agent-history UI.
- The separate dashboard terminal-UX cleanup (its own follow-up spec).

## Open follow-ups

- **Terminal-UX cleanup** (WindowTabs vs Jump-modal redundancy) — separate
  brainstorm/spec, agreed to tackle after this feature.
