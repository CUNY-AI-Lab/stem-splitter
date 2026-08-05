#!/usr/bin/env bash
# Boot an isolated local stack (worker + real local separator) and evaluate the
# Internet Archive crate end-to-end: live archive.org fetches, real separation,
# per-phase timings. Prints a summary table and writes JSON artifacts.

set -euo pipefail

MODEL="${ARCHIVE_EVAL_MODEL:-htdemucs_ft}"
WORKER_PORT="${WORKER_PORT:-8787}"
SEPARATOR_PORT="${SEPARATOR_PORT:-8765}"
CLASS_CODE="${CLASS_CODE:-local-class-code}"
LOCAL_WEBHOOK_SECRET="archive-crate-e2e-webhook"
LOCAL_SEPARATOR_TOKEN="archive-crate-e2e-separator"
ARTIFACT_DIR="${ARCHIVE_EVAL_ARTIFACT_DIR:-output/playwright/archive-crate}"
RUN_ROOT="$(mktemp -d /tmp/stem-splitter-archive-crate.XXXXXX)"
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

for command_name in curl npx rg uv python3; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Missing required command: $command_name" >&2
    exit 1
  }
done

case "$MODEL" in
  bs_roformer_vocals|htdemucs_ft|htdemucs_6s) ;;
  *)
    echo "Unsupported ARCHIVE_EVAL_MODEL: $MODEL" >&2
    exit 1
    ;;
esac

mkdir -p "$ARTIFACT_DIR"
rm -f "$ARTIFACT_DIR"/*.json

npx wrangler d1 execute stem-splitter \
  --local \
  --persist-to "$RUN_ROOT/state" \
  --file schema.sql \
  --yes >"$ARTIFACT_DIR/d1.log" 2>&1

UV_CACHE_DIR=.uv-cache \
uv sync --project local-separator --locked >"$ARTIFACT_DIR/uv-sync.log" 2>&1

# Model weights cache in the default local-separator/.data across runs.
AUDIO_SEPARATOR_TOKEN="$LOCAL_SEPARATOR_TOKEN" \
local-separator/.venv/bin/python local-separator/service.py \
  --port "$SEPARATOR_PORT" >"$ARTIFACT_DIR/separator.log" 2>&1 &
SEPARATOR_PID="$!"

npx wrangler dev \
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

ARCHIVE_EVAL_MODEL="$MODEL" \
ARCHIVE_EVAL_CLASS_CODE="$CLASS_CODE" \
ARCHIVE_CRATE_BASE_URL="http://127.0.0.1:$WORKER_PORT" \
ARCHIVE_EVAL_ARTIFACT_DIR="$ARTIFACT_DIR" \
npx playwright test --config playwright.archive-crate.config.mjs

if rg -n \
  'POST /api/webhooks/separation 5[0-9]{2}|Internal Server Error|Network connection lost' \
  "$ARTIFACT_DIR/worker.log"; then
  echo "Worker log contains a fatal archive-crate E2E failure" >&2
  exit 1
fi

if rg -n 'webhook delivery failed|Traceback' "$ARTIFACT_DIR/separator.log"; then
  echo "Separator log contains a fatal archive-crate E2E failure" >&2
  exit 1
fi

python3 - "$ARTIFACT_DIR" <<'PY'
import json, sys
from pathlib import Path

artifact_dir = Path(sys.argv[1])
results = sorted(
    (json.loads(p.read_text()) for p in artifact_dir.glob('*.json')),
    key=lambda r: r['completedAt'],
)
if not results:
    sys.exit('no per-track results found')

header = f"{'identifier':<26} {'genre':<20} {'licence':<18} {'len':>5} {'size':>7} {'search':>7} {'import':>7} {'separate':>9} {'total':>7}"
print()
print(header)
print('-' * len(header))
for r in results:
    t = r['timings']
    print(
        f"{r['identifier']:<26} {(r.get('genre') or ''):<20} {r['license']:<18} "
        f"{int(r['track']['durationSec'] // 60)}:{int(r['track']['durationSec'] % 60):02d} "
        f"{r['track']['bytes'] / 1e6:6.1f}M "
        f"{t['searchMs'] / 1000:6.1f}s {t['importMs'] / 1000:6.1f}s "
        f"{t['separationMs'] / 1000:8.1f}s {t['totalMs'] / 1000:6.1f}s"
    )

total_audio = sum(r['track']['durationSec'] for r in results)
total_wall = sum(r['timings']['totalMs'] for r in results) / 1000
sep_wall = sum(r['timings']['separationMs'] for r in results) / 1000
print('-' * len(header))
print(
    f"{len(results)} tracks · {total_audio / 60:.1f} min audio · "
    f"wall {total_wall / 60:.1f} min · separation {sep_wall / 60:.1f} min "
    f"({total_audio / sep_wall:.1f}x realtime)"
)

(artifact_dir / 'summary.json').write_text(json.dumps(results, indent=2) + '\n')
PY
