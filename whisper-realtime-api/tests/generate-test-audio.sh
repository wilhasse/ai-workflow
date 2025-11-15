#!/bin/bash
# Generate test audio files using ffmpeg (no speech, just valid audio)

set -e

echo "=== Test Audio Generator ==="
echo

# Check for ffmpeg
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Error: ffmpeg not found"
  echo "Install with: sudo apt-get install ffmpeg"
  exit 1
fi

# 1. Generate silence (1 second)
echo "1. Generating silence-1s.wav..."
ffmpeg -f lavfi -i anullsrc=r=16000:cl=mono -t 1 -acodec pcm_s16le silence-1s.wav -y 2>/dev/null
echo "   ✓ Created silence-1s.wav (1 second)"
echo

# 2. Generate silence (5 seconds)
echo "2. Generating silence-5s.wav..."
ffmpeg -f lavfi -i anullsrc=r=16000:cl=mono -t 5 -acodec pcm_s16le silence-5s.wav -y 2>/dev/null
echo "   ✓ Created silence-5s.wav (5 seconds)"
echo

# 3. Generate tone (440 Hz / A4 note, 2 seconds)
echo "3. Generating tone-440hz-2s.wav..."
ffmpeg -f lavfi -i "sine=frequency=440:duration=2" -ar 16000 -ac 1 tone-440hz-2s.wav -y 2>/dev/null
echo "   ✓ Created tone-440hz-2s.wav (440 Hz, 2 seconds)"
echo

# 4. Generate multi-tone (simulating speech-like frequencies)
echo "4. Generating multi-tone-3s.wav..."
ffmpeg -f lavfi -i "sine=frequency=200:duration=1" \
  -f lavfi -i "sine=frequency=400:duration=1" \
  -f lavfi -i "sine=frequency=600:duration=1" \
  -filter_complex "[0:a][1:a][2:a]concat=n=3:v=0:a=1" \
  -ar 16000 -ac 1 multi-tone-3s.wav -y 2>/dev/null
echo "   ✓ Created multi-tone-3s.wav (200/400/600 Hz, 3 seconds)"
echo

# 5. Generate white noise (2 seconds)
echo "5. Generating white-noise-2s.wav..."
ffmpeg -f lavfi -i "anoisesrc=d=2:c=pink:r=16000:a=0.5" -ar 16000 -ac 1 white-noise-2s.wav -y 2>/dev/null
echo "   ✓ Created white-noise-2s.wav (2 seconds)"
echo

echo "=== Generation Complete ==="
echo
echo "Files created:"
ls -lh silence-*.wav tone-*.wav multi-tone-*.wav white-noise-*.wav 2>/dev/null | awk '{print "  " $9 " (" $5 ")"}'
echo
echo "Note: These files contain no speech, so Whisper will return empty transcriptions."
echo "      They are useful for testing API functionality, not transcription quality."
echo
echo "For real Portuguese speech samples, use:"
echo "  python3 generate-portuguese-sample.py"
echo "  (requires: pip install gtts)"
echo
echo "Test with Whisper API:"
echo "  ./test-whisper-api.sh silence-1s.wav"
