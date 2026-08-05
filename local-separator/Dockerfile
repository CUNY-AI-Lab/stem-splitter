# Railway container for the Audio Separator service (CPU inference).
# Model weights cache on a volume at /models; job scratch space is ephemeral.
FROM python:3.12-slim

# build-essential: diffq (an audio-separator dependency) compiles a C extension.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg build-essential \
  && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev

COPY service.py ./

ENV PATH="/app/.venv/bin:$PATH" \
    AUDIO_SEPARATOR_MODEL_DIR=/models \
    AUDIO_SEPARATOR_DATA_DIR=/tmp/separator-data

EXPOSE 8765
CMD ["sh", "-c", "python service.py --host 0.0.0.0 --port ${PORT:-8765}"]
