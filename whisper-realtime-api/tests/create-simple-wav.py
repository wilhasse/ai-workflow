#!/usr/bin/env python3
"""
Create a simple WAV file with a sine wave tone
No external dependencies - uses only Python stdlib
"""

import wave
import math
import struct

def create_wav(filename, frequency=440, duration=2, sample_rate=16000, amplitude=0.3):
    """
    Create a WAV file with a sine wave

    Args:
        filename: Output filename
        frequency: Frequency in Hz (default 440 = A4 note)
        duration: Duration in seconds
        sample_rate: Sample rate in Hz
        amplitude: Volume (0.0 to 1.0)
    """
    num_samples = int(sample_rate * duration)

    with wave.open(filename, 'w') as wav_file:
        # Set WAV parameters
        # nchannels, sampwidth, framerate, nframes, comptype, compname
        wav_file.setparams((1, 2, sample_rate, num_samples, 'NONE', 'not compressed'))

        # Generate sine wave samples
        for i in range(num_samples):
            # Calculate sine wave value
            value = amplitude * math.sin(2 * math.pi * frequency * i / sample_rate)
            # Convert to 16-bit signed integer
            data = struct.pack('<h', int(value * 32767))
            wav_file.writeframes(data)

    print(f"✓ Created {filename}")
    print(f"  Frequency: {frequency} Hz")
    print(f"  Duration: {duration}s")
    print(f"  Sample rate: {sample_rate} Hz")

def create_silence(filename, duration=1, sample_rate=16000):
    """Create a silent WAV file"""
    num_samples = int(sample_rate * duration)

    with wave.open(filename, 'w') as wav_file:
        wav_file.setparams((1, 2, sample_rate, num_samples, 'NONE', 'not compressed'))

        # Write silence (zeros)
        silent_data = struct.pack('<h', 0)
        for _ in range(num_samples):
            wav_file.writeframes(silent_data)

    print(f"✓ Created {filename} ({duration}s silence)")

if __name__ == "__main__":
    print("=== Simple WAV Generator (Python stdlib only) ===\n")

    # Create test files
    create_silence("sample-silence-1s.wav", duration=1)
    create_wav("sample-tone-440hz-2s.wav", frequency=440, duration=2)
    create_wav("sample-tone-200hz-1s.wav", frequency=200, duration=1)

    print("\n✓ Generated 3 test WAV files")
    print("\nNote: These contain no speech, just tones/silence.")
    print("For Portuguese speech, run one of these on a machine with internet:")
    print("  1. python3 generate-portuguese-sample.py  (requires: pip install gtts)")
    print("  2. Open https://ttsmp3.com, select Portuguese, generate & download")
    print("\nTest with Whisper API:")
    print("  ./test-whisper-api.sh sample-silence-1s.wav")
