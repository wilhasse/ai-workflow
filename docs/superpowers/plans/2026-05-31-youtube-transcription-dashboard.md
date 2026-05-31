# YouTube Transcription in the Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user paste a YouTube URL into a new "Transcripts" view in the terminal dashboard, transcribe the audio via Deepgram, store the result in Apache Doris, and list past transcriptions with status and full text.

**Architecture:** A new Python/FastAPI service (`youtube-transcribe-service`, port 5005) reuses the proven core of `youtube-transcribe/transcribe.py` (yt-dlp download + Deepgram + DoH IP-pinning), writes to Doris (`agent_history` DB, new `youtube_transcripts` table), and exposes a small REST API. The dashboard gets a Terminals/Transcripts header toggle and a Transcripts view that talks to the service through an nginx `/api/transcribe/` proxy. A single background worker processes one job at a time.

**Tech Stack:** Python 3.11, FastAPI, uvicorn, pymysql (Doris speaks MySQL wire protocol), yt-dlp, ffmpeg, React (Vite), nginx, Docker Compose.

**Design doc:** `docs/superpowers/specs/2026-05-31-youtube-transcription-dashboard-design.md`

---

## File Structure

**Refactor (shared core, stdlib-only):**
- `youtube-transcribe/transcribe_core.py` — NEW. Canonical transcription core: DoH IP resolution, `PinnedHTTPSConnection`, audio download, metadata fetch, `video_id_from_url`, Deepgram call, transcript extraction.
- `youtube-transcribe/transcribe.py` — MODIFY. CLI now imports from `transcribe_core`.
- `youtube-transcribe/tests/test_transcribe_core.py` — NEW. Unit tests for pure functions.

**New backend service `youtube-transcribe-service/`:**
- `app/__init__.py` — empty package marker.
- `app/config.py` — env-driven config (Deepgram key, Doris connection, port).
- `app/db.py` — Doris client: schema bootstrap, upsert/get/list/recover.
- `app/worker.py` — asyncio queue + single background worker + job processing.
- `app/main.py` — FastAPI app, lifespan wiring, REST routes.
- `requirements.txt`, `Dockerfile`, `README.md`.
- `tests/test_db.py`, `tests/test_routes.py` — unit tests with fakes/mocks.

**Dashboard:**
- `terminal-dashboard/src/api/transcribe.js` — NEW. REST client for `/api/transcribe/*`.
- `terminal-dashboard/src/hooks/useTranscripts.js` — NEW. List state + polling.
- `terminal-dashboard/src/components/transcripts/TranscriptsView.jsx` — NEW. Submit box + list + detail.
- `terminal-dashboard/src/App.jsx` — MODIFY. `mainView` state, header toggle, render TranscriptsView.
- `terminal-dashboard/src/App.css` — MODIFY. Minimal styles.

**Infra:**
- `nginx/nginx.conf` — MODIFY. Add `location /api/transcribe/`.
- `docker-compose.yml` and `docker-compose.10.1.0.10.yml` — MODIFY. Add the service.
- `.env.production` (and local `.env`) — MODIFY. Add `DORIS_*` vars.

**Note on Docker build context:** the service image needs `youtube-transcribe/transcribe_core.py`, which lives outside its own folder. The service's compose entry therefore uses `context: .` (repo root) with `dockerfile: youtube-transcribe-service/Dockerfile`, so the Dockerfile can `COPY youtube-transcribe/transcribe_core.py`. This keeps one canonical core.

---

## Task 1: Extract the shared transcription core

**Files:**
- Create: `youtube-transcribe/transcribe_core.py`
- Modify: `youtube-transcribe/transcribe.py`
- Test: `youtube-transcribe/tests/test_transcribe_core.py`

- [ ] **Step 1: Write the failing tests**

Create `youtube-transcribe/tests/test_transcribe_core.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import transcribe_core as core


def test_video_id_from_standard_watch_url():
    assert core.video_id_from_url("https://www.youtube.com/watch?v=q9xD36NCtZ8") == "q9xD36NCtZ8"


def test_video_id_from_short_url():
    assert core.video_id_from_url("https://youtu.be/q9xD36NCtZ8?si=abc") == "q9xD36NCtZ8"


def test_video_id_from_embed_and_extra_params():
    assert core.video_id_from_url("https://www.youtube.com/embed/q9xD36NCtZ8") == "q9xD36NCtZ8"
    assert core.video_id_from_url("https://m.youtube.com/watch?feature=x&v=q9xD36NCtZ8") == "q9xD36NCtZ8"


def test_video_id_from_invalid_url_returns_none():
    assert core.video_id_from_url("https://example.com/not-a-video") is None


def test_extract_transcript_uses_paragraphs():
    result = {
        "results": {
            "channels": [
                {
                    "alternatives": [
                        {
                            "transcript": "flat text",
                            "paragraphs": {"transcript": "nice paragraphs"},
                            "words": [],
                        }
                    ]
                }
            ]
        }
    }
    assert core.extract_transcript(result, diarize=False) == "nice paragraphs"


def test_extract_transcript_diarized_groups_speakers():
    result = {
        "results": {
            "channels": [
                {
                    "alternatives": [
                        {
                            "transcript": "",
                            "words": [
                                {"word": "hi", "punctuated_word": "Hi", "speaker": 0},
                                {"word": "there", "punctuated_word": "there", "speaker": 0},
                                {"word": "yo", "punctuated_word": "Yo", "speaker": 1},
                            ],
                        }
                    ]
                }
            ]
        }
    }
    out = core.extract_transcript(result, diarize=True)
    assert out == "Speaker 0: Hi there\nSpeaker 1: Yo"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd youtube-transcribe && python3 -m pytest tests/test_transcribe_core.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'transcribe_core'`

- [ ] **Step 3: Create `transcribe_core.py` by moving the core out of `transcribe.py`**

Create `youtube-transcribe/transcribe_core.py`:

```python
"""Shared, dependency-free transcription core.

Used by both the CLI (transcribe.py) and youtube-transcribe-service. Only the
Python standard library is used here so the module can be vendored into the
service image without extra installs. yt-dlp/ffmpeg are invoked as subprocesses.
"""

import http.client
import json
import re
import socket
import ssl
import subprocess
import urllib.parse
import urllib.request
from pathlib import Path

DEEPGRAM_HOST = "api.deepgram.com"
DEEPGRAM_PATH = "/v1/listen"
DOH_URL = "https://dns.google/resolve"

_VIDEO_ID_RE = re.compile(r"(?:v=|/embed/|youtu\.be/|/v/|/shorts/)([0-9A-Za-z_-]{11})")


def video_id_from_url(url: str) -> str | None:
    """Extract the 11-char YouTube id from common URL shapes. No network."""
    match = _VIDEO_ID_RE.search(url or "")
    return match.group(1) if match else None


def resolve_pool(host: str, doh_samples: int = 15) -> list:
    """Collect the full set of A records for `host`.

    Deepgram hands out one rotating A record per query and the local resolver
    caches it for the TTL, so a single lookup only sees one IP. Querying a
    DNS-over-HTTPS endpoint repeatedly bypasses the cache and samples the whole
    rotation. Local resolution is merged in as a fallback if DoH is blocked."""
    pool = []
    for _ in range(doh_samples):
        try:
            url = f"{DOH_URL}?{urllib.parse.urlencode({'name': host, 'type': 'A'})}"
            with urllib.request.urlopen(url, timeout=10) as response:
                answers = json.load(response).get("Answer", [])
            for answer in answers:
                ip = answer.get("data")
                if answer.get("type") == 1 and ip and ip not in pool:
                    pool.append(ip)
        except Exception:
            break
    for _ in range(6):
        try:
            ip = socket.gethostbyname(host)
            if ip not in pool:
                pool.append(ip)
        except socket.gaierror:
            break
    return pool


def reachable_ip(host: str, port: int = 443, connect_timeout: int = 5) -> str:
    """First IP from the resolved pool that accepts a TCP connection."""
    pool = resolve_pool(host)
    if not pool:
        raise RuntimeError(f"could not resolve {host} (DNS and DoH both failed)")
    dead = []
    for ip in pool:
        try:
            socket.create_connection((ip, port), timeout=connect_timeout).close()
            return ip
        except OSError:
            dead.append(ip)
    raise RuntimeError(
        f"none of the resolved {host} IPs accept connections from this network "
        f"({', '.join(pool)}); routing/firewall issue on this host"
    )


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS connection dialed to a fixed IP while keeping SNI, cert hostname,
    and the Host header on the real hostname."""

    def __init__(self, hostname: str, ip: str, **kwargs):
        self._ssl_context = ssl.create_default_context()
        super().__init__(hostname, 443, context=self._ssl_context, **kwargs)
        self._ip = ip

    def connect(self):
        sock = socket.create_connection((self._ip, self.port), self.timeout)
        if self._tunnel_host:
            self.sock = sock
            self._tunnel()
        self.sock = self._ssl_context.wrap_socket(sock, server_hostname=self.host)


def fetch_metadata(url: str) -> dict:
    """Return {video_id, title, channel, duration_seconds} via yt-dlp (network)."""
    proc = subprocess.run(
        ["yt-dlp", "--no-warnings", "--skip-download", "--no-playlist",
         "--print", "%(id)s\t%(title)s\t%(channel)s\t%(duration)s", url],
        capture_output=True, text=True, check=True,
    )
    parts = proc.stdout.strip().split("\t")
    while len(parts) < 4:
        parts.append("")
    vid, title, channel, duration = parts[:4]
    try:
        duration_seconds = int(float(duration))
    except (TypeError, ValueError):
        duration_seconds = 0
    return {
        "video_id": vid or video_id_from_url(url),
        "title": title,
        "channel": channel,
        "duration_seconds": duration_seconds,
    }


def download_audio(url: str, workdir: Path) -> Path:
    """Download bestaudio as m4a via yt-dlp. Returns the audio file path."""
    out_template = str(workdir / "audio.%(ext)s")
    subprocess.run(
        ["yt-dlp", "-f", "bestaudio/best", "-x", "--audio-format", "m4a",
         "--no-playlist", "-o", out_template, url],
        check=True,
    )
    files = list(workdir.glob("audio.*"))
    if not files:
        raise RuntimeError("yt-dlp produced no audio file")
    return files[0]


def deepgram_transcribe(audio_path: Path, api_key: str, params: dict) -> dict:
    """POST raw audio bytes to Deepgram and return the parsed JSON response."""
    query = urllib.parse.urlencode(params)
    ip = reachable_ip(DEEPGRAM_HOST)
    conn = PinnedHTTPSConnection(DEEPGRAM_HOST, ip, timeout=900)
    try:
        conn.request(
            "POST", f"{DEEPGRAM_PATH}?{query}",
            body=audio_path.read_bytes(),
            headers={
                "Host": DEEPGRAM_HOST,
                "Authorization": f"Token {api_key}",
                "Content-Type": "audio/m4a",
            },
        )
        response = conn.getresponse()
        body = response.read()
        if response.status != 200:
            raise RuntimeError(
                f"Deepgram HTTP {response.status}: {body.decode('utf-8', 'replace')[:500]}"
            )
        return json.loads(body)
    finally:
        conn.close()


def extract_transcript(result: dict, diarize: bool) -> str:
    """Pull readable text out of the Deepgram response."""
    channel = result["results"]["channels"][0]
    alt = channel["alternatives"][0]
    if diarize and alt.get("words"):
        lines, current_speaker, buffer = [], None, []
        for word in alt["words"]:
            speaker = word.get("speaker", 0)
            token = word.get("punctuated_word", word["word"])
            if speaker != current_speaker:
                if buffer:
                    lines.append(f"Speaker {current_speaker}: {' '.join(buffer)}")
                current_speaker, buffer = speaker, [token]
            else:
                buffer.append(token)
        if buffer:
            lines.append(f"Speaker {current_speaker}: {' '.join(buffer)}")
        return "\n".join(lines)
    paragraphs = alt.get("paragraphs", {}).get("transcript")
    return paragraphs if paragraphs else alt.get("transcript", "")


def detected_language(result: dict, fallback: str = "unknown") -> str:
    channel = result["results"]["channels"][0]
    meta = result.get("metadata", {})
    return channel.get("detected_language") or meta.get("language") or fallback
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd youtube-transcribe && python3 -m pytest tests/test_transcribe_core.py -v`
Expected: PASS (6 passed)

- [ ] **Step 5: Rewrite `transcribe.py` to use the core**

Replace the body of `youtube-transcribe/transcribe.py` so it keeps the CLI/`.env`/argparse/output logic but imports the moved functions. The new file:

```python
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
```

- [ ] **Step 6: Verify the CLI still imports and shows help**

Run: `cd youtube-transcribe && python3 transcribe.py --help`
Expected: argparse help text prints, no ImportError.

- [ ] **Step 7: Commit**

```bash
git add youtube-transcribe/transcribe_core.py youtube-transcribe/transcribe.py youtube-transcribe/tests/test_transcribe_core.py
git commit -m "refactor: extract shared transcription core"
```

---

## Task 2: Service scaffold — config, requirements, health endpoint, Dockerfile

**Files:**
- Create: `youtube-transcribe-service/app/__init__.py`
- Create: `youtube-transcribe-service/app/config.py`
- Create: `youtube-transcribe-service/requirements.txt`
- Create: `youtube-transcribe-service/app/main.py`
- Create: `youtube-transcribe-service/Dockerfile`
- Create: `youtube-transcribe-service/.dockerignore`

- [ ] **Step 1: Create the config module**

Create `youtube-transcribe-service/app/config.py`:

```python
import os


class Config:
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "5005"))
    deepgram_api_key = os.environ.get("DEEPGRAM_API_KEY", "")
    model = os.environ.get("DEEPGRAM_STT_MODEL", "nova-3")
    doris = {
        "host": os.environ.get("DORIS_HOST", "10.1.0.7"),
        "port": int(os.environ.get("DORIS_PORT", "9030")),
        "user": os.environ.get("DORIS_USER", "root"),
        "password": os.environ.get("DORIS_PASSWORD", ""),
        "database": os.environ.get("DORIS_DATABASE", "agent_history"),
    }


config = Config()
```

- [ ] **Step 2: Create requirements and package marker**

Create `youtube-transcribe-service/app/__init__.py` (empty).

Create `youtube-transcribe-service/requirements.txt`:

```
fastapi==0.115.2
uvicorn[standard]==0.30.6
pymysql==1.1.1
```

- [ ] **Step 3: Create a minimal FastAPI app with /health**

Create `youtube-transcribe-service/app/main.py`:

```python
from fastapi import FastAPI

from .config import config

app = FastAPI(title="youtube-transcribe-service")


@app.get("/health")
def health():
    return {"ok": True, "service": "youtube-transcribe-service"}
```

- [ ] **Step 4: Verify the app boots locally**

Run: `cd youtube-transcribe-service && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt && python3 -c "from app.main import app; print('import ok')"`
Expected: prints `import ok` with no errors. (Deactivate after: `deactivate`.)

- [ ] **Step 5: Create the Dockerfile**

Create `youtube-transcribe-service/Dockerfile` (build context is the repo root; see File Structure note):

```dockerfile
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY youtube-transcribe-service/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Shared transcription core (canonical copy lives in youtube-transcribe/)
COPY youtube-transcribe/transcribe_core.py ./transcribe_core.py
COPY youtube-transcribe-service/app ./app

EXPOSE 5005

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "5005"]
```

Create `youtube-transcribe-service/.dockerignore`:

```
.venv
__pycache__
*.pyc
tests
output
```

- [ ] **Step 6: Commit**

```bash
git add youtube-transcribe-service/app/__init__.py youtube-transcribe-service/app/config.py youtube-transcribe-service/app/main.py youtube-transcribe-service/requirements.txt youtube-transcribe-service/Dockerfile youtube-transcribe-service/.dockerignore
git commit -m "feat: scaffold youtube-transcribe-service with health endpoint"
```

---

## Task 3: Doris persistence layer

**Files:**
- Create: `youtube-transcribe-service/app/db.py`
- Test: `youtube-transcribe-service/tests/test_db.py`

`transcribe_core.py` is imported as a top-level module in the image (`COPY ... ./transcribe_core.py`), so service code uses `import transcribe_core`. For local test runs, tests add `youtube-transcribe/` to `sys.path`.

- [ ] **Step 1: Write failing tests for row mapping and SQL building**

Create `youtube-transcribe-service/tests/test_db.py`:

```python
from app import db


def test_row_to_dict_serializes_datetimes():
    from datetime import datetime
    row = {
        "video_id": "abc", "url": "u", "title": "t", "channel": "c",
        "duration_seconds": 10, "language": "en", "model": "nova-3",
        "status": "done", "error": None, "transcript_text": "hi",
        "created_at": datetime(2026, 5, 31, 12, 0, 0),
        "updated_at": datetime(2026, 5, 31, 12, 1, 0),
    }
    out = db.row_to_dict(row)
    assert out["video_id"] == "abc"
    assert out["created_at"] == "2026-05-31T12:00:00"
    assert out["updated_at"] == "2026-05-31T12:01:00"


def test_row_to_dict_handles_none_datetimes():
    out = db.row_to_dict({"video_id": "x", "created_at": None, "updated_at": None})
    assert out["created_at"] is None
    assert out["updated_at"] is None


def test_upsert_sql_lists_all_columns():
    sql = db.UPSERT_SQL
    for col in ("video_id", "url", "title", "channel", "duration_seconds",
                "language", "model", "status", "error", "transcript_text",
                "created_at", "updated_at"):
        assert col in sql
    assert sql.count("%s") == 12
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd youtube-transcribe-service && . .venv/bin/activate && pip install pytest && python3 -m pytest tests/test_db.py -v`
Expected: FAIL — `AttributeError: module 'app.db' has no attribute 'row_to_dict'`

- [ ] **Step 3: Implement the Doris client**

Create `youtube-transcribe-service/app/db.py`:

```python
from datetime import datetime

import pymysql
from pymysql.cursors import DictCursor

from .config import config

COLUMNS = [
    "video_id", "url", "title", "channel", "duration_seconds", "language",
    "model", "status", "error", "transcript_text", "created_at", "updated_at",
]

UPSERT_SQL = (
    "INSERT INTO youtube_transcripts ("
    + ", ".join(COLUMNS)
    + ") VALUES (" + ", ".join(["%s"] * len(COLUMNS)) + ")"
)

DDL = """
CREATE TABLE IF NOT EXISTS youtube_transcripts (
    video_id         VARCHAR(32)   NOT NULL,
    url              VARCHAR(512)  DEFAULT NULL,
    title            STRING        DEFAULT NULL,
    channel          STRING        DEFAULT NULL,
    duration_seconds INT           NOT NULL DEFAULT 0,
    language         VARCHAR(16)   DEFAULT NULL,
    model            VARCHAR(32)   DEFAULT NULL,
    status           VARCHAR(16)   NOT NULL DEFAULT 'queued',
    error            STRING        DEFAULT NULL,
    transcript_text  STRING        DEFAULT NULL,
    created_at       DATETIME      NOT NULL,
    updated_at       DATETIME      NOT NULL,
    INDEX idx_transcript_text (transcript_text) USING INVERTED PROPERTIES("parser" = "unicode", "support_phrase" = "true")
)
UNIQUE KEY(video_id)
DISTRIBUTED BY HASH(video_id) BUCKETS 4
PROPERTIES ("replication_num" = "1")
"""


def connect():
    return pymysql.connect(
        host=config.doris["host"], port=config.doris["port"],
        user=config.doris["user"], password=config.doris["password"],
        database=config.doris["database"], cursorclass=DictCursor,
        charset="utf8mb4", autocommit=True, read_timeout=60, write_timeout=60,
    )


def check_connection() -> bool:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1")
        cur.fetchone()
    return True


def ensure_schema() -> None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(DDL)


def row_to_dict(row: dict) -> dict:
    out = dict(row)
    for key in ("created_at", "updated_at"):
        value = out.get(key)
        out[key] = value.isoformat() if isinstance(value, datetime) else value
    return out


def upsert(record: dict) -> None:
    values = [record.get(col) for col in COLUMNS]
    with connect() as conn, conn.cursor() as cur:
        cur.execute(UPSERT_SQL, values)


def get(video_id: str) -> dict | None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT * FROM youtube_transcripts WHERE video_id = %s", (video_id,))
        row = cur.fetchone()
    return row_to_dict(row) if row else None


def list_recent(limit: int = 100) -> list:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT * FROM youtube_transcripts ORDER BY created_at DESC LIMIT %s", (limit,))
        rows = cur.fetchall()
    return [row_to_dict(r) for r in rows]


def recover_pending() -> list:
    """On startup: return queued video_ids to re-enqueue; mark orphaned
    'processing' rows as failed (their temp audio is gone)."""
    now = datetime.now()
    requeue = []
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT * FROM youtube_transcripts WHERE status IN ('queued', 'processing')")
        rows = cur.fetchall()
    for row in rows:
        if row["status"] == "queued":
            requeue.append(row["video_id"])
        else:
            failed = dict(row)
            failed["status"] = "failed"
            failed["error"] = "Interrupted by service restart"
            failed["updated_at"] = now
            upsert(failed)
    return requeue
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd youtube-transcribe-service && . .venv/bin/activate && python3 -m pytest tests/test_db.py -v`
Expected: PASS (3 passed). (These tests touch no live DB.)

- [ ] **Step 5: Commit**

```bash
git add youtube-transcribe-service/app/db.py youtube-transcribe-service/tests/test_db.py
git commit -m "feat: add Doris persistence for youtube transcripts"
```

---

## Task 4: Background worker and job lifecycle

**Files:**
- Create: `youtube-transcribe-service/app/worker.py`
- Test: `youtube-transcribe-service/tests/test_worker.py`

- [ ] **Step 1: Write a failing test for the synchronous job processor**

The worker's per-job logic is factored into a pure-ish `process_job(video_id, deps)` so it can be tested with fakes (no network, no DB, no asyncio).

Create `youtube-transcribe-service/tests/test_worker.py`:

```python
from pathlib import Path

from app import worker


class FakeStore:
    def __init__(self, initial):
        self.rows = {r["video_id"]: dict(r) for r in initial}
    def get(self, vid):
        return self.rows.get(vid)
    def upsert(self, record):
        self.rows[record["video_id"]] = dict(record)


def make_deps(store, *, transcript="hello world", raise_on=None):
    def fetch_metadata(url):
        return {"video_id": "vid", "title": "T", "channel": "C", "duration_seconds": 42}
    def download_audio(url, workdir):
        p = Path(workdir) / "audio.m4a"
        p.write_bytes(b"x")
        return p
    def deepgram_transcribe(path, key, params):
        if raise_on == "deepgram":
            raise RuntimeError("Deepgram HTTP 401: bad key")
        return {"results": {"channels": [{"alternatives": [{"transcript": transcript}]}]},
                "metadata": {"duration": 42}}
    return worker.Deps(
        store_get=store.get, store_upsert=store.upsert,
        fetch_metadata=fetch_metadata, download_audio=download_audio,
        deepgram_transcribe=deepgram_transcribe, api_key="k", model="nova-3",
    )


def test_process_job_success_marks_done_with_text():
    store = FakeStore([{"video_id": "vid", "url": "u", "status": "queued"}])
    worker.process_job("vid", make_deps(store))
    row = store.get("vid")
    assert row["status"] == "done"
    assert row["transcript_text"] == "hello world"
    assert row["title"] == "T"
    assert row["duration_seconds"] == 42


def test_process_job_failure_marks_failed_with_error():
    store = FakeStore([{"video_id": "vid", "url": "u", "status": "queued"}])
    worker.process_job("vid", make_deps(store, raise_on="deepgram"))
    row = store.get("vid")
    assert row["status"] == "failed"
    assert "Deepgram HTTP 401" in row["error"]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd youtube-transcribe-service && . .venv/bin/activate && python3 -m pytest tests/test_worker.py -v`
Expected: FAIL — `AttributeError: module 'app.worker' has no attribute 'Deps'`

- [ ] **Step 3: Implement the worker**

Create `youtube-transcribe-service/app/worker.py`:

```python
import asyncio
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable

import transcribe_core as core

from . import db
from .config import config


@dataclass
class Deps:
    store_get: Callable
    store_upsert: Callable
    fetch_metadata: Callable
    download_audio: Callable
    deepgram_transcribe: Callable
    api_key: str
    model: str


def _default_deps() -> Deps:
    return Deps(
        store_get=db.get, store_upsert=db.upsert,
        fetch_metadata=core.fetch_metadata, download_audio=core.download_audio,
        deepgram_transcribe=core.deepgram_transcribe,
        api_key=config.deepgram_api_key, model=config.model,
    )


def process_job(video_id: str, deps: Deps) -> None:
    """Run one transcription synchronously and persist the outcome."""
    row = deps.store_get(video_id) or {"video_id": video_id, "created_at": datetime.now()}
    row = dict(row)
    row["status"] = "processing"
    row["updated_at"] = datetime.now()
    deps.store_upsert(row)

    workdir = Path(tempfile.mkdtemp(prefix="yt-svc-"))
    try:
        meta = deps.fetch_metadata(row.get("url") or video_id)
        row.update({k: meta[k] for k in ("title", "channel", "duration_seconds") if k in meta})
        audio = deps.download_audio(row.get("url") or video_id, workdir)
        params = {"model": deps.model, "smart_format": "true", "punctuate": "true",
                  "paragraphs": "true", "detect_language": "true"}
        result = deps.deepgram_transcribe(audio, deps.api_key, params)
        row["transcript_text"] = core.extract_transcript(result, diarize=False)
        row["language"] = core.detected_language(result)
        row["model"] = deps.model
        row["status"] = "done"
        row["error"] = None
    except Exception as exc:  # noqa: BLE001 — record any failure for the user
        row["status"] = "failed"
        row["error"] = str(exc)
    finally:
        row["updated_at"] = datetime.now()
        deps.store_upsert(row)
        for f in workdir.glob("*"):
            f.unlink()
        workdir.rmdir()


class JobQueue:
    """Single-worker async queue. Jobs run one at a time in a thread so blocking
    yt-dlp/Deepgram work never stalls the event loop."""

    def __init__(self):
        self._queue: asyncio.Queue = asyncio.Queue()
        self._task: asyncio.Task | None = None

    def start(self):
        self._task = asyncio.create_task(self._run())

    async def stop(self):
        if self._task:
            self._task.cancel()

    def enqueue(self, video_id: str):
        self._queue.put_nowait(video_id)

    async def _run(self):
        deps = _default_deps()
        while True:
            video_id = await self._queue.get()
            try:
                await asyncio.to_thread(process_job, video_id, deps)
            except Exception as exc:  # noqa: BLE001
                print(f"[worker] job {video_id} crashed: {exc}", flush=True)
            finally:
                self._queue.task_done()
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd youtube-transcribe-service && . .venv/bin/activate && python3 -m pytest tests/test_worker.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add youtube-transcribe-service/app/worker.py youtube-transcribe-service/tests/test_worker.py
git commit -m "feat: add single-worker job processor with failure handling"
```

---

## Task 5: REST routes and lifespan wiring

**Files:**
- Modify: `youtube-transcribe-service/app/main.py`
- Test: `youtube-transcribe-service/tests/test_routes.py`

- [ ] **Step 1: Write failing route tests**

Create `youtube-transcribe-service/tests/test_routes.py`:

```python
from fastapi.testclient import TestClient

import app.main as main


class FakeQueue:
    def __init__(self):
        self.enqueued = []
    def enqueue(self, vid):
        self.enqueued.append(vid)


def setup_function():
    main._STORE = {}
    main.queue = FakeQueue()
    main.db.get = lambda vid: main._STORE.get(vid)
    main.db.list_recent = lambda limit=100: list(main._STORE.values())
    def fake_upsert(record):
        main._STORE[record["video_id"]] = dict(record)
    main.db.upsert = fake_upsert


client = TestClient(main.app)


def test_post_job_rejects_bad_url():
    resp = client.post("/jobs", json={"url": "https://example.com/nope"})
    assert resp.status_code == 400


def test_post_job_enqueues_new_video():
    resp = client.post("/jobs", json={"url": "https://youtu.be/q9xD36NCtZ8"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["video_id"] == "q9xD36NCtZ8"
    assert body["status"] == "queued"
    assert "q9xD36NCtZ8" in main.queue.enqueued


def test_post_job_reuses_done_video_without_enqueue():
    main._STORE["q9xD36NCtZ8"] = {
        "video_id": "q9xD36NCtZ8", "status": "done", "transcript_text": "hi",
        "url": "https://youtu.be/q9xD36NCtZ8",
    }
    resp = client.post("/jobs", json={"url": "https://youtu.be/q9xD36NCtZ8"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "done"
    assert main.queue.enqueued == []


def test_get_jobs_lists_records():
    main._STORE["a"] = {"video_id": "a", "status": "done"}
    resp = client.get("/jobs")
    assert resp.status_code == 200
    assert any(j["video_id"] == "a" for j in resp.json())


def test_get_job_detail_404_when_missing():
    assert client.get("/jobs/missing").status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd youtube-transcribe-service && . .venv/bin/activate && python3 -m pytest tests/test_routes.py -v`
Expected: FAIL — routes `/jobs` do not exist yet (404/405).

- [ ] **Step 3: Implement routes + lifespan**

Replace `youtube-transcribe-service/app/main.py`:

```python
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

import transcribe_core as core

from . import db
from .config import config
from .worker import JobQueue

queue: JobQueue | None = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global queue
    db.ensure_schema()
    queue = JobQueue()
    queue.start()
    for video_id in db.recover_pending():
        queue.enqueue(video_id)
    yield
    if queue:
        await queue.stop()


app = FastAPI(title="youtube-transcribe-service", lifespan=lifespan)


class JobRequest(BaseModel):
    url: str


@app.get("/health")
def health():
    try:
        db.check_connection()
        return {"ok": True, "doris": "connected"}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=str(exc))


@app.post("/jobs")
def create_job(req: JobRequest):
    video_id = core.video_id_from_url(req.url)
    if not video_id:
        raise HTTPException(status_code=400, detail="Could not parse a YouTube video id from that URL")

    existing = db.get(video_id)
    if existing and existing["status"] in ("done", "processing", "queued"):
        return existing

    now = datetime.now()
    record = {
        "video_id": video_id, "url": req.url, "title": None, "channel": None,
        "duration_seconds": 0, "language": None, "model": config.model,
        "status": "queued", "error": None, "transcript_text": None,
        "created_at": now, "updated_at": now,
    }
    db.upsert(record)
    queue.enqueue(video_id)
    return db.get(video_id) or record


@app.get("/jobs")
def list_jobs():
    return db.list_recent()


@app.get("/jobs/{video_id}")
def get_job(video_id: str):
    row = db.get(video_id)
    if not row:
        raise HTTPException(status_code=404, detail="Transcript not found")
    return row
```

The route tests monkeypatch `main.db.*` and `main.queue`, so reuse short-circuits before any real DB/network call.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd youtube-transcribe-service && . .venv/bin/activate && python3 -m pytest tests/ -v`
Expected: PASS (all db, worker, and route tests green).

- [ ] **Step 5: Commit**

```bash
git add youtube-transcribe-service/app/main.py youtube-transcribe-service/tests/test_routes.py
git commit -m "feat: add transcript REST routes with dedup/reuse and recovery"
```

---

## Task 6: Wire the service into nginx and Docker Compose

**Files:**
- Modify: `nginx/nginx.conf`
- Modify: `docker-compose.yml`
- Modify: `docker-compose.10.1.0.10.yml`
- Modify: `.env.production`

- [ ] **Step 1: Add the nginx upstream + location**

In `nginx/nginx.conf`, after the `tmux_session_service` upstream block (around line 7), add:

```nginx
upstream youtube_transcribe_service {
    server youtube-transcribe-service:5005;
}
```

In the `server { listen 443 ... }` block, add this location **before** the `location /api/ {` catchall (nginx uses longest-prefix matching, but keep it above for clarity):

```nginx
    # YouTube transcription service
    location /api/transcribe/ {
        proxy_pass http://youtube_transcribe_service/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1200s;
        proxy_send_timeout 1200s;
    }
```

The trailing slash on `proxy_pass http://youtube_transcribe_service/;` strips the `/api/transcribe/` prefix, so the service sees `/jobs`, `/health`, etc.

- [ ] **Step 2: Add the service to `docker-compose.yml`**

In `docker-compose.yml`, add a new service after `tmux-session-service` (note `context: .` so the Dockerfile can read `youtube-transcribe/transcribe_core.py`):

```yaml
  # YouTube → Deepgram transcription service
  youtube-transcribe-service:
    build:
      context: .
      dockerfile: youtube-transcribe-service/Dockerfile
    container_name: ai-workflow-transcribe
    environment:
      - PORT=5005
      - HOST=0.0.0.0
      - DEEPGRAM_API_KEY=${DEEPGRAM_API_KEY:-}
      - DEEPGRAM_STT_MODEL=${DEEPGRAM_STT_MODEL:-nova-3}
      - DORIS_HOST=${DORIS_HOST:-10.1.0.7}
      - DORIS_PORT=${DORIS_PORT:-9030}
      - DORIS_USER=${DORIS_USER:-root}
      - DORIS_PASSWORD=${DORIS_PASSWORD:-}
      - DORIS_DATABASE=${DORIS_DATABASE:-agent_history}
    networks:
      - ai-workflow-network
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:5005/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
```

Then add `youtube-transcribe-service` to the `nginx` service's `depends_on` list.

- [ ] **Step 3: Mirror the service into the 10.1.0.10 variant**

Inspect `docker-compose.10.1.0.10.yml` and add the identical `youtube-transcribe-service` block (same env/build), matching that file's existing formatting and network name. If that file overrides `nginx`, add the service to its `depends_on` too.

Run: `grep -nE "services:|nginx:|tmux-session-service:|networks:" docker-compose.10.1.0.10.yml`
Use the output to place the block consistently.

- [ ] **Step 4: Add Doris env defaults to `.env.production`**

Append to `.env.production` (do NOT add `DEEPGRAM_API_KEY` here if it already exists elsewhere — keep the key out of committed files; it is provided via the existing env mechanism):

```
# Apache Doris (agent_history DB) for youtube-transcribe-service
DORIS_HOST=10.1.0.7
DORIS_PORT=9030
DORIS_USER=root
DORIS_PASSWORD=
DORIS_DATABASE=agent_history
```

- [ ] **Step 5: Validate compose config**

Run: `docker-compose config >/dev/null && echo "compose OK"`
Expected: prints `compose OK` (no YAML/interpolation errors).

- [ ] **Step 6: Commit**

```bash
git add nginx/nginx.conf docker-compose.yml docker-compose.10.1.0.10.yml .env.production
git commit -m "feat: wire youtube-transcribe-service into nginx and compose"
```

---

## Task 7: Dashboard API client and polling hook

**Files:**
- Create: `terminal-dashboard/src/api/transcribe.js`
- Create: `terminal-dashboard/src/hooks/useTranscripts.js`

- [ ] **Step 1: Create the API client**

Create `terminal-dashboard/src/api/transcribe.js`:

```javascript
// Base URL mirrors the page origin; nginx proxies /api/transcribe/* to the service.
const BASE = `${window.location.origin}/api/transcribe`

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const body = await res.json()
      detail = body.detail || detail
    } catch {
      // non-JSON error body; keep the status line
    }
    throw new Error(detail)
  }
  return res.json()
}

export function submitTranscript(url) {
  return request('/jobs', { method: 'POST', body: JSON.stringify({ url }) })
}

export function listTranscripts() {
  return request('/jobs')
}

export function getTranscript(videoId) {
  return request(`/jobs/${videoId}`)
}
```

- [ ] **Step 2: Create the polling hook**

Create `terminal-dashboard/src/hooks/useTranscripts.js`:

```javascript
import { useCallback, useEffect, useRef, useState } from 'react'
import { listTranscripts } from '../api/transcribe'

const POLL_MS = 3000
const ACTIVE = new Set(['queued', 'processing'])

export function useTranscripts(enabled) {
  const [items, setItems] = useState([])
  const [error, setError] = useState('')
  const timer = useRef(null)

  const refresh = useCallback(async () => {
    try {
      const rows = await listTranscripts()
      setItems(rows)
      setError('')
      return rows
    } catch (err) {
      setError(err.message)
      return []
    }
  }, [])

  useEffect(() => {
    if (!enabled) return undefined
    let cancelled = false

    const tick = async () => {
      const rows = await refresh()
      if (cancelled) return
      const anyActive = rows.some((r) => ACTIVE.has(r.status))
      if (anyActive) {
        timer.current = setTimeout(tick, POLL_MS)
      }
    }
    tick()

    return () => {
      cancelled = true
      if (timer.current) clearTimeout(timer.current)
    }
  }, [enabled, refresh])

  return { items, error, refresh, setItems }
}
```

- [ ] **Step 3: Verify the build compiles**

Run: `cd terminal-dashboard && npm run build`
Expected: build succeeds (these modules are imported in Task 8/9; this step just confirms no syntax errors once wired). If nothing imports them yet, run `npm run lint` instead and expect no errors for these files.

- [ ] **Step 4: Commit**

```bash
git add terminal-dashboard/src/api/transcribe.js terminal-dashboard/src/hooks/useTranscripts.js
git commit -m "feat: add dashboard transcribe API client and polling hook"
```

---

## Task 8: Transcripts view component

**Files:**
- Create: `terminal-dashboard/src/components/transcripts/TranscriptsView.jsx`

- [ ] **Step 1: Create the component**

Create `terminal-dashboard/src/components/transcripts/TranscriptsView.jsx`:

```javascript
import { useState } from 'react'
import { useTranscripts } from '../../hooks/useTranscripts'
import { getTranscript, submitTranscript } from '../../api/transcribe'

const STATUS_ICON = { done: '✓', processing: '⧗', queued: '⧗', failed: '✗' }

function formatDuration(seconds) {
  if (!seconds) return ''
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function TranscriptsView({ active }) {
  const { items, error, refresh, setItems } = useTranscripts(active)
  const [url, setUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [selected, setSelected] = useState(null)

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!url.trim()) return
    setSubmitting(true)
    setSubmitError('')
    try {
      const job = await submitTranscript(url.trim())
      setItems((prev) => [job, ...prev.filter((p) => p.video_id !== job.video_id)])
      setUrl('')
      refresh()
    } catch (err) {
      setSubmitError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const openDetail = async (videoId) => {
    try {
      setSelected(await getTranscript(videoId))
    } catch (err) {
      setSubmitError(err.message)
    }
  }

  return (
    <div className="transcripts-view">
      <form className="transcripts-form" onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="Paste a YouTube URL…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={submitting}
        />
        <button type="submit" disabled={submitting || !url.trim()}>
          {submitting ? 'Submitting…' : 'Transcribe'}
        </button>
      </form>
      {submitError && <div className="transcripts-error">{submitError}</div>}
      {error && <div className="transcripts-error">{error}</div>}

      <div className="transcripts-body">
        <ul className="transcripts-list">
          {items.length === 0 && <li className="transcripts-empty">No transcripts yet.</li>}
          {items.map((item) => (
            <li
              key={item.video_id}
              className={`transcripts-row ${selected?.video_id === item.video_id ? 'selected' : ''}`}
              onClick={() => openDetail(item.video_id)}
            >
              <span className={`status status-${item.status}`}>{STATUS_ICON[item.status] || '•'}</span>
              <span className="title">{item.title || item.url}</span>
              <span className="meta">
                {item.language || ''} {formatDuration(item.duration_seconds)}
              </span>
            </li>
          ))}
        </ul>

        {selected && (
          <div className="transcripts-detail">
            <div className="detail-header">
              <h3>{selected.title || selected.video_id}</h3>
              <a href={selected.url} target="_blank" rel="noreferrer">Open video ↗</a>
              <button type="button" onClick={() => navigator.clipboard.writeText(selected.transcript_text || '')}>
                Copy
              </button>
            </div>
            {selected.status === 'failed' && <div className="transcripts-error">{selected.error}</div>}
            <pre className="detail-text">{selected.transcript_text || '(no transcript yet)'}</pre>
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify lint passes**

Run: `cd terminal-dashboard && npm run lint`
Expected: no errors for the new file.

- [ ] **Step 3: Commit**

```bash
git add terminal-dashboard/src/components/transcripts/TranscriptsView.jsx
git commit -m "feat: add TranscriptsView component"
```

---

## Task 9: Header toggle + render integration + styles

**Files:**
- Modify: `terminal-dashboard/src/App.jsx`
- Modify: `terminal-dashboard/src/App.css`

- [ ] **Step 1: Import the view and add `mainView` state**

In `terminal-dashboard/src/App.jsx`, add the import near the other component imports (top of file, alongside line ~10 `import MobileLayout ...`):

```javascript
import TranscriptsView from './components/transcripts/TranscriptsView'
```

Add state next to `desktopView` (after line 205 `const [desktopView, setDesktopView] = useState('organizer')`):

```javascript
  const [mainView, setMainView] = useState(() => {
    if (typeof window === 'undefined') return 'terminals'
    return new URLSearchParams(window.location.search).get('view') === 'transcripts'
      ? 'transcripts'
      : 'terminals'
  })
```

- [ ] **Step 2: Persist `mainView` to the URL**

Add an effect near the other effects (anywhere after the state declarations, e.g. after the block ending at line ~281). It keeps `?view=` in sync without reloading:

```javascript
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (mainView === 'transcripts') params.set('view', 'transcripts')
    else params.delete('view')
    const query = params.toString()
    const next = `${window.location.pathname}${query ? `?${query}` : ''}`
    window.history.replaceState(null, '', next)
  }, [mainView])
```

- [ ] **Step 3: Add the header toggle button**

In the `<div className="header-right">` block (starts at line ~1613), add this as the FIRST control, before the existing Organize/Terminal button:

```javascript
          <button
            type="button"
            className={`secondary switcher-btn ${mainView === 'transcripts' ? 'active' : ''}`}
            onClick={() => setMainView((v) => (v === 'transcripts' ? 'terminals' : 'transcripts'))}
            title="Switch between terminals and YouTube transcripts"
          >
            {mainView === 'transcripts' ? 'Terminals' : 'Transcripts'}
          </button>
```

- [ ] **Step 4: Render the Transcripts view in `app-main`**

Replace the `<main className="app-main">` body (lines ~1668-1675) so the transcripts view takes over when active:

```javascript
      <main className="app-main">
        {mainView === 'transcripts' ? (
          <TranscriptsView active={mainView === 'transcripts'} />
        ) : desktopView === 'organizer' ? (
          <TerminalOrganizer
            tabs={terminalTabs}
            loading={terminalTabsLoading}
            errors={terminalTabErrors}
            saving={Boolean(terminalLabelSavingId)}
            onRefresh={loadTerminalTabs}
            onSaveLabels={handleSaveTerminalLabels}
          />
        ) : renderTerminalView()}
      </main>
```

- [ ] **Step 5: Add minimal styles**

Append to `terminal-dashboard/src/App.css`:

```css
/* YouTube transcripts view */
.transcripts-view { display: flex; flex-direction: column; height: 100%; padding: 1rem; gap: 0.75rem; }
.transcripts-form { display: flex; gap: 0.5rem; }
.transcripts-form input { flex: 1; padding: 0.5rem 0.75rem; }
.transcripts-error { color: #f87171; font-size: 0.85rem; }
.transcripts-body { display: flex; gap: 1rem; flex: 1; min-height: 0; }
.transcripts-list { list-style: none; margin: 0; padding: 0; width: 38%; overflow-y: auto; border-right: 1px solid rgba(255,255,255,0.1); }
.transcripts-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem; cursor: pointer; border-radius: 4px; }
.transcripts-row:hover, .transcripts-row.selected { background: rgba(255,255,255,0.08); }
.transcripts-row .title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.transcripts-row .meta { font-size: 0.75rem; opacity: 0.7; }
.transcripts-row .status-done { color: #4ade80; }
.transcripts-row .status-processing, .transcripts-row .status-queued { color: #fbbf24; }
.transcripts-row .status-failed { color: #f87171; }
.transcripts-empty { padding: 0.5rem; opacity: 0.6; }
.transcripts-detail { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.detail-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem; }
.detail-header h3 { flex: 1; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail-text { flex: 1; overflow-y: auto; white-space: pre-wrap; background: rgba(0,0,0,0.25); padding: 0.75rem; border-radius: 4px; }
```

- [ ] **Step 6: Build and lint**

Run: `cd terminal-dashboard && npm run lint && npm run build`
Expected: lint clean, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add terminal-dashboard/src/App.jsx terminal-dashboard/src/App.css
git commit -m "feat: add Terminals/Transcripts toggle and render transcripts view"
```

---

## Task 10: End-to-end verification and docs

**Files:**
- Create: `youtube-transcribe-service/README.md`
- Modify: `CLAUDE.md` (add the new service to the repo overview)

- [ ] **Step 1: Bring the stack up and check service health**

Run:
```bash
./rebuild-stack.sh youtube-transcribe-service nginx
docker-compose ps youtube-transcribe-service
curl -sk https://localhost/api/transcribe/health
```
Expected: container healthy; health returns `{"ok":true,"doris":"connected"}`. If Doris is unreachable, fix `DORIS_*` before continuing.

- [ ] **Step 2: Verify the Doris table was created**

Run:
```bash
docker-compose exec youtube-transcribe-service python3 -c "from app import db; db.ensure_schema(); print(db.list_recent())"
```
Expected: prints `[]` (empty list) with no error — confirms schema + connectivity.

- [ ] **Step 3: Submit a real transcription end-to-end**

Run:
```bash
curl -sk -X POST https://localhost/api/transcribe/jobs \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=q9xD36NCtZ8"}'
```
Expected: returns a job with `"status":"queued"` and `"video_id":"q9xD36NCtZ8"`.

Then poll until done:
```bash
sleep 90 && curl -sk https://localhost/api/transcribe/jobs/q9xD36NCtZ8 | head -c 400
```
Expected: `"status":"done"` with non-empty `transcript_text` and `"language":"en"`.

- [ ] **Step 4: Verify reuse (no duplicate work)**

Re-run the same POST from Step 3.
Expected: immediately returns the existing `"status":"done"` row (the worker queue is not re-triggered).

- [ ] **Step 5: Manual UI check**

Open `https://10.1.0.10` (or `https://localhost`), click the **Transcripts** toggle in the header. Verify:
- The list shows the `q9xD36NCtZ8` row marked done.
- Pasting a new URL adds a row that progresses ⧗ → ✓ via polling.
- Clicking a row shows the transcript, the Copy button works, and "Open video" links out.
- Toggling back to **Terminals** restores the terminal view; `?view=transcripts` appears/disappears in the URL.

- [ ] **Step 6: Write the service README**

Create `youtube-transcribe-service/README.md`:

```markdown
# youtube-transcribe-service

FastAPI service that transcribes a YouTube video with Deepgram and stores the
result in Apache Doris (`agent_history` DB, table `youtube_transcripts`). Backs
the dashboard's Transcripts view.

## Endpoints
- `POST /jobs` `{ "url": "<youtube-url>" }` — enqueue (or reuse) a transcription.
- `GET /jobs` — list recent transcripts (newest first).
- `GET /jobs/{video_id}` — one transcript with full text.
- `GET /health` — liveness + Doris connectivity.

A single background worker processes one job at a time: yt-dlp downloads the
audio, Deepgram (`nova-3`) transcribes it, the row advances
`queued → processing → done|failed`. Re-submitting a finished video returns the
existing row. Transcription core is shared with `../youtube-transcribe`.

## Config (env)
`DEEPGRAM_API_KEY`, `DORIS_HOST`, `DORIS_PORT`, `DORIS_USER`, `DORIS_PASSWORD`,
`DORIS_DATABASE`, `PORT` (default 5005).

## Tests
`python3 -m pytest tests/ -v`
```

- [ ] **Step 7: Update the repo overview**

In `CLAUDE.md`, add a bullet under the repository overview listing `youtube-transcribe-service/` (FastAPI · Deepgram → Doris · backs the dashboard Transcripts view) and note the dashboard's Terminals/Transcripts toggle.

- [ ] **Step 8: Commit**

```bash
git add youtube-transcribe-service/README.md CLAUDE.md
git commit -m "docs: document youtube-transcribe-service and dashboard transcripts"
```

---

## Self-Review Notes

- **Spec coverage:** new Python service (Tasks 2-5), Doris table with INVERTED index (Task 3), reuse/dedup (Task 5), single-worker + restart recovery (Tasks 4-5), dashboard toggle + view + polling (Tasks 7-9), nginx + compose + env (Task 6), error handling surfaced as `failed` rows / HTTP 400/503 (Tasks 4-5, 8), tests (Tasks 1,3,4,5), manual UI verification (Task 10). Out-of-scope items (diarization, search UI, :5003 surfacing, terminal-UX cleanup) are intentionally excluded.
- **Type/name consistency:** `video_id` is the identifier everywhere (table key, route param, React `key`). `db.get/upsert/list_recent/recover_pending/check_connection/ensure_schema`, `worker.Deps/process_job/JobQueue.enqueue`, and `core.video_id_from_url/fetch_metadata/download_audio/deepgram_transcribe/extract_transcript/detected_language` are referenced with identical names across tasks. Status vocabulary is fixed: `queued|processing|done|failed`.
- **No placeholders:** every code/command step contains runnable content.
```
