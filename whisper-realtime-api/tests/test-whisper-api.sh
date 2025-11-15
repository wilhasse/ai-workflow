#!/bin/bash
# Test script for whisper-realtime-api running at 10.1.1.218:8000

API_BASE="${API_BASE:-http://10.1.1.218:8000}"

echo "=== Testing Whisper API at $API_BASE ==="
echo

# 1. Health check
echo "1. Health Check"
echo "----------------"
curl -s "$API_BASE/health" | jq . || curl -s "$API_BASE/health"
echo
echo

# 2. Create a test audio file (1 second of silence)
echo "2. Creating test audio file (1s silence)..."
echo "----------------"
if command -v ffmpeg >/dev/null 2>&1; then
  ffmpeg -f lavfi -i anullsrc=r=16000:cl=mono -t 1 -q:a 9 -acodec pcm_s16le test-audio.wav -y 2>/dev/null
  echo "Created test-audio.wav"
else
  echo "⚠ ffmpeg not found - skipping audio file creation"
  echo "Please provide your own .wav file for testing"
fi
echo
echo

# 3. Test batch transcription
if [ -f "test-audio.wav" ]; then
  echo "3. Testing Batch Transcription"
  echo "--------------------------------"
  curl -s -X POST "$API_BASE/transcribe" \
    -F "file=@test-audio.wav" \
    -F "language=pt" \
    -F "translate=false" | jq . || \
    curl -X POST "$API_BASE/transcribe" \
      -F "file=@test-audio.wav" \
      -F "language=pt" \
      -F "translate=false"
  echo
  echo
fi

# 4. Test streaming transcription
if [ -f "test-audio.wav" ]; then
  echo "4. Testing Streaming Transcription"
  echo "-----------------------------------"
  curl -N -X POST "$API_BASE/transcribe/stream" \
    -F "file=@test-audio.wav" \
    -F "language=pt"
  echo
  echo
fi

# 5. Test with real audio (if provided)
if [ -n "$1" ] && [ -f "$1" ]; then
  echo "5. Testing with provided audio: $1"
  echo "------------------------------------"
  curl -s -X POST "$API_BASE/transcribe" \
    -F "file=@$1" \
    -F "language=pt" | jq . || \
    curl -X POST "$API_BASE/transcribe" -F "file=@$1" -F "language=pt"
  echo
fi

echo "=== Testing Complete ==="
echo
echo "Next steps:"
echo "  - Test with real audio: ./test-whisper-api.sh your-audio.wav"
echo "  - Test browser UI: open http://10.1.1.218:8000 in browser"
echo "  - Check logs: docker logs <container-id>"
