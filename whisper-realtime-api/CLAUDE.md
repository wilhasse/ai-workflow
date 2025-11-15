# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

FastAPI service that exposes OpenAI's Whisper model (via `faster-whisper`) for audio transcription. Supports both batch and streaming transcription endpoints, plus a browser-based recording UI. Designed to run in Docker with GPU acceleration (CUDA).

## Architecture

### Application Structure
- **app/main.py**: Core FastAPI application with all endpoints and transcription logic
  - Model lifecycle managed via FastAPI startup/shutdown events
  - Whisper model loaded once at startup and stored in `app.state.model`
  - Synchronous transcription runs in thread pool via `asyncio.to_thread()`
- **app/static/index.html**: Browser UI for microphone recording and transcription
- **requirements.txt**: Python dependencies (FastAPI, faster-whisper, uvicorn)
- **Dockerfile**: NVIDIA CUDA base image with FFmpeg and Python dependencies

### Key Design Patterns
1. **Model Singleton**: WhisperModel loaded once at startup, accessed via `get_model()` helper
2. **Streaming via Queue**: `/transcribe/stream` uses `asyncio.Queue` with Server-Sent Events to emit segments as they're generated
3. **Temporary File Handling**: Uploads saved to temp files with cleanup in try/finally blocks
4. **Thread Pool Execution**: CPU/GPU-bound transcription work offloaded from async event loop

## Development Commands

### Quick Rebuild Script

For rapid development and deployment:

```bash
# Stop, rebuild, and restart
./rebuild.sh

# Just restart without rebuilding
./rebuild.sh -n

# Rebuild and show logs
./rebuild.sh -l

# Just restart and show logs
./rebuild.sh -n -l
```

The script auto-detects GPU availability and configures accordingly.

### Local Development (without Docker)
```bash
# Install dependencies
pip install -r requirements.txt

# Run with auto-reload
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### Docker Build & Run (Manual)
```bash
# Build image
docker build -t whisper-realtime-api .

# Run with GPU support
docker run --rm --gpus all -p 8000:8000 \
  -e WHISPER_MODEL_SIZE=medium \
  -e WHISPER_DEVICE=cuda \
  -e WHISPER_COMPUTE_TYPE=float16 \
  whisper-realtime-api

# Run CPU-only
docker run --rm -p 8000:8000 \
  -e WHISPER_MODEL_SIZE=base \
  -e WHISPER_DEVICE=cpu \
  whisper-realtime-api
```

### Testing Endpoints
```bash
# Health check
curl http://localhost:8000/health

# Batch transcription
curl -X POST http://localhost:8000/transcribe \
  -F "file=@/path/to/audio.wav" \
  -F "language=pt" \
  -F "translate=false"

# Streaming transcription
curl -N -X POST http://localhost:8000/transcribe/stream \
  -F "file=@/path/to/audio.wav"
```

## Configuration

All configuration via environment variables:
- **WHISPER_MODEL_SIZE**: Model size (`tiny`, `base`, `small`, `medium`, `large-v3`)
- **WHISPER_DEVICE**: Compute device (`cuda`, `cpu`)
- **WHISPER_COMPUTE_TYPE**: Precision (`float16`, `float32`, `int8_float16`)
- **WHISPER_MAX_AUDIO_BYTES**: Upload size limit (default: 60 MiB)
- **WHISPER_BEAM_SIZE**: Beam search width (default: 5)
- **WHISPER_DOWNLOAD_ROOT**: Model cache directory (optional)

## Important Notes

- First run downloads the Whisper model (~1-3 GB depending on size)
- GPU memory usage scales with model size (medium ~5GB VRAM)
- Streaming endpoint emits JSON lines as `data: {...}\n\n` (SSE format)
- Audio processing is synchronous/blocking; adjust uvicorn workers for concurrency
- Browser UI requires HTTPS or localhost for microphone access
