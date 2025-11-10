import asyncio
import json
import os
import tempfile
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile, status
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from faster_whisper import WhisperModel
from pydantic import BaseModel


MAX_AUDIO_BYTES = int(os.getenv("WHISPER_MAX_AUDIO_BYTES", 60 * 1024 * 1024))


class Segment(BaseModel):
    id: int
    start: float
    end: float
    text: str
    avg_log_prob: Optional[float] = None
    no_speech_prob: Optional[float] = None


class TranscriptionResponse(BaseModel):
    text: str
    language: str
    duration: float
    segments: List[Segment]


BASE_DIR = Path(__file__).resolve().parent

app = FastAPI(title="Whisper Realtime API", version="0.1.0")
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


def _initial_compute_type(device: str) -> str:
    if device == "cuda":
        return os.getenv("WHISPER_COMPUTE_TYPE", "float16")
    return os.getenv("WHISPER_COMPUTE_TYPE", "int8_float16")


def _load_index_html() -> str:
    index_path = BASE_DIR / "static" / "index.html"
    try:
        return index_path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:  # pragma: no cover
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Index page missing") from exc


@app.on_event("startup")
async def load_model() -> None:
    model_size = os.getenv("WHISPER_MODEL_SIZE", "medium")
    device = os.getenv("WHISPER_DEVICE", "cuda")
    compute_type = _initial_compute_type(device)

    try:
        app.state.model = WhisperModel(
            model_size,
            device=device,
            compute_type=compute_type,
            download_root=os.getenv("WHISPER_DOWNLOAD_ROOT"),
        )
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("Failed to load Whisper model") from exc


@app.on_event("shutdown")
async def cleanup_model() -> None:
    if hasattr(app.state, "model"):
        delattr(app.state, "model")


def get_model() -> WhisperModel:
    model = getattr(app.state, "model", None)
    if model is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Model is not ready")
    return model


async def _save_upload_temporarily(upload: UploadFile) -> str:
    content = await upload.read()
    if not content:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty audio payload")
    if len(content) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Audio payload exceeds limit")

    suffix = Path(upload.filename or "audio").suffix or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(content)
        return tmp.name


async def _run_transcription(
    audio_path: str,
    *,
    language: Optional[str],
    task: str,
    vad_filter: bool,
) -> TranscriptionResponse:
    model = get_model()

    def worker() -> TranscriptionResponse:
        segments_iter, info = model.transcribe(
            audio_path,
            language=language,
            task=task,
            vad_filter=vad_filter,
            beam_size=int(os.getenv("WHISPER_BEAM_SIZE", "5")),
        )

        segments: List[Segment] = []
        accumulated = []
        for segment in segments_iter:
            text = segment.text.strip()
            accumulated.append(text)
            segments.append(
                Segment(
                    id=segment.id,
                    start=segment.start,
                    end=segment.end,
                    text=text,
                    avg_log_prob=segment.avg_log_prob,
                    no_speech_prob=segment.no_speech_prob,
                )
            )

        transcript = " ".join(accumulated).strip()

        return TranscriptionResponse(
            text=transcript,
            language=info.language,
            duration=info.duration,
            segments=segments,
        )

    return await asyncio.to_thread(worker)


@app.get("/health", tags=["system"])
async def healthcheck() -> JSONResponse:
    model_loaded = hasattr(app.state, "model")
    return JSONResponse(content={"status": "ok" if model_loaded else "loading"})


@app.get("/", response_class=HTMLResponse, tags=["ui"])
async def index() -> HTMLResponse:
    return HTMLResponse(content=_load_index_html())


@app.post("/transcribe", response_model=TranscriptionResponse, tags=["transcription"])
async def transcribe(
    file: UploadFile = File(...),
    language: Optional[str] = None,
    translate: bool = False,
    vad_filter: bool = True,
) -> TranscriptionResponse:
    audio_path = await _save_upload_temporarily(file)
    try:
        task = "translate" if translate else "transcribe"
        return await _run_transcription(audio_path, language=language, task=task, vad_filter=vad_filter)
    finally:
        if os.path.exists(audio_path):
            os.remove(audio_path)


@app.post("/transcribe/stream", tags=["transcription"])
async def transcribe_stream(
    file: UploadFile = File(...),
    language: Optional[str] = None,
    translate: bool = False,
    vad_filter: bool = True,
) -> StreamingResponse:
    audio_path = await _save_upload_temporarily(file)
    queue: asyncio.Queue[Optional[dict]] = asyncio.Queue()
    loop = asyncio.get_running_loop()
    task = "translate" if translate else "transcribe"

    def worker() -> None:
        try:
            model = get_model()
            segments_iter, info = model.transcribe(
                audio_path,
                language=language,
                task=task,
                vad_filter=vad_filter,
                beam_size=int(os.getenv("WHISPER_BEAM_SIZE", "5")),
            )

            for segment in segments_iter:
                payload = {
                    "type": "segment",
                    "id": segment.id,
                    "start": segment.start,
                    "end": segment.end,
                    "text": segment.text.strip(),
                }
                loop.call_soon_threadsafe(queue.put_nowait, payload)

            summary = {
                "type": "summary",
                "language": info.language,
                "duration": info.duration,
            }
            loop.call_soon_threadsafe(queue.put_nowait, summary)
        except Exception as exc:  # pragma: no cover
            loop.call_soon_threadsafe(
                queue.put_nowait,
                {"type": "error", "detail": str(exc)},
            )
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    asyncio.create_task(asyncio.to_thread(worker))

    async def event_stream():
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                yield f"data: {json.dumps(item)}\n\n"
        finally:
            if os.path.exists(audio_path):
                os.remove(audio_path)

    return StreamingResponse(event_stream(), media_type="text/event-stream")
