# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

FastAPI service that exposes OpenAI's Whisper model (via `faster-whisper`) for audio transcription and Text-to-Speech (TTS) synthesis. Supports both batch and streaming endpoints for both transcription and TTS, plus a browser-based UI. Designed to run in Docker with GPU acceleration (CUDA).

**Features:**
- **Speech-to-Text (STT)**: Whisper-based transcription with language detection
- **Text-to-Speech (TTS)**: Dual backend support (Chatterbox Multilingual / F5-TTS)
- **Voice Cloning**: Clone voices from 5-10s audio samples
- **Browser UI**: Record audio for transcription, synthesize speech from text

## Architecture

### Application Structure
- **app/main.py**: Core FastAPI application with all endpoints
  - Model lifecycle managed via FastAPI startup/shutdown events
  - Whisper model loaded at startup → `app.state.model`
  - TTS model loaded at startup → `app.state.tts_model`
  - Synchronous inference runs in thread pool via `asyncio.to_thread()`
- **app/static/index.html**: Browser UI for recording, transcription, and TTS
- **requirements.txt**: Python dependencies (FastAPI, faster-whisper, chatterbox-tts, f5-tts)
- **Dockerfile**: NVIDIA CUDA base image with Python 3.11, FFmpeg, and audio libs

### Key Design Patterns
1. **Model Singleton**: Models loaded once at startup, accessed via `get_model()` / `get_tts_model()` helpers
2. **Streaming via Queue**: `/transcribe/stream` and `/tts/stream` use `asyncio.Queue` with Server-Sent Events
3. **Temporary File Handling**: Uploads saved to temp files with cleanup in try/finally blocks
4. **Thread Pool Execution**: CPU/GPU-bound inference work offloaded from async event loop
5. **Dual TTS Backends**: Switchable via `TTS_BACKEND` env var (chatterbox or f5tts)

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
# Health check (shows Whisper + TTS status)
curl http://localhost:8000/health

# Batch transcription
curl -X POST http://localhost:8000/transcribe \
  -F "file=@/path/to/audio.wav" \
  -F "language=pt" \
  -F "translate=false"

# Streaming transcription
curl -N -X POST http://localhost:8000/transcribe/stream \
  -F "file=@/path/to/audio.wav"

# List available TTS voices
curl http://localhost:8000/tts/voices

# Text-to-Speech (Portuguese)
curl -X POST http://localhost:8000/tts \
  -F "text=Olá, tudo bem? Isso é um teste." \
  -F "language=pt" \
  -F "format=wav" \
  -o output.wav

# TTS with voice cloning
curl -X POST http://localhost:8000/tts \
  -F "text=Teste de clonagem de voz." \
  -F "language=pt" \
  -F "reference_audio=@voice_sample.wav" \
  -o cloned_output.wav

# Streaming TTS (SSE)
curl -N -X POST http://localhost:8000/tts/stream \
  -F "text=Teste de streaming de áudio."
```

## Configuration

### Whisper (Speech-to-Text)
- **WHISPER_MODEL_SIZE**: Model size (`tiny`, `base`, `small`, `medium`, `large-v3`)
- **WHISPER_DEVICE**: Compute device (`cuda`, `cpu`)
- **WHISPER_COMPUTE_TYPE**: Precision (`float16`, `float32`, `int8_float16`)
- **WHISPER_MAX_AUDIO_BYTES**: Upload size limit (default: 60 MiB)
- **WHISPER_BEAM_SIZE**: Beam search width (default: 5)
- **WHISPER_DOWNLOAD_ROOT**: Model cache directory (optional)

### TTS (Text-to-Speech)
- **TTS_BACKEND**: TTS engine (`chatterbox` or `f5tts`, default: chatterbox)
- **TTS_DEVICE**: Compute device (`cuda`, `cpu`, default: cuda)
- **TTS_LANGUAGE**: Default language code (default: pt for Portuguese)
- **TTS_MAX_TEXT_LENGTH**: Max characters per request (default: 5000)
- **TTS_SAMPLE_RATE**: Output audio sample rate (default: 24000)
- **TTS_DEFAULT_VOICE**: Path to default reference audio for F5-TTS (optional)
- **CHATTERBOX_EXAGGERATION**: Emotion exaggeration level 0-1 (default: 0.5)
- **CHATTERBOX_CFG**: Classifier-free guidance strength (default: 0.5)

## Important Notes

### Whisper
- First run downloads the Whisper model (~1-3 GB depending on size)
- GPU memory usage scales with model size (medium ~5GB VRAM)
- Streaming endpoint emits JSON lines as `data: {...}\n\n` (SSE format)

### TTS
- **Chatterbox**: Supports 23 languages, emotion control, voice cloning without reference required
- **F5-TTS**: Brazilian Portuguese optimized, requires reference audio for voice cloning
- TTS models require additional ~4-6GB VRAM
- Running both Whisper + TTS may require 12GB+ VRAM total
- Voice cloning works best with 5-10 second clean audio samples

### General
- Audio processing is synchronous/blocking; adjust uvicorn workers for concurrency
- Browser UI requires HTTPS or localhost for microphone access
