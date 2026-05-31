# youtube-transcribe-service

FastAPI service that transcribes a YouTube video with Deepgram and stores the
result in Apache Doris (`agent_history` DB, table `youtube_transcripts`). Backs
the dashboard's Transcripts view.

## Endpoints
- `POST /jobs` `{ "url": "<youtube-url>" }` — enqueue (or reuse) a transcription.
- `GET /jobs` — list recent transcripts (newest first).
- `GET /jobs/{video_id}` — one transcript with full text.
- `GET /health` — liveness + Doris connectivity.

A single background worker processes one job at a time: yt-dlp downloads the
audio, Deepgram (`nova-3`) transcribes it, the row advances
`queued → processing → done|failed`. Re-submitting a finished video returns the
existing row. Transcription core is shared with `../youtube-transcribe`
(`transcribe_core.py`), including the DNS-over-HTTPS workaround for Deepgram's
partly-unroutable IP pool.

## Config (env)
`DEEPGRAM_API_KEY`, `DEEPGRAM_STT_MODEL` (default `nova-3`), `DORIS_HOST`,
`DORIS_PORT`, `DORIS_USER`, `DORIS_PASSWORD`, `DORIS_DATABASE`, `PORT`
(default 5005). In the stack these come from the root `.env` / compose env.

## Run locally
```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
python3 -m pytest tests/ -v          # unit tests (no live DB/network)
uvicorn app.main:app --host 0.0.0.0 --port 5005
```

## In the stack
Built from the repo root (`context: .`) so the image can vendor
`youtube-transcribe/transcribe_core.py`. nginx proxies `/api/transcribe/*` to
this service on `:5005`.
