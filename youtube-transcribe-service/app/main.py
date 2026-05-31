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
