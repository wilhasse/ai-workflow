# Whisper API Test Suite

Testing tools for the whisper-realtime-api service.

## Quick Start

```bash
cd whisper-realtime-api/tests

# Configure API endpoint (IMPORTANT: set to where your Whisper API is running)
export API_BASE=http://localhost:8000  # or your actual Whisper API endpoint

# Run command-line tests with existing samples
./test-whisper-api.sh sample-pt-short.mp3

# Or start browser test interface
python3 -m http.server 8080
# Open: http://localhost:8080/test-whisper-browser.html
```

## What's Included

- **Test Scripts**
  - `test-whisper-api.sh` - Automated API testing (health, batch, stream)
  - `test-whisper-browser.html` - Interactive browser UI with recording

- **Sample Generators**
  - `create-simple-wav.py` - Generate test WAV files (no dependencies)
  - `generate-portuguese-sample.py` - Generate Portuguese speech (requires gTTS)
  - `generate-test-audio.sh` - Generate test audio with ffmpeg

- **Sample Audio Files**
  - `sample-silence-1s.wav` - 1 second silence (16kHz mono)
  - `sample-tone-440hz-2s.wav` - 440 Hz tone, 2 seconds
  - `sample-tone-200hz-1s.wav` - 200 Hz tone, 1 second
  - `sample-pt-short.mp3` - Portuguese speech sample (47.6 KB) ✅
  - `sample-pt-medium.mp3` - Portuguese speech sample (107.1 KB) ✅
  - `sample-pt-long.mp3` - Portuguese speech sample (211.9 KB) ✅

- **Documentation**
  - `TESTING.md` - Complete testing guide with examples

## Creating Portuguese Samples

Portuguese speech samples (`sample-pt-*.mp3`) are already included! If you need to regenerate or create new ones:

### Option 1: Use gTTS (Recommended)

Requires internet access. Uses Python virtual environment to avoid system package conflicts:

```bash
# Create virtual environment (first time only)
python3 -m venv venv

# Install dependencies
venv/bin/pip install gtts pydub

# Generate samples
venv/bin/python3 generate-portuguese-sample.py

# Creates: sample-pt-short.mp3, sample-pt-medium.mp3, sample-pt-long.mp3
```

### Option 2: Online TTS
1. Visit https://ttsmp3.com
2. Select "Portuguese (Brazil)" or "Portuguese (Portugal)"
3. Enter text: "Olá, este é um teste de transcrição de áudio em português."
4. Click "Read" and download the MP3

### Option 3: Record Your Own
Use the browser test interface (`test-whisper-browser.html`) to record directly from your microphone.

## Configuration

### Setting the API Endpoint

**IMPORTANT**: The test scripts need to know where your Whisper API is running.

#### For Command-Line Tests:
```bash
# Set API endpoint (required!)
export API_BASE=http://localhost:8000  # or wherever Whisper is running

# Then run tests
./test-whisper-api.sh sample-pt-short.mp3
```

#### For Browser Tests:
Open `test-whisper-browser.html` and edit the "API Base URL" field to point to your Whisper API endpoint.

#### Finding Your Whisper API:
```bash
# Check if Whisper is running in Docker
docker ps | grep whisper

# Check what's listening on port 8000
netstat -tlnp | grep :8000

# Test health endpoint
curl http://localhost:8000/health
# Should return: {"status":"ok"}
```

## More Info

See **[TESTING.md](TESTING.md)** for detailed usage, examples, and troubleshooting.
