FROM nvidia/cuda:12.3.2-cudnn9-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3.11 \
        python3.11-pip \
        python3.11-venv \
        python3.11-dev \
        build-essential \
        ffmpeg \
        libsndfile1 \
        libsox-dev \
        sox \
        git \
    && update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./

RUN python3 -m pip install --upgrade pip \
    && python3 -m pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Directory for default voice samples
RUN mkdir -p /app/voices

EXPOSE 8000

# Whisper configuration
ENV WHISPER_MODEL_SIZE=medium \
    WHISPER_DEVICE=cuda \
    WHISPER_COMPUTE_TYPE=float16

# TTS configuration
ENV TTS_BACKEND=chatterbox \
    TTS_DEVICE=cuda \
    TTS_LANGUAGE=pt \
    TTS_MAX_TEXT_LENGTH=5000 \
    TTS_SAMPLE_RATE=24000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
