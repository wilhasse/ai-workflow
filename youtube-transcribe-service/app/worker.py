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
