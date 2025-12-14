import asyncio
import base64
import io
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import List, Literal, Optional
from urllib.parse import urljoin

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from faster_whisper import WhisperModel
from pydantic import BaseModel, Field


MAX_AUDIO_BYTES = int(os.getenv("WHISPER_MAX_AUDIO_BYTES", 60 * 1024 * 1024))

# TTS Configuration
TTS_BACKEND = os.getenv("TTS_BACKEND", "chatterbox")
TTS_DEVICE = os.getenv("TTS_DEVICE", "cuda")
TTS_LANGUAGE = os.getenv("TTS_LANGUAGE", "pt")
TTS_MAX_TEXT_LENGTH = int(os.getenv("TTS_MAX_TEXT_LENGTH", "5000"))
TTS_SAMPLE_RATE = int(os.getenv("TTS_SAMPLE_RATE", "24000"))
TTS_DEFAULT_VOICE = os.getenv("TTS_DEFAULT_VOICE", "")
CHATTERBOX_EXAGGERATION = float(os.getenv("CHATTERBOX_EXAGGERATION", "0.5"))
CHATTERBOX_CFG = float(os.getenv("CHATTERBOX_CFG", "0.5"))


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


# TTS Models
class TTSStreamChunk(BaseModel):
    """Streaming TTS chunk."""
    type: Literal["audio", "metadata", "error"]
    data: Optional[str] = None  # Base64 encoded audio chunk
    duration: Optional[float] = None
    sample_rate: Optional[int] = None
    detail: Optional[str] = None


class VoiceInfo(BaseModel):
    """Voice information model."""
    id: str
    name: str
    language: str
    description: Optional[str] = None


class VoicesResponse(BaseModel):
    """Response model for available voices."""
    backend: str
    voices: List[VoiceInfo]
    default_voice: Optional[str] = None


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
        app.state.tts_model = None
        app.state.tts_backend = None
        return

    # Load Whisper model
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

    # Load TTS model
    try:
        if TTS_BACKEND == "chatterbox":
            from chatterbox.tts import ChatterboxTTS
            app.state.tts_model = ChatterboxTTS.from_pretrained(device=TTS_DEVICE)
            app.state.tts_backend = "chatterbox"
        elif TTS_BACKEND == "f5tts":
            from f5_tts.api import F5TTS
            app.state.tts_model = F5TTS(device=TTS_DEVICE)
            app.state.tts_backend = "f5tts"
        else:
            app.state.tts_model = None
            app.state.tts_backend = None
    except Exception as exc:  # pragma: no cover
        # TTS is optional - log error but don't fail startup
        print(f"Warning: Failed to load TTS model ({TTS_BACKEND}): {exc}")
        app.state.tts_model = None
        app.state.tts_backend = None


@app.on_event("shutdown")
async def cleanup_model() -> None:
    if REMOTE_MODE:
        return
    if hasattr(app.state, "model"):
        delattr(app.state, "model")
    if hasattr(app.state, "tts_model"):
        delattr(app.state, "tts_model")


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


def get_tts_model():
    """Get the loaded TTS model."""
    if REMOTE_MODE:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Running in remote proxy mode; local TTS model disabled.",
        )
    model = getattr(app.state, "tts_model", None)
    if model is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="TTS model is not ready or not configured",
        )
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


# TTS Helper Functions
def _preprocess_portuguese(text: str) -> str:
    """Preprocess text for Brazilian Portuguese TTS."""
    try:
        from num2words import num2words
        # Convert numbers to Portuguese words
        text = re.sub(
            r'\d+',
            lambda m: num2words(int(m.group()), lang='pt_BR'),
            text
        )
    except Exception:
        pass  # If num2words fails, use original text
    return text


def _convert_to_wav(audio_data, sample_rate: int) -> bytes:
    """Convert numpy audio to WAV bytes."""
    import soundfile as sf
    buffer = io.BytesIO()
    sf.write(buffer, audio_data, sample_rate, format='WAV')
    buffer.seek(0)
    return buffer.read()


def _convert_to_mp3(audio_data, sample_rate: int) -> bytes:
    """Convert numpy audio to MP3 bytes using ffmpeg."""
    import soundfile as sf

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as wav_tmp:
        sf.write(wav_tmp.name, audio_data, sample_rate)
        wav_path = wav_tmp.name

    mp3_path = wav_path.replace(".wav", ".mp3")
    try:
        subprocess.run([
            "ffmpeg", "-y", "-i", wav_path,
            "-codec:a", "libmp3lame", "-qscale:a", "2",
            mp3_path
        ], check=True, capture_output=True)

        with open(mp3_path, "rb") as f:
            return f.read()
    finally:
        if os.path.exists(wav_path):
            os.remove(wav_path)
        if os.path.exists(mp3_path):
            os.remove(mp3_path)


def _run_tts_synthesis(
    text: str,
    language: str,
    ref_audio_path: Optional[str] = None,
) -> tuple:
    """Run TTS synthesis synchronously (called from thread pool)."""
    model = get_tts_model()
    backend = getattr(app.state, "tts_backend", None)

    # Preprocess text for pt-BR
    if language == "pt":
        text = _preprocess_portuguese(text)

    if backend == "chatterbox":
        if ref_audio_path:
            wav = model.generate(
                text,
                audio_prompt_path=ref_audio_path,
                exaggeration=CHATTERBOX_EXAGGERATION,
                cfg_weight=CHATTERBOX_CFG,
            )
        else:
            wav = model.generate(
                text,
                exaggeration=CHATTERBOX_EXAGGERATION,
                cfg_weight=CHATTERBOX_CFG,
            )
        # Chatterbox returns tensor, convert to numpy
        audio_np = wav.cpu().numpy().squeeze()
        return audio_np, model.sr

    elif backend == "f5tts":
        ref_file = ref_audio_path or TTS_DEFAULT_VOICE
        if not ref_file:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="F5-TTS requires a reference audio file for voice cloning"
            )
        wav, sr, _ = model.infer(
            ref_file=ref_file,
            ref_text="",  # Auto-transcribe reference
            gen_text=text,
        )
        return wav, sr

    raise HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail=f"Unknown TTS backend: {backend}"
    )


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

    model_loaded = hasattr(app.state, "model") and app.state.model is not None
    tts_loaded = hasattr(app.state, "tts_model") and app.state.tts_model is not None
    tts_backend = getattr(app.state, "tts_backend", None)

    return JSONResponse(content={
        "status": "ok" if model_loaded else "loading",
        "whisper": "ready" if model_loaded else "loading",
        "tts": {
            "status": "ready" if tts_loaded else "not_loaded",
            "backend": tts_backend,
        }
    })


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


# TTS Endpoints
@app.get("/tts/voices", response_model=VoicesResponse, tags=["tts"])
async def list_voices() -> VoicesResponse:
    """List available voices and models for TTS."""
    backend = getattr(app.state, "tts_backend", None)
    voices = []

    if backend == "chatterbox":
        # Chatterbox supports these languages natively
        languages = [
            ("pt", "Portuguese"),
            ("en", "English"),
            ("es", "Spanish"),
            ("fr", "French"),
            ("de", "German"),
            ("it", "Italian"),
            ("ja", "Japanese"),
            ("ko", "Korean"),
            ("zh", "Chinese"),
            ("ar", "Arabic"),
            ("ru", "Russian"),
            ("nl", "Dutch"),
            ("pl", "Polish"),
            ("tr", "Turkish"),
            ("sv", "Swedish"),
            ("da", "Danish"),
            ("fi", "Finnish"),
            ("no", "Norwegian"),
            ("he", "Hebrew"),
            ("hi", "Hindi"),
            ("ms", "Malay"),
            ("sw", "Swahili"),
            ("el", "Greek"),
        ]
        for lang_code, lang_name in languages:
            voices.append(VoiceInfo(
                id=f"chatterbox-{lang_code}",
                name=f"Chatterbox {lang_name}",
                language=lang_code,
                description="Chatterbox voice with emotion control and voice cloning",
            ))

    elif backend == "f5tts":
        voices.append(VoiceInfo(
            id="f5tts-ptbr",
            name="F5-TTS Brazilian Portuguese",
            language="pt",
            description="F5-TTS fine-tuned for Brazilian Portuguese (requires reference audio)",
        ))

    return VoicesResponse(
        backend=backend or "none",
        voices=voices,
        default_voice=TTS_DEFAULT_VOICE or None,
    )


@app.post("/tts", tags=["tts"])
async def synthesize_speech(
    text: str = Form(...),
    language: Optional[str] = Form(None),
    format: str = Form("wav"),
    reference_audio: Optional[UploadFile] = File(None),
) -> Response:
    """
    Synthesize speech from text.

    - **text**: Text to convert to speech (max 5000 chars)
    - **language**: Language code (default: pt for Brazilian Portuguese)
    - **format**: Output format (wav or mp3)
    - **reference_audio**: Optional audio file for voice cloning (5-10s recommended)
    """
    # Validate text length
    if len(text) > TTS_MAX_TEXT_LENGTH:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Text exceeds maximum length of {TTS_MAX_TEXT_LENGTH} characters"
        )

    if not text.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Text cannot be empty"
        )

    # Handle reference audio if provided
    ref_audio_path = None
    if reference_audio:
        ref_audio_path = await _save_upload_temporarily(reference_audio)

    try:
        # Run synthesis in thread pool
        audio_data, sample_rate = await asyncio.to_thread(
            _run_tts_synthesis,
            text=text,
            language=language or TTS_LANGUAGE,
            ref_audio_path=ref_audio_path,
        )

        # Convert to requested format
        if format == "mp3":
            audio_bytes = _convert_to_mp3(audio_data, sample_rate)
            media_type = "audio/mpeg"
            filename = "speech.mp3"
        else:
            audio_bytes = _convert_to_wav(audio_data, sample_rate)
            media_type = "audio/wav"
            filename = "speech.wav"

        return Response(
            content=audio_bytes,
            media_type=media_type,
            headers={"Content-Disposition": f"attachment; filename={filename}"}
        )

    finally:
        if ref_audio_path and os.path.exists(ref_audio_path):
            os.remove(ref_audio_path)


@app.post("/tts/stream", tags=["tts"])
async def synthesize_speech_stream(
    text: str = Form(...),
    language: Optional[str] = Form(None),
    reference_audio: Optional[UploadFile] = File(None),
) -> StreamingResponse:
    """
    Stream synthesized speech via Server-Sent Events.

    Emits audio data as base64-encoded chunks.
    """
    # Validate text length
    if len(text) > TTS_MAX_TEXT_LENGTH:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Text exceeds maximum length of {TTS_MAX_TEXT_LENGTH} characters"
        )

    if not text.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Text cannot be empty"
        )

    ref_audio_path = None
    if reference_audio:
        ref_audio_path = await _save_upload_temporarily(reference_audio)

    queue: asyncio.Queue[Optional[dict]] = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def worker() -> None:
        try:
            audio_data, sample_rate = _run_tts_synthesis(
                text=text,
                language=language or TTS_LANGUAGE,
                ref_audio_path=ref_audio_path,
            )

            # Convert to WAV bytes
            wav_bytes = _convert_to_wav(audio_data, sample_rate)
            audio_b64 = base64.b64encode(wav_bytes).decode('utf-8')

            # Send audio chunk
            loop.call_soon_threadsafe(queue.put_nowait, {
                "type": "audio",
                "data": audio_b64,
                "sample_rate": sample_rate,
                "format": "wav",
            })

            # Send completion metadata
            duration = len(audio_data) / sample_rate if sample_rate > 0 else 0
            loop.call_soon_threadsafe(queue.put_nowait, {
                "type": "metadata",
                "duration": duration,
                "text_length": len(text),
            })

        except Exception as exc:
            loop.call_soon_threadsafe(queue.put_nowait, {
                "type": "error",
                "detail": str(exc),
            })
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
            if ref_audio_path and os.path.exists(ref_audio_path):
                os.remove(ref_audio_path)

    return StreamingResponse(event_stream(), media_type="text/event-stream")
