#!/usr/bin/env python3
"""Transcribe a YouTube video with Deepgram (CLI).

Downloads audio with yt-dlp and transcribes via Deepgram's pre-recorded API.
Core logic lives in transcribe_core.py (shared with youtube-transcribe-service).

Usage:
    export DEEPGRAM_API_KEY=...
    ./transcribe.py "https://www.youtube.com/watch?v=VIDEO_ID" [--diarize] [--language en]
"""

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

import transcribe_core as core


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def get_api_key() -> str:
    load_dotenv(Path(__file__).parent / ".env")
    key = os.environ.get("DEEPGRAM_API_KEY")
    if not key:
        sys.exit("ERROR: DEEPGRAM_API_KEY is not set (export it or create a .env file)")
    return key


def main() -> None:
    parser = argparse.ArgumentParser(description="Transcribe a YouTube video with Deepgram.")
    parser.add_argument("url", help="YouTube video URL")
    parser.add_argument("--model", default="nova-3")
    parser.add_argument("--language", default=None)
    parser.add_argument("--diarize", action="store_true")
    parser.add_argument("--keep-audio", action="store_true")
    parser.add_argument("-o", "--output-dir", default="output")
    args = parser.parse_args()

    api_key = get_api_key()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    params = {"model": args.model, "smart_format": "true", "punctuate": "true", "paragraphs": "true"}
    if args.diarize:
        params["diarize"] = "true"
    if args.language:
        params["language"] = args.language
    else:
        params["detect_language"] = "true"

    workdir = Path(tempfile.mkdtemp(prefix="yt-transcribe-"))
    try:
        print("[1/3] Downloading audio with yt-dlp ...", flush=True)
        audio = core.download_audio(args.url, workdir)
        size_mb = audio.stat().st_size / 1_048_576
        print(f"[2/3] Uploading {size_mb:.1f} MB to Deepgram ({args.model}) ...", flush=True)
        result = core.deepgram_transcribe(audio, api_key, params)

        print("[3/3] Saving transcript ...", flush=True)
        transcript = core.extract_transcript(result, args.diarize)
        base = output_dir / "transcript"
        base.with_suffix(".txt").write_text(transcript + "\n", encoding="utf-8")
        base.with_suffix(".json").write_text(json.dumps(result, indent=2), encoding="utf-8")
        lang = core.detected_language(result, args.language or "unknown")
        duration = result.get("metadata", {}).get("duration", 0)
        print(f"\nDone. language={lang}  audio={duration:.0f}s\n  {base.with_suffix('.txt')}\n  {base.with_suffix('.json')}")
    finally:
        for f in workdir.glob("*"):
            f.unlink()
        workdir.rmdir()


if __name__ == "__main__":
    main()
