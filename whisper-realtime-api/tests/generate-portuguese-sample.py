#!/usr/bin/env python3
"""
Generate sample Portuguese audio for testing Whisper API

Requirements:
  pip install gtts pydub

Usage:
  python3 generate-portuguese-sample.py
"""

import sys

try:
    from gtts import gTTS
    import tempfile
    import os
except ImportError:
    print("Error: Required packages not installed")
    print("Install with: pip install gtts pydub")
    sys.exit(1)

# Sample Portuguese texts for testing
SAMPLES = {
    "short": "Olá, este é um teste de transcrição de áudio em português.",
    "medium": "Bem-vindo ao sistema de transcrição de áudio. Este é um exemplo de fala em português brasileiro para testar o reconhecimento de voz usando o modelo Whisper.",
    "long": "A inteligência artificial está transformando a maneira como interagimos com a tecnologia. Sistemas de reconhecimento de voz como o Whisper permitem transcrever áudio com alta precisão em diversos idiomas, incluindo o português. Esta é uma amostra de áudio gerada automaticamente para fins de teste."
}

def generate_audio(text, output_file, language='pt', tld='com.br'):
    """Generate Portuguese audio using Google TTS"""
    try:
        print(f"Generating audio: '{text[:50]}...'")
        tts = gTTS(text=text, lang=language, tld=tld, slow=False)
        tts.save(output_file)
        print(f"✓ Saved to: {output_file}")

        # Get file size
        size_kb = os.path.getsize(output_file) / 1024
        print(f"  File size: {size_kb:.1f} KB")

        return True
    except Exception as e:
        print(f"✗ Error generating audio: {e}")
        return False

def main():
    print("=== Portuguese Audio Sample Generator ===\n")

    # Generate all samples
    success_count = 0
    for name, text in SAMPLES.items():
        output_file = f"sample-pt-{name}.mp3"
        if generate_audio(text, output_file):
            success_count += 1
        print()

    print(f"Generated {success_count}/{len(SAMPLES)} samples\n")

    if success_count > 0:
        print("Test with:")
        print("  ./test-whisper-api.sh sample-pt-short.mp3")
        print("  curl -X POST http://10.1.1.218:8000/transcribe \\")
        print("    -F 'file=@sample-pt-medium.mp3' \\")
        print("    -F 'language=pt'")

if __name__ == "__main__":
    main()
