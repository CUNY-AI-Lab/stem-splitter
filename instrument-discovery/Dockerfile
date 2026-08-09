# Build from the repository root:
#   docker build -f instrument-discovery/Dockerfile .

ARG PYTHON_IMAGE=python:3.12.13-slim-bookworm@sha256:4766d8b510c428e595d74b9cc5bbb2fae8e26316fffb4adc89908d79aacd58a2
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.11.32@sha256:df4cae8f3a96d175e2e5f992e597550000edbe78fdc2594d5cd8de1a217f504c

FROM ${UV_IMAGE} AS uv
FROM ${PYTHON_IMAGE} AS build

COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
COPY instrument-discovery/pyproject.toml instrument-discovery/uv.lock ./

ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy
RUN uv sync --frozen --no-dev --no-install-project

COPY instrument-discovery/constants.py instrument-discovery/contract.py ./
COPY instrument-discovery/clap_backend.py instrument-discovery/download_model.py ./
RUN /opt/venv/bin/python download_model.py /models/larger_clap_music \
  && find /models/larger_clap_music -type d -name .cache -prune -exec rm -r {} +

FROM ${PYTHON_IMAGE}

LABEL org.opencontainers.image.title="STEM Splitter instrument discovery" \
      org.opencontainers.image.description="Private advisory CLAP classifier; never a separator" \
      org.opencontainers.image.source="https://github.com/CUNY-AI-Lab/stem-splitter"

WORKDIR /app
COPY --from=build /opt/venv /opt/venv
COPY --from=build /models/larger_clap_music /models/larger_clap_music
COPY instrument-discovery/constants.py instrument-discovery/contract.py ./
COPY instrument-discovery/clap_backend.py instrument-discovery/service.py ./
COPY instrument-discovery/vocabulary.json ./vocabulary.json

ENV PATH="/opt/venv/bin:${PATH}" \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    INSTRUMENT_DISCOVERY_MODEL_DIR=/models/larger_clap_music \
    INSTRUMENT_DISCOVERY_VOCABULARY=/app/vocabulary.json \
    INSTRUMENT_DISCOVERY_MAX_CONCURRENCY=1 \
    INSTRUMENT_DISCOVERY_TORCH_THREADS=1 \
    INSTRUMENT_DISCOVERY_INFERENCE_TIMEOUT_SECONDS=30

USER 65532:65532
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+(os.environ.get('PORT') or '8080')+'/readyz',timeout=4)"

CMD ["python", "service.py"]
