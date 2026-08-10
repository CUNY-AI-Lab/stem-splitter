# Build from the repository root:
#   docker build -f yamnet-comparator/Dockerfile .

ARG PYTHON_IMAGE=python:3.12.13-slim-bookworm@sha256:4766d8b510c428e595d74b9cc5bbb2fae8e26316fffb4adc89908d79aacd58a2
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.11.32@sha256:df4cae8f3a96d175e2e5f992e597550000edbe78fdc2594d5cd8de1a217f504c

FROM ${UV_IMAGE} AS uv
FROM ${PYTHON_IMAGE} AS build

COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
COPY yamnet-comparator/pyproject.toml yamnet-comparator/uv.lock ./
RUN mkdir -p /opt/yamnet-comparator-provenance \
  && python -c "import hashlib,pathlib; source=pathlib.Path('/app/uv.lock'); pathlib.Path('/opt/yamnet-comparator-provenance/uv-lock.sha256').write_text(hashlib.sha256(source.read_bytes()).hexdigest() + '\n', encoding='ascii')"

ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy
RUN uv sync --frozen --no-dev --no-install-project

COPY yamnet-comparator/constants.py yamnet-comparator/contract.py /candidate/
COPY yamnet-comparator/backend.py yamnet-comparator/cli.py /candidate/
COPY yamnet-comparator/download_model.py yamnet-comparator/mapping.json /candidate/
COPY yamnet-comparator/Dockerfile /candidate/Dockerfile
COPY instrument-discovery/vocabulary.json /candidate/vocabulary.json
RUN python -c "import hashlib,json,pathlib; root=pathlib.Path('/candidate'); files={'yamnet-comparator/backend.py':'backend.py','yamnet-comparator/cli.py':'cli.py','yamnet-comparator/constants.py':'constants.py','yamnet-comparator/contract.py':'contract.py','yamnet-comparator/download_model.py':'download_model.py','yamnet-comparator/mapping.json':'mapping.json','yamnet-comparator/Dockerfile':'Dockerfile','instrument-discovery/vocabulary.json':'vocabulary.json'}; result={name:hashlib.sha256((root / local).read_bytes()).hexdigest() for name,local in files.items()}; pathlib.Path('/opt/yamnet-comparator-provenance/source-sha256.json').write_text(json.dumps(result,sort_keys=True,separators=(',',':'))+'\n',encoding='ascii')"
RUN python /candidate/download_model.py /models/yamnet

FROM ${PYTHON_IMAGE}

LABEL org.opencontainers.image.title="STEM Splitter YAMNet comparator" \
      org.opencontainers.image.description="Offline fixed-label evaluation candidate; not a service or separator" \
      org.opencontainers.image.source="https://github.com/CUNY-AI-Lab/stem-splitter" \
      org.opencontainers.image.licenses="Apache-2.0"

WORKDIR /app
COPY --from=build /opt/venv /opt/venv
COPY --from=build /models/yamnet /models/yamnet
COPY --from=build /opt/yamnet-comparator-provenance /opt/yamnet-comparator-provenance
COPY --from=build /candidate/constants.py /candidate/contract.py ./
COPY --from=build /candidate/backend.py /candidate/cli.py ./
COPY --from=build /candidate/mapping.json ./mapping.json
COPY --from=build /candidate/vocabulary.json ./vocabulary.json

ENV PATH="/opt/venv/bin:${PATH}" \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TF_CPP_MIN_LOG_LEVEL=3

USER 65532:65532
ENTRYPOINT ["python", "cli.py"]
