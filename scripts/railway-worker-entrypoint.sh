#!/usr/bin/env bash
# Boot the self-hosted worker on Railway: apply the D1 schema to the volume
# (idempotent — schema.sql is all CREATE TABLE IF NOT EXISTS), then run
# Wrangler under Node (`node_modules/.bin/wrangler`) bound to the container port.
set -euo pipefail

: "${PORT:=8080}"
: "${PUBLIC_BASE_URL:?Set PUBLIC_BASE_URL to the public URL of this service}"
: "${AUDIO_SEPARATOR_URL:?Set AUDIO_SEPARATOR_URL to the separator service URL}"
: "${AUDIO_SEPARATOR_TOKEN:?Set AUDIO_SEPARATOR_TOKEN}"
: "${WEBHOOK_SECRET:?Set WEBHOOK_SECRET}"
: "${CLASS_CODE:?Set CLASS_CODE}"

STATE_DIR="${STATE_DIR:-/data/state}"
mkdir -p "$STATE_DIR"
WRANGLER="node_modules/.bin/wrangler"

"$WRANGLER" d1 execute stem-splitter \
  --local \
  --persist-to "$STATE_DIR" \
  --file schema.sql \
  --yes

# Secrets go through .dev.vars rather than --var: wrangler only sees values it
# is handed explicitly (the container env is NOT inherited by the worker), and
# .dev.vars keeps them off the process command line where `ps` would show them.
# Values are single-quoted, so none of them may contain a single quote.
{
  printf "AUDIO_SEPARATOR_TOKEN='%s'\n" "$AUDIO_SEPARATOR_TOKEN"
  printf "WEBHOOK_SECRET='%s'\n" "$WEBHOOK_SECRET"
  printf "CLASS_CODE='%s'\n" "$CLASS_CODE"
  [ -n "${TEACHER_SEED:-}" ] && printf "TEACHER_SEED='%s'\n" "$TEACHER_SEED"
  [ -n "${OPENROUTER_API_KEY:-}" ] && printf "OPENROUTER_API_KEY='%s'\n" "$OPENROUTER_API_KEY"
  # R2 presigning is unused on the LOCAL_HOSTING path but the type demands them.
  printf "R2_ACCESS_KEY_ID='%s'\n" "${R2_ACCESS_KEY_ID:-local}"
  printf "R2_SECRET_ACCESS_KEY='%s'\n" "${R2_SECRET_ACCESS_KEY:-local}"
} > .dev.vars

ARGS=(
  --local
  --latest=false
  --show-interactive-dev-session=false
  --ip 0.0.0.0
  --port "$PORT"
  --persist-to "$STATE_DIR"
  --var "LOCAL_HOSTING:true"
  --var "PUBLIC_BASE_URL:$PUBLIC_BASE_URL"
  --var "SEPARATION_BACKEND:audio-separator"
  --var "AUDIO_SEPARATOR_URL:$AUDIO_SEPARATOR_URL"
)

# Listening Guy is optional — without a key its endpoints 503 by design.
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  ARGS+=(--var "ASSISTANT_MODEL:${ASSISTANT_MODEL:-z-ai/glm-5.2}")
fi

exec "$WRANGLER" dev "${ARGS[@]}"
