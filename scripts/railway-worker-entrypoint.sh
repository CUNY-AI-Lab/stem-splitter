#!/usr/bin/env bash
# Boot the self-hosted worker on Railway: apply the D1 schema to the volume
# (idempotent — schema.sql is all CREATE TABLE IF NOT EXISTS), then run
# wrangler dev --local bound to the container port.
set -euo pipefail

: "${PORT:=8080}"
: "${PUBLIC_BASE_URL:?Set PUBLIC_BASE_URL to the public URL of this service}"
: "${AUDIO_SEPARATOR_URL:?Set AUDIO_SEPARATOR_URL to the separator service URL}"
: "${AUDIO_SEPARATOR_TOKEN:?Set AUDIO_SEPARATOR_TOKEN}"
: "${WEBHOOK_SECRET:?Set WEBHOOK_SECRET}"
: "${CLASS_CODE:?Set CLASS_CODE}"

STATE_DIR="${STATE_DIR:-/data/state}"
mkdir -p "$STATE_DIR"

npx wrangler d1 execute stem-splitter \
  --local \
  --persist-to "$STATE_DIR" \
  --file schema.sql \
  --yes

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
  --var "AUDIO_SEPARATOR_TOKEN:$AUDIO_SEPARATOR_TOKEN"
  --var "WEBHOOK_SECRET:$WEBHOOK_SECRET"
  --var "CLASS_CODE:$CLASS_CODE"
)

# Listening Guy is optional — without a key its endpoints 503 by design.
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
  ARGS+=(--var "OPENROUTER_API_KEY:$OPENROUTER_API_KEY")
  ARGS+=(--var "ASSISTANT_MODEL:${ASSISTANT_MODEL:-z-ai/glm-5.2}")
fi

exec npx wrangler dev "${ARGS[@]}"
