#!/usr/bin/env bash
# Start an isolated local stack and exercise one real recording through the
# visible browser UI and a real separation model.
#
#   SOURCE_AUDIO=song.mp3 ./scripts/run-real-audio-e2e.sh
#   BACKEND=replicate MODEL=vocals_instrumental SOURCE_AUDIO=song.mp3 ./scripts/run-real-audio-e2e.sh
#   BACKEND=replicate MODEL=htdemucs_6s YOUTUBE_URL=<url> ./scripts/run-real-audio-e2e.sh
#
# BACKEND=audio-separator (default) runs the local Python separator and costs
# nothing. BACKEND=replicate runs the real paid provider and needs
# REPLICATE_API_TOKEN and REPLICATE_MODEL_VERSION (plus REPLICATE_YT_MODEL for
# an import). Provider webhooks cannot reach localhost, so a Replicate run
# completes through the reconciliation fallback in GET /api/jobs/:id — which is
# itself worth exercising.
#
# Supply exactly one of SOURCE_AUDIO or YOUTUBE_URL. No default song ships here.

set -euo pipefail

BACKEND="${BACKEND:-audio-separator}"
SOURCE_AUDIO="${SOURCE_AUDIO:-}"
YOUTUBE_URL="${YOUTUBE_URL:-}"

if [[ -z "$SOURCE_AUDIO" && -z "$YOUTUBE_URL" ]]; then
  echo "Set SOURCE_AUDIO to a readable MP3, WAV, FLAC, M4A, OGG, AIFF, or AIF file, or set YOUTUBE_URL" >&2
  exit 1
fi
if [[ -n "$SOURCE_AUDIO" && -n "$YOUTUBE_URL" ]]; then
  echo "Set exactly one of SOURCE_AUDIO or YOUTUBE_URL" >&2
  exit 1
fi
if [[ -n "$YOUTUBE_URL" && "$BACKEND" != "replicate" ]]; then
  echo "YOUTUBE_URL requires BACKEND=replicate — the import fetcher is Replicate-hosted" >&2
  exit 1
fi

if [[ "$BACKEND" == "replicate" ]]; then
  : "${REPLICATE_API_TOKEN:?BACKEND=replicate needs REPLICATE_API_TOKEN}"
  : "${REPLICATE_MODEL_VERSION:?BACKEND=replicate needs REPLICATE_MODEL_VERSION}"
  if [[ -n "$YOUTUBE_URL" ]]; then
    : "${REPLICATE_YT_MODEL:?A YouTube import needs REPLICATE_YT_MODEL}"
  fi
fi

if [[ "$BACKEND" == "replicate" ]]; then
  MODEL="${MODEL:-htdemucs_ft}"
else
  MODEL="${MODEL:-bs_roformer_vocals}"
fi
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

REQUIRED_COMMANDS=(curl npx rg)
[[ "$BACKEND" == "audio-separator" ]] && REQUIRED_COMMANDS+=(uv)
for command_name in "${REQUIRED_COMMANDS[@]}"; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Missing required command: $command_name" >&2
    exit 1
  }
done

if [[ -n "$SOURCE_AUDIO" && ( ! -f "$SOURCE_AUDIO" || ! -r "$SOURCE_AUDIO" ) ]]; then
  echo "SOURCE_AUDIO is not a readable file: $SOURCE_AUDIO" >&2
  exit 1
fi

# Each backend runs the choices its catalogue entry declares a runner for; this
# mirrors getSeparationOptions() rather than restating a global model list.
case "$BACKEND:$MODEL" in
  audio-separator:bs_roformer_vocals|audio-separator:htdemucs_ft|audio-separator:htdemucs_6s) ;;
  replicate:vocals_instrumental|replicate:htdemucs_ft|replicate:htdemucs_6s) ;;
  *)
    echo "Unsupported MODEL \"$MODEL\" for BACKEND \"$BACKEND\"" >&2
    exit 1
    ;;
esac

mkdir -p "$ARTIFACT_DIR"

npx wrangler d1 execute stem-splitter \
  --local \
  --persist-to "$RUN_ROOT/state" \
  --file schema.sql \
  --yes >"$ARTIFACT_DIR/d1.log" 2>&1

WORKER_VARS=(
  --var "LOCAL_DEV:1"
  --var "PUBLIC_BASE_URL:http://127.0.0.1:$WORKER_PORT"
  --var "WEBHOOK_SECRET:$LOCAL_WEBHOOK_SECRET"
  --var "CLASS_CODE:$CLASS_CODE"
  --var "SEPARATION_BACKEND:$BACKEND"
)

if [[ "$BACKEND" == "audio-separator" ]]; then
  UV_CACHE_DIR=.uv-cache \
  uv sync --project local-separator --locked >"$ARTIFACT_DIR/uv-sync.log" 2>&1

  AUDIO_SEPARATOR_DATA_DIR="$RUN_ROOT/separator-data" \
  AUDIO_SEPARATOR_TOKEN="$LOCAL_SEPARATOR_TOKEN" \
  local-separator/.venv/bin/python local-separator/service.py \
    --port "$SEPARATOR_PORT" >"$ARTIFACT_DIR/separator.log" 2>&1 &
  SEPARATOR_PID="$!"

  WORKER_VARS+=(
    --var "AUDIO_SEPARATOR_URL:http://127.0.0.1:$SEPARATOR_PORT"
    --var "AUDIO_SEPARATOR_TOKEN:$LOCAL_SEPARATOR_TOKEN"
  )
else
  WORKER_VARS+=(
    --var "REPLICATE_API_TOKEN:$REPLICATE_API_TOKEN"
    --var "REPLICATE_MODEL_VERSION:$REPLICATE_MODEL_VERSION"
  )
  [[ -n "${REPLICATE_YT_MODEL:-}" ]] &&
    WORKER_VARS+=(--var "REPLICATE_YT_MODEL:$REPLICATE_YT_MODEL")
  [[ -n "${YOUTUBE_FETCH_ORDER:-}" ]] &&
    WORKER_VARS+=(--var "YOUTUBE_FETCH_ORDER:$YOUTUBE_FETCH_ORDER")
fi

npx wrangler dev \
  --local \
  --latest=false \
  --show-interactive-dev-session=false \
  --port "$WORKER_PORT" \
  --persist-to "$RUN_ROOT/state" \
  "${WORKER_VARS[@]}" \
  >"$ARTIFACT_DIR/worker.log" 2>&1 &
WORKER_PID="$!"

if [[ "$BACKEND" == "audio-separator" ]]; then
  for _ in {1..120}; do
    if curl -sSf "http://127.0.0.1:$SEPARATOR_PORT/health" >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done
  curl -sSf "http://127.0.0.1:$SEPARATOR_PORT/health" >/dev/null
fi

for _ in {1..120}; do
  if curl -sSf "http://127.0.0.1:$WORKER_PORT/api/separation-options" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
curl -sSf "http://127.0.0.1:$WORKER_PORT/api/separation-options" >/dev/null

REAL_AUDIO_SOURCE="$SOURCE_AUDIO" \
REAL_AUDIO_YOUTUBE_URL="$YOUTUBE_URL" \
REAL_AUDIO_MODEL="$MODEL" \
REAL_AUDIO_CASE_SLUG="$CASE_SLUG" \
REAL_AUDIO_CLASS_CODE="$CLASS_CODE" \
REAL_AUDIO_BASE_URL="http://127.0.0.1:$WORKER_PORT" \
REAL_AUDIO_ARTIFACT_DIR="$ARTIFACT_DIR" \
REAL_AUDIO_RESULT_PATH="$RESULT_PATH" \
npm run test:e2e:real

if rg -n \
  'POST /api/webhooks/separation 5[0-9]{2}|Internal Server Error|Network connection lost' \
  "$ARTIFACT_DIR/worker.log"; then
  echo "Worker log contains a fatal real-audio E2E failure" >&2
  exit 1
fi

if [[ -f "$ARTIFACT_DIR/separator.log" ]] &&
   rg -n 'webhook delivery failed|Traceback' "$ARTIFACT_DIR/separator.log"; then
  echo "Separator log contains a fatal real-audio E2E failure" >&2
  exit 1
fi
