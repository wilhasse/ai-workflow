# Whisper Realtime API

Containerized FastAPI service that exposes Whisper (via `faster-whisper`) for batch and streaming transcription, plus a browser UI for quick recording.

## Prerequisites
- Docker Desktop (Windows/macOS) or Docker Engine (Linux) with NVIDIA Container Toolkit for GPU access (`--gpus all`).
- CUDA-capable GPU (tested on RTX 4090). CPU-only execution works but is slower; set `WHISPER_DEVICE=cpu` if needed.

## Build & Run
```bash
cd ~/whisper-realtime-api
docker build -t whisper-realtime-api .
docker run --rm --gpus all -p 8000:8000 \
  -e WHISPER_MODEL_SIZE=medium \
  -e WHISPER_DEVICE=cuda \
  -e WHISPER_COMPUTE_TYPE=float16 \
  whisper-realtime-api
```

Environment overrides:
- `WHISPER_MODEL_SIZE`: `tiny`, `base`, `small`, `medium`, `large-v3`, etc.
- `WHISPER_DEVICE`: `cuda`, `cpu`.
- `WHISPER_COMPUTE_TYPE`: e.g., `float16`, `float32`, `int8_float16`.
- `WHISPER_MAX_AUDIO_BYTES`: request size cap (default 60 MiB).

## HTTP Endpoints
- `GET /health` – readiness probe.
- `POST /transcribe` – multipart `file` upload, optional `language`, `translate`, `vad_filter`. Returns JSON with full transcript and segments.
- `POST /transcribe/stream` – same payload, responds with `text/event-stream` chunks for near real-time consumption.
- `GET /` – bundled web UI (served from `/static`) for recording via browser.

### cURL Example
```bash
curl -X POST http://localhost:8000/transcribe \
  -F "file=@/absolute/path/sample.wav" \
  -F "language=pt" \
  -F "translate=false"
```

### Streaming Example
```bash
curl -N -X POST http://localhost:8000/transcribe/stream \
  -F "file=@/absolute/path/sample.wav"
```

## Web Recorder
1. Open `http://HOST:8000/` (use HTTPS or LAN when remote so browsers allow mic access).
2. Click **Start Recording** to capture audio; **Stop & Transcribe** uploads to `/transcribe` and displays the transcript.
3. Choose language or enable translation to English before recording.

## Development
- Dependencies listed in `requirements.txt`.
- App entry point: `app/main.py`; static assets under `app/static/`.
- Uvicorn command baked into container (`CMD`). For local (non-Docker) runs: `uvicorn app.main:app --reload` after installing requirements.

## Notes
- First run downloads the specified Whisper model (cached in the container layer); change `WHISPER_DOWNLOAD_ROOT` to use a persistent volume.
- Streaming endpoint emits JSON lines prefixed with `data:` (Server-Sent Events); parse incrementally for live captions.
- Ensure GPU sharing: stop the container when the GPU is needed for other workloads (e.g., gaming).
