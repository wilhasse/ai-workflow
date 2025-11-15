FROM nvidia/cuda:12.3.2-cudnn9-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \ 
    && apt-get install -y --no-install-recommends \ 
        python3 \ 
        python3-pip \ 
        python3-venv \ 
        python3-dev \ 
        build-essential \ 
        ffmpeg \ 
        libsndfile1 \ 
    && apt-get clean \ 
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./

RUN python3 -m pip install --upgrade pip \ 
    && python3 -m pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8000

ENV WHISPER_MODEL_SIZE=medium \
    WHISPER_DEVICE=cuda \
    WHISPER_COMPUTE_TYPE=float16

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
