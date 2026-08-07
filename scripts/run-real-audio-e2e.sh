#!/usr/bin/env bash
# Start an isolated local stack and exercise one real audio file through the
# visible browser UI and the actual Audio Separator model selected by MODEL.

set -euo pipefail

: "${SOURCE_AUDIO:?Set SOURCE_AUDIO to a readable MP3, WAV, FLAC, M4A, OGG, AIFF, or AIF file}"

MODEL="${MODEL:-bs_roformer_vocals}"
CASE_SLUG="${CASE_SLUG:-$MODEL}"
WORKER_PORT="${WORKER_PORT:-8787}"
SEPARATOR_PORT="${SEPARATOR_PORT:-8765}"
CLASS_CODE="${CLASS_CODE:-local-class-code}"
LOCAL_WEBHOOK_SECRET="real-audio-e2e-webhook"
LOCAL_SEPARATOR_TOKEN="real-audio-e2e-separator"
ARTIFACT_DIR="${REAL_AUDIO_ARTIFACT_DIR:-output/playwright/real-audio/$CASE_SLUG}"
RESULT_PATH="${REAL_AUDIO_RESULT_PATH:-$ARTIFACT_DIR/result.json}"
RUN_ROOT="$(mktemp -d /tmp/stem-splitter-real-audio.XXXXXX)"
WORKER_PID=""
SEPARATOR_PID=""

cleanup() {
  if [[ -n "$WORKER_PID" ]]; then
    kill "$WORKER_PID" 2>/dev/null || true
    wait "$WORKER_PID" 2>/dev/null || true
  fi
  if [[ -n "$SEPARATOR_PID" ]]; then
    kill "$SEPARATOR_PID" 2>/dev/null || true
    wait "$SEPARATOR_PID" 2>/dev/null || true
  fi
  rm -rf "$RUN_ROOT"
}
trap cleanup EXIT INT TERM

for command_name in bun curl rg uv; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Missing required command: $command_name" >&2
    exit 1
  }
done

if [[ ! -f "$SOURCE_AUDIO" || ! -r "$SOURCE_AUDIO" ]]; then
  echo "SOURCE_AUDIO is not a readable file: $SOURCE_AUDIO" >&2
  exit 1
fi

case "$MODEL" in
  bs_roformer_vocals|htdemucs_ft|htdemucs_6s) ;;
  *)
    echo "Unsupported MODEL: $MODEL" >&2
    exit 1
    ;;
esac

mkdir -p "$ARTIFACT_DIR"

bun run wrangler -- d1 execute stem-splitter \
  --local \
  --persist-to "$RUN_ROOT/state" \
  --file schema.sql \
  --yes >"$ARTIFACT_DIR/d1.log" 2>&1

UV_CACHE_DIR=.uv-cache \
uv sync --project local-separator --locked >"$ARTIFACT_DIR/uv-sync.log" 2>&1

AUDIO_SEPARATOR_DATA_DIR="$RUN_ROOT/separator-data" \
AUDIO_SEPARATOR_TOKEN="$LOCAL_SEPARATOR_TOKEN" \
local-separator/.venv/bin/python local-separator/service.py \
  --port "$SEPARATOR_PORT" >"$ARTIFACT_DIR/separator.log" 2>&1 &
SEPARATOR_PID="$!"

bun run wrangler -- dev \
  --local \
  --latest=false \
  --show-interactive-dev-session=false \
  --port "$WORKER_PORT" \
  --persist-to "$RUN_ROOT/state" \
  --var "LOCAL_DEV:1" \
  --var "PUBLIC_BASE_URL:http://127.0.0.1:$WORKER_PORT" \
  --var "SEPARATION_BACKEND:audio-separator" \
  --var "AUDIO_SEPARATOR_URL:http://127.0.0.1:$SEPARATOR_PORT" \
  --var "AUDIO_SEPARATOR_TOKEN:$LOCAL_SEPARATOR_TOKEN" \
  --var "WEBHOOK_SECRET:$LOCAL_WEBHOOK_SECRET" \
  --var "CLASS_CODE:$CLASS_CODE" \
  >"$ARTIFACT_DIR/worker.log" 2>&1 &
WORKER_PID="$!"

for _ in {1..120}; do
  if curl -sSf "http://127.0.0.1:$SEPARATOR_PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
curl -sSf "http://127.0.0.1:$SEPARATOR_PORT/health" >/dev/null

for _ in {1..120}; do
  if curl -sSf "http://127.0.0.1:$WORKER_PORT/api/separation-options" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
curl -sSf "http://127.0.0.1:$WORKER_PORT/api/separation-options" >/dev/null

REAL_AUDIO_SOURCE="$SOURCE_AUDIO" \
REAL_AUDIO_MODEL="$MODEL" \
REAL_AUDIO_CASE_SLUG="$CASE_SLUG" \
REAL_AUDIO_CLASS_CODE="$CLASS_CODE" \
REAL_AUDIO_BASE_URL="http://127.0.0.1:$WORKER_PORT" \
REAL_AUDIO_ARTIFACT_DIR="$ARTIFACT_DIR" \
REAL_AUDIO_RESULT_PATH="$RESULT_PATH" \
bun run test:e2e:real

if rg -n \
  'POST /api/webhooks/separation 5[0-9]{2}|Internal Server Error|Network connection lost' \
  "$ARTIFACT_DIR/worker.log"; then
  echo "Worker log contains a fatal real-audio E2E failure" >&2
  exit 1
fi

if rg -n 'webhook delivery failed|Traceback' "$ARTIFACT_DIR/separator.log"; then
  echo "Separator log contains a fatal real-audio E2E failure" >&2
  exit 1
fi
