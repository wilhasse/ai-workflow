import asyncio
import json
import os
import tempfile
from pathlib import Path
from typing import List, Optional
from urllib.parse import urljoin

import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
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

REMOTE_API_BASE = os.getenv("WHISPER_REMOTE_API_BASE", "").strip().rstrip("/")
REMOTE_TIMEOUT = float(os.getenv("WHISPER_REMOTE_TIMEOUT", "300"))
REMOTE_VERIFY_TLS = os.getenv("WHISPER_REMOTE_VERIFY_TLS", "true").lower() not in {"0", "false", "off", "no"}
REMOTE_MODE = bool(REMOTE_API_BASE)

_origins_env = os.getenv("WHISPER_CORS_ORIGINS", "*").strip()
if _origins_env == "*":
    CORS_ORIGINS = ["*"]
else:
    CORS_ORIGINS = [origin.strip() for origin in _origins_env.split(",") if origin.strip()]

app = FastAPI(title="Whisper Realtime API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
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


def _remote_url(path: str) -> str:
    return urljoin(f"{REMOTE_API_BASE}/", path.lstrip("/"))


def _form_value(value: Optional[bool]) -> str:
    return "true" if value else "false"


async def _forward_remote_json(audio_path: str, endpoint: str, form_fields: dict) -> dict:
    if not REMOTE_MODE:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Remote API not configured")

    url = _remote_url(endpoint)
    try:
        async with httpx.AsyncClient(timeout=REMOTE_TIMEOUT, verify=REMOTE_VERIFY_TLS) as client:
            with open(audio_path, "rb") as audio_file:
                files = {
                    "file": (
                        Path(audio_path).name or "audio.webm",
                        audio_file,
                        "application/octet-stream",
                    )
                }
                response = await client.post(url, data=form_fields, files=files)
            response.raise_for_status()
            return response.json()
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text or str(exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Upstream error: {detail}") from exc
    except httpx.HTTPError as exc:  # pragma: no cover - network edge cases
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Remote call failed: {exc}") from exc


async def _remote_stream_generator(audio_path: str, endpoint: str, form_fields: dict):
    if not REMOTE_MODE:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Remote API not configured")

    url = _remote_url(endpoint)
    async with httpx.AsyncClient(timeout=REMOTE_TIMEOUT, verify=REMOTE_VERIFY_TLS) as client:
        with open(audio_path, "rb") as audio_file:
            files = {
                "file": (
                    Path(audio_path).name or "audio.webm",
                    audio_file,
                    "application/octet-stream",
                )
            }
            async with client.stream("POST", url, data=form_fields, files=files) as response:
                try:
                    response.raise_for_status()
                except httpx.HTTPStatusError as exc:
                    body = await response.aread()
                    detail = body.decode("utf-8", "ignore") or str(exc)
                    raise HTTPException(
                        status_code=status.HTTP_502_BAD_GATEWAY,
                        detail=f"Upstream error: {detail}",
                    ) from exc
                async for chunk in response.aiter_text():
                    yield chunk


def _cleanup_stream(generator, audio_path: str):
    async def wrapper():
        try:
            async for chunk in generator:
                yield chunk
        finally:
            if os.path.exists(audio_path):
                os.remove(audio_path)

    return wrapper()


def _build_form_fields(language: Optional[str], translate: bool, vad_filter: bool) -> dict:
    fields = {
        "translate": _form_value(translate),
        "vad_filter": _form_value(vad_filter),
    }
    if language:
        fields["language"] = language
    return fields


@app.on_event("startup")
async def load_model() -> None:
    if REMOTE_MODE:
        app.state.model = None
        return

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
    if REMOTE_MODE:
        return
    if hasattr(app.state, "model"):
        delattr(app.state, "model")


def get_model() -> WhisperModel:
    if REMOTE_MODE:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Running in remote proxy mode; local model disabled.",
        )
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
                    avg_log_prob=segment.avg_logprob,
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
    if REMOTE_MODE:
        try:
            async with httpx.AsyncClient(timeout=REMOTE_TIMEOUT, verify=REMOTE_VERIFY_TLS) as client:
                response = await client.get(_remote_url("health"))
                response.raise_for_status()
                upstream = response.json()
        except httpx.HTTPError as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Remote health check failed: {exc}",
            ) from exc
        return JSONResponse(content={"status": "proxy", "upstream": upstream})

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
    form_fields = _build_form_fields(language, translate, vad_filter)
    try:
        if REMOTE_MODE:
            payload = await _forward_remote_json(audio_path, "transcribe", form_fields)
            try:
                return TranscriptionResponse(**payload)
            except Exception as exc:  # pragma: no cover - depends on upstream payloads
                raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Invalid upstream response") from exc

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
    form_fields = _build_form_fields(language, translate, vad_filter)

    if REMOTE_MODE:
        remote_stream = _remote_stream_generator(audio_path, "transcribe/stream", form_fields)
        return StreamingResponse(_cleanup_stream(remote_stream, audio_path), media_type="text/event-stream")

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
