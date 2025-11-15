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
- `WHISPER_CORS_ORIGINS`: comma-separated list of allowed browser origins (default `*`).
- `WHISPER_REMOTE_API_BASE`: when set, skip local inference and proxy `/transcribe` + `/transcribe/stream` to a remote Whisper API.
- `WHISPER_REMOTE_TIMEOUT`: upstream timeout in seconds (default `300`).
- `WHISPER_REMOTE_VERIFY_TLS`: set to `false` to trust self-signed certificates on the remote host.

## HTTP Endpoints
- `GET /health` – readiness probe.
- `POST /transcribe` – multipart `file` upload, optional `language`, `translate`, `vad_filter`. Returns JSON with full transcript and segments.
- `POST /transcribe/stream` – same payload, responds with `text/event-stream` chunks for near real-time consumption.
- `GET /` – bundled web UI (served from `/static`) for microphone recording **and** manual uploads.

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
1. Open `https://HOST/` (or `http://localhost:8000/`). Browsers require HTTPS for live microphone capture.
2. Click **Start Recording** to capture audio; **Stop & Transcribe** uploads to `/transcribe` and displays the transcript.
3. Prefer uploading a clip instead? Use the **Upload audio** control to pick any WAV/MP3/etc. file and we will post it to `/transcribe`.
4. Choose language or enable translation to English before recording or uploading.

## Development
- Dependencies listed in `requirements.txt`.
- App entry point: `app/main.py`; static assets under `app/static/`.
- Uvicorn command baked into container (`CMD`). For local (non-Docker) runs: `uvicorn app.main:app --reload` after installing requirements.

## Notes
- First run downloads the specified Whisper model (cached in the container layer); change `WHISPER_DOWNLOAD_ROOT` to use a persistent volume.
- Streaming endpoint emits JSON lines prefixed with `data:` (Server-Sent Events); parse incrementally for live captions.
- Ensure GPU sharing: stop the container when the GPU is needed for other workloads (e.g., gaming).

## Remote / Proxy Mode

Running the UI on a host without a GPU? Deploy the model on a GPU machine and point a lightweight proxy at it:

```bash
# GPU box
docker run --rm --gpus all -p 9000:8000 --name whisper-gpu whisper-realtime-api

# Proxy/UI host (no GPU required)
docker run -p 8000:8000 \
  -e WHISPER_REMOTE_API_BASE="https://gpu-box.example.com:9000" \
  -e WHISPER_REMOTE_VERIFY_TLS=false \  # only if using self-signed certs
  whisper-realtime-api
```

With `WHISPER_REMOTE_API_BASE` set the FastAPI app skips Whisper model initialization and simply forwards `/transcribe` + `/transcribe/stream` to the remote service (including multipart uploads). Place the proxy behind HTTPS (the ai-workflow nginx works well) so browsers grant microphone access while the heavy lifting happens elsewhere.

## Browser Recording Tips

- `navigator.mediaDevices.getUserMedia` only works on secure contexts (`https://` or `http://localhost`). When opened over plain HTTP on a remote host the UI now displays a warning and lets you upload an audio file instead.
- The recorder captures audio via `MediaRecorder` (WebM/Opus). The upload control accepts WAV, MP3, M4A, etc., so you can grab snippets from other tools and send them directly.
- If you expose the API to other origins (e.g., calling it from the ai-workflow dashboard) set `WHISPER_CORS_ORIGINS` to the list of allowed schemes/hosts.
