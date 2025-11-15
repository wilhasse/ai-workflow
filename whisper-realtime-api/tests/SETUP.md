# Test Suite Setup Documentation

This document describes what's in this test directory and how it was set up.

## Directory Contents

```
whisper-realtime-api/tests/
├── README.md                      # Quick reference guide
├── TESTING.md                     # Comprehensive testing guide
├── SETUP.md                       # This file - setup documentation
│
├── venv/                          # Python virtual environment (gitignored)
│   └── bin/python3                # Used for running generate-portuguese-sample.py
│
├── test-whisper-api.sh           # Automated CLI test script
├── test-whisper-browser.html     # Interactive browser test interface
│
├── create-simple-wav.py          # Generate basic WAV files (no deps)
├── generate-portuguese-sample.py # Generate Portuguese TTS (needs gTTS)
├── generate-test-audio.sh        # Generate test audio with ffmpeg
│
├── sample-silence-1s.wav         # Test audio: 1s silence (32 KB)
├── sample-tone-200hz-1s.wav      # Test audio: 200 Hz tone (32 KB)
├── sample-tone-440hz-2s.wav      # Test audio: 440 Hz tone (64 KB)
│
├── sample-pt-short.mp3           # Portuguese TTS: short (47.6 KB) ✅
├── sample-pt-medium.mp3          # Portuguese TTS: medium (107.1 KB) ✅
└── sample-pt-long.mp3            # Portuguese TTS: long (211.9 KB) ✅
```

## What's Already Done

### 1. Basic Test Audio Files ✅

Generated using Python stdlib (no dependencies):

```bash
python3 create-simple-wav.py
```

Created:
- `sample-silence-1s.wav` - For testing API with silent audio
- `sample-tone-440hz-2s.wav` - For testing API with tone
- `sample-tone-200hz-1s.wav` - For testing API with different frequency

**Note**: These test the API infrastructure but return empty transcriptions (no speech).

### 2. Portuguese Speech Samples ✅

Generated using Google TTS via virtual environment:

```bash
# Created venv to avoid system package conflicts
python3 -m venv venv

# Installed dependencies
venv/bin/pip install gtts pydub

# Generated Portuguese samples
venv/bin/python3 generate-portuguese-sample.py
```

Created:
- `sample-pt-short.mp3` - "Olá, este é um teste de transcrição..."
- `sample-pt-medium.mp3` - "Bem-vindo ao sistema de transcrição..."
- `sample-pt-long.mp3` - "A inteligência artificial está transformando..."

**Note**: These contain actual Portuguese speech for realistic testing.

### 3. Test Scripts ✅

- **test-whisper-api.sh**: Automated testing of health, batch, and streaming endpoints
- **test-whisper-browser.html**: Browser UI with microphone recording and file upload

## Usage

### Quick Test

```bash
cd whisper-realtime-api/tests

# Set API endpoint
export API_BASE=http://localhost:8000

# Run tests
./test-whisper-api.sh sample-pt-short.mp3
```

### Browser Test

```bash
# Start HTTP server
python3 -m http.server 8080

# Open browser to:
# http://localhost:8080/test-whisper-browser.html
```

## Regenerating Samples

### Regenerate Basic Audio

```bash
python3 create-simple-wav.py
```

### Regenerate Portuguese Speech

```bash
# Activate venv (if it exists)
source venv/bin/activate

# Or use venv directly
venv/bin/python3 generate-portuguese-sample.py
```

### Generate Custom Portuguese Text

Edit `generate-portuguese-sample.py` and modify the `SAMPLES` dictionary:

```python
SAMPLES = {
    "custom": "Seu texto personalizado aqui.",
}
```

Then run:
```bash
venv/bin/python3 generate-portuguese-sample.py
```

## Environment Setup Notes

### Why Virtual Environment?

The system uses externally-managed Python (Debian/Ubuntu), which prevents `pip install` at the system level. Virtual environment avoids this:

```bash
python3 -m venv venv
venv/bin/pip install <package>
```

### Dependencies

- **Basic audio generation**: None (Python stdlib only)
- **Portuguese TTS**: `gtts`, `pydub` (installed in venv)
- **ffmpeg-based generation**: `ffmpeg` (system package, optional)

## API Endpoint Configuration

The Whisper API must be running for tests to work. Find your endpoint:

```bash
# Check Docker
docker ps | grep whisper

# Check local ports
netstat -tlnp | grep :8000

# Test health
curl http://localhost:8000/health
```

Set the endpoint:
```bash
export API_BASE=http://your-host:port
```

## Troubleshooting

### "Connection refused"
- Whisper API is not running at the configured endpoint
- Check `docker ps` or start the API service
- Verify firewall/network settings

### "Required packages not installed"
- Use the virtual environment: `venv/bin/python3 generate-portuguese-sample.py`
- Or reinstall: `venv/bin/pip install gtts pydub`

### Empty transcriptions
- If using WAV files (tones/silence), this is expected
- Use Portuguese MP3 samples for actual speech transcription
- Verify API is returning 200 OK status

## Next Steps

- Start the Whisper API service
- Run test scripts to verify functionality
- Integrate with terminal-dashboard for voice features
- Add custom test samples as needed

See **README.md** for quick reference or **TESTING.md** for complete guide.
