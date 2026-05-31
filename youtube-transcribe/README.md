# youtube-transcribe

Transcribe a YouTube video with [Deepgram](https://deepgram.com/).

Pipeline: `yt-dlp` downloads the audio → the bytes are POSTed to Deepgram's
pre-recorded API (`nova-3`) → a plain-text transcript and the full JSON
response are saved to `output/`.

Pure Python standard library — nothing to `pip install`.

## Setup

Requires `yt-dlp` and `ffmpeg` on PATH (already installed on this host).

```bash
cd youtube-transcribe
cp .env.example .env
# edit .env and paste your Deepgram API key
```

## Usage

```bash
./transcribe.py "https://www.youtube.com/watch?v=VIDEO_ID"
```

Options:

```bash
--model nova-3        # Deepgram model (default: nova-3)
--language en         # force a language (default: auto-detect). Use "multi" for code-switching
--diarize             # label speakers (Speaker 0, Speaker 1, ...)
--keep-audio          # keep the downloaded audio file
-o, --output-dir DIR  # where to write results (default: output/)
```

Example with speaker labels:

```bash
./transcribe.py "https://www.youtube.com/watch?v=VIDEO_ID" --diarize --keep-audio
```

## Output

- `output/transcript.txt` — readable transcript (paragraphs, or `Speaker N:` lines with `--diarize`)
- `output/transcript.json` — full Deepgram response (timestamps, word confidences, etc.)

## Security

The API key is read from the `DEEPGRAM_API_KEY` environment variable or a local
`.env` file. `.env` is git-ignored — never commit your key.
