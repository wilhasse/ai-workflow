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
