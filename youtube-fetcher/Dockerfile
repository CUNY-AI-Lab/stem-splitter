# The YouTube fetcher in a container. It runs as an unprivileged user with a read-only
# file system; its only writable places are its cache volume and a small /tmp.
# Base image and Python packages are pinned (digest and hashes); see README to update them.
FROM python:3.14-slim@sha256:9aaa474097d094040649f2162a627c0049b408f52138d980916788d80f04802f

# The user that owns the secrets files on the host, so the read-only secrets mount is
# readable without loosening its permissions (501 on a Mac's first account).
ARG FETCHER_UID=10001
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1

COPY requirements.txt /app/requirements.txt
RUN pip install --require-hashes --no-deps --only-binary=:all: -r /app/requirements.txt \
 && useradd --uid "$FETCHER_UID" --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin fetcher \
 && mkdir -p /cache && chown fetcher:fetcher /cache && chmod 700 /cache
# Readable, not writable, by the fetcher user, whatever the permissions on the host copy.
COPY --chmod=0444 fetcher.py /app/fetcher.py

USER fetcher
ENV YT_FETCHER_HOST=0.0.0.0 YT_FETCHER_PORT=8790 YT_FETCHER_CACHE=/cache \
    YT_FETCHER_SECRET_FILE=/run/secrets/fetcher-secrets YT_FETCHER_CACHE_KEY_FILE=/run/secrets/cache-key
# Listening is enough for a health check; /healthz needs a secret the check does not hold.
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD ["python3", "-c", "import socket; socket.create_connection(('127.0.0.1', 8790), 3).close()"]
CMD ["python3", "-I", "/app/fetcher.py"]
