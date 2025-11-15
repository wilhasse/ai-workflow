# Whisper API Testing Guide

This directory (`whisper-realtime-api/tests/`) contains tools for testing the Whisper API.

## Before You Begin

**Find your Whisper API endpoint**:

```bash
# Check if Whisper is running in Docker
docker ps | grep whisper

# Check what's on port 8000
netstat -tlnp | grep :8000

# Test the health endpoint
curl http://localhost:8000/health
# Should return: {"status":"ok"}
```

Common endpoints:
- `http://localhost:8000` - Local Docker container
- `http://10.1.1.218:8000` - Remote GPU server
- Set with: `export API_BASE=http://your-host:port`

## Quick Start

```bash
cd whisper-realtime-api/tests

# 1. Configure API endpoint (REQUIRED!)
export API_BASE=http://localhost:8000  # or wherever your Whisper API is running

# 2. Test with Portuguese speech sample
./test-whisper-api.sh sample-pt-short.mp3

# Or use browser interface
python3 -m http.server 8080
# Open: http://localhost:8080/test-whisper-browser.html
# Set API Base URL to your Whisper endpoint
```

**Note**: Portuguese speech samples are already included! See "Available Test Files" below.

## Available Test Files

✅ **Test Audio (no speech, but valid audio)**:
- `sample-silence-1s.wav` - 1 second of silence (32 KB)
- `sample-tone-440hz-2s.wav` - 2 second 440 Hz tone / A4 note (64 KB)
- `sample-tone-200hz-1s.wav` - 1 second 200 Hz tone (32 KB)

These files test API functionality but will return empty transcriptions (no speech).

✅ **Portuguese Speech Samples (ready to use)**:
- `sample-pt-short.mp3` - Short greeting (47.6 KB)
  - "Olá, este é um teste de transcrição de áudio em português."
- `sample-pt-medium.mp3` - Medium paragraph (107.1 KB)
  - "Bem-vindo ao sistema de transcrição de áudio..."
- `sample-pt-long.mp3` - Long technical description (211.9 KB)
  - "A inteligência artificial está transformando..."

These files contain actual Portuguese speech for realistic transcription testing.

## Regenerating Portuguese Speech Samples

Samples are already included, but if you need to regenerate or create custom ones:

### Option 1: Using gTTS (Recommended)

Requires internet access. Uses virtual environment to avoid system package conflicts:

```bash
# Create virtual environment (first time only)
python3 -m venv venv

# Install dependencies
venv/bin/pip install gtts pydub

# Generate samples
venv/bin/python3 generate-portuguese-sample.py
```

This generates:
- `sample-pt-short.mp3` - Short greeting (47.6 KB)
- `sample-pt-medium.mp3` - Medium paragraph (107.1 KB)
- `sample-pt-long.mp3` - Long technical description (211.9 KB)

### Option 2: Online TTS Services

1. Visit https://ttsmp3.com
2. Select "Portuguese (Brazil)" or "Portuguese (Portugal)"
3. Enter text: "Olá, este é um teste de transcrição de áudio em português."
4. Click "Read" and download the MP3
5. Save as `sample-portuguese.mp3`

### Option 3: Record Your Own

Use the browser test interface (`test-whisper-browser.html`) to record directly from your microphone.

## Testing Scripts

### 1. Command-Line Tests

```bash
# Basic health check
curl http://10.1.1.218:8000/health

# Test with sample file
./test-whisper-api.sh sample-silence-1s.wav

# Test with your own file
./test-whisper-api.sh /path/to/your/audio.wav

# Test specific endpoint
API_BASE=http://10.1.1.218:8000 ./test-whisper-api.sh
```

### 2. Browser Interface

```bash
# Start local server
python3 -m http.server 8080

# Open in browser
# http://localhost:8080/test-whisper-browser.html
```

Features:
- ✅ Health check
- ✅ File upload (batch & streaming)
- ✅ Live microphone recording
- ✅ Configurable endpoint & language

## Manual API Testing

### Health Check
```bash
curl http://10.1.1.218:8000/health
```

Expected response:
```json
{"status": "ok", "model": "medium"}
```

### Batch Transcription
```bash
curl -X POST http://10.1.1.218:8000/transcribe \
  -F "file=@sample-portuguese.mp3" \
  -F "language=pt" \
  -F "translate=false"
```

### Streaming Transcription
```bash
curl -N -X POST http://10.1.1.218:8000/transcribe/stream \
  -F "file=@sample-portuguese.mp3" \
  -F "language=pt"
```

## Troubleshooting

### Connection Refused
- Check if the service is running: `docker ps`
- Verify the port: `netstat -tlnp | grep 8000`
- Check firewall: `sudo ufw status`

### Empty Transcriptions
- Verify file contains actual speech (not just tones/silence)
- Check audio format: `file your-audio.wav`
- Try with a known good sample

### CORS Errors (Browser)
- The Whisper API must allow CORS for browser recording to work
- Check if CORS headers are present in response
- Use the command-line tests as an alternative

## Example Workflow

```bash
# 1. Generate Portuguese speech sample (on machine with internet)
pip install gtts
python3 generate-portuguese-sample.py

# 2. Test health
curl http://10.1.1.218:8000/health

# 3. Test batch transcription
./test-whisper-api.sh sample-pt-short.mp3

# 4. Test streaming
curl -N -X POST http://10.1.1.218:8000/transcribe/stream \
  -F "file=@sample-pt-medium.mp3" \
  -F "language=pt"

# 5. Test in browser
python3 -m http.server 8080
# Open http://localhost:8080/test-whisper-browser.html
# Click "Start Recording" and speak in Portuguese
```

## Next Steps

Once testing is complete:
- Integrate with `terminal-dashboard` for voice commands
- Add recording functionality to the dashboard UI
- Configure proxy routing in nginx
- Set up HTTPS for production use

See `../CLAUDE.md` for architecture details and deployment instructions.
