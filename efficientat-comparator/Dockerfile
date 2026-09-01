# Build from the repository root:
#   docker build -f efficientat-comparator/Dockerfile .

ARG PYTHON_IMAGE=python:3.12.13-slim-bookworm@sha256:4766d8b510c428e595d74b9cc5bbb2fae8e26316fffb4adc89908d79aacd58a2
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.11.32@sha256:df4cae8f3a96d175e2e5f992e597550000edbe78fdc2594d5cd8de1a217f504c

FROM ${UV_IMAGE} AS uv
FROM ${PYTHON_IMAGE} AS build

COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
COPY efficientat-comparator/pyproject.toml efficientat-comparator/uv.lock ./
RUN mkdir -p /opt/efficientat-comparator-provenance \
  && python -c "import hashlib,pathlib; source=pathlib.Path('/app/uv.lock'); pathlib.Path('/opt/efficientat-comparator-provenance/uv-lock.sha256').write_text(hashlib.sha256(source.read_bytes()).hexdigest() + '\n', encoding='ascii')"

ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy
RUN uv sync --frozen --no-dev --no-install-project

COPY efficientat-comparator/constants.py efficientat-comparator/contract.py /candidate/
COPY efficientat-comparator/model.py efficientat-comparator/backend.py /candidate/
COPY efficientat-comparator/cli.py efficientat-comparator/download_model.py /candidate/
COPY efficientat-comparator/mapping.json efficientat-comparator/LICENSE.EfficientAT /candidate/
COPY efficientat-comparator/Dockerfile /candidate/Dockerfile
COPY instrument-discovery/vocabulary.json /candidate/vocabulary.json
RUN python -c "import hashlib,json,pathlib; root=pathlib.Path('/candidate'); files={'efficientat-comparator/backend.py':'backend.py','efficientat-comparator/cli.py':'cli.py','efficientat-comparator/constants.py':'constants.py','efficientat-comparator/contract.py':'contract.py','efficientat-comparator/download_model.py':'download_model.py','efficientat-comparator/model.py':'model.py','efficientat-comparator/mapping.json':'mapping.json','efficientat-comparator/LICENSE.EfficientAT':'LICENSE.EfficientAT','efficientat-comparator/Dockerfile':'Dockerfile','instrument-discovery/vocabulary.json':'vocabulary.json'}; result={name:hashlib.sha256((root / local).read_bytes()).hexdigest() for name,local in files.items()}; pathlib.Path('/opt/efficientat-comparator-provenance/source-sha256.json').write_text(json.dumps(result,sort_keys=True,separators=(',',':'))+'\n',encoding='ascii')"
RUN PYTHONPATH=/candidate python -c "import hashlib,pathlib; from constants import UPSTREAM_LICENSE_SHA256; source=pathlib.Path('/candidate/LICENSE.EfficientAT'); assert hashlib.sha256(source.read_bytes()).hexdigest() == UPSTREAM_LICENSE_SHA256"
RUN /opt/venv/bin/python /candidate/download_model.py /models/efficientat

FROM ${PYTHON_IMAGE}

LABEL org.opencontainers.image.title="STEM Splitter EfficientAT comparator" \
      org.opencontainers.image.description="Offline comparison-only evaluator; not a service or separator" \
      org.opencontainers.image.source="https://github.com/CUNY-AI-Lab/stem-splitter" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY --from=build /opt/venv /opt/venv
COPY --from=build /models/efficientat /models/efficientat
COPY --from=build /opt/efficientat-comparator-provenance /opt/efficientat-comparator-provenance
COPY --from=build /candidate/constants.py /candidate/contract.py /candidate/model.py ./
COPY --from=build /candidate/backend.py /candidate/cli.py ./
COPY --from=build /candidate/mapping.json ./mapping.json
COPY --from=build /candidate/vocabulary.json ./vocabulary.json

ENV PATH="/opt/venv/bin:${PATH}" \
    XDG_CACHE_HOME=/tmp/.cache \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=1 \
    MKL_NUM_THREADS=1

USER 65532:65532
ENTRYPOINT ["python", "cli.py"]
